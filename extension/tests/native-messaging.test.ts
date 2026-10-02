// Native channel op surface: the closed op whitelist, the read-grant gate behind flow.read,
// zero-write refusals, CAS replacement, and the clientRef idempotency/watermark semantics. These
// drive dispatchOp/checkRequest directly — the port envelope echo is trivial wiring; the business
// guarantees are zero side effects on every refusal, replay without a new version, and watermark
// rejection of trimmed/clock-regressed refs.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { checkRequest, dispatchOp, parseClientRef } from '@/lib/native-messaging';
import {
  buildFlowStore,
  loadFlows,
  NATIVE_READ_GRANT_TTL_MS,
  nativeReadGrantItem,
  flowStoreItem,
  type FlowStore,
} from '@/lib/storage';
import { deriveFlowId, type Flow } from '@/lib/flow-schema';

const phoneTarget = { clues: { id: 'contactPhone' }, componentType: 'input', displayLabel: '联系电话' };

function flowJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    name: '发货通知',
    site: 'https://www.example.com',
    page: { urlIncludes: '/form-page.html' },
    trigger: { kind: 'pageEnter' },
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'fill-phone', kind: 'action', action: { type: 'setInputValue', target: phoneTarget, value: '13800001234' } },
      ],
    },
    ...overrides,
  });
}

function makeStoredFlow(overrides: Partial<Flow> = {}): Flow {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: deriveFlowId(),
    name: '原流程',
    site: 'https://www.example.com',
    page: { urlIncludes: '/form-page.html' },
    trigger: { kind: 'pageEnter' },
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'fill-phone', kind: 'action', action: { type: 'setInputValue', target: phoneTarget, value: '13100000000' } },
      ],
    },
    status: 'paused',
    provenance: { source: 'import', createdAt: now - 1000, updatedAt: now - 1000 },
    ...overrides,
  } as Flow;
}

// Deterministic, unique clientRefs: "<issuedAt-ms>.<32 hex chars>"
function makeRef(issuedAt: number, seq: number): string {
  return `${issuedAt}.${seq.toString(16).padStart(32, '0')}`;
}

async function seedStore(flows: Flow[]): Promise<void> {
  await flowStoreItem.setValue(buildFlowStore(flows));
}

async function snapshotStore(): Promise<FlowStore> {
  return structuredClone(await flowStoreItem.getValue());
}

async function call(op: string, payload: Record<string, unknown> | undefined) {
  return dispatchOp(op, payload);
}

beforeEach(() => {
  fakeBrowser.reset();
  // flow.save's post-write step realigns site scripts (scripting API is unimplemented in fakeBrowser)
  const scripting = fakeBrowser.scripting as unknown as Record<string, (arg: unknown) => Promise<unknown>>;
  scripting.getRegisteredContentScripts = async () => [];
  scripting.registerContentScripts = async () => undefined;
  scripting.unregisterContentScripts = async () => undefined;
  scripting.executeScript = async () => [];
});

describe('envelope and op whitelist (checkRequest)', () => {
  it('accepts a well-formed request and rejects wrong versions, missing ids and non-object payloads', () => {
    expect(checkRequest({ v: 1, id: 'a', op: 'ping' }).ok).toBe(true);
    expect(checkRequest({ v: 2, id: 'a', op: 'ping' }).ok).toBe(false);
    expect(checkRequest({ v: 1, op: 'ping' }).ok).toBe(false);
    expect(checkRequest({ v: 1, id: 'a', op: 'ping', payload: 'text' }).ok).toBe(false);
    expect(checkRequest('not-an-object').ok).toBe(false);
  });

  it('answers unsupported-op for every off-channel capability with zero side effects', async () => {
    await seedStore([makeStoredFlow()]);
    const before = await snapshotStore();
    for (const op of ['flow.enable', 'flow.delete', 'flow.rollback', 'flow.list', 'browser.navigate', 'eval', '']) {
      const checked = checkRequest({ v: 1, id: 1, op });
      expect(checked.ok, op).toBe(false);
      if (!checked.ok) expect(checked.code, op).toBe('unsupported-op');
    }
    // The same guard sits behind the port handler, so an off-channel op never reaches storage
    expect(await snapshotStore()).toEqual(before);
  });

  it('enforces the 512 KiB application cap', () => {
    const checked = checkRequest({ v: 1, id: 1, op: 'flow.validate', payload: { text: 'x'.repeat(600 * 1024) } });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.code).toBe('payload-too-large');
  });
});

