// Sync HTTP client — the extension's first and only network surface. All fetches live here and are
// called exclusively from the background service worker (UI never fetches). Hand-rolled on purpose:
// zero new dependencies. Paths are relative to the user-configured server origin; server errors use
// the unified body {"error":{"code","message"}}. With a host permission for the origin the SW fetch
// is exempt from CORS — a missing/revoked permission therefore surfaces as 'unreachable'.
//
// No-account model: every space-scoped call carries the space access key in the X-Space-Key header;
// entity ids (spaces, scripts) are client-generated opaque strings, and the space share code is
// `<spaceId>#<key>` produced and parsed here (single source for the format).
import { parseOrigin } from './flow-schema';

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
  | { kind: 'unauthorized' }
  | { kind: 'http'; status: number; code: string; message: string };

export type SyncApiResult<T> = { ok: true; data: T } | { ok: false; error: SyncApiError };

// Keep the fetch budget under SYNC_TIMEOUT_MS so the background answers before the UI→background
// message hop times out (a hung connection then reports 'unreachable' instead of a generic timeout)
const FETCH_TIMEOUT_MS = 28_000;

async function request(
  serverUrl: string,
  spaceKey: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<SyncApiResult<unknown>> {
  // Bodyless requests (DELETE / no-body POST) must not carry a Content-Type or a body
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (spaceKey !== null) headers['X-Space-Key'] = spaceKey;
  let resp: Response;
  try {
    resp = await fetch(`${serverUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    // Network layer failure covers DNS, refused connections, CORS blocks from a missing host
    // permission and the fetch timeout above
    return { ok: false, error: { kind: 'unreachable' } };
  }
  if (resp.status === 401) return { ok: false, error: { kind: 'unauthorized' } };
  if (resp.status === 204) return { ok: true, data: undefined };
  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    payload = undefined;
  }
  if (!resp.ok) {
    const errBody =
      payload !== undefined && typeof payload === 'object' && payload !== null && 'error' in payload
        ? (payload as { error: unknown }).error
        : undefined;
    const code =
      errBody !== undefined && typeof errBody === 'object' && errBody !== null && 'code' in errBody
        ? String((errBody as { code: unknown }).code)
        : 'UNKNOWN';
    const message =
      errBody !== undefined && typeof errBody === 'object' && errBody !== null && 'message' in errBody
        ? String((errBody as { message: unknown }).message)
        : `HTTP ${resp.status}`;
    return { ok: false, error: { kind: 'http', status: resp.status, code, message } };
  }
  return { ok: true, data: payload };
}

// Create is idempotent per key: the same (id, key) pair re-registers cleanly (device reinstall);
// an existing id under a different key is a 409 the caller surfaces as key-mismatch.
export async function createSpace(
  serverUrl: string,
  input: { id: string; key: string; name: string },
): Promise<SyncApiResult<SpaceDto>> {
  return request(serverUrl, null, 'POST', '/api/spaces', input) as Promise<SyncApiResult<SpaceDto>>;
}

// The join verification: the code is only stored locally when the server accepts it
export async function getSpace(serverUrl: string, spaceId: string, key: string): Promise<SyncApiResult<SpaceDto>> {
  return request(
    serverUrl,
    key,
    'GET',
    `/api/spaces/${encodeURIComponent(spaceId)}`,
  ) as Promise<SyncApiResult<SpaceDto>>;
}

export async function deleteSpace(serverUrl: string, spaceId: string, key: string): Promise<SyncApiResult<undefined>> {
  return request(
    serverUrl,
    key,
    'DELETE',
    `/api/spaces/${encodeURIComponent(spaceId)}`,
  ) as Promise<SyncApiResult<undefined>>;
}

export async function listScripts(serverUrl: string, key: string, spaceId: string): Promise<SyncApiResult<ScriptDto[]>> {
  return request(
    serverUrl,
    key,
    'GET',
    `/api/spaces/${encodeURIComponent(spaceId)}/scripts`,
  ) as Promise<SyncApiResult<ScriptDto[]>>;
}

export async function createScript(
  serverUrl: string,
  key: string,
  spaceId: string,
  input: { id: string; name: string; note: string; versionNote: string; flowContent: object },
): Promise<SyncApiResult<ScriptDto>> {
  return request(
    serverUrl,
    key,
    'POST',
    `/api/spaces/${encodeURIComponent(spaceId)}/scripts`,
    input,
  ) as Promise<SyncApiResult<ScriptDto>>;
}

export async function updateScript(
  serverUrl: string,
  key: string,
  spaceId: string,
  scriptId: string,
  input: { name?: string; note?: string },
): Promise<SyncApiResult<ScriptDto>> {
  return request(
    serverUrl,
    key,
    'PATCH',
    `/api/spaces/${encodeURIComponent(spaceId)}/scripts/${encodeURIComponent(scriptId)}`,
    input,
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
): Promise<SyncApiResult<VersionMetaDto>> {
  return request(
    serverUrl,
    key,
    'POST',
    `/api/spaces/${encodeURIComponent(spaceId)}/scripts/${encodeURIComponent(scriptId)}/versions`,
    input,
  ) as Promise<SyncApiResult<VersionMetaDto>>;
}

export async function listScriptVersions(
  serverUrl: string,
  key: string,
  spaceId: string,
  scriptId: string,
): Promise<SyncApiResult<VersionMetaDto[]>> {
  return request(
    serverUrl,
    key,
    'GET',
    `/api/spaces/${encodeURIComponent(spaceId)}/scripts/${encodeURIComponent(scriptId)}/versions`,
  ) as Promise<SyncApiResult<VersionMetaDto[]>>;
}

export async function getScriptVersion(
  serverUrl: string,
  key: string,
  spaceId: string,
  scriptId: string,
  versionNumber: number,
): Promise<SyncApiResult<VersionDto>> {
  return request(
    serverUrl,
    key,
    'GET',
    `/api/spaces/${encodeURIComponent(spaceId)}/scripts/${encodeURIComponent(scriptId)}/versions/${versionNumber}`,
  ) as Promise<SyncApiResult<VersionDto>>;
}

export async function getHealth(serverUrl: string): Promise<SyncApiResult<{ status: string }>> {
  return request(serverUrl, null, 'GET', '/api/health') as Promise<SyncApiResult<{ status: string }>>;
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
// fall through to the generic lowercase transform so new server codes stay readable
export function syncErrorToReason(error: SyncApiError): { reason: string; detail?: string } {
  if (error.kind === 'unreachable') return { reason: 'unreachable' };
  if (error.kind === 'unauthorized') return { reason: 'bad-space-key' };
  return { reason: error.code.toLowerCase().replace(/_/g, '-'), detail: error.message };
}

// Normalize user input into a server origin: default https://, strip path/query, origin only
export function normalizeServerUrl(raw: string): string | null {
  const withScheme = raw.includes('://') ? raw : `https://${raw}`;
  return parseOrigin(withScheme);
}
