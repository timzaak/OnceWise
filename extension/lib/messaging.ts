// All message names, payloads, response types and type guards live in this single file. wxt 0.21.3 ships no
// messaging helper (defineExtensionMessaging does not exist), so this is a hand-rolled thin wrapper over
// browser.runtime.sendMessage / browser.tabs.sendMessage with the same semantics and zero new dependencies.
// The messaging layer never auto-retries (conservative abort; the UI offers manual retry). Request-response
// defaults to a 10s timeout.
//
// Prefixes: sp: = extension UI page → background (sidepanel / import page — DEC-015 caller
// generalization); bg: = UI-initiated routing to the active flow-site tab; ct: = content → background.
import { browser } from 'wxt/browser';
import { createLogger } from './logger';
import type { Flow, RunFailureDetail } from './flow-schema';
import { isPlainObject, parseOrigin } from './flow-schema';
import type { InputIssue, InputSnapshot } from './flow-inputs';
import type { FlowOutcome } from './flow-compiler';
import type { PendingHandover, HandoverDescriptor } from './flow-handover';
import type { ScriptDto, VersionMetaDto } from './sync-api';
import type { SyncSpaceEntry } from './sync-storage';
import type { FlowHistoryMeta } from './storage';

export type ExtensionMessage =
  // extension UI pages (sidepanel / import page) -> background (request-response)
  | { type: 'sp:getFlows' }
  // expectedUpdatedAt is the editor's compare-and-swap token: passing it makes an update of an
  // existing flow refuse with reason 'changed' when the flow was revised after the editor opened
  // (AI revision, sync pull); the create path omits it. The ok response carries the freshly stamped
  // updatedAt so the editor can save again.
  | { type: 'sp:saveFlow'; flow: unknown; expectedUpdatedAt?: number }
  | { type: 'sp:setFlowStatus'; id: string; status: 'draft' | 'enabled' | 'paused' }
  | { type: 'sp:deleteFlow'; id: string }
  // native channel UI surface: grant the time-limited single-flow read behind flow.read (the
  // sidepanel's "Improve with AI" pause+grant flow), poll the port state for the import page hint,
  // and the user-only local history/rollback views
  | { type: 'sp:grantNativeRead'; flowId: string }
  | { type: 'sp:getNativeChannelState' }
  | { type: 'sp:getFlowHistory'; flowId: string }
  | { type: 'sp:rollbackFlow'; flowId: string; versionId: number }
  // form-support: flow-detail input value read/save. values is the WHOLE form mapping; unfilled items
  // are expressed by key absence. background validates against the current definitions (single writer).
  | { type: 'sp:getFlowInputs'; flowId: string }
  | { type: 'sp:saveFlowInputs'; flowId: string; values: Record<string, unknown> }
  // data-sync: sp:sync* — all handled by lib/sync-service.ts in the background (fetch + space
  // bookkeeping); the UI hop uses SYNC_TIMEOUT_MS instead of the 10s default. No accounts: spaces are
  // locally generated id+key pairs, the UI never sees keys except through SyncSpaceView.code.
  | { type: 'sp:syncGetStatus' }
  | { type: 'sp:syncProbeHealth' }
  | { type: 'sp:syncSetServer'; serverUrl: string }
  | { type: 'sp:syncCreateSpace'; name: string }
  | { type: 'sp:syncJoinSpace'; code: string }
  | { type: 'sp:syncSelectSpace'; spaceId: string }
  | { type: 'sp:syncForgetSpace'; spaceId: string }
  | { type: 'sp:syncDeleteSpace'; spaceId: string }
  | { type: 'sp:syncListScripts'; spaceId: string }
  | { type: 'sp:syncListVersions'; spaceId: string; scriptId: string }
  | { type: 'sp:syncPreviewVersion'; spaceId: string; scriptId: string; versionNumber: number }
  | { type: 'sp:syncPullVersion'; spaceId: string; scriptId: string; versionNumber: number }
  | { type: 'sp:syncUploadScript'; flowId: string; name: string; note: string; versionNote: string }
  | { type: 'sp:syncPublishVersion'; flowId: string; versionNote: string }
  | { type: 'sp:syncUpdateScript'; flowId: string; name?: string; note?: string }
  | { type: 'sp:syncUnlink'; flowId: string }
  // Herald-gated servers: the sign-in lifecycle lives in lib/sync-auth.ts in the background. The
  // messages carry no URL, token or proof — the SW builds the safe navigation itself; the auth
  // state that comes back is non-secret facts only (mode + signedIn).
  | { type: 'sp:syncGetAuthState' }
  | { type: 'sp:syncSignIn' }
  | { type: 'sp:syncSignOut' }
  // background <-> content (when initiated by an extension page, background routes to the active flow-site tab)
  // The preview runs on the same XState runtime as automatic execution
  | { type: 'bg:startDryRun'; flow: Flow }
  | { type: 'bg:abortDryRun' }
  | { type: 'bg:getContentState' }
  | { type: 'bg:reloadFlows' }
  // A handover was staged for a page this tab is already showing (target=_blank race compensation):
  // re-pull the descriptors and re-evaluate locally
  | { type: 'bg:handoverStaged' }
  // content -> background (events; getEnabledFlows, claimBusiness and releaseBusiness are request-response)
  | { type: 'ct:getEnabledFlows' }
  // Cross-page handover: stage the run state at a navigate node, poll it from the waiting source,
  // atomically claim it from the declaring page, drop it on timeout/abort. sourceTabId in the
  // staged payload is ignored — the background stamps the real sender tab.
  | { type: 'ct:stageHandover'; handover: PendingHandover }
  | { type: 'ct:probeHandover'; runId: string }
  | { type: 'ct:takeHandover'; runId: string }
  | { type: 'ct:dropHandover'; runId: string }
  // form-support: run-start input snapshot — background checks the sender site and, for automatic
  // runs, the flow status and draft hash; a dry-run preview (dryRun: true) carries the editor's flow
  // (typically a draft or unsaved edits), so it must pass only the site check and its refusals never
  // write the automatic-run failure notice. Background evaluates saved values against the current
  // definitions and returns the snapshot only when every item is filled/valid; otherwise the flow
  // skips with zero page actions
  | { type: 'ct:getInputSnapshot'; flowId: string; flowDraftHash: string; dryRun?: boolean }
  | { type: 'ct:claimBusiness'; site: string; flowId: string; businessKey: string }
  // Gives back a claim whose run never started (mutex refusal / route left mid round-trip)
  | { type: 'ct:releaseBusiness'; site: string; flowId: string; businessKey: string }
  | { type: 'ct:flowRunStatus'; flowId: string; flowDraftHash: string; failure?: RunFailureDetail }
  // Preview progress: the actually-executed path (run/node ids and loop positions), never a
  // pre-assumed step total — loop lengths are page data, unknown before the run
  | {
      type: 'ct:dryRunProgress';
      runId: string;
      phase: 'run-start' | 'node-start' | 'node-ok' | 'run-end';
      resumed?: boolean;
      nodeId?: string;
      nodeKind?: 'read' | 'action' | 'wait' | 'navigate';
      iterationPath?: string;
      executed?: number;
      highlight?: string;
      outcome?: FlowTerminal;
      failure?: RunFailureDetail;
    }
  | {
      type: 'ct:dryRunFinished';
      flowDraftHash: string;
      runId: string;
      ok: boolean;
      // The reportable terminals only: a run that handed over to another document never sends
      // this message (the final document reports the real terminal)
      outcome: 'completed' | 'failed' | 'cancelled';
      detail?: string;
      failure?: RunFailureDetail;
    };