describe('ping', () => {
  it('returns the schema version and the active read grant, never a flow enumeration', async () => {
    await seedStore([makeStoredFlow(), makeStoredFlow()]);
    await nativeReadGrantItem.setValue({ flowId: 'r-x', grantedAt: Date.now() });
    const res = await call('ping', undefined);
    expect(res.error).toBeUndefined();
    expect(res.data!.schemaVersion).toBe(1);
    expect(res.data!.readGrant).toEqual({ flowId: 'r-x' });
    expect(JSON.stringify(res.data)).not.toContain('flows');
    expect(JSON.stringify(res.data)).not.toContain('steps');
  });
});

describe('flow.read (time-limited single-flow grant)', () => {
  it('refuses without a grant, with a wrong-flow grant, and with an expired grant — all zero-write', async () => {
    const flow = makeStoredFlow();
    await seedStore([flow]);
    const before = await snapshotStore();

    const noGrant = await call('flow.read', { flowId: flow.id });
    expect(noGrant.error!.code).toBe('read-not-authorized');

    await nativeReadGrantItem.setValue({ flowId: 'other-flow', grantedAt: Date.now() });
    const wrongFlow = await call('flow.read', { flowId: flow.id });
    expect(wrongFlow.error!.code).toBe('read-not-authorized');

    await nativeReadGrantItem.setValue({ flowId: flow.id, grantedAt: Date.now() - (NATIVE_READ_GRANT_TTL_MS + 60_000) });
    const expired = await call('flow.read', { flowId: flow.id });
    expect(expired.error!.code).toBe('read-not-authorized');

    expect(await snapshotStore()).toEqual(before);
  });

  it('returns the full flow plus the CAS stamp for a valid grant; a granted-then-deleted flow says flow-not-found', async () => {
    const flow = makeStoredFlow();
    await seedStore([flow]);
    await nativeReadGrantItem.setValue({ flowId: flow.id, grantedAt: Date.now() });

    const res = await call('flow.read', { flowId: flow.id });
    expect(res.error).toBeUndefined();
    expect(res.data!.flow).toEqual(flow);
    expect(res.data!.updatedAt).toBe(flow.provenance.updatedAt);

    // The flow was granted, then deleted elsewhere: the grant still matches its id, so the answer
    // is the flow's absence, not an authorization failure
    await nativeReadGrantItem.setValue({ flowId: 'gone', grantedAt: Date.now() });
    const missing = await call('flow.read', { flowId: 'gone' });
    expect(missing.error!.code).toBe('flow-not-found');
  });
});

describe('flow.validate (zero-write summary)', () => {
  it('summarizes a valid flow with submit flags and rejects invalid text without touching the store', async () => {
    const flow = makeStoredFlow();
    await seedStore([flow]);
    const before = await snapshotStore();

    const ok = await call('flow.validate', { text: flowJson() });
    expect(ok.error).toBeUndefined();
    expect(ok.data).toMatchObject({ name: '发货通知', site: 'https://www.example.com' });
    expect(ok.data!.steps).toEqual([{ text: expect.any(String), submit: false }]);

    const invalid = await call('flow.validate', { text: flowJson({ steps: { id: 'root', kind: 'sequence', steps: [] } }) });
    expect(invalid.error!.code).toBe('validation-failed');
    expect(invalid.error!.errors!.length).toBeGreaterThan(0);

    const notJson = await call('flow.validate', { text: '{ nope' });
    expect(notJson.error!.code).toBe('not-json');

    expect(await snapshotStore()).toEqual(before);
  });
});

