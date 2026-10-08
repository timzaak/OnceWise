// Sync HTTP client — the extension's first and only network surface. All fetches live here and are
// called exclusively from the background service worker (UI never fetches). Hand-rolled on purpose:
// zero new dependencies. Paths are relative to the user-configured server origin; server errors use
// the unified body {"error":{"code","message"}}. With a host permission for the origin the SW fetch
// is exempt from CORS — a missing/revoked permission therefore surfaces as 'unreachable'.
//
// No-account model: every space-scoped call carries the space access key in the X-Space-Key header;
// entity ids (spaces, scripts) are client-generated opaque strings, and the space share code is
// `<spaceId>#<key>` produced and parsed here (single source for the format).
import { isPlainObject, parseOrigin } from './flow-schema';

export interface SpaceDto {
  id: string;
  name: string;
  createdAt: string;
}

export interface ScriptDto {
  id: string;
  name: string;
  note: string;
  latestVersionNumber: number;
  latestVersionNote: string;
  updatedAt: string;
}

export interface VersionMetaDto {
  versionNumber: number;
  note: string;
  createdAt: string;
}

export interface VersionDto extends VersionMetaDto {
  // Opaque flow snapshot; structural validation happens on the pull side (validateFlow 'import')
  flowContent: object;
}

export type SyncApiError =
  | { kind: 'unreachable' }
  // Aborted on the fetch budget: sent=true means the request was dispatched and a write's outcome
  // is unknown (callers surface operation-uncertain); sent=false means the shared deadline ran out
  // before dispatch, so nothing was sent and nothing was committed
  | { kind: 'timeout'; sent: boolean }
  // 401 without an AUTH_REQUIRED code — the space-key rejection of pre-auth servers
  | { kind: 'unauthorized' }
  // 401 AUTH_REQUIRED — the server's sign-in gate rejected (or missed) the bearer token
  | { kind: 'auth-required' }
  | { kind: 'http'; status: number; code: string; message: string };

export type SyncApiResult<T> = { ok: true; data: T } | { ok: false; error: SyncApiError };

export interface RequestOptions {
  // Bearer for auth-gated servers; omitted sends no Authorization header
  bearer?: string | null;
  // Shared per-message deadline (ms epoch); the fetch budget is capped by the remaining time
  deadlineAt?: number;
  // Extra per-fetch cap below FETCH_TIMEOUT_MS (refresh/redeem stay at 10s)
  maxFetchMs?: number;
}

// Keep the fetch budget under SYNC_TIMEOUT_MS so the background answers before the UI→background
// message hop times out (a hung connection then reports 'unreachable' instead of a generic timeout)
const FETCH_TIMEOUT_MS = 28_000;

async function request(
  serverUrl: string,
  spaceKey: string | null,
  method: string,
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<SyncApiResult<unknown>> {
  // Bodyless requests (DELETE / no-body POST) must not carry a Content-Type or a body
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (spaceKey !== null) headers['X-Space-Key'] = spaceKey;
  if (opts?.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`;
  let budget = FETCH_TIMEOUT_MS;
  if (opts?.maxFetchMs !== undefined) budget = Math.min(budget, opts.maxFetchMs);
  if (opts?.deadlineAt !== undefined) {
    const remaining = opts.deadlineAt - Date.now();
    if (remaining <= 0) return { ok: false, error: { kind: 'timeout', sent: false } };
    budget = Math.min(budget, remaining);
  }
  let resp: Response;
  try {
    resp = await fetch(`${serverUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      signal: AbortSignal.timeout(budget),
    });
  } catch (error) {
    // AbortSignal.timeout aborts with TimeoutError/AbortError after dispatch; everything else
    // (DNS, refused connections, CORS blocks from a missing host permission) never sent anything
    if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return { ok: false, error: { kind: 'timeout', sent: true } };
    }
    return { ok: false, error: { kind: 'unreachable' } };
  }
  if (resp.status === 401) {
    // Two gates share this status: the sign-in gate answers AUTH_REQUIRED, the space-key check
    // answers BAD_SPACE_KEY (pre-auth servers have no code at all) — the code decides
    const code = await errorBodyCode(resp);
    return code === 'AUTH_REQUIRED'
      ? { ok: false, error: { kind: 'auth-required' } }
      : { ok: false, error: { kind: 'unauthorized' } };
  }
  if (resp.status === 204) return { ok: true, data: undefined };
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    payload = undefined;
  }
  if (!resp.ok) {
    const code = errorObjectCode(payload);
    return {
      ok: false,
      error: {
        kind: 'http',
        status: resp.status,
        code,
        message: errorObjectMessage(payload, resp.status),
      },
    };
  }
  return { ok: true, data: payload };
}

// The unified error envelope {"error":{code,message}} extracted once; anything else (non-JSON
// body, wrong shape) leaves this undefined and the readers below fall back
function errorObject(payload: unknown): Record<string, unknown> | undefined {
  return isPlainObject(payload) && isPlainObject(payload.error) ? payload.error : undefined;
}