// Steps run terminals (the machine's final states) — the runtime's FlowOutcome is the
// single definition; the payload guard below still validates the literal list against forged messages
export type FlowTerminal = FlowOutcome;

export interface ContentStateView {
  dryRun: boolean;
  url: string;
  origin: string;
  // Fingerprint target of the current page (pathname + hash without query)
  pageTarget: string;
}

// What the sync tab renders from: local config + current selection. `code` is the shareable
// `spaceId#key` pair — the extension's own pages may display it, nothing else ever receives it.
export interface SyncSpaceView {
  id: string;
  name: string;
  createdAt: string;
  code: string;
}

export interface SyncStateView {
  serverUrl: string;
  spaces: SyncSpaceView[];
  currentSpaceId: string | null;
}

// Non-secret sign-in facts for the sync tab's auth card: 'unknown' means the mode probe could not
// establish the server's auth mode (probe failure is never treated as none)
export interface SyncAuthView {
  mode: 'herald' | 'none' | 'unknown';
  signedIn: boolean;
}

// The local join of a space script with the local pinning link (undefined when not linked)
export interface ScriptLocalInfo {
  flowId: string;
  pinnedVersionNumber: number;
  localFlowExists: boolean;
  hasLocalEdits: boolean;
  newVersionAvailable: boolean;
}