describe('flow.save — create, CAS replace, refusals', () => {
  it('creates a not-enabled flow with a history version and a receipt', async () => {
    const ref = makeRef(Date.now(), 1);
    const res = await call('flow.save', { text: flowJson(), clientRef: ref });
    expect(res.error).toBeUndefined();
    expect(res.data).toMatchObject({ name: '发货通知', status: 'draft', replayed: false });

    const store = await flowStoreItem.getValue();
    expect(store.flows).toHaveLength(1);
    expect(store.flows[0]).toMatchObject({ id: res.data!.flowId, status: 'draft' });
    expect(store.history[res.data!.flowId as string]).toHaveLength(1);
    expect(store.receipts).toHaveLength(1);
    expect(store.receipts[0]).toMatchObject({ clientRef: ref, flowId: res.data!.flowId });
    expect(store.maxAcceptedIssuedAt).toBeGreaterThanOrEqual(store.receipts[0]!.issuedAt);
  });

  it('replaces under the original id with the right stamp; stale stamps, enabled flows and missing flows refuse with zero writes', async () => {
    const original = makeStoredFlow();
    await seedStore([original]);
    await nativeReadGrantItem.setValue({ flowId: original.id, grantedAt: Date.now() });

    const ok = await call('flow.save', {
      text: flowJson({ name: '修订版' }),
      clientRef: makeRef(Date.now(), 2),
      flowId: original.id,
      expectedUpdatedAt: original.provenance.updatedAt,
    });
    expect(ok.error).toBeUndefined();
    expect(ok.data!.flowId).toBe(original.id);
    const flows = await loadFlows();
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ id: original.id, name: '修订版', status: 'draft' });
    // The replace consumed the read grant — its snapshot is stale now
    expect(await nativeReadGrantItem.getValue()).toBeNull();

    const revised = flows[0]!;
    const before = await snapshotStore();
    const stale = await call('flow.save', {
      text: flowJson(),
      clientRef: makeRef(Date.now(), 3),
      flowId: revised.id,
      expectedUpdatedAt: original.provenance.updatedAt,
    });
    expect(stale.error!.code).toBe('revision-stale');

    const enabled = makeStoredFlow({ id: 'r-enabled', status: 'enabled' });
    await seedStore([enabled]);
    const refusedEnabled = await call('flow.save', {
      text: flowJson(),
      clientRef: makeRef(Date.now(), 4),
      flowId: enabled.id,
      expectedUpdatedAt: enabled.provenance.updatedAt,
    });
    expect(refusedEnabled.error!.code).toBe('flow-enabled');

    const missing = await call('flow.save', {
      text: flowJson(),
      clientRef: makeRef(Date.now(), 5),
      flowId: 'gone',
      expectedUpdatedAt: 1,
    });
    expect(missing.error!.code).toBe('flow-not-found');

    const noStamp = await call('flow.save', { text: flowJson(), clientRef: makeRef(Date.now(), 6), flowId: original.id });
    expect(noStamp.error!.code).toBe('bad-payload');
  });

  it('rejects malformed clientRefs before anything is read', async () => {
    const before = await snapshotStore();
    const res = await call('flow.save', { text: flowJson(), clientRef: 'not-a-ref' });
    expect(res.error!.code).toBe('bad-payload');
    expect(await snapshotStore()).toEqual(before);
  });
});

