// Native Messaging channel: the AI-side client talks to a local host launched by Chrome; the
// extension holds the other end of the port and is the ONLY writer and validator of flows. The op
// surface is a closed whitelist — enable, delete, rollback, list, browser and script are not on the
// channel (destructive and user-reserved actions are never AI-callable); unknown ops answer
// unsupported-op with zero side effects. The host validates requests too
// (skills/oncewise-message/protocol.mjs) — both layers enforce the same envelope, op and size
// constraints independently.
//
// Port lifecycle: connected synchronously at background start; on disconnect a rate-limited backoff
// reconnects (a missing host must not spawn a restart loop). The in-memory connected flag is UI
// display state only — it is never a persistence fact.
import { browser } from 'wxt/browser';
import { createLogger } from './logger';
import { importFlowText } from './import-pipeline';
import {
  describePage,
  describePages,
  describeTrigger,
  describeSteps,
  isPlainObject,
  SCHEMA_VERSION,
  type Flow,
} from './flow-schema';
import {
  lastNativeSaveItem,
  loadFlows,
  nativeReadGrantActive,
  nativeReadGrantItem,
  nativeSaveRecord,
  nativeVerifyRecord,
} from './storage';
import { afterFlowsWrite } from './site-scripts';

type Port = ReturnType<typeof browser.runtime.connectNative>;

const HOST_NAME = 'ai.oncewise.native';

const log = createLogger('native');
const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 512 * 1024;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

type NativeRequest = { id: string | number; op: string; payload: Record<string, unknown> | undefined };
type NativeResponse =
  | { v: typeof PROTOCOL_VERSION; id: string | number | null; ok: true; data?: Record<string, unknown> }
  | { v: typeof PROTOCOL_VERSION; id: string | number | null; ok: false; error: { code: string; message: string; errors?: string[] } };

let port: Port | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let connected = false;

export function isNativeChannelConnected(): boolean {
  return connected;
}

function post(response: NativeResponse): void {
  try {
    port?.postMessage(response);
  } catch (error) {
    // The port died mid-response — onDisconnect will schedule the reconnect
    log.debug('port died mid-response', error);
  }
}

function respondOk(id: string | number, data?: Record<string, unknown>): void {
  post({ v: PROTOCOL_VERSION, id, ok: true, ...(data !== undefined ? { data } : {}) });
}

function respondError(id: string | number | null, code: string, message: string, errors?: string[]): void {
  post({ v: PROTOCOL_VERSION, id, ok: false, error: { code, message, ...(errors !== undefined ? { errors } : {}) } });
}

// Extension-side clientRef parsing (the host/client share skills/oncewise-message/protocol.mjs;
// this is the independent second implementation by design): "<issuedAt-ms>.<32 hex chars>".
export function parseClientRef(ref: unknown): { issuedAt: number; random: string } | null {
  if (typeof ref !== 'string') return null;
  const match = /^(\d{1,15})\.([0-9a-f]{32})$/.exec(ref);
  return match === null ? null : { issuedAt: Number(match[1]), random: match[2]! };
}

// importFlowText refusals map to channel errors identically for flow.validate and flow.save — one
// mapping so the validation preview and the save can never disagree on what the AI sees.
function importFailureError(result: { reason: 'not-json' | 'invalid-flow'; errors: string[] }): { code: string; message: string; errors: string[] } {
  const code = result.reason === 'not-json' ? 'not-json' : 'validation-failed';
  return {
    code,
    message: code === 'not-json' ? result.errors[0] ?? 'not valid JSON' : 'flow rejected by full validation',
    errors: result.errors,
  };
}

// Envelope + payload guard: v, id, op whitelist, payload shape, application size cap. Exported for
// the Vitest suite (tests/native-messaging.test.ts).
export function checkRequest(raw: unknown): { ok: true; request: NativeRequest } | { ok: false; id: string | number | null; code: string; message: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, id: null, code: 'bad-payload', message: 'request must be an object' };
  }
  const v = raw as Record<string, unknown>;
  const id = typeof v.id === 'string' || typeof v.id === 'number' ? v.id : null;
  if (v.v !== PROTOCOL_VERSION) return { ok: false, id, code: 'bad-payload', message: `v must be ${PROTOCOL_VERSION}` };
  if (id === null) return { ok: false, id: null, code: 'bad-payload', message: 'id must be a string or number' };
  if (typeof v.op !== 'string') return { ok: false, id, code: 'unsupported-op', message: 'op must be a string' };
  if (v.op !== 'ping' && v.op !== 'flow.read' && v.op !== 'flow.validate' && v.op !== 'flow.save' && v.op !== 'flow.verify') {
    return { ok: false, id, code: 'unsupported-op', message: `op "${v.op}" is not part of the native channel` };
  }
  if (v.payload !== undefined && !isPlainObject(v.payload)) {
    return { ok: false, id, code: 'bad-payload', message: 'payload must be an object' };
  }
  if (JSON.stringify(v).length > MAX_REQUEST_BYTES) {
    return { ok: false, id, code: 'payload-too-large', message: `request exceeds ${MAX_REQUEST_BYTES} bytes` };
  }
  return { ok: true, request: { id, op: v.op, payload: v.payload as Record<string, unknown> | undefined } };
}