export interface ScriptRowView extends ScriptDto {
  local?: ScriptLocalInfo;
}

// Pull-side preview summary (describe* + redactText applied on the background side)
export interface VersionPreviewView {
  name: string;
  site: string;
  pageDesc: string;
  triggerDesc: string;
  actions: { text: string; submit: boolean }[];
  hasSubmit: boolean;
}

export type ExtensionResponse =
  | {
      ok: true;
      flows?: Flow[];
      state?: ContentStateView;
      options?: string[];
      started?: boolean;
      granted?: boolean;
      reason?: string;
      detail?: string;
      values?: InputSnapshot;
      inputIssues?: InputIssue[];
      syncState?: SyncStateView;
      // sp:syncGetAuthState — non-secret sign-in facts (mode + signedIn), never tokens
      authState?: SyncAuthView;
      health?: 'ok' | 'unreachable';
      space?: { id: string; name: string };
      spaces?: SyncSpaceView[];
      currentSpaceId?: string | null;
      scriptRows?: ScriptRowView[];
      versionMetas?: VersionMetaDto[];
      versionPreview?: VersionPreviewView;
      flowId?: string;
      created?: boolean;
      // ct:probeHandover — claim state of a staged handover
      status?: 'pending' | 'gone';
      // ct:takeHandover — the full payload handed to the single winner
      handover?: PendingHandover;
      // ct:getEnabledFlows — startup piggyback descriptors for this site's pages
      handovers?: HandoverDescriptor[];
      // sp:getNativeChannelState — in-memory port display state, never a persistence fact
      connected?: boolean;
      // sp:grantNativeRead — remaining grant lifetime
      expiresInMs?: number;
      // sp:getFlowHistory — metadata only, snapshots never leave storage through this view
      versions?: FlowHistoryMeta[];
      // Fresh provenance stamp returned by sp:saveFlow so an editor holding a CAS token can save again
      updatedAt?: number;
      scriptId?: string;
      versionNumber?: number;
    }
  | { ok: false; reason: string; errors?: string[]; detail?: string; inputIssues?: InputIssue[] };

export const DEFAULT_TIMEOUT_MS = 10_000;

const log = createLogger('msg');
// Sync hop: the self-hosted server may sit behind a VPN or slow links, so the generic 10s budget is
// too tight
export const SYNC_TIMEOUT_MS = 30_000;
// Auth-gated business messages: the background may spend up to 115s (mode probe + one refresh +
// all requests incl. one retry), so the UI hop must outlive it. Sign-in spans a real authorization
// window (background budget 280s).
export const SYNC_AUTH_OP_TIMEOUT_MS = 120_000;
export const SYNC_SIGN_IN_TIMEOUT_MS = 285_000;

const MESSAGE_TYPES = new Set([
  'sp:getFlows', 'sp:saveFlow', 'sp:setFlowStatus', 'sp:deleteFlow',
  'sp:grantNativeRead', 'sp:getNativeChannelState', 'sp:getFlowHistory', 'sp:rollbackFlow',
  'sp:getFlowInputs', 'sp:saveFlowInputs',
  'sp:syncGetStatus', 'sp:syncProbeHealth', 'sp:syncSetServer', 'sp:syncCreateSpace',
  'sp:syncJoinSpace', 'sp:syncSelectSpace', 'sp:syncForgetSpace', 'sp:syncDeleteSpace',
  'sp:syncListScripts', 'sp:syncListVersions', 'sp:syncPreviewVersion', 'sp:syncPullVersion',
  'sp:syncUploadScript', 'sp:syncPublishVersion', 'sp:syncUpdateScript', 'sp:syncUnlink',
  'sp:syncGetAuthState', 'sp:syncSignIn', 'sp:syncSignOut',
  'bg:startDryRun', 'bg:abortDryRun', 'bg:getContentState', 'bg:reloadFlows', 'bg:handoverStaged',
  'ct:getEnabledFlows', 'ct:getInputSnapshot', 'ct:claimBusiness', 'ct:releaseBusiness', 'ct:flowRunStatus', 'ct:dryRunProgress', 'ct:dryRunFinished',
  'ct:stageHandover', 'ct:probeHandover', 'ct:takeHandover', 'ct:dropHandover',
]);

