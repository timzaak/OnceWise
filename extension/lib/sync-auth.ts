// Sign-in orchestration for Herald-gated sync servers, background-only: the storage.local
// trusted-contexts gate, the OAuth Code+PKCE handoff through chrome.identity (proof-bound
// single-use handoff code redeemed by POST), epoch-guarded persistence, single-flight refresh and
// the per-message authed business call (one renewal + one 401 retry inside a shared deadline).
// Tokens never leave storage except into request headers/bodies and are never logged; the
// authorization window itself renders the real Herald pages — this extension builds no login form
// and embeds no Herald address, everything is discovered through the connected server.
import { browser } from 'wxt/browser';
import * as api from './sync-api';
import {
  clearAuthForServer,
  clearedSyncAuth,
  commitAuthIfCurrent,
  loadSyncAuth,
  loadSyncConfig,
  type SyncAuthData,
} from './sync-storage';
import { isPlainObject } from './flow-schema';
import type { ExtensionResponse } from './messaging';

// Budgets fit Chrome 114's service-worker lifetime rules (no identity >5min exemption there):
// business messages share 115s across mode probe + at most one refresh + every request incl. one
// 401 retry; sign-in gets 280s total with at most 260s for the window, keeping a redemption
// reserve. Every fetch stays <=28s; refresh/redeem stay at 10s.
export const AUTHED_OP_BUDGET_MS = 115_000;
// Strictly under SYNC_TIMEOUT_MS so a none/unknown message (probe + request) always answers
// before the UI hop dies
export const NONE_OP_BUDGET_MS = 28_000;
export const SIGN_IN_BUDGET_MS = 280_000;
const SIGN_IN_WINDOW_MAX_MS = 260_000;
const SIGN_IN_REDEEM_RESERVE_MS = 15_000;
const AUTH_FETCH_CAP_MS = 10_000;
// Renew a little before the server-side expiry so a token that passes the local check still has
// enough life left for the request round trip
const TOKEN_EXPIRY_MARGIN_MS = 10_000;

// --- authReady: storage.local is readable by content scripts unless the whole area is restricted
// to trusted contexts. Every auth read/write/orchestration below waits for that restriction and
// refuses auth operations when it could not be established. ---
let authReadyPromise: Promise<boolean> | undefined;

export function initAuthReady(): Promise<boolean> {
  authReadyPromise = Promise.resolve()
    .then(() => browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }))
    .then(
      () => true,
      // Fail closed: auth operations refuse when the restriction cannot be established (also
      // covers a synchronous throw from the API)
      () => false,
    );
  return authReadyPromise;
}

export function authReady(): Promise<boolean> {
  return authReadyPromise ?? initAuthReady();
}

// herald implies a non-null loginUrl; none/unknown never carry one. Single-literal discriminants
// so signIn's early returns narrow probe down to the herald variant.
export type AuthModeProbe =
  | { mode: 'herald'; loginUrl: string }
  | { mode: 'none'; loginUrl: null }
  | { mode: 'unknown'; loginUrl: null };

function asAuthConfig(v: unknown): api.AuthConfigDto | null {
  if (!isPlainObject(v)) return null;
  if (typeof v.enabled !== 'boolean') return null;
  if (v.loginUrl !== null && typeof v.loginUrl !== 'string') return null;
  return { enabled: v.enabled, loginUrl: v.loginUrl };
}

// 200 {enabled:true, loginUrl} → herald; 200 enabled:false → none; 404 → none (pre-auth servers
// have no /api/auth/config). Everything else — network failure, malformed body, other HTTP
// statuses — is unknown: a probe failure is never silently treated as none.
export async function probeAuthMode(serverUrl: string, deadlineAt: number): Promise<AuthModeProbe> {
  const res = await api.getAuthConfig(serverUrl, { deadlineAt });
  if (res.ok) {
    const config = asAuthConfig(res.data);
    if (config === null) return { mode: 'unknown', loginUrl: null };
    if (config.enabled) {
      if (typeof config.loginUrl === 'string' && config.loginUrl !== '') {
        return { mode: 'herald', loginUrl: config.loginUrl };
      }
      return { mode: 'unknown', loginUrl: null };
    }
    return { mode: 'none', loginUrl: null };
  }
  if (res.error.kind === 'http' && res.error.status === 404) return { mode: 'none', loginUrl: null };
  return { mode: 'unknown', loginUrl: null };
}

