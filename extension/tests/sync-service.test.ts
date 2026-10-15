// Background sync orchestration (lib/sync-service.ts) driven through handleSyncMessage with
// fakeBrowser storage and a mocked fetch: space bookkeeping (local id+key generation, join-by-code
// verification, forget/delete, server-switch reset), pull/switch/upload/publish data flows,
// validation-failure zero writes, key rejection pass-through, and the not-configured /
// unknown-space uniform rejections (no local side effects).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { handleSyncMessage } from '@/lib/sync-service';
import { initAuthReady } from '@/lib/sync-auth';
import { syncAuthItem, syncConfigItem, syncLinksItem, syncUiItem } from '@/lib/sync-storage';
import { upsertSyncLink, upsertSyncSpace, writeSyncConfig } from '@/lib/sync-storage';
import { buildFlowStore, loadFlows, flowInputValuesItem, flowStoreItem } from '@/lib/storage';
import { flowDraftHash, type InputDefinition, type Flow } from '@/lib/flow-schema';

const SERVER = 'http://127.0.0.1:8080';
const SPACE_ID = 'sp-test000000000001';
const SPACE_KEY = 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk';
const SCRIPT_ID = 'sc-test000000000001';

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: 'r_local',
    name: 'Local flow',
    site: 'https://saas.example.com',
    page: { urlIncludes: '#/shipment' },
    trigger: { kind: 'pageEnter' },
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'fill-phone',
          kind: 'action',
          action: { type: 'setInputValue', target: { clues: { id: 'phone' }, componentType: 'input', displayLabel: 'Phone' }, value: '13800001234' },
        },
      ],
    },
    status: 'draft',
    provenance: { source: 'import', importedAt: now, createdAt: now, updatedAt: now },
    ...overrides,
  };
}

// Server-side flow snapshot: carries an envelope with id/status to prove the pull side ignores and
// rewrites them (a cloud copy can never inject an enabled state)
function serverFlowContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'cloud-id',
    status: 'enabled',
    provenance: { source: 'import', createdAt: 0, updatedAt: 0 },
    name: 'Cloud script flow',
    site: 'https://saas.example.com',
    page: { urlIncludes: '#/shipment' },
    trigger: { kind: 'pageEnter' },
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'fill-phone',
          kind: 'action',
          action: { type: 'setInputValue', target: { clues: { id: 'phone' }, componentType: 'input', displayLabel: 'Phone' }, value: '13800001234' },
        },
      ],
    },
    ...overrides,
  };
}

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function apiError(status: number, code: string, message = code): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status });
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init ?? {});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function configured(): Promise<void> {
  await writeSyncConfig({
    serverUrl: SERVER,
    spaces: [{ id: SPACE_ID, key: SPACE_KEY, name: 'Team Space', createdAt: '2026-01-01T00:00:00.000Z' }],
  });
}

async function seededLink(seedFlow: Flow): Promise<void> {
  await flowStoreItem.setValue(buildFlowStore([seedFlow]));
  await upsertSyncLink({
    flowId: seedFlow.id,
    spaceId: SPACE_ID,
    scriptId: SCRIPT_ID,
    scriptName: 'Cloud script',
    pinnedVersionNumber: 1,
    pinnedContentHash: flowDraftHash(seedFlow),
  });
  await syncUiItem.setValue({ currentSpaceId: SPACE_ID });
}