// The op surface behind the port handler. Exported for the Vitest suite (tests/native-messaging.test.ts)
// — the module's only other consumer is handleNativeMessage, which adds the envelope echo.
export async function dispatchOp(op: string, payload: Record<string, unknown> | undefined): Promise<{ data?: Record<string, unknown>; error?: { code: string; message: string; errors?: string[] } }> {
  switch (op) {
    case 'ping': {
      // No flow enumeration — only the schema version and, when present, the active read grant
      const grant = await nativeReadGrantItem.getValue();
      const active = grant !== null && nativeReadGrantActive(grant, grant.flowId);
      return {
        data: {
          schemaVersion: SCHEMA_VERSION,
          ...(active ? { readGrant: { flowId: grant.flowId } } : {}),
        },
      };
    }

    case 'flow.read': {
      const flowId = payload?.flowId;
      if (typeof flowId !== 'string' || flowId.length === 0) {
        return { error: { code: 'bad-payload', message: 'flowId must be a non-empty string' } };
      }
      const grant = await nativeReadGrantItem.getValue();
      if (!nativeReadGrantActive(grant, flowId)) {
        return { error: { code: 'read-not-authorized', message: 'no active read grant for this flow (the user must start "Improve with AI" in the sidepanel; grants last 15 minutes)' } };
      }
      const flow = (await loadFlows()).find((r) => r.id === flowId);
      if (flow === undefined) return { error: { code: 'flow-not-found', message: 'flow not found' } };
      return { data: { flow, updatedAt: flow.provenance.updatedAt } };
    }

    case 'flow.validate': {
      const text = payload?.text;
      if (typeof text !== 'string') return { error: { code: 'bad-payload', message: 'text must be a string' } };
      const result = importFlowText(text);
      if (!result.ok) return { error: importFailureError(result) };
      return { data: summarizeDraft(result.draft, result.hadEnvelope) };
    }

    case 'flow.save': {
      const text = payload?.text;
      const clientRef = payload?.clientRef;
      const flowId = payload?.flowId;
      const expectedUpdatedAt = payload?.expectedUpdatedAt;
      if (typeof text !== 'string' || typeof clientRef !== 'string') {
        return { error: { code: 'bad-payload', message: 'text and clientRef must be strings' } };
      }
      if (flowId !== undefined && typeof flowId !== 'string') {
        return { error: { code: 'bad-payload', message: 'flowId must be a string' } };
      }
      if (expectedUpdatedAt !== undefined && !Number.isSafeInteger(expectedUpdatedAt)) {
        return { error: { code: 'bad-payload', message: 'expectedUpdatedAt must be an integer' } };
      }
      if (flowId !== undefined && expectedUpdatedAt === undefined) {
        return { error: { code: 'bad-payload', message: 'a replacement needs expectedUpdatedAt (read it via flow.read)' } };
      }
      const parsedRef = parseClientRef(clientRef);
      if (parsedRef === null) {
        return { error: { code: 'bad-payload', message: 'clientRef must be "<issuedAt-ms>.<32 hex chars>"' } };
      }
      // No save confirmation gate lives here (DEC-007): the AI obtained the user's explicit
      // confirmation in the conversation before sending; validation still happens in full below.
      const validated = importFlowText(text);
      if (!validated.ok) return { error: importFailureError(validated) };
      const outcome = await nativeSaveRecord({
        draft: validated.draft,
        text,
        clientRef,
        issuedAt: parsedRef.issuedAt,
        ...(flowId !== undefined ? { flowId, expectedUpdatedAt: expectedUpdatedAt as number } : {}),
      });
      if (!outcome.ok) {
        const messages: Record<typeof outcome.reason, string> = {
          'ref-expired': 'this clientRef is older than the receipt retention watermark — re-check the extension state and mint a new ref after a fresh user confirmation',
          'clock-regressed': 'this clientRef was issued before the newest accepted save — re-check the extension state and mint a new ref after a fresh user confirmation',
          'bad-ref-time': 'clientRef issuedAt is too far in the future',
          'ref-conflict': 'this clientRef was already used for a different payload — a confirmation always mints a new ref',
          'flow-not-found': 'the flow to replace no longer exists',
          'revision-stale': 'the flow changed after it was read (modified, re-enabled or deleted meanwhile) — re-read and re-confirm',
          'flow-enabled': 'the flow to replace is enabled — pause it before replacing',
        };
        return { error: { code: outcome.reason, message: messages[outcome.reason] } };
      }
      if (outcome.replayed) {
        // Idempotent replay: no new version — the stored receipt answers with its original identity
        await lastNativeSaveItem.setValue({
          flowId: outcome.receipt.flowId,
          clientRef,
          savedAt: outcome.receipt.savedAt,
          replayed: true,
        });
        return {
          data: {
            flowId: outcome.receipt.flowId,
            status: 'draft' as const,
            updatedAt: outcome.receipt.updatedAt,
            replayed: true,
          },
        };
      }
      // A successful replace cleared the read grant inside the save (its snapshot is stale); the
      // shared post-write step realigns site scripts and reloads open flow-site tabs
      await afterFlowsWrite();
      await lastNativeSaveItem.setValue({
        flowId: outcome.flow.id,
        clientRef,
        savedAt: Date.now(),
        replayed: false,
      });
      return {
        data: {
          flowId: outcome.flow.id,
          name: outcome.flow.name,
          status: 'draft' as const,
          updatedAt: outcome.flow.provenance.updatedAt,
          replayed: false,
        },
      };
    }

    case 'flow.verify': {
      const clientRef = payload?.clientRef;
      if (typeof clientRef !== 'string') {
        return { error: { code: 'bad-payload', message: 'clientRef must be a string' } };
      }
      const parsedRef = parseClientRef(clientRef);
      if (parsedRef === null) {
        return { error: { code: 'bad-payload', message: 'clientRef must be "<issuedAt-ms>.<32 hex chars>"' } };
      }
      const result = await nativeVerifyRecord(clientRef, parsedRef.issuedAt);
      if (!result.ok) {
        if (result.reason === 'unconfirmed') {
          // Unknown ref says ONLY that it cannot be confirmed — it must never be read as "not saved"
          return { error: { code: 'result-unknown', message: 'no receipt for this clientRef within the retention window — the save outcome cannot be confirmed; re-check the flow state before retrying' } };
        }
        return { error: { code: result.reason, message: `clientRef rejected: ${result.reason}` } };
      }
      return {
        data: {
          confirmed: true,
          receipt: result.receipt,
          flowStatus: result.flowStatus,
          updatedAt: result.updatedAt,
        },
      };
    }

    default:
      return { error: { code: 'unsupported-op', message: `op "${op}" is not part of the native channel` } };
  }
}