// The login URL must be a fixed relative path on the connected server — an absolute or foreign URL
// is never accepted (the extension must not be navigable to an attacker-chosen origin).
function resolveLoginUrl(serverUrl: string, loginUrl: string): string | null {
  if (!loginUrl.startsWith('/') || loginUrl.startsWith('//')) return null;
  try {
    const url = new URL(loginUrl, serverUrl);
    if (url.origin !== serverUrl || url.search !== '' || url.hash !== '') return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

// --- error → UI reason mapping shared by both modes; writers upgrade a sent-timeout to
// operation-uncertain (the request may have committed; it is never auto-replayed) ---
export function syncFailure(error: api.SyncApiError, mutation: boolean): ExtensionResponse {
  if (mutation && error.kind === 'timeout' && error.sent) {
    return { ok: false, reason: 'operation-uncertain' };
  }
  const { reason, detail } = api.syncErrorToReason(error);
  return { ok: false, reason, detail };
}

function authChanged(): ExtensionResponse {
  // The session was replaced mid-operation (sign-out / server switch / newer sign-in); the caller
  // stops without reporting the stale session's error and the UI reloads its current state
  return { ok: false, reason: 'auth-changed' };
}

interface FlightSnapshot {
  serverUrl: string;
  epoch: number;
  refreshToken: string;
}

type FlightResult =
  | { ok: true; auth: SyncAuthData }
  | { ok: false; resp: ExtensionResponse }
  | { ok: false; authChanged: true };

let activeFlight: { snapshot: FlightSnapshot; promise: Promise<FlightResult> } | null = null;

function sameSnapshot(a: FlightSnapshot, b: FlightSnapshot): boolean {
  return a.serverUrl === b.serverUrl && a.epoch === b.epoch && a.refreshToken === b.refreshToken;
}

// Only callers holding the exact same snapshot share a flight; the finally clears only its own
// flight object so a late finish can never drop a newer session's flight.
async function singleFlightRefresh(snapshot: FlightSnapshot, deadlineAt: number): Promise<FlightResult> {
  if (activeFlight !== null && sameSnapshot(activeFlight.snapshot, snapshot)) {
    return activeFlight.promise;
  }
  const promise = doRefresh(snapshot, deadlineAt).finally(() => {
    if (activeFlight !== null && sameSnapshot(activeFlight.snapshot, snapshot)) activeFlight = null;
  });
  activeFlight = { snapshot, promise };
  return promise;
}

async function doRefresh(snapshot: FlightSnapshot, deadlineAt: number): Promise<FlightResult> {
  const res = await api.refreshToken(snapshot.serverUrl, snapshot.refreshToken, {
    deadlineAt,
    maxFetchMs: AUTH_FETCH_CAP_MS,
  });
  if (!res.ok) {
    if (res.error.kind === 'auth-required') {
      // The refresh token was rejected (rotated away, expired, account disabled): the session is
      // dead. Clear guarded so a newer sign-in survives; dependency failures (network/503/timeout)
      // keep the stored credentials for recovery instead.
      const cleared = await commitAuthIfCurrent(
        clearedSyncAuth(snapshot.serverUrl, snapshot.epoch + 1),
        { serverUrl: snapshot.serverUrl, epoch: snapshot.epoch, refreshToken: snapshot.refreshToken },
      );
      // A failed guard means a newer session already replaced this one — its fate is not ours to report
      if (!cleared) return { ok: false, authChanged: true };
      return { ok: false, resp: { ok: false, reason: 'sign-in-required' } };
    }
    return { ok: false, resp: syncFailure(res.error, false) };
  }
  const tokens = api.parseTokenSet(res.data);
  if (tokens === null) {
    return { ok: false, resp: { ok: false, reason: 'auth-unavailable' } };
  }
  const record: SyncAuthData = {
    serverUrl: snapshot.serverUrl,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
    epoch: snapshot.epoch,
  };
  // The rotation must be fully persisted before the flight resolves — callers send business
  // requests only with a token that survived a SW restart.
  let committed: boolean;
  try {
    committed = await commitAuthIfCurrent(record, {
      serverUrl: snapshot.serverUrl,
      epoch: snapshot.epoch,
      refreshToken: snapshot.refreshToken,
    });
  } catch {
    // A persist failure must not continue as "signed in"; the server already rotated, so the next
    // attempt fails closed and asks for a fresh sign-in
    return { ok: false, resp: { ok: false, reason: 'auth-unavailable' } };
  }
  if (!committed) return { ok: false, authChanged: true };
  return { ok: true, auth: record };
}

interface OpContext {
  serverUrl: string;
  epoch: number;
  deadlineAt: number;
  refreshUsed: boolean;
}

export type AuthedOutcome<T> = { ok: true; data: T } | { ok: false; resp: ExtensionResponse };

// Bump-and-clear guarded on this message's last-known refresh token: a rotation another message
// landed after that read survives; only a session this message still believes current is treated
// as dead. Returns false when the guard no longer matched.
async function clearIfCurrent(ctx: OpContext, refreshToken: string): Promise<boolean> {
  return commitAuthIfCurrent(clearedSyncAuth(ctx.serverUrl, ctx.epoch + 1), {
    serverUrl: ctx.serverUrl,
    epoch: ctx.epoch,
    refreshToken,
  });
}

// One refresh action per message (success or failure); returns a ready outcome when the operation
// must stop, or undefined when the rotation landed and the caller should re-read state.
async function runRefresh(
  ctx: OpContext,
  auth: SyncAuthData,
): Promise<{ resp: ExtensionResponse } | { authChanged: true } | undefined> {
  const flight = await singleFlightRefresh(
    { serverUrl: ctx.serverUrl, epoch: ctx.epoch, refreshToken: auth.refreshToken },
    ctx.deadlineAt,
  );
  ctx.refreshUsed = true;
  if (flight.ok) return undefined;
  if ('authChanged' in flight) return { authChanged: true };
  return { resp: flight.resp };
}

// The signed-in predicate: credentials for exactly this server with both tokens present
function signedInto(auth: SyncAuthData, serverUrl: string): boolean {
  return auth.serverUrl === serverUrl && auth.accessToken !== '' && auth.refreshToken !== '';
}

// The token-selection epoch guard shared by the renewal and no-renewal paths: re-reads the
// session and hands back its current record, or reports auth-changed when the session moved on
// while the operation was parked. Callers keep the record as their last-known snapshot — the
// guarded clear below only fires while that belief still holds.
async function authIfCurrent(ctx: OpContext): Promise<{ auth: SyncAuthData } | { authChanged: true }> {
  const auth = await loadSyncAuth();
  return auth.epoch !== ctx.epoch ? { authChanged: true } : { auth };
}

function refreshedResponse(refreshed: { resp: ExtensionResponse } | { authChanged: true }): ExtensionResponse {
  return 'authChanged' in refreshed ? authChanged() : refreshed.resp;
}

// The single entry every business API call goes through. Probes the server's auth mode within the
// message budget: none/unknown keep the original wire shape (no bearer — a stale token is never
// sent to a server whose mode could not be established); herald attaches the bearer with lazy
// renewal, at most one refresh and one 401 AUTH_REQUIRED retry, all inside the shared deadline.
export async function authedOperation<T>(
  serverUrl: string,
  run: (bearer: string | null, deadlineAt: number) => Promise<api.SyncApiResult<T>>,
  mutation: boolean,
): Promise<AuthedOutcome<T>> {
  const startedAt = Date.now();
  const probe = await probeAuthMode(serverUrl, startedAt + NONE_OP_BUDGET_MS);
  if (probe.mode !== 'herald') {
    const res = await run(null, startedAt + NONE_OP_BUDGET_MS);
    return res.ok ? { ok: true, data: res.data } : { ok: false, resp: syncFailure(res.error, mutation) };
  }
  if (!(await authReady())) return { ok: false, resp: { ok: false, reason: 'auth-unavailable' } };

  const initial = await loadSyncAuth();
  if (!signedInto(initial, serverUrl)) {
    return { ok: false, resp: { ok: false, reason: 'sign-in-required' } };
  }
  const ctx: OpContext = {
    serverUrl,
    epoch: initial.epoch,
    deadlineAt: startedAt + AUTHED_OP_BUDGET_MS,
    refreshUsed: false,
  };

  // Token selection: renew when within the expiry margin, otherwise take the session's latest
  // token — sequential operations must not replay a snapshot taken before the first request
  if (initial.accessTokenExpiresAt <= Date.now() + TOKEN_EXPIRY_MARGIN_MS) {
    const refreshed = await runRefresh(ctx, initial);
    if (refreshed !== undefined) return { ok: false, resp: refreshedResponse(refreshed) };
  }
  const selected = await authIfCurrent(ctx);
  if ('authChanged' in selected) return { ok: false, resp: authChanged() };
  let current = selected.auth;
  const bearer = current.accessToken;

  let res = await run(bearer, ctx.deadlineAt);
  if (res.ok) return { ok: true, data: res.data };
  if (res.error.kind === 'auth-required') {
    const after = await loadSyncAuth();
    if (after.epoch !== ctx.epoch) return { ok: false, resp: authChanged() };
    current = after;
    if (after.accessToken !== bearer) {
      // Another message already rotated the token — reuse the current one; the old refresh token
      // must not be used for another rotation
      res = await run(after.accessToken, ctx.deadlineAt);
    } else if (!ctx.refreshUsed) {
      const refreshed = await runRefresh(ctx, after);
      if (refreshed !== undefined) return { ok: false, resp: refreshedResponse(refreshed) };
      const renewed = await authIfCurrent(ctx);
      if ('authChanged' in renewed) return { ok: false, resp: authChanged() };
      current = renewed.auth;
      res = await run(current.accessToken, ctx.deadlineAt);
    } else {
      // Already renewed (or reused a rotation) this message and still rejected: the session is
      // dead — clear guarded and ask for a fresh sign-in
      const cleared = await clearIfCurrent(ctx, current.refreshToken);
      if (!cleared) return { ok: false, resp: authChanged() };
      return { ok: false, resp: { ok: false, reason: 'sign-in-required' } };
    }
    if (res.ok) return { ok: true, data: res.data };
    if (res.error.kind === 'auth-required') {
      const cleared = await clearIfCurrent(ctx, current.refreshToken);
      if (!cleared) return { ok: false, resp: authChanged() };
      return { ok: false, resp: { ok: false, reason: 'sign-in-required' } };
    }
  }
  return { ok: false, resp: syncFailure(res.error, mutation) };
}

export async function getAuthState(): Promise<ExtensionResponse> {
  const config = await loadSyncConfig();
  if (config.serverUrl === '') {
    return { ok: true, authState: { mode: 'none', signedIn: false } };
  }
  if (!(await authReady())) return { ok: false, reason: 'auth-unavailable' };
  const probe = await probeAuthMode(config.serverUrl, Date.now() + NONE_OP_BUDGET_MS);
  const auth = await loadSyncAuth();
  return {
    ok: true,
    authState: {
      mode: probe.mode,
      signedIn: signedInto(auth, config.serverUrl),
    },
  };
}

export async function signOut(): Promise<ExtensionResponse> {
  if (!(await authReady())) return { ok: false, reason: 'auth-unavailable' };
  const config = await loadSyncConfig();
  if (config.serverUrl === '') return { ok: false, reason: 'not-configured' };
  await clearAuthForServer(config.serverUrl);
  return { ok: true };
}

// base64url without padding (43 chars for 32 bytes) — the exact wire shape the server validates
function base64UrlNoPad(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlNoPad(bytes);
}

// RFC 7636 S256 over the verifier string — the server compares this challenge shape-for-shape
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlNoPad(new Uint8Array(digest));
}

class BudgetTimeoutError {}

function withBudgetMs<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BudgetTimeoutError()), Math.max(0, ms));
    }),
  ]).finally(() => {
    // A pending timer would hold the MV3 service worker alive long after the race settled
    if (timer !== undefined) clearTimeout(timer);
  });
}

