// Sign-in orchestration (lib/sync-auth.ts) with deferred-Promise ordering: the proof-bound
// handoff redemption, single-flight refresh with immediate persistence, epoch guards (sign-out /
// server switch / newer sign-in must never be resurrected by a late result), mode probing, the
// one-renewal-one-retry authedOperation budget, and the sign-in window lifecycle. Ordering is the
// point: no test here may rely on "sign in first, sign out later" happy sequencing alone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { authedOperation, getAuthState, initAuthReady, signIn, signOut } from '@/lib/sync-auth';
import {
  resetSyncForServer,
  syncAuthItem,
  writeSyncConfig,
  type SyncAuthData,
} from '@/lib/sync-storage';
import { jsonResponse, recordingFetch, type Recorded } from './fetch-recorder';

const SERVER = 'http://127.0.0.1:8080';
const OTHER_SERVER = 'http://127.0.0.1:9090';
const CONFIG_URL = `${SERVER}/api/auth/config`;
const REFRESH_URL = `${SERVER}/api/auth/refresh`;
const REDEEM_URL = `${SERVER}/api/auth/redeem`;

const HANDOFF_CODE = 'h'.repeat(43);
const TOKEN_SET = {
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresIn: 3600,
  refreshExpiresIn: 86400,
  tokenType: 'Bearer',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let calls: Recorded[];
let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

function stubFetch(h: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  handler = h;
}

function callsTo(url: string): Recorded[] {
  return calls.filter((c) => c.url === url);
}

// The fake ships identity.getRedirectURL as a throwing placeholder; pin the value the fixed
// extension ID produces in production (wxt.config.ts key → fkkfdckchahnjkcbimnbhonbgcefnafi)
const REDIRECT_BASE = 'https://fkkfdckchahnjkcbimnbhonbgcefnafi.chromiumapp.org/';

async function seedAuth(over: Partial<SyncAuthData> = {}): Promise<SyncAuthData> {
  await writeSyncConfig({ serverUrl: SERVER, spaces: [] });
  const auth: SyncAuthData = {
    serverUrl: SERVER,
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    accessTokenExpiresAt: Date.now() + 3_600_000,
    epoch: 1,
    ...over,
  };
  await syncAuthItem.setValue(auth);
  return auth;
}

async function seedHeraldProbe(loginUrl = '/api/auth/oauth/start') {
  stubFetch((url) => (url === CONFIG_URL ? jsonResponse(200, { enabled: true, loginUrl }) : jsonResponse(404, {})));
}

beforeEach(() => {
  fakeBrowser.reset();
  // fakeBrowser ships setAccessLevel as a throwing placeholder; the auth gate awaits the real call
  (fakeBrowser.storage.local as unknown as Record<string, unknown>).setAccessLevel = async () => undefined;
  (fakeBrowser.identity as unknown as Record<string, unknown>).getRedirectURL = () => REDIRECT_BASE;
  void initAuthReady();
  calls = [];
  vi.stubGlobal('fetch', recordingFetch(calls, (url, init) => handler(url, init)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('sign-in: proof-bound handoff redemption', () => {
  function stubWindow(redirect: string | Error) {
    const fn = vi.fn(async () => {
      if (redirect instanceof Error) throw redirect;
      return redirect;
    });
    (fakeBrowser.identity as unknown as Record<string, unknown>).launchWebAuthFlow = fn;
    return fn;
  }

  async function redeemBody(): Promise<{ handoffCode: string; handoffVerifier: string }> {
    return JSON.parse(callsTo(REDEEM_URL)[0]!.body!) as { handoffCode: string; handoffVerifier: string };
  }

  async function b64UrlSha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    let binary = '';
    for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  it('redeems the single-use code with the in-memory proof and persists an epoch-guarded session', async () => {
    await seedAuth({ accessToken: 'stale', refreshToken: 'stale-r', epoch: 4 });
    const flow = stubWindow(`${REDIRECT_BASE}#handoffCode=${HANDOFF_CODE}`);
    stubFetch((url) =>
      url === CONFIG_URL
        ? jsonResponse(200, { enabled: true, loginUrl: '/api/auth/oauth/start' })
        : url === REDEEM_URL
          ? jsonResponse(200, TOKEN_SET)
          : jsonResponse(404, {}),
    );

    const res = await signIn();
    expect(res).toEqual({ ok: true });

    // The start URL carries ONLY the challenge (never the verifier or any token) plus the
    // extension's fixed redirect endpoint
    const startUrl = new URL((flow.mock.calls[0] as unknown as [{ url: string }])[0].url);
    expect(startUrl.origin + startUrl.pathname).toBe(`${SERVER}/api/auth/oauth/start`);
    expect(startUrl.searchParams.get('finalUri')).toBe(REDIRECT_BASE);
    const challenge = startUrl.searchParams.get('handoffChallenge')!;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(startUrl.search).not.toContain('handoffVerifier');

    // The verifier posted to redeem is exactly the preimage of the challenge (S256)
    const body = await redeemBody();
    expect(body.handoffCode).toBe(HANDOFF_CODE);
    expect(await b64UrlSha256(body.handoffVerifier)).toBe(challenge);
    expect(callsTo(REDEEM_URL)[0]!.headers['Authorization']).toBeUndefined();

    // Persisted: new session replaced the old one, epoch advanced, TTL from redemption time
    const stored = await syncAuthItem.getValue();
    expect(stored).toMatchObject({
      serverUrl: SERVER,
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      epoch: 5,
    });
    expect(stored.accessTokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it('an error fragment fails sign-in with the public description and never redeems', async () => {
    await seedAuth();
    stubWindow(`${REDIRECT_BASE}#error=access_denied&errorDescription=${encodeURIComponent('User denied')}`);
    await seedHeraldProbe();
    const res = await signIn();
    expect(res).toEqual({ ok: false, reason: 'login-failed', detail: 'User denied' });
    expect(callsTo(REDEEM_URL)).toHaveLength(0);
  });

  it('a token arriving in the URL is refused outright (tokens never travel in URLs)', async () => {
    await seedAuth();
    stubWindow(`${REDIRECT_BASE}#handoffCode=${HANDOFF_CODE}&accessToken=leaked`);
    await seedHeraldProbe();
    expect(await signIn()).toEqual({ ok: false, reason: 'login-failed' });
    expect(callsTo(REDEEM_URL)).toHaveLength(0);
  });

  it('a redirect to any other origin/path is rejected', async () => {
    await seedAuth();
    stubWindow('https://evil.example.com/#handoffCode=' + HANDOFF_CODE);
    await seedHeraldProbe();
    expect(await signIn()).toEqual({ ok: false, reason: 'login-failed' });
    expect(callsTo(REDEEM_URL)).toHaveLength(0);
  });

  it('the window being closed by the user maps to login-cancelled', async () => {
    await seedAuth();
    stubWindow(new Error('Authorization page could not be loaded.'));
    await seedHeraldProbe();
    expect(await signIn()).toEqual({ ok: false, reason: 'login-cancelled' });
  });

  it('a rejected redemption is a terminal login-failure — the consumed code is never retried', async () => {
    await seedAuth();
    stubWindow(`${REDIRECT_BASE}#handoffCode=${HANDOFF_CODE}`);
    stubFetch((url) =>
      url === CONFIG_URL
        ? jsonResponse(200, { enabled: true, loginUrl: '/api/auth/oauth/start' })
        : url === REDEEM_URL
          ? jsonResponse(400, { error: { code: 'INVALID_INPUT', message: 'The handoff code was rejected' } })
          : jsonResponse(404, {}),
    );
    expect(await signIn()).toEqual({ ok: false, reason: 'login-failed' });
    expect(callsTo(REDEEM_URL)).toHaveLength(1);
    // No half-signed-in state lands
    expect(await syncAuthItem.getValue()).toMatchObject({ accessToken: '', refreshToken: '' });
  });

  it('a malformed token set from redeem is not a session', async () => {
    await seedAuth();
    stubWindow(`${REDIRECT_BASE}#handoffCode=${HANDOFF_CODE}`);
    stubFetch((url) =>
      url === CONFIG_URL
        ? jsonResponse(200, { enabled: true, loginUrl: '/api/auth/oauth/start' })
        : url === REDEEM_URL
          ? jsonResponse(200, { accessToken: '', oops: true })
          : jsonResponse(404, {}),
    );
    expect(await signIn()).toEqual({ ok: false, reason: 'login-failed' });
  });

  it('window overrun fails login-timeout, clears the epoch it created and leaves no window residue state', async () => {
    vi.useFakeTimers();
    // digest runs on the real thread pool (a macrotask that frozen fake timers never yield to)
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async () => new Uint8Array(32).buffer);
    await seedAuth();
    (fakeBrowser.identity as unknown as Record<string, unknown>).launchWebAuthFlow = vi.fn(
      () => new Promise<never>(() => undefined),
    );
    await seedHeraldProbe();

    const pending = signIn();
    // ~265s window budget inside the 280s total (15s redemption reserve)
    const res = await vi.advanceTimersByTimeAsync(266_000).then(() => pending);
    expect(res).toEqual({ ok: false, reason: 'login-timeout' });
    const stored = await syncAuthItem.getValue();
    expect(stored).toMatchObject({ accessToken: '', refreshToken: '' });
    expect(stored.epoch).toBeGreaterThan(1);
  });
});

describe('single-flight refresh with immediate persistence', () => {
  async function stubRefreshDeferred() {
    const refresh = deferred<Response>();
    stubFetch((url) => (url === CONFIG_URL ? jsonResponse(200, { enabled: true, loginUrl: '/x' }) : refresh.promise));
    return refresh;
  }

  it('concurrent operations with the same snapshot share exactly one refresh and the new token is persisted', async () => {
    await seedAuth({ accessTokenExpiresAt: Date.now() - 1_000 });
    const refresh = await stubRefreshDeferred();
    const run1 = vi.fn(async (bearer: string | null) => ({ ok: true as const, data: bearer }));
    const run2 = vi.fn(async (bearer: string | null) => ({ ok: true as const, data: bearer }));

    const [o1, o2] = [authedOperation(SERVER, run1, false), authedOperation(SERVER, run2, false)];
    // Both are parked on the shared flight before it settles
    await Promise.resolve();
    await Promise.resolve();
    refresh.resolve(jsonResponse(200, { ...TOKEN_SET, accessToken: 'at-2', refreshToken: 'rt-2' }));
    const [r1, r2] = await Promise.all([o1, o2]);

    expect(r1).toEqual({ ok: true, data: 'at-2' });
    expect(r2).toEqual({ ok: true, data: 'at-2' });
    expect(callsTo(REFRESH_URL)).toHaveLength(1);
    expect(JSON.parse(callsTo(REFRESH_URL)[0]!.body!)).toEqual({ refreshToken: 'rt-1' });
    expect(await syncAuthItem.getValue()).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' });

    // The flight slot frees: a later expiry refreshes again instead of joining a stale flight
    await syncAuthItem.setValue({ ...(await syncAuthItem.getValue()), accessTokenExpiresAt: Date.now() - 1 });
    const run3 = vi.fn(async (bearer: string | null) => ({ ok: true as const, data: bearer }));
    const o3 = authedOperation(SERVER, run3, false);
    // new refresh response for the second flight
    stubFetch((url) =>
      url === CONFIG_URL
        ? jsonResponse(200, { enabled: true, loginUrl: '/x' })
        : jsonResponse(200, { ...TOKEN_SET, accessToken: 'at-3', refreshToken: 'rt-3' }),
    );
    expect(await o3).toEqual({ ok: true, data: 'at-3' });
    expect(callsTo(REFRESH_URL)).toHaveLength(2);
  });

  it('a rejected refresh token clears the session guarded and reports sign-in-required', async () => {
    await seedAuth({ accessTokenExpiresAt: Date.now() - 1_000 });
    stubFetch((url) =>
      url === CONFIG_URL
        ? jsonResponse(200, { enabled: true, loginUrl: '/x' })
        : jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: 'Sign in' } }),
    );
    const run = vi.fn(async () => ({ ok: true as const, data: 'never' }));
    expect(await authedOperation(SERVER, run, false)).toEqual({ ok: false, resp: { ok: false, reason: 'sign-in-required' } });
    expect(run).not.toHaveBeenCalled();
    expect(await syncAuthItem.getValue()).toMatchObject({ accessToken: '', refreshToken: '', epoch: 2 });
  });

  it('a dependency failure (503) keeps the stored credentials for recovery', async () => {
    await seedAuth({ accessTokenExpiresAt: Date.now() - 1_000 });
    stubFetch((url) =>
      url === CONFIG_URL
        ? jsonResponse(200, { enabled: true, loginUrl: '/x' })
        : jsonResponse(503, { error: { code: 'AUTH_UNAVAILABLE', message: 'Herald is down' } }),
    );
    const run = vi.fn(async () => ({ ok: true as const, data: 'never' }));
    expect(await authedOperation(SERVER, run, false)).toEqual({
      ok: false,
      resp: { ok: false, reason: 'auth-unavailable', detail: 'Herald is down' },
    });
    expect(await syncAuthItem.getValue()).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1' });
  });

  it('a malformed 200 from the refresh proxy is an auth-unavailable, not a session', async () => {
    await seedAuth({ accessTokenExpiresAt: Date.now() - 1_000 });
    stubFetch((url) => (url === CONFIG_URL ? jsonResponse(200, { enabled: true, loginUrl: '/x' }) : jsonResponse(200, 'nope')));
    expect(await authedOperation(SERVER, vi.fn(), false)).toEqual({ ok: false, resp: { ok: false, reason: 'auth-unavailable' } });
    expect(await syncAuthItem.getValue()).toMatchObject({ accessToken: 'at-1' });
  });
});

describe('late results and epoch guards (deferred ordering)', () => {
  async function heraldProbeStub() {
    stubFetch((url) => (url === CONFIG_URL ? jsonResponse(200, { enabled: true, loginUrl: '/x' }) : jsonResponse(500, {})));
  }

  it('a late 401 reuses the session’s current token instead of rotating again', async () => {
    await seedAuth(); // valid at-1
    await heraldProbeStub();
    const first = deferred<{ ok: false; error: { kind: 'auth-required' } }>();
    const firstOut = deferred<void>();
    const run = vi.fn()
      .mockImplementationOnce(() => {
        firstOut.resolve();
        return first.promise;
      })
      .mockImplementationOnce(async (bearer: string | null) => ({ ok: true as const, data: bearer }));
    const op = authedOperation(SERVER, run, false);
    // Only rotate after the request with at-1 has actually been dispatched
    await firstOut.promise;
    await syncAuthItem.setValue({ ...(await syncAuthItem.getValue()), accessToken: 'at-9', refreshToken: 'rt-9' });
    first.resolve({ ok: false, error: { kind: 'auth-required' } });
    expect(await op).toEqual({ ok: true, data: 'at-9' });
    expect(run.mock.calls.map((c) => c[0])).toEqual(['at-1', 'at-9']);
    expect(callsTo(REFRESH_URL)).toHaveLength(0);
  });

  it('a second 401 racing a newer rotation keeps the newer session and reports auth-changed', async () => {
    await seedAuth();
    await heraldProbeStub();
    const first = deferred<{ ok: false; error: { kind: 'auth-required' } }>();
    const firstSent = deferred<void>();
    const second = deferred<{ ok: false; error: { kind: 'auth-required' } }>();
    const secondSent = deferred<void>();
    const run = vi.fn()
      .mockImplementationOnce(() => {
        firstSent.resolve();
        return first.promise;
      })
      .mockImplementationOnce(() => {
        secondSent.resolve();
        return second.promise;
      });
    const op = authedOperation(SERVER, run, false);
    await firstSent.promise;
    // Another message rotated to at-2 while our at-1 request was in flight → reuse branch
    await syncAuthItem.setValue({ ...(await syncAuthItem.getValue()), accessToken: 'at-2', refreshToken: 'rt-2' });
    first.resolve({ ok: false, error: { kind: 'auth-required' } });
    await secondSent.promise;
    // A third rotation lands before our guarded clear runs: that session is not ours to clear
    await syncAuthItem.setValue({ ...(await syncAuthItem.getValue()), accessToken: 'at-3', refreshToken: 'rt-3' });
    second.resolve({ ok: false, error: { kind: 'auth-required' } });
    expect(await op).toEqual({ ok: false, resp: { ok: false, reason: 'auth-changed' } });
    expect(await syncAuthItem.getValue()).toMatchObject({ accessToken: 'at-3', refreshToken: 'rt-3', epoch: 1 });
  });

  it('a refresh resolving after sign-out never resurrects the session', async () => {
    await seedAuth({ accessTokenExpiresAt: Date.now() - 1_000 });
    const refresh = deferred<Response>();
    stubFetch((url) => (url === CONFIG_URL ? jsonResponse(200, { enabled: true, loginUrl: '/x' }) : refresh.promise));
    const op = authedOperation(SERVER, vi.fn(), false);
    await Promise.resolve();
    await Promise.resolve();
    await signOut();
    refresh.resolve(jsonResponse(200, { ...TOKEN_SET, accessToken: 'at-2', refreshToken: 'rt-2' }));
    expect(await op).toEqual({ ok: false, resp: { ok: false, reason: 'auth-changed' } });
    const stored = await syncAuthItem.getValue();
    expect(stored).toMatchObject({ accessToken: '', refreshToken: '' });
  });

  it('a refresh rejection landing after a newer sign-in reports auth-changed, not sign-in-required', async () => {
    await seedAuth({ accessTokenExpiresAt: Date.now() - 1_000 });
    const refresh = deferred<Response>();
    stubFetch((url) => (url === CONFIG_URL ? jsonResponse(200, { enabled: true, loginUrl: '/x' }) : refresh.promise));
    const op = authedOperation(SERVER, vi.fn(), false);
    // Park the operation on the old refresh token before replacing the session
    await vi.waitFor(() => expect(callsTo(REFRESH_URL)).toHaveLength(1));
    // A newer sign-in replaced the session while the old refresh token was still in flight; the
    // user just signed in successfully — a "sign in" error would contradict the visible state
    await syncAuthItem.setValue({
      serverUrl: SERVER,
      accessToken: 'at-9',
      refreshToken: 'rt-9',
      accessTokenExpiresAt: Date.now() + 3_600_000,
      epoch: 2,
    });
    refresh.resolve(jsonResponse(401, { error: { code: 'AUTH_REQUIRED', message: 'Sign in' } }));
    expect(await op).toEqual({ ok: false, resp: { ok: false, reason: 'auth-changed' } });
    expect(await syncAuthItem.getValue()).toMatchObject({ accessToken: 'at-9', refreshToken: 'rt-9', epoch: 2 });
  });

  it('A→B→A: a server switch invalidates the old session and switching back restores nothing', async () => {
    await writeSyncConfig({ serverUrl: SERVER, spaces: [] });
    await syncAuthItem.setValue({
      serverUrl: SERVER,
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      accessTokenExpiresAt: Date.now() - 1_000,
      epoch: 3,
    });
    const refresh = deferred<Response>();
    stubFetch((url) => (url === CONFIG_URL ? jsonResponse(200, { enabled: true, loginUrl: '/x' }) : refresh.promise));
    const op = authedOperation(SERVER, vi.fn(), false);
    await Promise.resolve();
    await Promise.resolve();
    // The user switches to B while the old server's refresh is in flight…
    await resetSyncForServer(OTHER_SERVER);
    refresh.resolve(jsonResponse(200, TOKEN_SET));
    expect(await op).toEqual({ ok: false, resp: { ok: false, reason: 'auth-changed' } });
    expect(await syncAuthItem.getValue()).toMatchObject({ serverUrl: OTHER_SERVER, accessToken: '', epoch: 4 });
    // …and switching back to A does not bring the credentials or the old epoch back
    await resetSyncForServer(SERVER);
    const stored = await syncAuthItem.getValue();
    expect(stored).toMatchObject({ serverUrl: SERVER, accessToken: '', refreshToken: '' });
    expect(stored.epoch).toBeGreaterThan(4);
    expect(await getAuthState()).toEqual({ ok: true, authState: { mode: 'herald', signedIn: false } });
  });

  it('one renewal per message: a second 401 after the pre-send renewal clears and asks for sign-in', async () => {
    await seedAuth({ accessTokenExpiresAt: Date.now() - 1_000 });
    stubFetch((url) =>
      url === CONFIG_URL
        ? jsonResponse(200, { enabled: true, loginUrl: '/x' })
        : jsonResponse(200, { ...TOKEN_SET, accessToken: 'at-2', refreshToken: 'rt-2' }),
    );
    const run = vi.fn(async () => ({ ok: false as const, error: { kind: 'auth-required' as const } }));
    expect(await authedOperation(SERVER, run, false)).toEqual({ ok: false, resp: { ok: false, reason: 'sign-in-required' } });
    expect(callsTo(REFRESH_URL)).toHaveLength(1);
    expect(await syncAuthItem.getValue()).toMatchObject({ accessToken: '', refreshToken: '', epoch: 2 });
  });

  it('renew → retry → still 401 clears guarded (the retry itself is not a loop)', async () => {
    await seedAuth();
    await heraldProbeStub();
    stubFetch((url) =>
      url === CONFIG_URL ? jsonResponse(200, { enabled: true, loginUrl: '/x' }) : jsonResponse(200, TOKEN_SET),
    );
    const run = vi.fn(async () => ({ ok: false as const, error: { kind: 'auth-required' as const } }));
    expect(await authedOperation(SERVER, run, false)).toEqual({ ok: false, resp: { ok: false, reason: 'sign-in-required' } });
    expect(run).toHaveBeenCalledTimes(2);
    expect(await syncAuthItem.getValue()).toMatchObject({ accessToken: '' });
  });
});

describe('mode probing and wire shape', () => {
  it('a 404 config probe means none: business runs credential-free (pre-auth server compat)', async () => {
    await seedAuth();
    stubFetch((url) => (url === CONFIG_URL ? jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'x' } }) : jsonResponse(200, [])));
    const run = vi.fn(async (bearer: string | null) => ({ ok: true as const, data: bearer }));
    expect(await authedOperation(SERVER, run, false)).toEqual({ ok: true, data: null });
    expect(calls).toHaveLength(1);
  });

  it('an unprobed mode (network failure) still never sends the stored bearer', async () => {
    await seedAuth();
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const run = vi.fn(async (bearer: string | null) => ({ ok: false as const, error: { kind: 'unreachable' as const } }));
    expect(await authedOperation(SERVER, run, false)).toEqual({ ok: false, resp: { ok: false, reason: 'unreachable' } });
    expect(run.mock.calls[0]![0]).toBeNull();
  });

  it('herald with no stored credentials refuses before any business request', async () => {
    await writeSyncConfig({ serverUrl: SERVER, spaces: [] });
    await seedHeraldProbe();
    const run = vi.fn(async () => ({ ok: true as const, data: 'x' }));
    expect(await authedOperation(SERVER, run, false)).toEqual({ ok: false, resp: { ok: false, reason: 'sign-in-required' } });
    expect(run).not.toHaveBeenCalled();
  });

  it('a valid token rides the Authorization header on the business call', async () => {
    await seedAuth();
    await seedHeraldProbe();
    const run = vi.fn(async (bearer: string | null) => ({ ok: true as const, data: bearer }));
    expect(await authedOperation(SERVER, run, false)).toEqual({ ok: true, data: 'at-1' });
    expect(run.mock.calls[0]![0]).toBe('at-1');
  });

  it('writes that time out after dispatch surface operation-uncertain; reads stay unreachable', async () => {
    await seedAuth();
    await seedHeraldProbe();
    const write = vi.fn(async () => ({ ok: false as const, error: { kind: 'timeout' as const, sent: true } }));
    const read = vi.fn(async () => ({ ok: false as const, error: { kind: 'timeout' as const, sent: true } }));
    expect(await authedOperation(SERVER, write, true)).toEqual({ ok: false, resp: { ok: false, reason: 'operation-uncertain' } });
    expect(await authedOperation(SERVER, read, false)).toEqual({ ok: false, resp: { ok: false, reason: 'unreachable' } });
  });
});

describe('auth state and sign-out handlers', () => {
  it('getAuthState reports the probed mode and signed-in facts, never tokens', async () => {
    await seedAuth();
    await seedHeraldProbe();
    const res = await getAuthState();
    expect(res).toEqual({ ok: true, authState: { mode: 'herald', signedIn: true } });
    expect(JSON.stringify(res)).not.toContain('at-1');
    expect(JSON.stringify(res)).not.toContain('rt-1');
  });

  it('getAuthState: none probe (404) and unsigned storage', async () => {
    await writeSyncConfig({ serverUrl: SERVER, spaces: [] });
    stubFetch((url) => (url === CONFIG_URL ? jsonResponse(404, {}) : jsonResponse(200, [])));
    expect(await getAuthState()).toEqual({ ok: true, authState: { mode: 'none', signedIn: false } });
  });

  it('getAuthState without a configured server is a local answer', async () => {
    await writeSyncConfig({ serverUrl: '', spaces: [] });
    expect(await getAuthState()).toEqual({ ok: true, authState: { mode: 'none', signedIn: false } });
  });

  it('signOut clears tokens, keeps the record and advances the epoch', async () => {
    const seeded = await seedAuth({ epoch: 7 });
    expect(await signOut()).toEqual({ ok: true });
    expect(await syncAuthItem.getValue()).toEqual({
      serverUrl: SERVER,
      accessToken: '',
      refreshToken: '',
      accessTokenExpiresAt: 0,
      epoch: 8,
    });
    expect(seeded.epoch).toBe(7);
  });

  it('signOut on an unconfigured server refuses', async () => {
    await writeSyncConfig({ serverUrl: '', spaces: [] });
    expect(await signOut()).toEqual({ ok: false, reason: 'not-configured' });
  });
});
