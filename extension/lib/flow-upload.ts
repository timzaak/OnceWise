// Upload step runtime (support-http, DEC-support-http-001..006): the single source of truth for
// everything an `upload` node does after validation. Split of duties: the content side only gets the
// driver decorator (withUpload → ct:performUpload round trip, no fetch, no credential value ever in
// the page context); the background owns the executor (performUpload) and the device-local
// credential store (single writer via serializeStorageWrite). The vocabulary (node shape, URL /
// name rules, byte caps) lives in lib/step-schema.ts.
//
// Conservative semantics, same as every other side-effecting step: one attempt, no retry, no
// rollback. "Only ever less, never more" — a timeout counts as possibly-sent and is still not
// retried; a missing credential fails BEFORE any network activity.
import { DriverFailure, type FlowDriver } from './flow-compiler';
import {
  CONTROL_CHARS,
  flowDraftHash,
  isUploadRequestShape,
  isValidUploadCredentialName,
  MAX_UPLOAD_PAYLOAD_BYTES,
  uploadDeclarationsOf,
  type Flow,
  type UploadMethod,
} from './flow-schema';
import { sendRuntimeMessage, type ExtensionMessage, type ExtensionResponse, type UploadCredentialView } from './messaging';
import { loadFlows, serializeStorageWrite, uploadCredentialsItem } from './storage';

// Content-side message budget: the SW fetch may legitimately take the node's full timeoutMs; the
// 10s default message hop would cut it short (the SYNC_TIMEOUT_MS precedent)
export const UPLOAD_TIMEOUT_MARGIN_MS = 5_000;
// Single header value cap — one bearer/API key, not a document
export const UPLOAD_CREDENTIAL_VALUE_MAX = 4096;

// The six user-facing failure classes (each has its own i18n line). `bad-request` and
// `flow-mismatch` are defensive refusals a validated flow on the regular runtime never produces —
// they fall through the generic failure line. Single-sourced like UPLOAD_METHODS: the array is
// the authority, the type is derived from it.
export const UPLOAD_FAILURE_REASONS = [
  'credential-missing',
  'upload-network',
  'upload-status',
  'upload-timeout',
  'upload-response-too-large',
  'upload-payload-too-large',
] as const;

export type UploadFailureReason = (typeof UPLOAD_FAILURE_REASONS)[number];

export type UploadRefusal = 'bad-request' | 'flow-mismatch';

export interface UploadDriverRequest {
  url: string;
  method: UploadMethod;
  // Already resolved runtime values: GET values are String()-normalized by the compiler
  // (boolean → 'true'/'false'); POST keeps the runtime types for the fixed JSON mapping below
  payload: Record<string, unknown>;
  credentialName?: string;
  timeoutMs: number;
  // Present only when the node declares `capture`; the compiler always passes the engine cap
  captureMaxBytes?: number;
}

export type UploadOutcome =
  | { ok: true; status: number; body?: string }
  | { ok: false; reason: UploadFailureReason | UploadRefusal; detail?: string };

// What the content host closes over for the background's binding checks. Lazy, like
// HandoverHostMeta: the decorator wraps the driver before the run exists.
export interface UploadHostMeta {
  flowId: string;
  flowDraftHash: string;
}

