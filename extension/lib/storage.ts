// All items are local:/session:, never sync:. Writes happen only from background (single writer) plus unit
// tests, with one declared exception: local:onboarding (pure UI flag written by the sidepanel).
//
// Flows truth is the `local:flowStore` single value: flows, per-flow history, native-save
// receipts and the ref watermarks commit through ONE setValue — a failed write leaves the previous
// store fully intact. User-filled input values stay in their own key
// (personal-data boundary) and remain eventually consistent with the store, repaired by the orphan
// sweep; no cross-key atomicity is claimed for them.
import { storage } from 'wxt/utils/storage';
import { djb2, flowDraftHash, validateFlow, type ExecOutcome, type Flow, type RunFailureDetail } from './flow-schema';
import type { FlowInputValueMap } from './flow-inputs';
import type { PendingHandover } from './flow-handover';

export interface OnboardingState {
  seen: boolean;
}

export const FLOW_HISTORY_LIMIT = 10;
export const RECEIPT_LIMIT = 10;
export const NATIVE_READ_GRANT_TTL_MS = 15 * 60_000;
// A clientRef issued more than this far in the future is treated as a broken clock, not a save
export const FUTURE_REF_TOLERANCE_MS = 5 * 60_000;

// One saved version of a flow. versionId is a per-flow monotonic sequence (never a timestamp —
// collisions would break rollback addressing).
export interface FlowVersion {
  versionId: number;
  savedAt: number;
  flow: Flow;
}

// Idempotency receipt for one accepted native save. Kept per flow (last RECEIPT_LIMIT); trimming or
// deleting receipts advances the global expiredThrough watermark so old refs can never replay.
export interface SaveReceipt {
  clientRef: string;
  issuedAt: number;
  flowId: string;
  savedAt: number;
  updatedAt: number;
  payloadHash: string;
}

export interface FlowStore {
  flows: Flow[];
  history: Record<string, FlowVersion[]>;
  receipts: SaveReceipt[];
  expiredThrough: number;
  maxAcceptedIssuedAt: number;
}

export const flowStoreItem = storage.defineItem('local:flowStore', {
  fallback: { flows: [], history: {}, receipts: [], expiredThrough: 0, maxAcceptedIssuedAt: 0 } as FlowStore,
});

// Test/demo seeding helper: a well-formed store over the given flows (one initial version each).
export function buildFlowStore(flows: Flow[]): FlowStore {
  return {
    flows,
    history: Object.fromEntries(flows.map((flow) => [flow.id, [{ versionId: 1, savedAt: flow.provenance.updatedAt, flow }]])),
    receipts: [],
    expiredThrough: 0,
    maxAcceptedIssuedAt: 0,
  };
}

export const onboardingItem = storage.defineItem('local:onboarding', { fallback: { seen: false } as OnboardingState });

// User-filled pre-run input values, keyed by flow id. This store is the personal-data boundary: it is
// never serialized into a Flow, a sync payload or a log, and reading sides always revalidate each
// record against the current definition signature (see lib/flow-inputs.ts).
export const flowInputValuesItem = storage.defineItem('local:flowInputValues', {
  fallback: {} as Record<string, FlowInputValueMap>,
});

export function readFlowInputValues(flowId: string): Promise<FlowInputValueMap> {
  return flowInputValuesItem.getValue().then((all) => all[flowId] ?? {});
}

// Replace semantics: the submitted form mapping is the whole truth for this flow (removed input items
// disappear with the replace), matching the save contract in the flow detail.
export function writeFlowInputValues(flowId: string, map: FlowInputValueMap): Promise<void> {
  return serializeStorageWrite(async () => {
    const all = { ...(await flowInputValuesItem.getValue()) };
    all[flowId] = map;
    await flowInputValuesItem.setValue(all);
  });
}

export function deleteFlowInputValues(flowId: string): Promise<void> {
  return serializeStorageWrite(async () => {
    const all = { ...(await flowInputValuesItem.getValue()) };
    if (!Object.prototype.hasOwnProperty.call(all, flowId)) return;
    delete all[flowId];
    await flowInputValuesItem.setValue(all);
  });
}