function errorObjectCode(payload: unknown): string {
  const errBody = errorObject(payload);
  return errBody !== undefined && 'code' in errBody ? String(errBody.code) : 'UNKNOWN';
}

function errorObjectMessage(payload: unknown, status: number): string {
  const errBody = errorObject(payload);
  return errBody !== undefined && 'message' in errBody ? String(errBody.message) : `HTTP ${status}`;
}

async function errorBodyCode(resp: Response): Promise<string> {
  try {
    return errorObjectCode(await resp.json());
  } catch {
    return 'UNKNOWN';
  }
}

// Create is idempotent per key: the same (id, key) pair re-registers cleanly (device reinstall);
// an existing id under a different key is a 409 the caller surfaces as key-mismatch.
export async function createSpace(
  serverUrl: string,
  input: { id: string; key: string; name: string },
  opts?: RequestOptions,
): Promise<SyncApiResult<SpaceDto>> {
  return request(serverUrl, null, 'POST', '/api/spaces', input, opts) as Promise<SyncApiResult<SpaceDto>>;
}

// The join verification: the code is only stored locally when the server accepts it
export async function getSpace(
  serverUrl: string,
  spaceId: string,
  key: string,
  opts?: RequestOptions,
): Promise<SyncApiResult<SpaceDto>> {
  return request(
    serverUrl,
    key,
    'GET',
    `/api/spaces/${encodeURIComponent(spaceId)}`,
    undefined,
    opts,
  ) as Promise<SyncApiResult<SpaceDto>>;
}

export async function deleteSpace(
  serverUrl: string,
  spaceId: string,
  key: string,
  opts?: RequestOptions,
): Promise<SyncApiResult<undefined>> {
  return request(
    serverUrl,
    key,
    'DELETE',
    `/api/spaces/${encodeURIComponent(spaceId)}`,
    undefined,
    opts,
  ) as Promise<SyncApiResult<undefined>>;
}

export async function listScripts(
  serverUrl: string,
  key: string,
  spaceId: string,
  opts?: RequestOptions,
): Promise<SyncApiResult<ScriptDto[]>> {
  return request(
    serverUrl,
    key,
    'GET',
    `/api/spaces/${encodeURIComponent(spaceId)}/scripts`,
    undefined,
    opts,
  ) as Promise<SyncApiResult<ScriptDto[]>>;
}

export async function createScript(
  serverUrl: string,
  key: string,
  spaceId: string,
  input: { id: string; name: string; note: string; versionNote: string; flowContent: object },
  opts?: RequestOptions,
): Promise<SyncApiResult<ScriptDto>> {
  return request(
    serverUrl,
    key,
    'POST',
    `/api/spaces/${encodeURIComponent(spaceId)}/scripts`,
    input,
    opts,
  ) as Promise<SyncApiResult<ScriptDto>>;
}

export async function updateScript(
  serverUrl: string,
  key: string,
  spaceId: string,
  scriptId: string,
  input: { name?: string; note?: string },
  opts?: RequestOptions,
): Promise<SyncApiResult<ScriptDto>> {
  return request(
    serverUrl,
    key,
    'PATCH',
    `/api/spaces/${encodeURIComponent(spaceId)}/scripts/${encodeURIComponent(scriptId)}`,
    input,
    opts,
  ) as Promise<SyncApiResult<ScriptDto>>;
}

// The server allocates the next version number (MAX+1) under its write lock — version numbers stay
// strictly serial even when two devices publish concurrently.
export async function createScriptVersion(
  serverUrl: string,
  key: string,
  spaceId: string,
  scriptId: string,
  input: { versionNote: string; flowContent: object },
  opts?: RequestOptions,
): Promise<SyncApiResult<VersionMetaDto>> {
  return request(
    serverUrl,
    key,
    'POST',
    `/api/spaces/${encodeURIComponent(spaceId)}/scripts/${encodeURIComponent(scriptId)}/versions`,
    input,
    opts,
  ) as Promise<SyncApiResult<VersionMetaDto>>;
}

export async function listScriptVersions(
  serverUrl: string,
  key: string,
  spaceId: string,
  scriptId: string,
  opts?: RequestOptions,
): Promise<SyncApiResult<VersionMetaDto[]>> {
  return request(
    serverUrl,
    key,
    'GET',
    `/api/spaces/${encodeURIComponent(spaceId)}/scripts/${encodeURIComponent(scriptId)}/versions`,
    undefined,
    opts,
  ) as Promise<SyncApiResult<VersionMetaDto[]>>;
}

export async function getScriptVersion(
  serverUrl: string,
  key: string,
  spaceId: string,
  scriptId: string,
  versionNumber: number,
  opts?: RequestOptions,
): Promise<SyncApiResult<VersionDto>> {
  return request(
    serverUrl,
    key,
    'GET',
    `/api/spaces/${encodeURIComponent(spaceId)}/scripts/${encodeURIComponent(scriptId)}/versions/${versionNumber}`,
    undefined,
    opts,
  ) as Promise<SyncApiResult<VersionDto>>;
}