// Nonce naming one upload request on both sides (ct:performUpload → ct:cancelUpload).
// getRandomValues rather than randomUUID: randomUUID is a secure-context-only API and the nonce is
// minted in the content script, which must not depend on the flow site being https
function newUploadId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Adds the upload capability to a driver. Must be the OUTERMOST decorator on the content side:
// withHandover forwards only read/act/waitUntil/handover, so wrapping it around this one would drop
// `upload` — hence handover is forwarded here explicitly.
export function withUpload(driver: FlowDriver, metaOf: () => UploadHostMeta | null): FlowDriver {
  return {
    read: (spec, scope, signal) => driver.read(spec, scope, signal),
    act: (spec, value, scope, signal) => driver.act(spec, value, scope, signal),
    waitUntil: (cond, timeoutMs, scope, evaluate, signal) =>
      driver.waitUntil(cond, timeoutMs, scope, evaluate, signal),
    ...(driver.handover !== undefined ? { handover: (req, signal) => driver.handover!(req, signal) } : {}),
    upload: async (req: UploadDriverRequest, signal: AbortSignal): Promise<UploadOutcome> => {
      // Side-effect guard, same rule as the DOM driver's act (flow-dom.ts): cancellation must never
      // let a queued upload out. Past this guard the run may still be cancelled while the hop is
      // out (flow paused / deleted / replaced, route left, page unload) — that cancellation is
      // forwarded as ct:cancelUpload so the background stops the request instead of letting a
      // request nobody wants any more run to its deadline. The request may already have left the
      // device by then: it is never retried either way, and the run is already stopping, so this
      // request's own outcome is never observed.
      if (signal.aborted) throw new DriverFailure('upload', 'aborted', req.url);
      const meta = metaOf();
      if (meta === null) throw new DriverFailure('upload', 'unsupported', req.url);
      const uploadId = newUploadId();
      const onCancel = (): void => {
        void sendRuntimeMessage({ type: 'ct:cancelUpload', uploadId }).catch(() => undefined);
      };
      signal.addEventListener('abort', onCancel, { once: true });
      let res;
      try {
        res = await sendRuntimeMessage(
          {
            type: 'ct:performUpload',
            uploadId,
            flowId: meta.flowId,
            flowDraftHash: meta.flowDraftHash,
            url: req.url,
            method: req.method,
            payload: req.payload,
            ...(req.credentialName !== undefined ? { credentialName: req.credentialName } : {}),
            timeoutMs: req.timeoutMs,
            ...(req.captureMaxBytes !== undefined ? { captureMaxBytes: req.captureMaxBytes } : {}),
          },
          req.timeoutMs + UPLOAD_TIMEOUT_MARGIN_MS,
        );
      } catch {
        // The hop timed out or the worker died mid-fetch: the outcome is unknown — treated as a
        // network failure, never retried (the request may already have landed). The background may
        // still be working towards the fetch, and this run will never read its answer: stop it the
        // same way a cancellation would (a dead worker has no registration left — a no-op there)
        onCancel();
        return { ok: false, reason: 'upload-network', detail: req.url };
      } finally {
        signal.removeEventListener('abort', onCancel);
      }
      if (res === undefined) return { ok: false, reason: 'upload-network', detail: req.url };
      if (!res.ok) {
        return {
          ok: false,
          reason: res.reason as UploadFailureReason | UploadRefusal,
          ...(res.detail !== undefined ? { detail: res.detail } : {}),
        };
      }
      if (res.upload === undefined) return { ok: false, reason: 'upload-network', detail: req.url };
      return { ok: true, status: res.upload.status, ...(res.upload.body !== undefined ? { body: res.upload.body } : {}) };
    },
  };
}

export interface ResolvedUploadCredential {
  headerName: string;
  value: string;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

const fail = (reason: UploadFailureReason, detail: string): UploadOutcome => ({ ok: false, reason, detail });

// Both abort sources of a request's one controller count as a timeout — "possibly sent": the
// node's own deadline (TimeoutError) and a run cancellation reaching the in-flight request
// (AbortError; the run is already stopping, so that outcome is never observed)
const isTimeoutAbort = (error: unknown): boolean =>
  error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');

// Streams the body up to maxBytes; null = exceeded (the partial read is discarded, never truncated
// into the slot — PRD §4.2).
async function readBodyBounded(resp: Response, maxBytes: number): Promise<string | null> {
  if (resp.body === null) {
    const text = await resp.text();
    return utf8Bytes(text) > maxBytes ? null : text;
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

// An unread body keeps its connection until it is consumed, cancelled or collected, and nothing
// else releases it once the outcome is known (the request's deadline is cleared with it): every
// path that leaves the body unread cancels it outright. Cancelling is not reading — none of it is
// parsed or kept
function discardBody(resp: Response): void {
  void resp.body?.cancel().catch(() => undefined);
}

// One controller per request: the deadline arms here and spans the whole fetch, body included,
// and a run cancellation aborts the same controller from the outside. A plain controller + timer
// instead of AbortSignal.timeout / AbortSignal.any — the Chrome 114 baseline predates .any()
export async function performUpload(
  req: UploadDriverRequest,
  credential: ResolvedUploadCredential | null,
  cancel?: AbortController,
): Promise<UploadOutcome> {
  const controller = cancel ?? new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new DOMException('upload deadline', 'TimeoutError')),
    req.timeoutMs,
  );
  try {
    return await fetchUpload(req, credential, controller.signal);
  } finally {
    clearTimeout(deadline);
  }
}

// The one network call of the feature. Transport policy is hard-coded, not configurable:
//   redirect 'error'   — a 3xx is a failure: the credential header never follows a redirect to a
//                        second destination and a POST is never replayed as a GET
//   credentials 'omit' — no cookies of the destination origin ride along; the declared single
//                        header is the only authentication
//   cache 'no-store'   — a request carrying a credential never enters the HTTP cache
// Serialization and the request-size cap happen BEFORE fetch (zero egress on overflow). The
// error body of a non-2xx is never read or parsed (PRD §4.2); the success body is read only when
// the node declared capture, streamed under the cap.
async function fetchUpload(
  req: UploadDriverRequest,
  credential: ResolvedUploadCredential | null,
  signal: AbortSignal,
): Promise<UploadOutcome> {
  const headers: Record<string, string> = {};
  if (credential !== null) headers[credential.headerName] = credential.value;
  let url = req.url;
  let body: string | undefined;
  if (req.method === 'GET') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.payload)) params.append(key, String(value));
    const query = params.toString();
    if (utf8Bytes(query) > MAX_UPLOAD_PAYLOAD_BYTES) return fail('upload-payload-too-large', req.url);
    if (query.length > 0) url = `${url}?${query}`;
  } else {
    body = JSON.stringify(req.payload);
    if (utf8Bytes(body) > MAX_UPLOAD_PAYLOAD_BYTES) return fail('upload-payload-too-large', req.url);
    headers['Content-Type'] = 'application/json';
  }
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: req.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (error) {
    if (isTimeoutAbort(error)) return fail('upload-timeout', req.url);
    return fail('upload-network', req.url);
  }
  if (resp.status < 200 || resp.status > 299) {
    discardBody(resp);
    return fail('upload-status', String(resp.status));
  }
  if (req.captureMaxBytes === undefined) {
    discardBody(resp);
    return { ok: true, status: resp.status };
  }
  const declared = resp.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > req.captureMaxBytes) {
      discardBody(resp);
      return fail('upload-response-too-large', req.url);
    }
  }
  let captured: string | null;
  try {
    captured = await readBodyBounded(resp, req.captureMaxBytes);
  } catch (error) {
    // The timeout signal spans the whole fetch, body included: headers may have arrived at 2xx
    // while a slow body crosses the deadline and aborts the stream mid-read. Same classification
    // as the fetch phase — the request itself may already have been delivered
    if (isTimeoutAbort(error)) return fail('upload-timeout', req.url);
    return fail('upload-network', req.url);
  }
  if (captured === null) return fail('upload-response-too-large', req.url);
  return { ok: true, status: resp.status, body: captured };
}