// Every message payload passes a type guard; invalid payloads get a structured error instead of a thrown exception
export function isExtensionMessage(v: unknown): v is ExtensionMessage {
  if (!isPlainObject(v) || typeof v.type !== 'string' || !MESSAGE_TYPES.has(v.type)) return false;
  switch (v.type) {
    case 'sp:saveFlow':
      return (
        isPlainObject(v.flow) &&
        (v.expectedUpdatedAt === undefined || Number.isSafeInteger(v.expectedUpdatedAt))
      );
    case 'sp:setFlowStatus':
    case 'sp:deleteFlow':
      return typeof v.id === 'string';
    case 'sp:grantNativeRead':
    case 'sp:getFlowHistory':
      return typeof v.flowId === 'string';
    case 'sp:getNativeChannelState':
      return true;
    case 'sp:rollbackFlow':
      return typeof v.flowId === 'string' && Number.isSafeInteger(v.versionId);
    case 'sp:getFlowInputs':
      return typeof v.flowId === 'string';
    case 'sp:saveFlowInputs':
      return (
        typeof v.flowId === 'string' &&
        isPlainObject(v.values) &&
        Object.values(v.values).every(
          (x) =>
            typeof x === 'string' ||
            typeof x === 'boolean' ||
            (Array.isArray(x) && x.every((i) => typeof i === 'string')),
        )
      );
    case 'ct:getInputSnapshot':
      return (
        typeof v.flowId === 'string' &&
        typeof v.flowDraftHash === 'string' &&
        (v.dryRun === undefined || typeof v.dryRun === 'boolean')
      );
    case 'sp:syncSetServer':
      return typeof v.serverUrl === 'string';
    case 'sp:syncCreateSpace':
      return typeof v.name === 'string';
    case 'sp:syncSelectSpace':
    case 'sp:syncForgetSpace':
    case 'sp:syncDeleteSpace':
    case 'sp:syncListScripts':
      return typeof v.spaceId === 'string';
    case 'sp:syncJoinSpace':
      return typeof v.code === 'string';
    // ListVersions carries no versionNumber — grouping it with the preview/pull guard silently
    // rejects the message (bad-payload) and the version list never renders
    case 'sp:syncListVersions':
      return typeof v.spaceId === 'string' && typeof v.scriptId === 'string';
    case 'sp:syncPreviewVersion':
    case 'sp:syncPullVersion':
      return (
        typeof v.spaceId === 'string' && typeof v.scriptId === 'string' && typeof v.versionNumber === 'number'
      );
    case 'sp:syncUploadScript':
      return (
        typeof v.flowId === 'string' &&
        typeof v.name === 'string' &&
        typeof v.note === 'string' &&
        typeof v.versionNote === 'string'
      );
    case 'sp:syncPublishVersion':
      return typeof v.flowId === 'string' && typeof v.versionNote === 'string';
    case 'sp:syncUpdateScript':
      // PATCH semantics: at least one of name/note must be present
      return (
        typeof v.flowId === 'string' &&
        (v.name !== undefined || v.note !== undefined) &&
        (v.name === undefined || typeof v.name === 'string') &&
        (v.note === undefined || typeof v.note === 'string')
      );
    case 'sp:syncUnlink':
      return typeof v.flowId === 'string';
    case 'bg:startDryRun':
      return isPlainObject(v.flow) && v.flow.schemaVersion === 1;
    case 'ct:claimBusiness':
    case 'ct:releaseBusiness':
      return (
        typeof v.site === 'string' &&
        typeof v.flowId === 'string' &&
        typeof v.businessKey === 'string' &&
        v.businessKey.length > 0
      );
    case 'ct:flowRunStatus':
      return typeof v.flowId === 'string' && typeof v.flowDraftHash === 'string' &&
        (v.failure === undefined || (isPlainObject(v.failure) &&
          typeof v.failure.nodeId === 'string' && typeof v.failure.iterationPath === 'string' &&
          typeof v.failure.stage === 'string' && typeof v.failure.reason === 'string' &&
          (v.failure.detail === undefined || typeof v.failure.detail === 'string') &&
          (v.failure.pageId === undefined || typeof v.failure.pageId === 'string')));
    case 'ct:stageHandover':
      return (
        isPlainObject(v.handover) &&
        typeof v.handover.runId === 'string' && v.handover.runId.length > 0 &&
        typeof v.handover.flowId === 'string' && v.handover.flowId.length > 0 &&
        typeof v.handover.flowDraftHash === 'string' &&
        typeof v.handover.site === 'string' &&
        typeof v.handover.dryRun === 'boolean' &&
        (v.handover.businessKey === null || typeof v.handover.businessKey === 'string') &&
        typeof v.handover.toPageId === 'string' && v.handover.toPageId.length > 0 &&
        typeof v.handover.resumeAfter === 'string' &&
        Number.isSafeInteger(v.handover.deadline) &&
        Number.isSafeInteger(v.handover.createdAt) &&
        isPlainObject(v.handover.flow) &&
        isPlainObject(v.handover.context)
      );
    case 'ct:probeHandover':
    case 'ct:takeHandover':
    case 'ct:dropHandover':
      return typeof v.runId === 'string' && v.runId.length > 0;
    case 'ct:dryRunProgress':
      return (
        typeof v.runId === 'string' &&
        ['run-start', 'node-start', 'node-ok', 'run-end'].includes(v.phase as string)
      );
    case 'ct:dryRunFinished':
      return (
        typeof v.flowDraftHash === 'string' &&
        typeof v.runId === 'string' &&
        typeof v.ok === 'boolean' &&
        ['completed', 'failed', 'cancelled'].includes(v.outcome as string)
      );
    default:
      return true;
  }
}