// The full delete of one flow: store entry (flow + history + receipts, watermark advanced), saved
// input values, session failure notice and any read grant removed in ONE serialized section. Separate
// writes could be interrupted between them — that gap is what orphans value records (personal data)
// in storage and leaves a grant pointing at a deleted flow.
// Reads and writes go straight to the items: the wrapped helpers above re-enter the write chain and
// would deadlock inside this section.
export function deleteFlowCompletely(id: string): Promise<void> {
  return serializeStorageWrite(async () => {
    const store = await flowStoreItem.getValue();
    if (store.flows.some((r) => r.id === id)) {
      const droppedMax = store.receipts
        .filter((r) => r.flowId === id)
        .reduce((max, r) => Math.max(max, r.issuedAt), 0);
      const history = { ...store.history };
      delete history[id];
      await flowStoreItem.setValue({
        ...store,
        flows: store.flows.filter((r) => r.id !== id),
        history,
        receipts: store.receipts.filter((r) => r.flowId !== id),
        expiredThrough: Math.max(store.expiredThrough, droppedMax),
      });
    }
    const values = { ...(await flowInputValuesItem.getValue()) };
    if (Object.prototype.hasOwnProperty.call(values, id)) {
      delete values[id];
      await flowInputValuesItem.setValue(values);
    }
    const notices = { ...(await flowFailuresItem.getValue()) };
    if (Object.prototype.hasOwnProperty.call(notices, id)) {
      delete notices[id];
      await flowFailuresItem.setValue(notices);
    }
    await clearReadGrantLocked(id);
  });
}

// Self-heal for records orphaned by an interrupted flow delete (flows and values are separate keys —
// no cross-key transaction exists); no write happens when there is nothing to drop.
export function pruneOrphanFlowInputValues(knownFlowIds: Set<string>): Promise<void> {
  return serializeStorageWrite(async () => {
    const all = await flowInputValuesItem.getValue();
    const orphans = Object.keys(all).filter((id) => !knownFlowIds.has(id));
    if (orphans.length === 0) return;
    const next = { ...all };
    for (const id of orphans) delete next[id];
    await flowInputValuesItem.setValue(next);
  });
}

// Business-instance claims (DEC-019 §5.3): key = site|flowId|businessKey, held by the background single
// writer for the whole browser session — no TTL auto-release, because unlocking an outcome-unknown
// business (save request possibly sent) cannot be timed, only resolved by closing the session.
export interface BusinessClaim {
  key: string;
  claimedAt: number;
}

export const businessClaimsItem = storage.defineItem('session:businessClaims', {
  fallback: [] as BusinessClaim[],
});

// Cross-page handovers in flight. Session storage — browser restart clears it, which IS the
// conservative cancel (DEC-cross-page-flow-002). Background single writer only (content claims
// through ct:* messages); entries carry runtime-read values (vars), so they never leave this
// machine's session: no logs, no sync, no export.
export const pendingHandoversItem = storage.defineItem('session:pendingHandovers', {
  fallback: [] as PendingHandover[],
});

// Dry-run result fallback: closing the sidepanel mid dry-run still shows the result on reopen
// (session display only)
export interface LastDryRunResult {
  flowDraftHash: string;
  ok: boolean;
  ts: number;
  outcome?: ExecOutcome;
  detail?: string;
}

export const lastDryRunResultItem = storage.defineItem('session:lastDryRunResult', {
  fallback: null as LastDryRunResult | null,
});

// One current diagnostic per flow, scoped to this browser session. This is not an execution history.
export interface FlowFailureNotice {
  flowId: string;
  flowDraftHash: string;
  ts: number;
  failure: RunFailureDetail;
}

export const flowFailuresItem = storage.defineItem('session:flowFailures', {
  fallback: {} as Record<string, FlowFailureNotice>,
});

export function setFlowFailureNotice(flowId: string, notice: FlowFailureNotice | null): Promise<void> {
  return serializeStorageWrite(async () => {
    const notices = { ...(await flowFailuresItem.getValue()) };
    if (notice === null) {
      if (!Object.prototype.hasOwnProperty.call(notices, flowId)) return;
      delete notices[flowId];
    } else {
      notices[flowId] = notice;
    }
    await flowFailuresItem.setValue(notices);
  });
}

// Time-limited single-flow read grant behind the native `flow.read` op: the user clicked "Improve
// with AI" in the sidepanel and the flow is paused. Session storage — it dies with the browser; it
// is also cleared inside the delete/rollback/replace sections below, so it can never outlive the
// flow state it vouches for.
export interface NativeReadGrant {
  flowId: string;
  grantedAt: number;
}

export const nativeReadGrantItem = storage.defineItem('session:nativeReadGrant', {
  fallback: null as NativeReadGrant | null,
});