// In-flight uploads by their nonce. handlePerformUpload registers its controller at its entry —
// before the first await — so a cancel that lands while the binding checks are still reading
// storage already finds its target. Worker memory only, nothing persisted: a terminated worker
// takes its own fetches down with it, and a cancel naming an unknown (settled or never seen) id is
// a no-op
const inFlightUploads = new Map<string, { controller: AbortController; tabId: number | undefined }>();

export function cancelUpload(uploadId: string): void {
  inFlightUploads.get(uploadId)?.controller.abort();
}

// Closing the tab: the content script's own ct:cancelUpload may not get out of a dying document
export function abortUploadsByTab(tabId: number): void {
  for (const entry of inFlightUploads.values()) {
    if (entry.tabId === tabId) entry.controller.abort();
  }
}

// The ct:performUpload adjudication (DEC-support-http-002/003/006) — the background router only
// forwards the sender origin it alone knows. Check chain, in order:
//   1. shape — the payload guard already ran in onMessage; the same rule is re-applied here so
//      this handler can never become a generic proxy for a caller that bypassed the guard;
//   2. binding — the request must come from this site's enabled flow at its current draft hash AND
//      the (url, method, credentialName) triple must be one of that flow's own declared upload
//      steps: a credential can only ever travel to a destination the validated flow names. There
//      is no looser leg: the extension has no preview entry (baseline FR7), so nothing legitimate
//      ever sends on behalf of a flow that is not the enabled, current one;
//   3. credential — resolved BEFORE any network: a missing name fails with zero egress.
// `flowsOf` is injectable so the chain is unit-testable without the background entrypoint.
export type PerformUploadMessage = Extract<ExtensionMessage, { type: 'ct:performUpload' }>;

export async function handlePerformUpload(
  msg: PerformUploadMessage,
  origin: string,
  flowsOf: () => Promise<Flow[]> = loadFlows,
  tabId?: number,
): Promise<ExtensionResponse> {
  if (!isUploadRequestShape(msg as unknown as Record<string, unknown>)) return { ok: false, reason: 'bad-request' };
  // A replayed nonce must not displace (or later delete) a live request's registration
  if (inFlightUploads.has(msg.uploadId)) return { ok: false, reason: 'bad-request' };
  const controller = new AbortController();
  inFlightUploads.set(msg.uploadId, { controller, tabId });
  try {
    const flow = (await flowsOf()).find((r) => r.id === msg.flowId);
    if (flow === undefined || flow.site !== origin || flow.status !== 'enabled' || flowDraftHash(flow) !== msg.flowDraftHash) {
      return { ok: false, reason: 'flow-mismatch' };
    }
    const declared = uploadDeclarationsOf(flow.steps).some(
      (d) => d.url === msg.url && d.method === msg.method && d.credential === msg.credentialName,
    );
    if (!declared) return { ok: false, reason: 'flow-mismatch' };
    let credential: ResolvedUploadCredential | null = null;
    if (msg.credentialName !== undefined) {
      credential = await resolveUploadCredential(msg.credentialName);
      if (credential === null) return { ok: false, reason: 'credential-missing', detail: msg.credentialName };
    }
    const outcome = await performUpload(
      {
        url: msg.url,
        method: msg.method,
        payload: msg.payload,
        ...(msg.credentialName !== undefined ? { credentialName: msg.credentialName } : {}),
        timeoutMs: msg.timeoutMs,
        ...(msg.captureMaxBytes !== undefined ? { captureMaxBytes: msg.captureMaxBytes } : {}),
      },
      credential,
      controller,
    );
    if (!outcome.ok) return { ok: false, reason: outcome.reason, ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}) };
    return { ok: true, upload: { status: outcome.status, ...(outcome.body !== undefined ? { body: outcome.body } : {}) } };
  } finally {
    inFlightUploads.delete(msg.uploadId);
  }
}

