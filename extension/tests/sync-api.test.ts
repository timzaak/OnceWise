// Sync HTTP client (lib/sync-api.ts) at the fetch boundary with a mocked global fetch: error
// classification (unreachable / unauthorized / unified error body / non-JSON fallback), request
// construction (method, path join, X-Space-Key header, camelCase body, bodyless DELETE), the
// space-code format helpers (single source for `<id>#<key>`) and the server-address normalization
// used by the configure flow.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/sync-api';
import { jsonResponse, recordingFetch, type Recorded } from './fetch-recorder';

const SERVER = 'http://127.0.0.1:8080';
const KEY = 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk';

let calls: Recorded[];

// The handler sees only the URL (sync-api request construction is asserted through the recording)
function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', recordingFetch(calls, handler));
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('error classification', () => {
  it('a network-layer failure (refused connection / missing host permission) maps to unreachable', async () => {
    mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const res = await api.getSpace(SERVER, 'sp-test000000000001', KEY);
    expect(res).toEqual({ ok: false, error: { kind: 'unreachable' } });
  });

  it('a fetch timeout abort after dispatch is classified as timeout(sent) — never plain unreachable, a write outcome is unknown', async () => {
    mockFetch(() => Promise.reject(new DOMException('aborted', 'TimeoutError')));
    const res = await api.getHealth(SERVER);
    expect(res).toEqual({ ok: false, error: { kind: 'timeout', sent: true } });
    // Reads still surface as the retryable 'unreachable' reason; writers upgrade to operation-uncertain
    expect(api.syncErrorToReason((res as { ok: false; error: api.SyncApiError }).error).reason).toBe('unreachable');
  });

  it('401 splits by error code: AUTH_REQUIRED is the sign-in gate, everything else (incl. old servers with no code) stays unauthorized', async () => {
    mockFetch(() => jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: 'Sign in to use this server' } }));
    const res = await api.getSpace(SERVER, 'sp-test000000000001', KEY);
    expect(res).toEqual({ ok: false, error: { kind: 'auth-required' } });

    mockFetch(() => jsonResponse(401, { error: { code: 'BAD_SPACE_KEY', message: 'The space key was rejected for this space' } }));
    expect(await api.getSpace(SERVER, 'sp-test000000000001', KEY)).toEqual({ ok: false, error: { kind: 'unauthorized' } });

    // A pre-auth server's bare 401 (no unified body) must keep the original classification
    mockFetch(() => new Response('Nope', { status: 401 }));
    expect(await api.getSpace(SERVER, 'sp-test000000000001', KEY)).toEqual({ ok: false, error: { kind: 'unauthorized' } });
  });

  it('the unified error body {"error":{code,message}} is parsed and carried through', async () => {
    mockFetch(() => jsonResponse(409, { error: { code: 'SCRIPT_EXISTS', message: 'A script with this id already exists' } }));
    const res = await api.createScript(SERVER, KEY, 'sp-test000000000001', {
      id: 'sc-test000000000001',
      name: 's',
      note: '',
      versionNote: '',
      flowContent: {},
    });
    expect(res).toEqual({
      ok: false,
      error: { kind: 'http', status: 409, code: 'SCRIPT_EXISTS', message: 'A script with this id already exists' },
    });
  });

  it('a non-JSON error body falls back to HTTP <status> instead of throwing', async () => {
    mockFetch(() => new Response('Bad Gateway', { status: 502 }));
    const res = await api.listScripts(SERVER, KEY, 'sp-test000000000001');
    expect(res).toEqual({ ok: false, error: { kind: 'http', status: 502, code: 'UNKNOWN', message: 'HTTP 502' } });
  });

  it('a JSON body without the error envelope also falls back', async () => {
    mockFetch(() => jsonResponse(500, { unrelated: true }));
    const res = await api.listScriptVersions(SERVER, KEY, 'sp-test000000000001', 'sc-test000000000001');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toEqual({ kind: 'http', status: 500, code: 'UNKNOWN', message: 'HTTP 500' });
  });
});