// Clears the read grant from inside a serialized mutation section, only when it points at the
// mutated flow — the surrounding flow change is what invalidates that grant, so the clearing belongs
// to that section; a grant for a different flow must survive unrelated mutations.
async function clearReadGrantLocked(flowId: string): Promise<void> {
  const grant = await nativeReadGrantItem.getValue();
  if (grant !== null && grant.flowId === flowId) await nativeReadGrantItem.setValue(null);
}

export function setNativeReadGrant(grant: NativeReadGrant | null): Promise<void> {
  return nativeReadGrantItem.setValue(grant);
}

export function nativeReadGrantActive(grant: NativeReadGrant | null, flowId: string, now = Date.now()): boolean {
  return grant !== null && grant.flowId === flowId && now - grant.grantedAt <= NATIVE_READ_GRANT_TTL_MS;
}

// Session pointer for the import page's saved-summary card: display only, which flow was last
// delivered over the native channel. The card always re-reads the real flow from the store.
export interface LastNativeSave {
  flowId: string;
  clientRef: string;
  savedAt: number;
  replayed: boolean;
}

export const lastNativeSaveItem = storage.defineItem('session:lastNativeSave', {
  fallback: null as LastNativeSave | null,
});

// Note: getValue() returns the fallback instance itself when storage is empty; write paths must copy first —
// never mutate the fallback in place.

// MV3 onMessage handlers run concurrently, so every read-modify-write against a storage item must join
// this chain: two interleaved writers both read the pre-write list and the second setValue silently drops
// the first (lost update — e.g. two ct:pageEnterClaim both granted, or a save undone by a concurrent
// delete). Composed writers must call the *Locked internals instead of re-entering the chain.
let storageWriteChain: Promise<unknown> = Promise.resolve();

export function serializeStorageWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = storageWriteChain.then(fn, fn);
  storageWriteChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function loadFlows(): Promise<Flow[]> {
  return flowStoreItem.getValue().then((store) => store.flows);
}

// Store internals run inside a serialized section; they never commit on their own.

// Append the saved snapshot as the flow's newest version, trimming to FLOW_HISTORY_LIMIT. Status
// flips never reach here — only successful saves do.
function appendHistory(history: Record<string, FlowVersion[]>, flow: Flow, savedAt: number): Record<string, FlowVersion[]> {
  const versions = [...(history[flow.id] ?? [])];
  const versionId = versions.length > 0 ? versions[versions.length - 1]!.versionId + 1 : 1;
  versions.push({ versionId, savedAt, flow });
  const trimmed = versions.length > FLOW_HISTORY_LIMIT ? versions.slice(versions.length - FLOW_HISTORY_LIMIT) : versions;
  return { ...history, [flow.id]: trimmed };
}

// Append one native-save receipt, keeping only the last RECEIPT_LIMIT receipts of that flow. Trimmed
// receipts advance the global expiredThrough watermark: a ref whose receipt is gone can never be
// replayed as a save again.
function appendReceipt(
  store: FlowStore,
  receipt: SaveReceipt,
): Pick<FlowStore, 'receipts' | 'expiredThrough' | 'maxAcceptedIssuedAt'> {
  const kept = [...store.receipts.filter((r) => r.flowId === receipt.flowId), receipt];
  const overflow = kept.length > RECEIPT_LIMIT ? kept.slice(0, kept.length - RECEIPT_LIMIT) : [];
  const trimmed = kept.slice(Math.max(0, kept.length - RECEIPT_LIMIT));
  const droppedMax = overflow.reduce((max, r) => Math.max(max, r.issuedAt), 0);
  return {
    receipts: [...store.receipts.filter((r) => r.flowId !== receipt.flowId), ...trimmed],
    expiredThrough: Math.max(store.expiredThrough, droppedMax),
    maxAcceptedIssuedAt: Math.max(store.maxAcceptedIssuedAt, receipt.issuedAt),
  };
}

interface ReplaceOutcome {
  refuse?: 'not-found' | 'changed' | 'enabled';
  store?: FlowStore;
  replaced?: Flow;
}