// RFC 7230 token syntax for the header name, minus the names fetch itself forbids (and the proxy-/
// sec- prefixes): a credential record must not become a channel for protocol-header hijacking or
// cookie smuggling. Authorization / X-API-Key and other self-named headers stay legal (DEC-005).
// The last two entries are this feature's own invariants, not fetch rules: a POST always sets its
// own Content-Type (a credential named Content-Type would be silently overwritten or merged away),
// and __proto__ hits the plain-object assignment trap below (the header would never attach).
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_HEADER_NAMES = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  '__proto__',
]);

export function isValidUploadHeaderName(name: unknown): name is string {
  if (typeof name !== 'string' || !HEADER_TOKEN.test(name)) return false;
  const lower = name.toLowerCase();
  if (FORBIDDEN_HEADER_NAMES.has(lower)) return false;
  return !lower.startsWith('proxy-') && !lower.startsWith('sec-');
}

// No control characters at all (CR/LF would split the header — injection line), and Latin-1 only:
// header values are ByteStrings — a codepoint above 0xFF makes the Headers construction throw
// (TypeError, not a DOMException) and the upload would be misreported as a network failure
const HEADER_VALUE_CHARS = /^[\u0000-\u00FF]*$/;
export function isValidUploadCredentialValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= UPLOAD_CREDENTIAL_VALUE_MAX &&
    !CONTROL_CHARS.test(value) &&
    HEADER_VALUE_CHARS.test(value)
  );
}

export async function listUploadCredentials(): Promise<UploadCredentialView[]> {
  const all = await uploadCredentialsItem.getValue();
  return Object.entries(all)
    .map(([name, record]) => ({ name, headerName: record.headerName, createdAt: record.createdAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type SaveUploadCredentialResult =
  | { ok: true }
  | { ok: false; reason: 'invalid-name' | 'invalid-header' | 'invalid-value' };

// Upsert: the name is the key, so saving an existing name overwrites its header/value and keeps
// the original createdAt
export function saveUploadCredential(input: {
  name: unknown;
  headerName: unknown;
  value: unknown;
}): Promise<SaveUploadCredentialResult> {
  if (!isValidUploadCredentialName(input.name)) return Promise.resolve({ ok: false, reason: 'invalid-name' });
  if (!isValidUploadHeaderName(input.headerName)) return Promise.resolve({ ok: false, reason: 'invalid-header' });
  if (!isValidUploadCredentialValue(input.value)) return Promise.resolve({ ok: false, reason: 'invalid-value' });
  const name = input.name;
  const headerName = input.headerName;
  const value = input.value;
  return serializeStorageWrite(async () => {
    const all = { ...(await uploadCredentialsItem.getValue()) };
    const existing = all[name];
    all[name] = { headerName, value, createdAt: existing?.createdAt ?? Date.now() };
    await uploadCredentialsItem.setValue(all);
    return { ok: true };
  });
}

export function deleteUploadCredential(name: string): Promise<{ ok: true } | { ok: false; reason: 'not-found' }> {
  return serializeStorageWrite(async () => {
    const all = { ...(await uploadCredentialsItem.getValue()) };
    if (!Object.prototype.hasOwnProperty.call(all, name)) return { ok: false, reason: 'not-found' };
    delete all[name];
    await uploadCredentialsItem.setValue(all);
    return { ok: true };
  });
}

// The only read that returns a value — consumed by the background upload handler right before
// fetch, never by a UI message
export async function resolveUploadCredential(name: string): Promise<ResolvedUploadCredential | null> {
  const all = await uploadCredentialsItem.getValue();
  if (!Object.prototype.hasOwnProperty.call(all, name)) return null;
  const record = all[name]!;
  return { headerName: record.headerName, value: record.value };
}