describe('request construction', () => {
  it('space registration posts path + JSON body + Content-Type, with no key header', async () => {
    mockFetch(() => jsonResponse(201, { id: 'sp-test000000000001', name: 'Team', createdAt: 't' }));
    const res = await api.createSpace(SERVER, { id: 'sp-test000000000001', key: KEY, name: 'Team' });
    expect(res.ok).toBe(true);
    expect(calls[0]!.url).toBe(`${SERVER}/api/spaces`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(calls[0]!.headers['X-Space-Key']).toBeUndefined();
    expect(JSON.parse(calls[0]!.body!)).toEqual({ id: 'sp-test000000000001', key: KEY, name: 'Team' });
  });

  it('space-scoped GET carries the X-Space-Key header and no body', async () => {
    mockFetch(() => jsonResponse(200, []));
    const res = await api.listScripts(SERVER, KEY, 'sp-test000000000001');
    expect(res.ok).toBe(true);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['X-Space-Key']).toBe(KEY);
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers['Content-Type']).toBeUndefined();
    expect(calls[0]!.url).toBe(`${SERVER}/api/spaces/sp-test000000000001/scripts`);
  });

  it('bodyless DELETE sends neither a body nor Content-Type', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    expect((await api.deleteSpace(SERVER, 'sp-test000000000001', KEY)).ok).toBe(true);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers['Content-Type']).toBeUndefined();
  });

  it('script create posts camelCase fields with the client id and flowContent object as-is', async () => {
    mockFetch(() =>
      jsonResponse(201, {
        id: 'sc-test000000000001', name: 's', note: '', latestVersionNumber: 1, latestVersionNote: '',
        updatedAt: '2026-09-25T08:30:00.123Z',
      }),
    );
    const flowContent = { schemaVersion: 1, id: 'r1', status: 'draft' };
    const res = await api.createScript(SERVER, KEY, 'sp-test000000000001', {
      id: 'sc-test000000000001',
      name: 'Ship helper',
      note: 'note',
      versionNote: 'v1',
      flowContent,
    });
    expect(res.ok).toBe(true);
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['flowContent', 'id', 'name', 'note', 'versionNote']);
    expect(body['flowContent']).toEqual(flowContent);
    expect(calls[0]!.url).toBe(`${SERVER}/api/spaces/sp-test000000000001/scripts`);
  });

  it('path parameters are interpolated (script version endpoints)', async () => {
    mockFetch(() => jsonResponse(200, { versionNumber: 2, note: '', createdAt: 't', flowContent: {} }));
    await api.getScriptVersion(SERVER, KEY, 'sp-test000000000001', 'sc-test000000000001', 3);
    expect(calls[0]!.url).toBe(`${SERVER}/api/spaces/sp-test000000000001/scripts/sc-test000000000001/versions/3`);
  });
});

describe('space code format (single source for `<id>#<key>`)', () => {
  it('round-trips codes produced by the generators', () => {
    for (let i = 0; i < 20; i++) {
      const id = api.generateSpaceId();
      const key = api.generateSpaceKey();
      expect(id).toMatch(/^sp-[A-Za-z0-9]{16}$/);
      expect(key).toMatch(/^[A-Za-z0-9]{32}$/);
      const code = api.spaceCodeOf(id, key);
      expect(api.parseSpaceCode(code)).toEqual({ id, key });
    }
  });

  it('rejects malformed codes instead of guessing', () => {
    const good = api.spaceCodeOf('sp-abcdefghijklmnop', KEY);
    for (const bad of [
      '',
      'nonsense',
      good.replace('#', '@'),
      `sp-short#${KEY}`,
      `${good}#extra`,
      `sp-abcdefghijklmnop#${KEY}#tail`,
    ]) {
      expect(api.parseSpaceCode(bad)).toBeNull();
    }
  });
});

describe('server address normalization (configure flow input)', () => {
  it('defaults to https, strips path/query and keeps the origin only', () => {
    expect(api.normalizeServerUrl('sync.example.com')).toBe('https://sync.example.com');
    expect(api.normalizeServerUrl('https://sync.example.com/')).toBe('https://sync.example.com');
    expect(api.normalizeServerUrl('http://192.168.1.5:8080/some/path?x=1')).toBe('http://192.168.1.5:8080');
  });

  it('rejects empty and non-http(s) input', () => {
    expect(api.normalizeServerUrl('')).toBeNull();
    expect(api.normalizeServerUrl('ftp://example.com')).toBeNull();
    expect(api.normalizeServerUrl('not a url ://')).toBeNull();
  });
});

describe('machine-code → reason mapping', () => {
  it('maps server codes to the kebab-case reason vocabulary with the message as detail', () => {
    expect(api.syncErrorToReason({ kind: 'http', status: 400, code: 'INVALID_INPUT', message: 'name: too long' })).toEqual({
      reason: 'invalid-input',
      detail: 'name: too long',
    });
    expect(api.syncErrorToReason({ kind: 'http', status: 404, code: 'SPACE_NOT_FOUND', message: 'x' }).reason).toBe('space-not-found');
    expect(api.syncErrorToReason({ kind: 'http', status: 409, code: 'SCRIPT_EXISTS', message: 'x' }).reason).toBe('script-exists');
    expect(api.syncErrorToReason({ kind: 'unreachable' })).toEqual({ reason: 'unreachable' });
    expect(api.syncErrorToReason({ kind: 'unauthorized' })).toEqual({ reason: 'bad-space-key' });
    expect(api.syncErrorToReason({ kind: 'auth-required' })).toEqual({ reason: 'sign-in-required' });
    // unknown future codes stay readable via the generic transform
    expect(api.syncErrorToReason({ kind: 'http', status: 418, code: 'SOME_NEW_CODE', message: 'x' }).reason).toBe('some-new-code');
  });
});