// CAS replace behind the native save path: same id, expected updatedAt, never enabled; lands as
// draft with a bumped stamp and a new history version.
function replaceInStore(
  store: FlowStore,
  id: string,
  expectedUpdatedAt: number,
  draft: Flow,
  now: number,
): ReplaceOutcome {
  const flows = [...store.flows];
  const index = flows.findIndex((flow) => flow.id === id);
  if (index < 0) return { refuse: 'not-found' };
  const existing = flows[index]!;
  if (existing.provenance.updatedAt !== expectedUpdatedAt) return { refuse: 'changed' };
  if (existing.status === 'enabled') return { refuse: 'enabled' };
  const replaced: Flow = {
    ...draft,
    id,
    status: 'draft',
    provenance: {
      ...existing.provenance,
      updatedAt: Math.max(now, existing.provenance.updatedAt + 1),
    },
  };
  flows[index] = replaced;
  return {
    store: { ...store, flows, history: appendHistory(store.history, replaced, replaced.provenance.updatedAt) },
    replaced,
  };
}

// The revision's input declarations are the new truth: value records for definitions it dropped
// stop at the replace (personal-data boundary — deleteFlowCompletely is the model); still-defined
// keys keep their records and stay governed by signature revalidation.
async function pruneDroppedInputKeysLocked(id: string, draft: Flow): Promise<void> {
  const values = { ...(await flowInputValuesItem.getValue()) };
  const valueMap = values[id];
  if (valueMap === undefined) return;
  const keep = new Set((draft.inputs ?? []).map((d) => d.key));
  const next = Object.fromEntries(Object.entries(valueMap).filter(([key]) => keep.has(key)));
  if (Object.keys(next).length !== Object.keys(valueMap).length) {
    if (Object.keys(next).length === 0) delete values[id];
    else values[id] = next;
    await flowInputValuesItem.setValue(values);
  }
}

export function saveFlowRecord(flow: Flow, expectedUpdatedAt?: number): Promise<{ created: boolean; changed?: boolean }> {
  return serializeStorageWrite(async () => {
    const store = await flowStoreItem.getValue();
    const flows = [...store.flows];
    const existing = flows.find((r) => r.id === flow.id);

    // Compare-and-swap for editor updates (sp:saveFlow): a flow changed after the editor opened (AI
    // revision, sync pull — or deleted outright) refuses the overwrite instead of silently rolling
    // the newer content back or resurrecting the deleted flow. Absent expectedUpdatedAt keeps the
    // create/pull semantics — a deliberate full write.
    if (expectedUpdatedAt !== undefined && (existing === undefined || existing.provenance.updatedAt !== expectedUpdatedAt)) {
      return { created: false, changed: true };
    }

    let saved: Flow;
    if (existing) {
      saved = {
        ...flow,
        provenance: {
          ...flow.provenance,
          createdAt: existing.provenance.createdAt,
          enabledAt: flow.status === 'enabled' && existing.status !== 'enabled' ? Date.now() : existing.provenance.enabledAt,
        },
      };
      flows[flows.indexOf(existing)] = saved;
    } else {
      saved = flow;
      flows.push(saved);
    }
    await flowStoreItem.setValue({ ...store, flows, history: appendHistory(store.history, saved, saved.provenance.updatedAt) });
    return { created: existing === undefined };
  });
}

export interface SetStatusOutcome {
  ok: boolean;
  reason?: string;
}

// Enabling has no gate beyond the user's own click (DEC-015): imported flows start not enabled and the
// enable action is reserved to the user. A status flip never adds a history version.
export function setFlowStatusRecord(id: string, status: Flow['status']): Promise<SetStatusOutcome> {
  return serializeStorageWrite(async () => {
    const store = await flowStoreItem.getValue();
    const flows = [...store.flows];
    const existing = flows.find((r) => r.id === id);
    if (!existing) return { ok: false, reason: 'flow-not-found' };
    flows[flows.indexOf(existing)] = {
      ...existing,
      status,
      provenance: {
        ...existing.provenance,
        updatedAt: Date.now(),
        enabledAt: status === 'enabled' ? existing.provenance.enabledAt ?? Date.now() : existing.provenance.enabledAt,
      },
    };
    await flowStoreItem.setValue({ ...store, flows });
    return { ok: true };
  });
}