type RedirectFragment = { handoffCode: string } | { error: string; errorDescription?: string };

// The redirect must land exactly on this extension's own launchWebAuthFlow endpoint (origin+path,
// no query); the fragment carries either the single-use handoff code or public error fields — a
// token in the URL is a contract break and is refused outright.
function parseRedirectFragment(raw: string, finalUri: string): RedirectFragment | null {
  let url: URL;
  let expected: URL;
  try {
    url = new URL(raw);
    expected = new URL(finalUri);
  } catch {
    return null;
  }
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.search !== '') return null;
  if (url.hash === '') return null;
  const params = new URLSearchParams(url.hash.slice(1));
  if (params.has('accessToken') || params.has('refreshToken')) return null;
  const handoffCode = params.get('handoffCode');
  const error = params.get('error');
  if (handoffCode !== null && /^[A-Za-z0-9_-]{43}$/.test(handoffCode) && error === null) {
    return { handoffCode };
  }
  if (error !== null && error !== '') {
    const description = params.get('errorDescription');
    return { error, errorDescription: description === null || description === '' ? undefined : description };
  }
  return null;
}

export async function signIn(): Promise<ExtensionResponse> {
  if (!(await authReady())) return { ok: false, reason: 'auth-unavailable' };
  const config = await loadSyncConfig();
  if (config.serverUrl === '') return { ok: false, reason: 'not-configured' };
  const deadlineAt = Date.now() + SIGN_IN_BUDGET_MS;
  const probe = await probeAuthMode(config.serverUrl, deadlineAt);
  if (probe.mode === 'unknown') return { ok: false, reason: 'auth-unavailable' };
  if (probe.mode === 'none') return { ok: false, reason: 'login-failed' };
  const startUrl = resolveLoginUrl(config.serverUrl, probe.loginUrl);
  if (startUrl === null) return { ok: false, reason: 'login-failed' };

  // A new sign-in replaces any prior session: bump the epoch and clear tokens first, so late
  // results of the old session (refresh, redeem) cannot land afterwards
  const epoch = await clearAuthForServer(config.serverUrl);
  const verifier = randomVerifier();
  const challenge = await s256(verifier);
  const finalUri = browser.identity.getRedirectURL();
  const url = `${startUrl}?finalUri=${encodeURIComponent(finalUri)}&handoffChallenge=${encodeURIComponent(challenge)}`;

  // Window time is capped so redemption and persistence always keep their reserve; the identity
  // API cannot force-close a leftover window, so a timeout invalidates the epoch and the UI tells
  // the user to close it themselves
  const windowBudget = Math.min(SIGN_IN_WINDOW_MAX_MS, deadlineAt - Date.now() - SIGN_IN_REDEEM_RESERVE_MS);
  let redirectUrl: string;
  try {
    const raw = await withBudgetMs(
      browser.identity.launchWebAuthFlow({ url, interactive: true }),
      windowBudget,
    );
    // The typed API may resolve without a URL (no redirect ever landed on the final endpoint)
    if (raw === undefined || raw === '') return { ok: false, reason: 'login-failed' };
    redirectUrl = raw;
  } catch (error) {
    if (error instanceof BudgetTimeoutError) {
      // Atomic check-and-clear in one serialized write: a newer sign-in that bumped the epoch
      // after this window opened must survive this cleanup
      await commitAuthIfCurrent(clearedSyncAuth(config.serverUrl, epoch + 1), {
        serverUrl: config.serverUrl,
        epoch,
      });
      return { ok: false, reason: 'login-timeout' };
    }
    // The window was closed by the user or failed to navigate — back to signed-out either way
    return { ok: false, reason: 'login-cancelled' };
  }

  const fragment = parseRedirectFragment(redirectUrl, finalUri);
  if (fragment === null) return { ok: false, reason: 'login-failed' };
  if ('error' in fragment) {
    return { ok: false, reason: 'login-failed', detail: fragment.errorDescription };
  }

  // The handoff code is single-use and bound to this in-memory proof; any redemption failure means
  // a fresh sign-in — the code is never blindly retried
  const res = await api.redeemToken(
    config.serverUrl,
    { handoffCode: fragment.handoffCode, handoffVerifier: verifier },
    { deadlineAt, maxFetchMs: AUTH_FETCH_CAP_MS },
  );
  if (!res.ok) return { ok: false, reason: 'login-failed' };
  const tokens = api.parseTokenSet(res.data);
  if (tokens === null) return { ok: false, reason: 'login-failed' };
  const committed = await commitAuthIfCurrent(
    {
      serverUrl: config.serverUrl,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
      epoch,
    },
    { serverUrl: config.serverUrl, epoch },
  );
  if (!committed) return { ok: false, reason: 'auth-changed' };
  return { ok: true };
}