describe('auth endpoints and bearer construction', () => {
  it('a bearer token rides the Authorization header; none-mode sends no header', async () => {
    mockFetch(() => jsonResponse(200, { id: 'sp-test000000000001', name: 'n', createdAt: 't' }));
    await api.getSpace(SERVER, 'sp-test000000000001', KEY, { bearer: 'at-1' });
    expect(calls[0]!.headers['Authorization']).toBe('Bearer at-1');
    expect(calls[0]!.headers['X-Space-Key']).toBe(KEY);
    await api.getSpace(SERVER, 'sp-test000000000001', KEY);
    expect(calls[1]!.headers['Authorization']).toBeUndefined();
    await api.getSpace(SERVER, 'sp-test000000000001', KEY, { bearer: null });
    expect(calls[2]!.headers['Authorization']).toBeUndefined();
  });

  it('getAuthConfig hits the public config endpoint with no credentials', async () => {
    mockFetch(() => jsonResponse(200, { enabled: true, loginUrl: '/api/auth/oauth/start' }));
    const res = await api.getAuthConfig(SERVER);
    expect(res).toEqual({ ok: true, data: { enabled: true, loginUrl: '/api/auth/oauth/start' } });
    expect(calls[0]!.url).toBe(`${SERVER}/api/auth/config`);
    expect(calls[0]!.headers['Authorization']).toBeUndefined();
    expect(calls[0]!.headers['X-Space-Key']).toBeUndefined();
  });

  it('redeem POSTs {handoffCode, handoffVerifier} — the verifier is in the body, never in the URL', async () => {
    mockFetch(() =>
      jsonResponse(200, { accessToken: 'at-9', refreshToken: 'rt-9', expiresIn: 60, refreshExpiresIn: 600, tokenType: 'Bearer' }),
    );
    const verifier = 'v'.repeat(43);
    const res = await api.redeemToken(SERVER, { handoffCode: 'c'.repeat(43), handoffVerifier: verifier });
    expect(res.ok).toBe(true);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${SERVER}/api/auth/redeem`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ handoffCode: 'c'.repeat(43), handoffVerifier: verifier });
    expect(calls[0]!.url).not.toContain(verifier);
    expect(calls[0]!.url).not.toContain('at-9');
  });

  it('refresh POSTs {refreshToken} — same body-only rule for the rotating credential', async () => {
    mockFetch(() =>
      jsonResponse(200, { accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 60, refreshExpiresIn: 600, tokenType: 'Bearer' }),
    );
    const res = await api.refreshToken(SERVER, 'rt-1');
    expect(res.ok).toBe(true);
    expect(calls[0]!.url).toBe(`${SERVER}/api/auth/refresh`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ refreshToken: 'rt-1' });
    expect(calls[0]!.url).not.toContain('rt-1');
  });

  it('503 AUTH_UNAVAILABLE carries the machine code through for auth-unavailable mapping', async () => {
    mockFetch(() => jsonResponse(503, { error: { code: 'AUTH_UNAVAILABLE', message: 'Herald is unreachable' } }));
    const res = await api.listScripts(SERVER, KEY, 'sp-test000000000001');
    expect(res).toEqual({
      ok: false,
      error: { kind: 'http', status: 503, code: 'AUTH_UNAVAILABLE', message: 'Herald is unreachable' },
    });
    expect(api.syncErrorToReason((res as { ok: false; error: api.SyncApiError }).error).reason).toBe('auth-unavailable');
  });
});

describe('shared deadline budget', () => {
  it('an exhausted deadline refuses before dispatch — nothing was sent, so nothing was committed', async () => {
    mockFetch(() => jsonResponse(200, {}));
    const res = await api.getSpace(SERVER, 'sp-test000000000001', KEY, { deadlineAt: Date.now() - 1 });
    expect(res).toEqual({ ok: false, error: { kind: 'timeout', sent: false } });
    expect(calls).toHaveLength(0);
  });

  it('maxFetchMs caps below the default when the deadline still allows it', async () => {
    mockFetch(() => jsonResponse(200, {}));
    // Only the cap logic matters here: a 10s-capped refresh-style call still dispatches normally
    const res = await api.refreshToken(SERVER, 'rt-1', { deadlineAt: Date.now() + 60_000, maxFetchMs: 10_000 });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('token set wire shape (redeem/refresh responses)', () => {
  const good = { accessToken: 'at', refreshToken: 'rt', expiresIn: 60, refreshExpiresIn: 600, tokenType: 'Bearer' };

  it('accepts the five-field Bearer shape', () => {
    expect(api.parseTokenSet(good)).toEqual(good);
  });

  it('rejects malformed sets — no session is ever built from a broken contract', () => {
    for (const bad of [
      null,
      {},
      { ...good, accessToken: '' },
      { ...good, refreshToken: 7 },
      { ...good, expiresIn: 0 },
      { ...good, expiresIn: Number.POSITIVE_INFINITY },
      { ...good, refreshExpiresIn: -1 },
      { ...good, tokenType: 'Basic' },
    ]) {
      expect(api.parseTokenSet(bad)).toBeNull();
    }
  });
});