beforeEach(() => {
  fakeBrowser.reset();
  // fakeBrowser ships setAccessLevel as a throwing placeholder; the sync auth gate awaits the
  // real call, so pin a resolving no-op (mocked call — not evidence of real storage isolation)
  (fakeBrowser.storage.local as unknown as Record<string, unknown>).setAccessLevel = async () => undefined;
  // The pull path's post-write step (afterFlowsWrite → syncFlowSiteScripts) touches the scripting
  // API, which fakeBrowser ships unimplemented — same in-memory stubs as tests/site-scripts.test.ts
  const scripting = fakeBrowser.scripting as unknown as Record<string, (arg: unknown) => Promise<unknown>>;
  scripting.getRegisteredContentScripts = async () => [];
  scripting.registerContentScripts = async () => undefined;
  scripting.unregisterContentScripts = async () => undefined;
  scripting.executeScript = async () => [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('preconditions: not configured / unknown space', () => {
  it('space operations are uniformly rejected with not-configured and write nothing local', async () => {
    // Fresh installs now start against DEFAULT_SYNC_SERVER_URL; serverUrl === '' is the
    // legacy/cleared state, so it has to be written explicitly to exercise the guard
    await writeSyncConfig({ serverUrl: '', spaces: [] });
    const res = await handleSyncMessage({ type: 'sp:syncListScripts', spaceId: SPACE_ID });
    expect(res).toEqual({ ok: false, reason: 'not-configured' });
    const res2 = await handleSyncMessage({ type: 'sp:syncCreateSpace', name: 'Team' });
    expect(res2).toEqual({ ok: false, reason: 'not-configured' });
    // Nothing landed in the existing local stores
    expect((await flowStoreItem.getValue()).flows).toEqual([]);
  });

  it('a configured server with an unknown space id rejects with space-not-known', async () => {
    await writeSyncConfig({ serverUrl: SERVER, spaces: [] });
    const res = await handleSyncMessage({ type: 'sp:syncListScripts', spaceId: 'sp-unknown000000001' });
    expect(res).toEqual({ ok: false, reason: 'space-not-known' });
  });

  it('sp:syncGetStatus is purely local (no fetch, no probe) and exposes share codes', async () => {
    const fetchMock = mockFetch(() => {
      throw new Error('must not fetch');
    });
    await configured();
    await syncUiItem.setValue({ currentSpaceId: SPACE_ID });
    const res = await handleSyncMessage({ type: 'sp:syncGetStatus' });
    expect(res).toEqual({
      ok: true,
      syncState: {
        serverUrl: SERVER,
        spaces: [
          {
            id: SPACE_ID,
            name: 'Team Space',
            createdAt: '2026-01-01T00:00:00.000Z',
            code: `${SPACE_ID}#${SPACE_KEY}`,
          },
        ],
        currentSpaceId: SPACE_ID,
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('server configuration', () => {
  it('setServer normalizes, saves and probes; same address keeps state, invalid input rejected', async () => {
    const fetchMock = mockFetch((url) => (url === `${SERVER}/api/health` ? ok({ status: 'ok' }) : noContent()));
    const res = await handleSyncMessage({ type: 'sp:syncSetServer', serverUrl: `${SERVER}/ignored/path` });
    expect(res).toEqual({ ok: true, health: 'ok' });
    expect(await syncConfigItem.getValue()).toEqual({ serverUrl: SERVER, spaces: [] });
    expect(fetchMock).toHaveBeenCalledOnce();

    const bad = await handleSyncMessage({ type: 'sp:syncSetServer', serverUrl: 'not a url' });
    expect(bad).toEqual({ ok: false, reason: 'invalid-origin' });
  });

  it('changing the server resets spaces + links + selection (local flows untouched)', async () => {
    mockFetch((url) => (url === 'https://other.example.com/api/health' ? ok({ status: 'ok' }) : noContent()));
    await seededLink(makeFlow());
    await configured();
    const res = await handleSyncMessage({ type: 'sp:syncSetServer', serverUrl: 'https://other.example.com' });
    expect(res).toEqual({ ok: true, health: 'ok' });
    const config = await syncConfigItem.getValue();
    expect(config.serverUrl).toBe('https://other.example.com');
    expect(config.spaces).toEqual([]);
    expect(await syncLinksItem.getValue()).toEqual([]);
    expect(await syncUiItem.getValue()).toEqual({ currentSpaceId: null });
    expect(await loadFlows()).toHaveLength(1);
  });

  it('an unreachable server still saves the address and reports unreachable', async () => {
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const res = await handleSyncMessage({ type: 'sp:syncSetServer', serverUrl: SERVER });
    expect(res).toEqual({ ok: false, reason: 'unreachable' });
    expect((await syncConfigItem.getValue()).serverUrl).toBe(SERVER);
  });

  it('probeHealth reports ok / unreachable without touching the config', async () => {
    await configured();
    mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await handleSyncMessage({ type: 'sp:syncProbeHealth' })).toEqual({ ok: true, health: 'unreachable' });
    mockFetch(() => ok({ status: 'ok' }));
    expect(await handleSyncMessage({ type: 'sp:syncProbeHealth' })).toEqual({ ok: true, health: 'ok' });
    expect((await syncConfigItem.getValue()).spaces).toHaveLength(1);
  });
});

describe('space lifecycle (no accounts: ids and keys are generated locally)', () => {
  // The creation branch needs the server's mode first: none (404 config) keeps the original
  // key path byte-for-byte — the probe must answer none explicitly for the legacy assertions
  it('createSpace on a none server generates the id+key locally, registers, stores the entry and selects it', async () => {
    await writeSyncConfig({ serverUrl: SERVER, spaces: [] });
    const fetchMock = mockFetch((url, init) =>
      url === `${SERVER}/api/auth/config`
        ? apiError(404, 'NOT_FOUND')
        : url === `${SERVER}/api/spaces`
          ? ok({ id: (JSON.parse(String(init.body)) as { id: string }).id, name: 'Fresh', createdAt: 't' }, 201)
          : noContent(),
    );
    const res = await handleSyncMessage({ type: 'sp:syncCreateSpace', name: 'Fresh' });
    expect(res?.ok).toBe(true);
    if (res?.ok) expect(res.space?.name).toBe('Fresh');
    // The POST body carries a locally generated id (sp- + 16 base62) and a 32-char key
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.body !== undefined)!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as { id: string; key: string; name: string };
    expect(body.id).toMatch(/^sp-[A-Za-z0-9]{16}$/);
    expect(body.key).toMatch(/^[A-Za-z0-9]{32}$/);
    // Stored only after acceptance, and selected as current
    const config = await syncConfigItem.getValue();
    expect(config.spaces[0]).toMatchObject({ id: body.id, key: body.key, name: 'Fresh' });
    expect(await syncUiItem.getValue()).toEqual({ currentSpaceId: body.id });
  });

  it('joinSpace rejects malformed codes locally and stores only server-verified entries', async () => {
    await writeSyncConfig({ serverUrl: SERVER, spaces: [] });
    const fetchMock = mockFetch(() => {
      throw new Error('must not fetch for malformed codes');
    });
    for (const code of ['', 'nonsense', `${SPACE_ID}#short`, `sp-with!bad!chars1#${SPACE_KEY}`]) {
      const res = await handleSyncMessage({ type: 'sp:syncJoinSpace', code });
      expect(res?.reason ?? `unexpected success for code=${code}`).toBe('bad-space-code');
      expect(res?.ok).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // A well-formed code the server rejects (wrong key) never lands locally
    mockFetch(() => apiError(401, 'BAD_SPACE_KEY', 'The space key was rejected for this space'));
    const rejected = await handleSyncMessage({
      type: 'sp:syncJoinSpace',
      code: `${SPACE_ID}#${SPACE_KEY.replace(/k/, 'j')}`,
    });
    expect(rejected).toEqual({ ok: false, reason: 'bad-space-key' });
    expect((await syncConfigItem.getValue()).spaces).toEqual([]);

    // A verified code is stored with the server-side name
    mockFetch(() => ok({ id: SPACE_ID, name: 'Team Space', createdAt: 't' }));
    const joined = await handleSyncMessage({ type: 'sp:syncJoinSpace', code: `${SPACE_ID}#${SPACE_KEY}` });
    expect(joined).toEqual({ ok: true, space: { id: SPACE_ID, name: 'Team Space' } });
    expect(await syncConfigItem.getValue()).toEqual({
      serverUrl: SERVER,
      spaces: [{ id: SPACE_ID, key: SPACE_KEY, name: 'Team Space', createdAt: 't' }],
    });
  });

  it('forgetSpace is local-only: drops entry + links + selection, server untouched', async () => {
    await seededLink(makeFlow());
    await configured();
    const fetchMock = mockFetch(() => {
      throw new Error('forget must not touch the server');
    });
    const res = await handleSyncMessage({ type: 'sp:syncForgetSpace', spaceId: SPACE_ID });
    expect(res).toEqual({ ok: true });
    expect(await syncConfigItem.getValue()).toEqual({ serverUrl: SERVER, spaces: [] });
    expect(await syncLinksItem.getValue()).toEqual([]);
    expect(await syncUiItem.getValue()).toEqual({ currentSpaceId: null });
    expect(await loadFlows()).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deleteSpace removes server-side then forgets locally; other spaces keep their links', async () => {
    await seededLink(makeFlow());
    await configured();
    await upsertSyncSpace({ id: 'sp-other00000000001', key: 'j'.repeat(32), name: 'Other', createdAt: 't' });
    const fetchMock = mockFetch((url) => (url === `${SERVER}/api/spaces/${SPACE_ID}` ? noContent() : ok({})));
    const res = await handleSyncMessage({ type: 'sp:syncDeleteSpace', spaceId: SPACE_ID });
    expect(res).toEqual({ ok: true });
    expect(fetchMock.mock.calls.filter(([u]) => u === `${SERVER}/api/spaces/${SPACE_ID}`)).toHaveLength(1);
    const config = await syncConfigItem.getValue();
    expect(config.spaces.map((s) => s.id)).toEqual(['sp-other00000000001']);
    expect(await syncLinksItem.getValue()).toEqual([]);
  });
});

describe('pull / switch data flow', () => {
  it('first pull creates a draft flow (envelope rewritten) and pins the link', async () => {
    await configured();
    const fetchMock = mockFetch((url) =>
      url.endsWith('/versions/2')
        ? ok({ versionNumber: 2, note: 'v2', createdAt: 't', flowContent: serverFlowContent() })
        : noContent(),
    );
    const res = await handleSyncMessage({ type: 'sp:syncPullVersion', spaceId: SPACE_ID, scriptId: SCRIPT_ID, versionNumber: 2 });
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      expect(res.created).toBe(true);
      expect(typeof res.flowId).toBe('string');
    }
    const flows = await loadFlows();
    expect(flows).toHaveLength(1);
    // Pulled flows land not-enabled and the cloud envelope (id/status) never survives the pull
    expect(flows[0]!.status).toBe('draft');
    expect(flows[0]!.id).not.toBe('cloud-id');
    expect(flows[0]!.name).toBe('Cloud script flow');
    const links = await syncLinksItem.getValue();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ spaceId: SPACE_ID, scriptId: SCRIPT_ID, pinnedVersionNumber: 2 });
    expect(links[0]!.pinnedContentHash).toBe(flowDraftHash(flows[0]!));
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/versions/2'))).toHaveLength(1);
  });

  it('switch keeps the flowId, resets status to draft and updates the pin/hash', async () => {
    await configured();
    const seed = makeFlow({ status: 'enabled' });
    await seededLink(seed);
    expect((await loadFlows())[0]!.provenance.createdAt).toBe(seed.provenance.createdAt);
    mockFetch(() =>
      ok({
        versionNumber: 2,
        note: 'v2',
        createdAt: 't',
        flowContent: serverFlowContent({ name: 'Switched content' }),
      }),
    );
    const res = await handleSyncMessage({ type: 'sp:syncPullVersion', spaceId: SPACE_ID, scriptId: SCRIPT_ID, versionNumber: 2 });
    expect(res).toEqual({ ok: true, flowId: 'r_local', created: false });
    const flows = await loadFlows();
    expect(flows).toHaveLength(1);
    expect(flows[0]!.name).toBe('Switched content');
    // A switched flow falls back to not-enabled and must be re-authorized locally
    expect(flows[0]!.status).toBe('draft');
    expect(flows[0]!.provenance.createdAt).toBe(seed.provenance.createdAt);
    const link = (await syncLinksItem.getValue())[0]!;
    expect(link.pinnedVersionNumber).toBe(2);
    expect(link.pinnedContentHash).toBe(flowDraftHash(flows[0]!));
  });

  it('validation failure rejects the whole pull with zero writes to flows and links', async () => {
    await configured();
    const seed = makeFlow();
    await seededLink(seed);
    mockFetch(() =>
      ok({ versionNumber: 3, note: '', createdAt: 't', flowContent: serverFlowContent({ steps: { id: 'root', kind: 'sequence', steps: [] } }) }),
    );
    const res = await handleSyncMessage({ type: 'sp:syncPullVersion', spaceId: SPACE_ID, scriptId: SCRIPT_ID, versionNumber: 3 });
    expect(res?.ok).toBe(false);
    if (!res?.ok) {
      expect(res.reason).toBe('invalid-content');
      expect(res.errors?.join('\n')).toContain('steps must be a non-empty array');
    }
    expect(await loadFlows()).toEqual([seed]);
    expect(await syncLinksItem.getValue()).toHaveLength(1);
  });

  it('preview validates without writing and marks submit-class actions', async () => {
    await configured();
    const steps = [
      {
        id: 'fill-phone',
        kind: 'action',
        action: { type: 'setInputValue', target: { clues: { id: 'phone' }, componentType: 'input', displayLabel: 'Phone' }, value: '13800001234' },
      },
      {
        id: 'submit-order',
        kind: 'action',
        action: { type: 'clickButton', target: { clues: { id: 'save' }, componentType: 'button', displayLabel: 'Submit order' } },
      },
    ];
    mockFetch(() =>
      ok({
        versionNumber: 1,
        note: '',
        createdAt: 't',
        flowContent: serverFlowContent({ steps: { id: 'root', kind: 'sequence', steps } }),
      }),
    );
    const res = await handleSyncMessage({ type: 'sp:syncPreviewVersion', spaceId: SPACE_ID, scriptId: SCRIPT_ID, versionNumber: 1 });
    expect(res?.ok).toBe(true);
    if (res?.ok && res.versionPreview) {
      expect(res.versionPreview.hasSubmit).toBe(true);
      expect(res.versionPreview.actions.some((a) => a.submit)).toBe(true);
      // Masking: the raw phone constant never appears in the preview text
      const joined = res.versionPreview.actions.map((a) => a.text).join('|');
      expect(joined).not.toContain('13800001234');
      expect(joined).toContain('138****1234');
    }
    expect(await loadFlows()).toEqual([]);
    expect(await syncLinksItem.getValue()).toEqual([]);
  });
});

describe('upload / publish / rename / unlink', () => {
  it('upload creates the script with a locally generated id, the flow as-is, and pins the link at v1', async () => {
    await configured();
    const flow = makeFlow();
    await flowStoreItem.setValue(buildFlowStore([flow]));
    await syncUiItem.setValue({ currentSpaceId: SPACE_ID });
    const fetchMock = mockFetch((url, init) =>
      url.endsWith('/scripts')
        ? ok(
            {
              id: (JSON.parse(String(init.body)) as { id: string }).id,
              name: 'Ship helper',
              note: 'note',
              latestVersionNumber: 1,
              latestVersionNote: 'v1',
              updatedAt: 't',
            },
            201,
          )
        : noContent(),
    );
    const res = await handleSyncMessage({
      type: 'sp:syncUploadScript',
      flowId: flow.id,
      name: 'Ship helper',
      note: 'note',
      versionNote: 'v1',
    });
    expect(res?.ok).toBe(true);
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.body !== undefined)!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as {
      id: string;
      flowContent: Record<string, unknown>;
    };
    // The script id is generated on this device (sc- + 16 base62)
    expect(body.id).toMatch(/^sc-[A-Za-z0-9]{16}$/);
    // flowContent = the local Flow object as-is (envelope included)
    expect(body.flowContent).toEqual(flow as unknown as Record<string, unknown>);
    if (res?.ok) expect(res.scriptId).toBe(body.id);
    const link = (await syncLinksItem.getValue())[0]!;
    expect(link).toMatchObject({ flowId: flow.id, spaceId: SPACE_ID, scriptId: body.id, pinnedVersionNumber: 1 });
    expect(link.pinnedContentHash).toBe(flowDraftHash(flow));
  });

  it('uploads never carry history or receipts — only the flow projection leaves the device', async () => {
    await configured();
    const flow = makeFlow();
    // A flow with real local history and native-save receipts in the v2 store
    const base = buildFlowStore([flow]);
    const store = {
      ...base,
      history: { ...base.history, [flow.id]: [...base.history[flow.id]!, { versionId: 2, savedAt: Date.now(), flow }] },
      receipts: [{ clientRef: `${Date.now()}.${'a'.repeat(32)}`, issuedAt: Date.now(), flowId: flow.id, savedAt: Date.now(), updatedAt: Date.now(), payloadHash: 'h' }],
    };
    await flowStoreItem.setValue(store);
    await syncUiItem.setValue({ currentSpaceId: SPACE_ID });
    const fetchMock = mockFetch((url) =>
      url.endsWith('/scripts')
        ? ok({ id: 'sc-fixed0000000000a', name: 'S', note: '', latestVersionNumber: 1, latestVersionNote: '', updatedAt: 't' }, 201)
        : noContent(),
    );
    const res = await handleSyncMessage({ type: 'sp:syncUploadScript', flowId: flow.id, name: 'S', note: '', versionNote: '' });
    expect(res?.ok).toBe(true);
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.body !== undefined)!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as Record<string, unknown>;
    // The request body is the script envelope + flowContent only; no store sections travel
    expect(Object.keys(body).sort()).toEqual(['flowContent', 'id', 'name', 'note', 'versionNote']);
    expect(body.flowContent).toEqual(flow as unknown as Record<string, unknown>);
    expect(JSON.stringify(body)).not.toContain('receipts');
    expect(JSON.stringify(body)).not.toContain('expiredThrough');
    expect(JSON.stringify(body)).not.toContain('versionId');
  });

  it('uploading a flow that is already linked is rejected instead of silently rebinding', async () => {
    await configured();
    const seed = makeFlow();
    await seededLink(seed);
    const fetchMock = mockFetch(() => {
      throw new Error('must not reach the server');
    });
    const res = await handleSyncMessage({
      type: 'sp:syncUploadScript',
      flowId: seed.id,
      name: 'again',
      note: '',
      versionNote: '',
    });
    expect(res?.ok).toBe(false);
    if (!res?.ok) expect(res.reason).toBe('invalid-input');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await syncLinksItem.getValue()).toHaveLength(1);
  });

  it('publish appends a version and re-pins the link to it', async () => {
    await configured();
    const seed = makeFlow({ name: 'Edited, pending publish' });
    await seededLink(seed);
    mockFetch(() => ok({ versionNumber: 2, note: 'v2', createdAt: 't' }, 201));
    const res = await handleSyncMessage({ type: 'sp:syncPublishVersion', flowId: seed.id, versionNote: 'v2' });
    expect(res).toEqual({ ok: true, versionNumber: 2 });
    const link = (await syncLinksItem.getValue())[0]!;
    expect(link.pinnedVersionNumber).toBe(2);
    expect(link.pinnedContentHash).toBe(flowDraftHash(seed));
  });

  it('publish/update without a link fails fast with not-linked', async () => {
    await configured();
    const flow = makeFlow();
    await flowStoreItem.setValue(buildFlowStore([flow]));
    const fetchMock = mockFetch(() => {
      throw new Error('must not reach the server');
    });
    expect(await handleSyncMessage({ type: 'sp:syncPublishVersion', flowId: flow.id, versionNote: 'x' })).toEqual({
      ok: false,
      reason: 'not-linked',
    });
    expect(
      await handleSyncMessage({ type: 'sp:syncUpdateScript', flowId: flow.id, name: 'New name' }),
    ).toEqual({ ok: false, reason: 'not-linked' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unlink removes only the mapping — the local flow stays', async () => {
    await configured();
    const seed = makeFlow();
    await seededLink(seed);
    const res = await handleSyncMessage({ type: 'sp:syncUnlink', flowId: seed.id });
    expect(res).toEqual({ ok: true });
    expect(await syncLinksItem.getValue()).toEqual([]);
    expect(await loadFlows()).toEqual([seed]);
  });
});

describe('error pass-through and list joins', () => {
  it('a server 401 passes through as bad-space-key and keeps local state', async () => {
    await configured();
    await seededLink(makeFlow());
    mockFetch(() => apiError(401, 'BAD_SPACE_KEY'));
    const res = await handleSyncMessage({ type: 'sp:syncListScripts', spaceId: SPACE_ID });
    expect(res).toEqual({ ok: false, reason: 'bad-space-key' });
    // Local-first resilience: flow and link survive untouched
    expect(await loadFlows()).toHaveLength(1);
    expect(await syncLinksItem.getValue()).toHaveLength(1);
  });

  it('listScripts joins links: pinned badge, new-version flag, local-edits flag, deleted-flow fallback', async () => {
    await configured();
    const seed = makeFlow();
    await seededLink(seed);
    // Server reports latest v3 while the pin is v1; the local flow was edited after pinning
    const edited = makeFlow({ name: 'Edited locally' });
    await flowStoreItem.setValue(buildFlowStore([edited]));
    mockFetch(() =>
      ok([
        {
          id: SCRIPT_ID, name: 'Cloud script', note: '', latestVersionNumber: 3, latestVersionNote: 'v3',
          updatedAt: 't',
        },
      ]),
    );
    const res = await handleSyncMessage({ type: 'sp:syncListScripts', spaceId: SPACE_ID });
    expect(res?.ok).toBe(true);
    if (res?.ok && res.scriptRows) {
      expect(res.scriptRows[0]!.local).toEqual({
        flowId: seed.id,
        pinnedVersionNumber: 1,
        localFlowExists: true,
        hasLocalEdits: true,
        newVersionAvailable: true,
      });
    }

    // flow deleted locally → localFlowExists false, mapping retained
    await flowStoreItem.setValue(buildFlowStore([]));
    const res2 = await handleSyncMessage({ type: 'sp:syncListScripts', spaceId: SPACE_ID });
    expect(res2?.ok && res2.scriptRows?.[0]?.local?.localFlowExists).toBe(false);
    expect(res2?.ok && res2.scriptRows?.[0]?.local?.flowId).toBe(seed.id);
  });

  it('scripts without a local link carry no local field', async () => {
    await configured();
    mockFetch(() =>
      ok([
        {
          id: 'sc-foreign0000000001', name: 'Someone else\'s script', note: '', latestVersionNumber: 1,
          latestVersionNote: '', updatedAt: 't',
        },
      ]),
    );
    const res = await handleSyncMessage({ type: 'sp:syncListScripts', spaceId: SPACE_ID });
    expect(res?.ok && res.scriptRows?.[0]).not.toHaveProperty('local');
  });
});

// Message-shape guard for the sync channel: handleSyncMessage unit tests bypass isExtensionMessage
// (the background routes through it), so a guard that demands fields a message never carries — e.g.
// versionNumber on listVersions — silently breaks the flow at runtime while staying green here.
import { isExtensionMessage, type ExtensionMessage } from '@/lib/messaging';

describe('sp:sync* payload guard (isExtensionMessage)', () => {
  it('accepts sp:syncListVersions without versionNumber (the version list request carries none)', () => {
    expect(isExtensionMessage({ type: 'sp:syncListVersions', spaceId: SPACE_ID, scriptId: SCRIPT_ID })).toBe(true);
  });

  it('still requires versionNumber for preview and pull', () => {
    expect(isExtensionMessage({ type: 'sp:syncPreviewVersion', spaceId: SPACE_ID, scriptId: SCRIPT_ID })).toBe(false);
    expect(isExtensionMessage({ type: 'sp:syncPullVersion', spaceId: SPACE_ID, scriptId: SCRIPT_ID })).toBe(false);
    expect(isExtensionMessage({ type: 'sp:syncPreviewVersion', spaceId: SPACE_ID, scriptId: SCRIPT_ID, versionNumber: 1 })).toBe(true);
    expect(isExtensionMessage({ type: 'sp:syncPullVersion', spaceId: SPACE_ID, scriptId: SCRIPT_ID, versionNumber: 1 })).toBe(true);
  });

  it('rejects unknown sync types and malformed fields', () => {
    expect(isExtensionMessage({ type: 'sp:syncListVersions', spaceId: SPACE_ID })).toBe(false);
    expect(isExtensionMessage({ type: 'sp:syncNoSuchOp' })).toBe(false);
    expect(isExtensionMessage(null)).toBe(false);
  });
});

// Input-definition sync boundary (form-support): uploads/publishes serialize the validated whitelist
// object — definitions travel, personal values never do, even when a caller attaches a foreign values
// field to the stored record. Pulling an input-carrying script lands definitions only; the puller's
// own local values stay untouched (each participant fills their own).
describe('input values never enter sync payloads', () => {
  const inputDefs: InputDefinition[] = [
    { key: 'phone', label: 'Phone', type: 'text', required: true },
    { key: 'channel', label: 'Channel', type: 'multi', required: false, options: [{ value: 'A', label: 'A' }] },
  ];

  it('upload serializes the whitelist: definitions included, a foreign values field dropped', async () => {
    await configured();
    await syncUiItem.setValue({ currentSpaceId: SPACE_ID });
    const base = makeFlow({ inputs: inputDefs });
    // Simulate a future caller attaching personal values to the stored flow object
    const tampered = { ...base, inputValues: { phone: 'PERSONAL-VALUE-9999' } } as unknown as Flow;
    await flowStoreItem.setValue(buildFlowStore([tampered]));
    const fetchMock = mockFetch((_url, init) =>
      String(init.method ?? 'GET').toUpperCase() === 'POST'
        ? ok({ id: SCRIPT_ID, name: 'S', note: '', latestVersionNumber: 1, latestVersionNote: '', updatedAt: 't' }, 201)
        : noContent(),
    );
    const res = await handleSyncMessage({ type: 'sp:syncUploadScript', flowId: base.id, name: 'S', note: '', versionNote: '' });
    expect(res?.ok).toBe(true);
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.body !== undefined)!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as {
      flowContent: Record<string, unknown>;
    };
    expect(body.flowContent.inputs).toEqual(inputDefs);
    expect(body.flowContent).not.toHaveProperty('inputValues');
    expect(JSON.stringify(body)).not.toContain('PERSONAL-VALUE-9999');
  });

  it('publish serializes the same whitelist (definitions only, no values fields)', async () => {
    await configured();
    const base = makeFlow({ inputs: inputDefs });
    await seededLink(base);
    const fetchMock = mockFetch(() => ok({ versionNumber: 2, note: 'v2', createdAt: 't' }, 201));
    const res = await handleSyncMessage({ type: 'sp:syncPublishVersion', flowId: base.id, versionNote: 'v2' });
    expect(res?.ok).toBe(true);
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.body !== undefined)!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as {
      flowContent: Record<string, unknown>;
    };
    expect(body.flowContent.inputs).toEqual(inputDefs);
    expect(body.flowContent).not.toHaveProperty('inputValues');
  });

  it('pulling an input-carrying script lands definitions; the puller starts with no local values', async () => {
    await configured();
    const content = serverFlowContent({ inputs: inputDefs });
    mockFetch(() => ok({ id: SCRIPT_ID, name: 'S', note: '', versionNumber: 3, versionNote: '', createdAt: 't', flowContent: content }));
    const res = await handleSyncMessage({ type: 'sp:syncPullVersion', spaceId: SPACE_ID, scriptId: SCRIPT_ID, versionNumber: 3 });
    expect(res?.ok, JSON.stringify(res)).toBe(true);
    const flows = await loadFlows();
    expect(flows[0]!.inputs).toEqual(inputDefs);
    // No local values were created or inferred by the pull — the puller fills their own
    expect(await flowInputValuesItem.getValue()).toEqual({});
  });
});

// Herald-gated servers: the auth lifecycle handlers are wired through the same router, every
// business call rides authedOperation (probe → bearer → renewal), and the storage trusted-contexts
// gate refuses auth-writing paths when it cannot be established.
describe('sign-in gate wiring (herald mode)', () => {
  const CONFIG_URL = `${SERVER}/api/auth/config`;
  const REFRESH_URL = `${SERVER}/api/auth/refresh`;

  function heraldProbe() {
    mockFetch((url) => (url === CONFIG_URL ? ok({ enabled: true, loginUrl: '/api/auth/oauth/start' }) : ok({})));
  }

  async function seedSession() {
    await syncAuthItem.setValue({
      serverUrl: SERVER,
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      accessTokenExpiresAt: Date.now() + 3_600_000,
      epoch: 1,
    });
  }

  it('sp:syncGetAuthState reports the probed mode + signedIn facts and never echoes tokens', async () => {
    await configured();
    await seedSession();
    heraldProbe();
    const res = await handleSyncMessage({ type: 'sp:syncGetAuthState' });
    expect(res).toEqual({ ok: true, authState: { mode: 'herald', signedIn: true } });
    expect(JSON.stringify(res)).not.toContain('at-1');
    expect(JSON.stringify(res)).not.toContain('rt-1');
  });

  it('sp:syncGetAuthState on a pre-auth server (404 config) answers none without a sign-in card state', async () => {
    await configured();
    mockFetch((url) => (url === CONFIG_URL ? apiError(404, 'NOT_FOUND') : ok({})));
    expect(await handleSyncMessage({ type: 'sp:syncGetAuthState' })).toEqual({
      ok: true,
      authState: { mode: 'none', signedIn: false },
    });
  });

  it('a herald-mode business call carries Authorization alongside X-Space-Key', async () => {
    await configured();
    await seedSession();
    const fetchMock = mockFetch((url, init) =>
      url === CONFIG_URL
        ? ok({ enabled: true, loginUrl: '/api/auth/oauth/start' })
        : url === `${SERVER}/api/spaces/${SPACE_ID}/scripts`
          ? ok([])
          : ok({}),
    );
    const res = await handleSyncMessage({ type: 'sp:syncListScripts', spaceId: SPACE_ID });
    expect(res?.ok).toBe(true);
    const business = fetchMock.mock.calls.find(([u]) => u === `${SERVER}/api/spaces/${SPACE_ID}/scripts`)!;
    expect((business[1]!.headers as Record<string, string>)['Authorization']).toBe('Bearer at-1');
    expect((business[1]!.headers as Record<string, string>)['X-Space-Key']).toBe(SPACE_KEY);
  });

  it('a business 401 AUTH_REQUIRED renews once through the refresh proxy and retries with the rotated token', async () => {
    await configured();
    await seedSession();
    let businessCalls = 0;
    mockFetch((url) => {
      if (url === CONFIG_URL) return ok({ enabled: true, loginUrl: '/api/auth/oauth/start' });
      if (url === REFRESH_URL) {
        return ok({ accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 3600, refreshExpiresIn: 86400, tokenType: 'Bearer' });
      }
      businessCalls += 1;
      return businessCalls === 1
        ? apiError(401, 'AUTH_REQUIRED', 'Sign in required')
        : ok([{ id: SCRIPT_ID, name: 'S', note: '', latestVersionNumber: 1, latestVersionNote: '', updatedAt: 't' }]);
    });
    const res = await handleSyncMessage({ type: 'sp:syncListScripts', spaceId: SPACE_ID });
    expect(res?.ok).toBe(true);
    expect(businessCalls).toBe(2);
    // The rotation is persisted before the retry is dispatched
    expect(await syncAuthItem.getValue()).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });
  });

  it('a failed trusted-contexts gate refuses auth-writing paths: setServer neither resets nor probes', async () => {
    await configured();
    (fakeBrowser.storage.local as unknown as Record<string, unknown>).setAccessLevel = async () => {
      throw new Error('cannot restrict');
    };
    void initAuthReady();
    const fetchMock = mockFetch(() => {
      throw new Error('must not probe');
    });
    expect(await handleSyncMessage({ type: 'sp:syncSetServer', serverUrl: 'https://other.example.com' })).toEqual({
      ok: false,
      reason: 'auth-unavailable',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await syncConfigItem.getValue()).serverUrl).toBe(SERVER);

    // Restore the resolving gate so later tests in this file are not poisoned by the module-level
    // authReadyPromise carrying the failure
    (fakeBrowser.storage.local as unknown as Record<string, unknown>).setAccessLevel = async () => undefined;
    void initAuthReady();
  });
});

// Workspace permissions: creation branches by the probed server capability, join routes invite
// codes, the scripts view refreshes the server-fresh role, and the five member handlers stay
// org-bound-only with the local-first guarantees (removed/self-exited keeps local data).
describe('workspace permissions (org-bound spaces)', () => {
  const CONFIG_URL = `${SERVER}/api/auth/config`;
  const MY_USER = '11111111-1111-1111-1111-111111111111';
  const OTHER_USER = '22222222-2222-2222-2222-222222222222';
  const INVITE_SECRET = 'i'.repeat(32);

  function noneProbe(handler: (url: string, init: RequestInit) => Response = () => noContent()) {
    return mockFetch((url, init) => (url === CONFIG_URL ? apiError(404, 'NOT_FOUND') : handler(url, init)));
  }

  function wpProbe(handler: (url: string, init: RequestInit) => Response = () => noContent()) {
    return mockFetch((url, init) =>
      url === CONFIG_URL
        ? ok({ enabled: true, loginUrl: '/api/auth/oauth/start', workspacePermissions: true })
        : handler(url, init),
    );
  }

  async function seedSession() {
    await syncAuthItem.setValue({
      serverUrl: SERVER,
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      accessTokenExpiresAt: Date.now() + 3_600_000,
      epoch: 1,
    });
  }

  // The org-bound twin of configured(): an entry with no key, only role facts
  async function orgConfigured(myRole: 'owner' | 'admin' | 'member' = 'member', withUserId = true) {
    await writeSyncConfig({
      serverUrl: SERVER,
      spaces: [
        {
          id: SPACE_ID,
          name: 'Team Space',
          createdAt: '2026-01-01T00:00:00.000Z',
          myRole,
          ...(withUserId ? { myUserId: MY_USER } : {}),
        },
      ],
    });
    await syncUiItem.setValue({ currentSpaceId: SPACE_ID });
  }

  it('creation on a workspace server is key-less and stores the owner role facts from the response', async () => {
    await writeSyncConfig({ serverUrl: SERVER, spaces: [] });
    await seedSession();
    const fetchMock = wpProbe((url, init) =>
      url === `${SERVER}/api/spaces`
        ? ok(
            {
              id: (JSON.parse(String(init.body)) as { id: string }).id,
              name: 'Fresh',
              createdAt: 't',
              myRole: 'owner',
              myUserId: MY_USER,
            },
            201,
          )
        : noContent(),
    );
    const res = await handleSyncMessage({ type: 'sp:syncCreateSpace', name: 'Fresh' });
    expect(res?.ok).toBe(true);
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.body !== undefined)!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as Record<string, unknown>;
    // The org-bound request carries no key — a key here would create a key space instead
    expect(Object.keys(body).sort()).toEqual(['id', 'name']);
    const config = await syncConfigItem.getValue();
    expect(config.spaces[0]).toEqual({
      id: body.id,
      name: 'Fresh',
      createdAt: 't',
      myRole: 'owner',
      myUserId: MY_USER,
    });
    expect(await syncUiItem.getValue()).toEqual({ currentSpaceId: body.id });
  });

  it('a herald server without workspacePermissions keeps the original key path byte-for-byte', async () => {
    await writeSyncConfig({ serverUrl: SERVER, spaces: [] });
    await seedSession();
    const fetchMock = mockFetch((url, init) =>
      url === CONFIG_URL
        ? ok({ enabled: true, loginUrl: '/api/auth/oauth/start', workspacePermissions: false })
        : url === `${SERVER}/api/spaces`
          ? ok({ id: (JSON.parse(String(init.body)) as { id: string }).id, name: 'Old', createdAt: 't' }, 201)
          : noContent(),
    );
    const res = await handleSyncMessage({ type: 'sp:syncCreateSpace', name: 'Old' });
    expect(res?.ok).toBe(true);
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.body !== undefined)!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['id', 'key', 'name']);
    expect((await syncConfigItem.getValue()).spaces[0]).toMatchObject({ key: expect.any(String) });
  });

  it('an unknown probe refuses creation fail-closed: zero space requests, zero local writes', async () => {
    await writeSyncConfig({ serverUrl: SERVER, spaces: [] });
    await seedSession();
    const fetchMock = mockFetch(() => apiError(500, 'BOOM'));
    expect(await handleSyncMessage({ type: 'sp:syncCreateSpace', name: 'X' })).toEqual({
      ok: false,
      reason: 'auth-unavailable',
    });
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === `${SERVER}/api/spaces`)).toHaveLength(0);
    expect((await syncConfigItem.getValue()).spaces).toEqual([]);
    expect(await syncUiItem.getValue()).toEqual({ currentSpaceId: null });
  });

  it('invite join redeems into a role entry; a replayed code stores the server-actual role (no demotion)', async () => {
    await writeSyncConfig({ serverUrl: SERVER, spaces: [] });
    await seedSession();
    const redeemUrl = `${SERVER}/api/invites/redeem`;
    const fetchMock = wpProbe((url) =>
      url === redeemUrl ? ok({ id: SPACE_ID, name: 'Team Space', createdAt: 't', myRole: 'member', myUserId: MY_USER }) : noContent(),
    );
    const joined = await handleSyncMessage({ type: 'sp:syncJoinSpace', code: `${SPACE_ID}#iv-${INVITE_SECRET}` });
    expect(joined).toEqual({ ok: true, space: { id: SPACE_ID, name: 'Team Space' } });
    expect(JSON.parse(String((fetchMock.mock.calls.find(([u]) => u === redeemUrl)![1] as RequestInit).body))).toEqual({
      code: `${SPACE_ID}#iv-${INVITE_SECRET}`,
    });
    expect((await syncConfigItem.getValue()).spaces[0]).toEqual({
      id: SPACE_ID,
      name: 'Team Space',
      createdAt: 't',
      myRole: 'member',
      myUserId: MY_USER,
    });

    // Idempotent replay of an already-used code returns the caller's ACTUAL role
    mockFetch((url) =>
      url === CONFIG_URL
        ? ok({ enabled: true, loginUrl: '/api/auth/oauth/start', workspacePermissions: true })
        : url === redeemUrl
          ? ok({ id: SPACE_ID, name: 'Team Space', createdAt: 't', myRole: 'admin', myUserId: MY_USER })
          : noContent(),
    );
    await handleSyncMessage({ type: 'sp:syncJoinSpace', code: `${SPACE_ID}#iv-${INVITE_SECRET}` });
    expect((await syncConfigItem.getValue()).spaces[0]).toMatchObject({ myRole: 'admin' });
  });

  it('invite join without a session asks for sign-in before any redeem — the code is not consumed', async () => {
    await writeSyncConfig({ serverUrl: SERVER, spaces: [] });
    const fetchMock = wpProbe();
    expect(
      await handleSyncMessage({ type: 'sp:syncJoinSpace', code: `${SPACE_ID}#iv-${INVITE_SECRET}` }),
    ).toEqual({ ok: false, reason: 'sign-in-required' });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/invites/redeem'))).toHaveLength(0);
    expect((await syncConfigItem.getValue()).spaces).toEqual([]);
  });

  it('none servers and malformed invite shapes refuse locally with zero network', async () => {
    await writeSyncConfig({ serverUrl: SERVER, spaces: [] });
    const noneMock = noneProbe();
    expect(
      await handleSyncMessage({ type: 'sp:syncJoinSpace', code: `${SPACE_ID}#iv-${INVITE_SECRET}` }),
    ).toEqual({ ok: false, reason: 'invite-unsupported' });
    expect(noneMock.mock.calls.filter(([u]) => String(u).includes('/api/invites'))).toHaveLength(0);

    const shapeMock = mockFetch(() => {
      throw new Error('must not fetch for malformed codes');
    });
    for (const bad of [`${SPACE_ID}#iv-short`, `${SPACE_ID}#iv-${'i'.repeat(33)}`, `${SPACE_ID}#iv--${'i'.repeat(31)}`]) {
      const res = await handleSyncMessage({ type: 'sp:syncJoinSpace', code: bad });
      expect(res?.reason ?? `unexpected success for ${bad}`).toBe('bad-space-code');
    }
    expect(shapeMock).not.toHaveBeenCalled();
  });

  it('org-bound listScripts refreshes the role first in one probe: changes write back and ride the response', async () => {
    await orgConfigured('member');
    await seedSession();
    const scriptsUrl = `${SERVER}/api/spaces/${SPACE_ID}/scripts`;
    const spaceUrl = `${SERVER}/api/spaces/${SPACE_ID}`;
    const fetchMock = wpProbe((url) =>
      url === spaceUrl
        ? ok({ id: SPACE_ID, name: 'Team Space', createdAt: 't', myRole: 'admin', myUserId: MY_USER })
        : url === scriptsUrl
          ? ok([])
          : noContent(),
    );
    const res = await handleSyncMessage({ type: 'sp:syncListScripts', spaceId: SPACE_ID });
    expect(res?.ok).toBe(true);
    if (res?.ok) expect(res.myRole).toBe('admin');
    // Single probe, single run: config answered once, the role refresh answered once
    expect(fetchMock.mock.calls.filter(([u]) => u === CONFIG_URL)).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([u]) => u === spaceUrl)).toHaveLength(1);
    // The fresh role + identity landed in the entry
    expect((await syncConfigItem.getValue()).spaces[0]).toMatchObject({ myRole: 'admin', myUserId: MY_USER });
  });

  it('a removed member sees their next listScripts refused with space-access-denied and local data intact', async () => {
    await orgConfigured('member');
    await seedSession();
    const scriptsUrl = `${SERVER}/api/spaces/${SPACE_ID}/scripts`;
    const fetchMock = wpProbe((url) =>
      url === `${SERVER}/api/spaces/${SPACE_ID}` ? apiError(403, 'SPACE_ACCESS_DENIED', 'no access') : noContent(),
    );
    expect(await handleSyncMessage({ type: 'sp:syncListScripts', spaceId: SPACE_ID })).toEqual({
      ok: false,
      reason: 'space-access-denied',
      detail: 'no access',
    });
    // Short-circuited: the scripts request never left, the entry stays (local-first)
    expect(fetchMock.mock.calls.filter(([u]) => u === scriptsUrl)).toHaveLength(0);
    expect((await syncConfigItem.getValue()).spaces).toHaveLength(1);
  });

  it('key spaces make no extra get_space round trip on listScripts (byte-identical legacy path)', async () => {
    await configured();
    const spaceUrl = `${SERVER}/api/spaces/${SPACE_ID}`;
    const fetchMock = noneProbe((url) => (url === `${spaceUrl}/scripts` ? ok([]) : noContent()));
    expect((await handleSyncMessage({ type: 'sp:syncListScripts', spaceId: SPACE_ID }))?.ok).toBe(true);
    expect(fetchMock.mock.calls.filter(([u]) => u === spaceUrl)).toHaveLength(0);
  });

  it('org-bound space operations omit the X-Space-Key header (membership is the credential)', async () => {
    await orgConfigured('admin');
    await seedSession();
    const fetchMock = wpProbe((url) => (url === `${SERVER}/api/spaces/${SPACE_ID}` ? noContent() : noContent()));
    expect((await handleSyncMessage({ type: 'sp:syncDeleteSpace', spaceId: SPACE_ID }))?.ok).toBe(true);
    const del = fetchMock.mock.calls.find(([u]) => String(u) === `${SERVER}/api/spaces/${SPACE_ID}`)!;
    const delHeaders = (del[1] as RequestInit).headers as Record<string, string>;
    expect(delHeaders['X-Space-Key']).toBeUndefined();
    expect(delHeaders['Authorization']).toBe('Bearer at-1');
  });

  it('member surface guards: key spaces refuse locally, unknown spaces stay space-not-known', async () => {
    await configured();
    const messages: ExtensionMessage[] = [
      { type: 'sp:syncIssueInvite', spaceId: SPACE_ID },
      { type: 'sp:syncListMembers', spaceId: SPACE_ID },
      { type: 'sp:syncUpdateMemberRole', spaceId: SPACE_ID, userId: OTHER_USER, role: 'admin' },
      { type: 'sp:syncRemoveMember', spaceId: SPACE_ID, userId: OTHER_USER },
      { type: 'sp:syncTransferOwnership', spaceId: SPACE_ID, userId: OTHER_USER },
    ];
    const fetchMock = mockFetch(() => {
      throw new Error('key spaces must not reach the member endpoints');
    });
    for (const msg of messages) {
      const res = await handleSyncMessage(msg);
      expect(res?.ok).toBe(false);
      // A dedicated reason (not invalid-input + a server-style English detail) — the view
      // layer localizes it instead of bypassing i18n
      expect(res?.reason).toBe('space-key-unsupported');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await handleSyncMessage({ type: 'sp:syncListMembers', spaceId: 'sp-unknown000000001' }))?.reason).toBe(
      'space-not-known',
    );
  });

  it('the member guard rejects owner as a settable role before any traffic', () => {
    const bad = { type: 'sp:syncUpdateMemberRole', spaceId: SPACE_ID, userId: OTHER_USER, role: 'owner' };
    expect(isExtensionMessage(bad)).toBe(false);
  });

  it('the member guard rejects transfer to an empty id but keeps removeMember self-exit', () => {
    // userId '' means self-exit on removeMember only; transfer always targets a concrete id
    expect(isExtensionMessage({ type: 'sp:syncTransferOwnership', spaceId: SPACE_ID, userId: '' })).toBe(false);
    expect(isExtensionMessage({ type: 'sp:syncRemoveMember', spaceId: SPACE_ID, userId: '' })).toBe(true);
  });

  it('issueInvite surfaces the one-time code exactly once and never persists it', async () => {
    await orgConfigured('admin');
    await seedSession();
    const wire = { spaceId: SPACE_ID, code: `${SPACE_ID}#iv-${INVITE_SECRET}`, createdAt: 't', expiresAt: 't2' };
    wpProbe((url) => (url === `${SERVER}/api/spaces/${SPACE_ID}/invites` ? ok(wire, 201) : noContent()));
    const res = await handleSyncMessage({ type: 'sp:syncIssueInvite', spaceId: SPACE_ID });
    expect(res).toEqual({ ok: true, invite: { code: wire.code, expiresAt: 't2' } });
    // Nothing invite-shaped may land anywhere local
    expect(JSON.stringify(await syncConfigItem.getValue())).not.toContain(INVITE_SECRET);
  });

  it('listMembers re-decides the caller identity first, maps rows, flags truncation and rides the bearer', async () => {
    // The entry's stored role is 'admin' but the server says 'owner' — the response (and the
    // stored entry) must follow the server, since the view marks its own row on these facts
    await orgConfigured('admin');
    await seedSession();
    const membersUrl = `${SERVER}/api/spaces/${SPACE_ID}/members`;
    const spaceUrl = `${SERVER}/api/spaces/${SPACE_ID}`;
    const fetchMock = wpProbe((url) =>
      String(url).startsWith(membersUrl)
        ? ok({
            items: [
              { userId: MY_USER, nickname: 'Me', role: 'owner', isOwner: true, joinedAt: 'j1' },
              { userId: OTHER_USER, role: 'member', isOwner: false },
            ],
            page: 1,
            pageSize: 100,
            total: 101,
          })
        : url === spaceUrl
          ? ok({ id: SPACE_ID, name: 'Team Space', createdAt: 't', myRole: 'owner', myUserId: MY_USER })
          : noContent(),
    );
    const res = await handleSyncMessage({ type: 'sp:syncListMembers', spaceId: SPACE_ID });
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      expect(res.members).toEqual([
        { userId: MY_USER, email: null, nickname: 'Me', role: 'owner', isOwner: true, joinedAt: 'j1' },
        { userId: OTHER_USER, email: null, nickname: null, role: 'member', isOwner: false, joinedAt: null },
      ]);
      expect(res.membersTruncated).toBe(true);
      expect(res.myRole).toBe('owner');
      expect(res.myUserId).toBe(MY_USER);
    }
    expect((await syncConfigItem.getValue()).spaces[0]?.myRole).toBe('owner');
    const call = fetchMock.mock.calls.find(([u]) => String(u) === `${membersUrl}?page=1&pageSize=100`)!;
    expect((call[1]!.headers as Record<string, string>)['Authorization']).toBe('Bearer at-1');
  });

  it('role changes / removal / transfer return ok and leave member facts to the refreshed list', async () => {
    await orgConfigured('owner');
    await seedSession();
    const membersUrl = `${SERVER}/api/spaces/${SPACE_ID}/members`;
    const fetchMock = wpProbe((url, init) =>
      url === `${membersUrl}/${OTHER_USER}` && init.method === 'PATCH'
        ? ok({ userId: OTHER_USER, role: 'admin', isOwner: false })
        : url === `${membersUrl}/${OTHER_USER}`
          ? noContent()
          : url === `${SERVER}/api/spaces/${SPACE_ID}/ownership`
            ? ok({ userId: OTHER_USER, role: 'owner', isOwner: true })
            : noContent(),
    );
    expect(
      (await handleSyncMessage({ type: 'sp:syncUpdateMemberRole', spaceId: SPACE_ID, userId: OTHER_USER, role: 'admin' }))?.ok,
    ).toBe(true);
    expect(
      JSON.parse(
        String(fetchMock.mock.calls.find(([u]) => String(u) === `${membersUrl}/${OTHER_USER}`)![1]!.body),
      ),
    ).toEqual({
      role: 'admin',
    });
    expect((await handleSyncMessage({ type: 'sp:syncRemoveMember', spaceId: SPACE_ID, userId: OTHER_USER }))?.ok).toBe(true);
    expect((await handleSyncMessage({ type: 'sp:syncTransferOwnership', spaceId: SPACE_ID, userId: OTHER_USER }))?.ok).toBe(true);
    expect(JSON.parse(String(fetchMock.mock.calls.find(([u]) => String(u).endsWith('/ownership'))![1]!.body))).toEqual({
      userId: OTHER_USER,
    });
    // No member facts were cached locally — the list is always a fresh fetch
    expect(JSON.stringify(await syncConfigItem.getValue())).not.toContain(OTHER_USER);
  });

  it('a successful ownership transfer demotes the stored role from owner to admin', async () => {
    // The panel status reads the STORED role; without the write-back the ex-owner keeps
    // owner-gated UI until the next scripts-view refresh and every click answers 403
    await orgConfigured('owner');
    await seedSession();
    wpProbe((url) => (url === `${SERVER}/api/spaces/${SPACE_ID}/ownership` ? noContent() : noContent()));
    expect((await handleSyncMessage({ type: 'sp:syncTransferOwnership', spaceId: SPACE_ID, userId: OTHER_USER }))?.ok).toBe(true);
    expect((await syncConfigItem.getValue()).spaces[0]?.myRole).toBe('admin');
  });

  it('leave (userId "") always re-resolves the caller id from the server and clears the stale role facts', async () => {
    // The entry's myUserId can belong to a previous account on this device — trusting it
    // would remove THAT user's membership instead of the caller's
    await orgConfigured('member', true);
    await seedSession();
    const spaceUrl = `${SERVER}/api/spaces/${SPACE_ID}`;
    const removeUrl = `${SERVER}/api/spaces/${SPACE_ID}/members/${MY_USER}`;
    const fetchMock = wpProbe((url) =>
      url === spaceUrl ? ok({ id: SPACE_ID, name: 'Team Space', createdAt: 't', myRole: 'member', myUserId: MY_USER }) : noContent(),
    );
    expect((await handleSyncMessage({ type: 'sp:syncRemoveMember', spaceId: SPACE_ID, userId: '' }))?.ok).toBe(true);
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === spaceUrl)).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === removeUrl)).toHaveLength(1);
    // Local-first: leaving never deletes the local entry, but the role facts are dropped so
    // the spaces list stops rendering member/manager UI for a membership that no longer exists
    const spaces = (await syncConfigItem.getValue()).spaces;
    expect(spaces).toHaveLength(1);
    expect(spaces[0]?.myRole).toBeUndefined();
    expect(spaces[0]?.myUserId).toBeUndefined();

    // A pre-refresh entry without myUserId: the id is fetched inside the same run, then removed
    await orgConfigured('member', false);
    const fetchMock2 = wpProbe((url) =>
      url === spaceUrl ? ok({ id: SPACE_ID, name: 'Team Space', createdAt: 't', myRole: 'member', myUserId: MY_USER }) : noContent(),
    );
    expect((await handleSyncMessage({ type: 'sp:syncRemoveMember', spaceId: SPACE_ID, userId: '' }))?.ok).toBe(true);
    expect(fetchMock2.mock.calls.filter(([u]) => String(u) === removeUrl)).toHaveLength(1);
  });

  it('a member mutation that times out after dispatch surfaces operation-uncertain (check, never auto-replay)', async () => {
    await orgConfigured('admin');
    await seedSession();
    mockFetch((url) => {
      if (url === CONFIG_URL) return ok({ enabled: true, loginUrl: '/api/auth/oauth/start', workspacePermissions: true });
      throw new DOMException('aborted', 'TimeoutError');
    });
    expect(await handleSyncMessage({ type: 'sp:syncRemoveMember', spaceId: SPACE_ID, userId: OTHER_USER })).toEqual({
      ok: false,
      reason: 'operation-uncertain',
    });
  });
});