function summarizeDraft(draft: Flow, hadEnvelope: boolean): Record<string, unknown> {
  // Readable summary for the in-conversation confirmation: site, page match, trigger and the
  // action list with submit-class actions flagged; no envelope fields
  return {
    name: draft.name,
    site: draft.site,
    page: describePages(draft),
    trigger: describeTrigger(draft),
    steps: describeSteps(draft.steps).map((step) => ({ text: step.text, submit: step.submit === true })),
    ...(hadEnvelope ? { envelopeIgnored: true } : {}),
  };
}

function handleNativeMessage(raw: unknown): void {
  // The first frame received is the proof the host actually serves — only now may the reconnect
  // backoff restart (resetting on connect alone turns a missing host into a steady 1 Hz retry loop).
  reconnectAttempts = 0;
  const checked = checkRequest(raw);
  if (!checked.ok) {
    respondError(checked.id, checked.code, checked.message);
    return;
  }
  const { id, op, payload } = checked.request;
  void (async () => {
    try {
      const result = await dispatchOp(op, payload);
      if (result.error !== undefined) {
        respondError(id, result.error.code, result.error.message, result.error.errors);
      } else {
        respondOk(id, result.data);
      }
    } catch (error) {
      // The op name is logged, never the payload — payloads carry flow text
      log.error('native op failed', op, error);
      respondError(id, 'storage-error', 'the flow store could not be read or written');
    }
  })();
}

function scheduleReconnect(): void {
  const delay = Math.min(RECONNECT_MIN_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts += 1;
  log.debug(`reconnect attempt ${reconnectAttempts} in ${delay}ms`);
  reconnectTimer = setTimeout(connectNativeChannel, delay);
}

export function connectNativeChannel(): void {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  try {
    port = browser.runtime.connectNative(HOST_NAME);
  } catch (error) {
    log.warn('connectNative threw', error);
    connected = false;
    port = null;
    scheduleReconnect();
    return;
  }
  port.onMessage.addListener(handleNativeMessage);
  port.onDisconnect.addListener((disconnected) => {
    // chrome.runtime.Port.error (absent from the polyfill's Port type) carries the disconnect reason
    const reason = (disconnected as { error?: { message?: string } }).error?.message ?? 'no reason given';
    log.warn(`native host disconnected (${reason})`);
    connected = false;
    port = null;
    scheduleReconnect();
  });
  log.debug('native port opened');
  // A port that connects is considered up until Chrome says otherwise; the first message exchange is
  // the real proof (ping resets the backoff there), and the in-memory flag is display state only
  connected = true;
}