export class MessageTimeoutError extends Error {
  constructor(type: string) {
    super(`Message ${type} timed out`);
    this.name = 'MessageTimeoutError';
  }
}

export async function sendRuntimeMessage(
  msg: ExtensionMessage,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ExtensionResponse | undefined> {
  return withTimeout(browser.runtime.sendMessage(msg), msg.type, timeoutMs);
}

export async function sendTabMessage(
  tabId: number,
  msg: ExtensionMessage,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ExtensionResponse | undefined> {
  return withTimeout(browser.tabs.sendMessage(tabId, msg), msg.type, timeoutMs);
}

async function withTimeout(
  p: Promise<unknown>,
  type: string,
  timeoutMs: number,
): Promise<ExtensionResponse | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p as Promise<ExtensionResponse | undefined>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          log.warn('message timed out', type);
          reject(new MessageTimeoutError(type));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    // No receiver (e.g. forwarding events while the sidepanel is closed) is treated as silent success, not an error
    if (error instanceof Error && error.message.includes('Could not establish connection')) {
      log.debug('no receiver for', type);
      return undefined;
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function emitEvent(msg: ExtensionMessage): Promise<void> {
  try {
    await sendRuntimeMessage(msg, DEFAULT_TIMEOUT_MS);
  } catch (error) {
    // Lost events are acceptable: pick results are also persisted to session:pickResult, and content
    // state is queryable via bg:getContentState
    log.debug('event lost', msg.type, error);
  }
}

// @wxt-dev/browser namespace type exports change across versions; derive sender/tab types from the actual API instead
export type MessageSender = Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1];

export type MessageHandler = (
  msg: ExtensionMessage,
  sender: MessageSender,
) => Promise<ExtensionResponse | undefined> | ExtensionResponse | undefined;

export function onMessage(handler: MessageHandler): () => void {
  const listener = (
    raw: unknown,
    sender: MessageSender,
  ): Promise<ExtensionResponse | undefined> | ExtensionResponse | undefined => {
    if (!isExtensionMessage(raw)) {
      // A bad payload means a forged or version-mismatched sender — visible even in production
      log.warn('rejecting bad-payload message', raw);
      return Promise.resolve({ ok: false, reason: 'bad-payload' });
    }
    log.debug('recv', raw.type);
    return handler(raw, sender);
  };
  browser.runtime.onMessage.addListener(listener as Parameters<typeof browser.runtime.onMessage.addListener>[0]);
  return () => browser.runtime.onMessage.removeListener(listener as Parameters<typeof browser.runtime.onMessage.removeListener>[0]);
}

export function isFromExtension(sender: MessageSender): boolean {
  return sender.id === browser.runtime.id;
}

// sp:*/bg:* caller guard (DEC-015): any extension UI page — the extension's own chrome-extension:// origin
// prefix naturally covers sidepanel, the import page, popup and any future page, no per-page enumeration.
export function isFromExtensionPage(sender: MessageSender): boolean {
  if (!isFromExtension(sender) || typeof sender.url !== 'string') return false;
  return sender.url.startsWith(browser.runtime.getURL(''));
}

// ct:* sender guard: the content message must originate from this extension's content script on a web
// page (http(s) origin). Content scripts are only registered on flow sites (DEC-007), so the injection
// surface stays flow-bound; foreign extensions and arbitrary URL proxying are rejected via the id check.
export function isFromContentScript(sender: MessageSender): boolean {
  if (!isFromExtension(sender) || typeof sender.url !== 'string') return false;
  return parseOrigin(sender.url) !== null;
}