// User-initiated rollback (sidepanel only — the native channel has no rollback op): the target
// snapshot is revalidated against the current schema, then written as a NEW current version under
// the original id as draft. The pre-rollback content keeps its own history version (every successful
// save appended one), so nothing is lost; the 10-version cap applies as usual. A failure leaves the
// flow, history and receipts untouched. Saved input values are NOT pruned here: unlike a replace,
// rollback can be reversed again by rolling back to the newer version — stale keys stay withheld by
// definition-signature revalidation instead of being deleted.
export function rollbackFlowRecord(id: string, versionId: number): Promise<'ok' | 'not-found' | 'version-not-found' | 'invalid-snapshot'> {
  return serializeStorageWrite(async () => {
    const store = await flowStoreItem.getValue();
    const index = store.flows.findIndex((flow) => flow.id === id);
    if (index < 0) return 'not-found';
    const snapshot = (store.history[id] ?? []).find((version) => version.versionId === versionId);
    if (snapshot === undefined) return 'version-not-found';
    const validated = validateFlow(snapshot.flow, 'full');
    if (!validated.ok || !validated.flow) return 'invalid-snapshot';
    const current = store.flows[index]!;
    const restored: Flow = {
      ...validated.flow,
      id,
      status: 'draft',
      provenance: {
        ...validated.flow.provenance,
        updatedAt: Math.max(Date.now(), current.provenance.updatedAt + 1),
      },
    };
    const flows = [...store.flows];
    flows[index] = restored;
    await flowStoreItem.setValue({ ...store, flows, history: appendHistory(store.history, restored, restored.provenance.updatedAt) });
    // A rollback invalidates a read grant on this flow exactly like a replace — inside the same section
    await clearReadGrantLocked(id);
    return 'ok';
  });
}

// History metadata for the sidepanel (full snapshots never leave storage through this view). The
// current marker matches the newest version whose content hash equals the live flow's — status
// flips change no content, so the marker survives enable/pause.
export interface FlowHistoryMeta {
  versionId: number;
  savedAt: number;
  current: boolean;
}

export async function flowHistoryMeta(flowId: string): Promise<FlowHistoryMeta[] | null> {
  const store = await flowStoreItem.getValue();
  const flow = store.flows.find((r) => r.id === flowId);
  if (flow === undefined) return null;
  const contentHash = flowDraftHash(flow);
  let currentMarked = false;
  const metas = [...(store.history[flowId] ?? [])].reverse().map((version) => {
    const current = !currentMarked && flowDraftHash(version.flow) === contentHash;
    if (current) currentMarked = true;
    return { versionId: version.versionId, savedAt: version.savedAt, current };
  });
  return metas.reverse();
}

// Native channel save/verify: all ref decisions happen inside the serialized section.

// The clientRef admission window shared by save and verify: one definition, so the two ops can never
// disagree about whether a ref is future-dated, expired or regressed.
function refWindowVerdict(
  issuedAt: number,
  expiredThrough: number,
  maxAcceptedIssuedAt: number,
  now: number,
): 'bad-ref-time' | 'ref-expired' | 'clock-regressed' | null {
  if (issuedAt > now + FUTURE_REF_TOLERANCE_MS) return 'bad-ref-time';
  if (issuedAt <= expiredThrough) return 'ref-expired';
  if (issuedAt < maxAcceptedIssuedAt) return 'clock-regressed';
  return null;
}

export type NativeSaveResult =
  | { ok: true; replayed: true; receipt: SaveReceipt }
  | { ok: true; replayed: false; flow: Flow }
  | { ok: false; reason: 'ref-expired' | 'clock-regressed' | 'bad-ref-time' | 'ref-conflict' | 'flow-not-found' | 'revision-stale' | 'flow-enabled' };