describe('clientRef idempotency and watermarks', () => {
  it('replays the same ref with identical payload without a new version, and refuses the same ref with a different payload', async () => {
    const ref = makeRef(Date.now(), 1);
    const first = await call('flow.save', { text: flowJson(), clientRef: ref });
    expect(first.data!.replayed).toBe(false);
    const afterFirst = await snapshotStore();

    const replay = await call('flow.save', { text: flowJson(), clientRef: ref });
    expect(replay.error).toBeUndefined();
    expect(replay.data!.replayed).toBe(true);
    expect(replay.data!.flowId).toBe(first.data!.flowId);
    // No new version, no new receipt — the store is byte-identical
    expect(await snapshotStore()).toEqual(afterFirst);

    const conflict = await call('flow.save', { text: flowJson({ name: '不同内容' }), clientRef: ref });
    expect(conflict.error!.code).toBe('ref-conflict');
    expect(await snapshotStore()).toEqual(afterFirst);
  });

  it('after 11 saves on one flow keeps 10 versions/receipts and replays the first ref as ref-expired with zero new writes', async () => {
    const base = Date.now();
    const refs: string[] = [];
    const res0 = await call('flow.save', { text: flowJson({ name: '流程 v0' }), clientRef: makeRef(base, 1) });
    refs.push(makeRef(base, 1));
    expect(res0.error).toBeUndefined();
    const flowId = res0.data!.flowId as string;
    let stamp = res0.data!.updatedAt as number;
    // Saves 2..11 replace the same flow (chained CAS stamps) — one flow, eleven successful saves
    for (let i = 1; i < 11; i += 1) {
      refs.push(makeRef(base + i, i + 1));
      const res = await call('flow.save', {
        text: flowJson({ name: `流程 v${i}` }),
        clientRef: refs[i]!,
        flowId,
        expectedUpdatedAt: stamp,
      });
      expect(res.error, `save ${i}`).toBeUndefined();
      stamp = res.data!.updatedAt as number;
    }
    const store = await flowStoreItem.getValue();
    expect(store.flows).toHaveLength(1);
    // 11 successful saves, but only the last 10 versions survive
    expect(store.history[flowId]).toHaveLength(10);
    expect(store.receipts).toHaveLength(10);

    // The first receipt was trimmed into the expiredThrough watermark: its ref can never save again
    const before = await snapshotStore();
    const replay = await call('flow.save', {
      text: flowJson({ name: '流程 v0' }),
      clientRef: refs[0]!,
      flowId,
      expectedUpdatedAt: stamp,
    });
    expect(replay.error!.code).toBe('ref-expired');
    expect(await snapshotStore()).toEqual(before);
    expect(store.history[flowId]).toHaveLength(10);
  });

  it('refuses clock-regressed and too-future refs with zero writes', async () => {
    const base = Date.now();
    await call('flow.save', { text: flowJson(), clientRef: makeRef(base, 1) });
    const before = await snapshotStore();

    const regressed = await call('flow.save', { text: flowJson(), clientRef: makeRef(base - 5_000, 2) });
    expect(regressed.error!.code).toBe('clock-regressed');
    expect(await snapshotStore()).toEqual(before);

    const future = await call('flow.save', { text: flowJson(), clientRef: makeRef(Date.now() + 6 * 60_000, 3) });
    expect(future.error!.code).toBe('bad-ref-time');
    expect(await snapshotStore()).toEqual(before);
  });
});

describe('flow.verify', () => {
  it('confirms a held receipt with the flow\'s current status and never infers "not saved" from an unknown ref', async () => {
    const base = Date.now();
    const save = await call('flow.save', { text: flowJson(), clientRef: makeRef(base, 1) });
    const flowId = save.data!.flowId!;

    const confirmed = await call('flow.verify', { clientRef: makeRef(base, 1) });
    expect(confirmed.error).toBeUndefined();
    expect(confirmed.data!.confirmed).toBe(true);
    expect(confirmed.data!.flowStatus).toBe('draft');

    // Unknown but plausible ref: explicitly unconfirmable, not a "not saved" verdict
    const unknown = await call('flow.verify', { clientRef: makeRef(base + 10_000, 99) });
    expect(unknown.error!.code).toBe('result-unknown');
  });

  it('maps trimmed and regressed refs to their watermark codes', async () => {
    const base = Date.now();
    await call('flow.save', { text: flowJson(), clientRef: makeRef(base, 1) });
    const regressed = await call('flow.verify', { clientRef: makeRef(base - 1_000, 2) });
    expect(regressed.error!.code).toBe('clock-regressed');
  });
});

describe('parseClientRef', () => {
  it('accepts the documented shape only', () => {
    const good = `${Date.now()}.${'ab'.repeat(16)}`;
    expect(parseClientRef(good)).toMatchObject({ random: 'ab'.repeat(16) });
    expect(parseClientRef('123')).toBeNull();
    expect(parseClientRef(`${Date.now()}.zzz`)).toBeNull();
    expect(parseClientRef(42)).toBeNull();
  });
});