export async function getHealth(serverUrl: string): Promise<SyncApiResult<{ status: string }>> {
  return request(serverUrl, null, 'GET', '/api/health') as Promise<SyncApiResult<{ status: string }>>;
}

// --- public auth endpoints (Herald-gated servers); tokens only ever travel in POST bodies ---

export interface AuthConfigDto {
  enabled: boolean;
  loginUrl: string | null;
}

export async function getAuthConfig(serverUrl: string, opts?: RequestOptions): Promise<SyncApiResult<AuthConfigDto>> {
  return request(serverUrl, null, 'GET', '/api/auth/config', undefined, opts) as Promise<SyncApiResult<AuthConfigDto>>;
}

export interface TokenSetDto {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  tokenType: string;
}

export async function redeemToken(
  serverUrl: string,
  input: { handoffCode: string; handoffVerifier: string },
  opts?: RequestOptions,
): Promise<SyncApiResult<TokenSetDto>> {
  return request(serverUrl, null, 'POST', '/api/auth/redeem', input, opts) as Promise<SyncApiResult<TokenSetDto>>;
}

export async function refreshToken(
  serverUrl: string,
  token: string,
  opts?: RequestOptions,
): Promise<SyncApiResult<TokenSetDto>> {
  return request(serverUrl, null, 'POST', '/api/auth/refresh', { refreshToken: token }, opts) as Promise<
    SyncApiResult<TokenSetDto>
  >;
}

// Wire shape of redeem/refresh responses: five fields, non-empty tokens, positive finite TTLs,
// Bearer type. A malformed 200 is a contract break, never a usable session.
export function parseTokenSet(v: unknown): TokenSetDto | null {
  if (!isPlainObject(v)) return null;
  const { accessToken, refreshToken: refresh, expiresIn, refreshExpiresIn, tokenType } = v;
  if (typeof accessToken !== 'string' || accessToken === '') return null;
  if (typeof refresh !== 'string' || refresh === '') return null;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  if (typeof refreshExpiresIn !== 'number' || !Number.isFinite(refreshExpiresIn) || refreshExpiresIn <= 0) return null;
  if (tokenType !== 'Bearer') return null;
  return { accessToken, refreshToken: refresh, expiresIn, refreshExpiresIn, tokenType };
}

export const SPACE_CODE_SEPARATOR = '#';

export function spaceCodeOf(spaceId: string, key: string): string {
  return `${spaceId}${SPACE_CODE_SEPARATOR}${key}`;
}

// `<spaceId>#<key>` with the shapes produced by the generators below; anything else is rejected so
// typos surface as bad-code instead of a confusing server error
export function parseSpaceCode(raw: string): { id: string; key: string } | null {
  const hash = raw.indexOf(SPACE_CODE_SEPARATOR);
  if (hash <= 0 || hash !== raw.lastIndexOf(SPACE_CODE_SEPARATOR)) return null;
  const id = raw.slice(0, hash);
  const key = raw.slice(hash + 1);
  if (!/^sp-[A-Za-z0-9]{16}$/.test(id)) return null;
  if (!/^[A-Za-z0-9]{32}$/.test(key)) return null;
  return { id, key };
}

const BASE62_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomBase62(length: number): string {
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  let out = '';
  for (let i = 0; i < length; i++) out += BASE62_ALPHABET.charAt(values[i]! % BASE62_ALPHABET.length);
  return out;
}

// ~95 bits of entropy in the id (namespace + 16 base62 chars); the key carries ~190 bits (32 chars)
export function generateSpaceId(): string {
  return `sp-${randomBase62(16)}`;
}

export function generateSpaceKey(): string {
  return randomBase62(32);
}

export function generateScriptId(): string {
  return `sc-${randomBase62(16)}`;
}

// Server machine codes (SCREAMING_SNAKE) → extension reason vocabulary (kebab-case); unknown codes
// fall through to the generic lowercase transform so new server codes stay readable. A read that
// timed out reports unreachable (retryable); mutations are upgraded to operation-uncertain by the
// caller when the request had already been sent.
export function syncErrorToReason(error: SyncApiError): { reason: string; detail?: string } {
  if (error.kind === 'unreachable') return { reason: 'unreachable' };
  if (error.kind === 'timeout') return { reason: 'unreachable' };
  if (error.kind === 'unauthorized') return { reason: 'bad-space-key' };
  if (error.kind === 'auth-required') return { reason: 'sign-in-required' };
  return { reason: error.code.toLowerCase().replace(/_/g, '-'), detail: error.message };
}

// Normalize user input into a server origin: default https://, strip path/query, origin only
export function normalizeServerUrl(raw: string): string | null {
  const withScheme = raw.includes('://') ? raw : `https://${raw}`;
  return parseOrigin(withScheme);
}