// One atomic native save: ref replay/watermark checks, then create or CAS replace, then the receipt —
// flow, history, receipts and watermarks land in the SAME setValue. Zero write on every refusal.
export function nativeSaveRecord(input: {
  draft: Flow;
  text: string;
  clientRef: string;
  issuedAt: number;
  flowId?: string;
  expectedUpdatedAt?: number;
}): Promise<NativeSaveResult> {
  return serializeStorageWrite(async () => {
    const store = await flowStoreItem.getValue();
    const payloadHash = djb2(input.text);

    // Replay window: a full ref still held by a receipt is idempotent for the identical payload and
    // a hard refusal for a different one (a confirmation always mints a new ref).
    const known = store.receipts.find((r) => r.clientRef === input.clientRef);
    if (known !== undefined) {
      return known.payloadHash === payloadHash
        ? { ok: true, replayed: true, receipt: known }
        : { ok: false, reason: 'ref-conflict' };
    }

    const now = Date.now();
    const verdict = refWindowVerdict(input.issuedAt, store.expiredThrough, store.maxAcceptedIssuedAt, now);
    if (verdict !== null) return { ok: false, reason: verdict };

    let saved: Flow;
    let next: FlowStore;
    if (input.flowId !== undefined) {
      const outcome = replaceInStore(store, input.flowId, input.expectedUpdatedAt!, input.draft, now);
      if (outcome.refuse !== undefined) {
        const reason =
          outcome.refuse === 'changed' ? 'revision-stale' : outcome.refuse === 'enabled' ? 'flow-enabled' : 'flow-not-found';
        return { ok: false, reason };
      }
      next = outcome.store!;
      saved = outcome.replaced!;
      await pruneDroppedInputKeysLocked(input.flowId, input.draft);
    } else {
      // The draft arrives fully built from importFlowText (id, provenance, draft status stamped
      // there); the save only commits it — the envelope rewrite happens once, in the pipeline
      saved = { ...input.draft, status: 'draft' };
      next = {
        ...store,
        flows: [...store.flows, saved],
        history: appendHistory(store.history, saved, saved.provenance.updatedAt),
      };
    }
    const receipt: SaveReceipt = {
      clientRef: input.clientRef,
      issuedAt: input.issuedAt,
      flowId: saved.id,
      savedAt: now,
      updatedAt: saved.provenance.updatedAt,
      payloadHash,
    };
    await flowStoreItem.setValue({ ...next, ...appendReceipt(next, receipt) });
    // A successful replace clears the read grant (its snapshot is now stale) in the same section
    if (input.flowId !== undefined) await clearReadGrantLocked(input.flowId);
    return { ok: true, replayed: false, flow: saved };
  });
}

export type NativeVerifyResult =
  | { ok: true; confirmed: true; receipt: SaveReceipt; flowStatus: Flow['status'] | null; updatedAt: number | null }
  | { ok: false; reason: 'ref-expired' | 'clock-regressed' | 'bad-ref-time' | 'unconfirmed' };

// Read-back for the AI after a save (or after a result-unknown): a held receipt plus the flow's
// CURRENT persisted status, or an explicit cannot-confirm. An unknown ref never implies "not saved".
export async function nativeVerifyRecord(clientRef: string, issuedAt: number): Promise<NativeVerifyResult> {
  const store = await flowStoreItem.getValue();
  const known = store.receipts.find((r) => r.clientRef === clientRef);
  if (known !== undefined) {
    const flow = store.flows.find((r) => r.id === known.flowId);
    return {
      ok: true,
      confirmed: true,
      receipt: known,
      flowStatus: flow?.status ?? null,
      updatedAt: flow?.provenance.updatedAt ?? null,
    };
  }
  const verdict = refWindowVerdict(issuedAt, store.expiredThrough, store.maxAcceptedIssuedAt, Date.now());
  if (verdict !== null) return { ok: false, reason: verdict };
  return { ok: false, reason: 'unconfirmed' };
}
// Business-instance claim (single writer, session storage): a claim is taken before execution and kept
// whether the run later succeeds, fails or is cancelled (no retry, DEC-019 §5.3). Serialized so two
// concurrent cross-tab claims for the same key cannot both read a claim-free list and both win.
// Cross-restart protection is NOT claimed: session storage dies with the browser, and re-entry after a
// restart is gated by page-state checks instead.
export function claimBusinessInstance(key: string, now = Date.now()): Promise<boolean> {
  return serializeStorageWrite(async () => {
    const claims = [...(await businessClaimsItem.getValue())];
    if (claims.some((c) => c.key === key)) {
      return false;
    }
    claims.push({ key, claimedAt: now });
    await businessClaimsItem.setValue(claims);
    return true;
  });
}

export function businessClaimKey(site: string, flowId: string, businessKey: string): string {
  return `${site}|${flowId}|${businessKey}`;
}

// Give a claim back when the run it was taken for never started (the mutex refused the start, or the
// route was left during the claim round-trip): that business instance was never acted on, so keeping
// the claim would lock it out for the whole session with no outcome to protect.
export function releaseBusinessInstance(key: string): Promise<void> {
  return serializeStorageWrite(async () => {
    const claims = [...(await businessClaimsItem.getValue())];
    const next = claims.filter((c) => c.key !== key);
    if (next.length !== claims.length) await businessClaimsItem.setValue(next);
  });
}

export async function writeLastDryRunResult(result: LastDryRunResult): Promise<void> {
  await lastDryRunResultItem.setValue(result);
}

export async function readLastDryRunResult(): Promise<LastDryRunResult | null> {
  return lastDryRunResultItem.getValue();
}
