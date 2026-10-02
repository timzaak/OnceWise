// content: the flow runtime host — pulls this site's enabled flows from background via messages
// (the service worker may idle-unload at any time; storage + message wake-up, no shared in-memory
// state). One FlowRuntime per document is shared by automatic runs and dry runs: single-run mutex,
// same driver semantics, same business-instance claims (DEC-019 §5.2/§5.3). Cancellation paths: user
// preview stop, flow pause/delete/replacement (reloadFlows), leaving the business route,
// document unload.
import { createDryRunDriver, highlightTrigger } from '@/lib/dry-run';
import {
  PageEnterTracker,
  claimBusinessRun,
  needsBusinessClaim,
  pageMatches,
  pageRouteMatches,
  releaseBusinessRun,
} from '@/lib/page-enter';
import {
  attachFieldChangeWatcher,
  readTriggerValue,
  OBSERVER_DEBOUNCE_MS,
  type TriggerWatcherHandle,
} from '@/lib/flow-triggers';
import { pageTargetOf } from '@/lib/locator';
import { createDomFlowDriver } from '@/lib/flow-dom';
import { createFlowRuntime, type FlowLogEvent } from '@/lib/flow-runtime';
import type { FlowRunResult } from '@/lib/flow-compiler';
import { withHandover, type HandoverDescriptor, type PendingHandover } from '@/lib/flow-handover';
import { redactText } from '@/lib/redact';
import { t } from '@/lib/i18n';
import { flowDraftHash, type RunFailureDetail, type Flow } from '@/lib/flow-schema';
import { emitEvent, isFromExtension, onMessage, sendRuntimeMessage } from '@/lib/messaging';

const POLL_MS = 800;

export default defineContentScript({
  // Registered at runtime by background (site-scripts.ts) per flow site; no static matches — the
  // manifest carries no content_scripts entry at all (DEC-007).
  registration: 'runtime',
  runAt: 'document_idle',
  main() {
    // Injection idempotency: registration + executeScript top-up can both deliver this file to the same
    // document; the window flag (shared isolated world) makes the second run a no-op.
    const flagScope = window as { __ssbaContentMain?: boolean };
    if (flagScope.__ssbaContentMain) return;
    flagScope.__ssbaContentMain = true;

    const doc = document;
    let flows: Flow[] = [];
    // This site's in-flight handover descriptors (piggybacked on ct:getEnabledFlows) plus the
    // runIds this document has already consumed (claimed, or adjudicated dead) — never re-attempted
    let handovers: HandoverDescriptor[] = [];
    const deadHandoverRuns = new Set<string>();
    // A payload claimed while the document mutex was busy: held in memory and started on a later
    // arm cycle until its deadline (serialized boundary — no queue jumping)
    let pendingResume: PendingHandover | null = null;
    const watchers = new Map<string, TriggerWatcherHandle>();
    const pageEnterTracker = new PageEnterTracker();
    // The shared reader driver serves trigger and businessKey reads outside any run (a throwaway
    // registry-free usage; runs always create their own driver through the runtime factory)
    const readerDriver = createDomFlowDriver(doc);

    // Context of the run currently owned by this document's runtime; set before tryStart so the
    // synchronous first events already know which flow they belong to
    let activeRun: { flow: Flow; runId: string; dryRun: boolean; businessKey: string | null } | null = null;
    let dryRunCleanup: (() => void) | null = null;
    let lastHighlightLabel: string | undefined;

    const failureLine = (failure: RunFailureDetail): string =>
      (failure.pageId !== undefined ? t('flows.failurePage', { page: failure.pageId }) : '') +
      `${failure.nodeId}${failure.iterationPath} ${failure.stage}:${failure.reason}` +
      (failure.detail !== undefined && failure.detail !== '' ? ` (${redactText(failure.detail)})` : '');

    const runtime = createFlowRuntime({
      driver: () => {
        const base = activeRun?.dryRun
          ? createDryRunDriver(doc, {
              hooks: { onHighlight: (label) => (lastHighlightLabel = label) },
            })
          : createDomFlowDriver(doc);
        // The handover capability reads the run's identity lazily: navigate nodes execute mid-run,
        // long after this factory call, when activeRun carries the real runId
        return withHandover(base, () => {
          const run = activeRun;
          if (run === null || run.runId === '') return null;
          return { runId: run.runId, flow: run.flow, dryRun: run.dryRun, businessKey: run.businessKey };
        });
      },
      onEvent: (event) => forwardRunEvent(event),
    });

    const forwardRunEvent = (event: FlowLogEvent): void => {
      const ctx = activeRun;
      if (ctx === null) return;
      if (!ctx.dryRun) return; // auto runs report only their terminal (per-node detail would spam the log)
      const base =
        event.type === 'node'
          ? {
              runId: event.runId,
              phase: event.phase === 'start' ? ('node-start' as const) : ('node-ok' as const),
              nodeId: event.nodeId,
              nodeKind: event.kind,
              iterationPath: event.iterationPath,
              executed: event.executed,
            }
          : event.type === 'run-start'
            ? { runId: event.runId, phase: 'run-start' as const, ...(event.resumed === true ? { resumed: true } : {}) }
            : {
                runId: event.runId,
                phase: 'run-end' as const,
                executed: event.executed,
                outcome: event.outcome,
                failure: event.failure,
              };
      void emitEvent({
        type: 'ct:dryRunProgress',
        ...base,
        ...(event.type === 'node' && event.phase === 'ok' && lastHighlightLabel !== undefined
          ? { highlight: lastHighlightLabel }
          : {}),
      });
      if (event.type === 'node' && event.phase === 'ok') lastHighlightLabel = undefined;
    };

    // Automatic runs remain page-silent. Only their current failure is reported for the flow workbench.
    const reportDryRunEnd = (flow: Flow, runId: string, result: FlowRunResult): void => {
      if (result.outcome === 'handed-over') return; // settleRun already filtered; narrows the type
      dryRunCleanup?.();
      dryRunCleanup = null;
      void emitEvent({
        type: 'ct:dryRunFinished',
        flowDraftHash: flowDraftHash(flow),
        runId,
        ok: result.outcome === 'completed',
        outcome: result.outcome,
        ...(result.failure !== undefined ? { detail: failureLine(result.failure) } : {}),
        ...(result.failure !== undefined ? { failure: result.failure } : {}),
      });
    };

    // Shared terminal handling for every run this document hosts — fresh starts and cross-page
    // resumes alike. 'handed-over' is not a report: another document owns the run now, so this side
    // only releases the mutex and drops the preview highlight.
    const settleRun = (flow: Flow, runId: string, dryRun: boolean, result: FlowRunResult): void => {
      if (activeRun?.runId === runId) activeRun = null;
      if (result.outcome === 'handed-over') {
        dryRunCleanup?.();
        dryRunCleanup = null;
        return;
      }
      if (dryRun) {
        reportDryRunEnd(flow, runId, result);
        return;
      }
      if (result.outcome === 'completed' || result.outcome === 'failed') {
        void emitEvent({
          type: 'ct:flowRunStatus',
          flowId: flow.id,
          flowDraftHash: flowDraftHash(flow),
          ...(result.outcome === 'failed' ? { failure: result.failure === undefined
            ? { nodeId: 'steps', iterationPath: '', stage: 'runtime', reason: 'unknown' }
            : { nodeId: result.failure.nodeId, iterationPath: result.failure.iterationPath,
                stage: result.failure.stage,
                reason: result.failure.reason.startsWith('assert-failed:')
                  ? 'assert-failed' : result.failure.reason,
                ...(result.failure.pageId !== undefined ? { pageId: result.failure.pageId } : {}) } } : {}),
        });
      }
    };

    const startRun = async (
      flow: Flow,
      opts: { dryRun?: boolean; trigger?: string; inputs?: Record<string, unknown>; businessKey?: string | null } = {},
    ): Promise<{ started: false } | { started: true; runId: string; done: Promise<void> }> => {
      // Keep the previous run's context when the mutex refuses this start: nulling activeRun would
      // orphan a live run — its cancel supervision, user abort and progress forwarding all read it
      const prevRun = activeRun;
      activeRun = { flow, runId: '', dryRun: opts.dryRun === true, businessKey: opts.businessKey ?? null };
      const start = runtime.tryStart({
        steps: flow.steps,
        trigger: opts.trigger ?? '',
        inputs: opts.inputs,
        budget: flow.budget,
      });
      if (!start.started) {
        activeRun = prevRun;
        return { started: false };
      }
      const runId = start.runId;
      activeRun = { flow, runId, dryRun: opts.dryRun === true, businessKey: opts.businessKey ?? null };
      const done = start.result.then((result) => settleRun(flow, runId, opts.dryRun === true, result));
      return { started: true, runId, done };
    };

    // Input gate (form-support): for flows declaring inputs, the run-start snapshot is taken from the
    // background BEFORE the business claim and any page action. Missing required / invalid / stale
    // values or an unreadable store refuse the start — for automatic runs background already recorded
    // the session notice, so the skip stays page-silent here; a dry-run preview keeps its refusals
    // preview-local (dryRun: true also lets drafts and unsaved editor edits pass the site-only gate).
    // Flows without inputs take the zero-cost fast path.
    const gateFlowInputs = async (
      flow: Flow,
      opts: { dryRun?: boolean } = {},
    ): Promise<{ ok: true; values: Record<string, unknown> } | { ok: false; reason: string }> => {
      if ((flow.inputs?.length ?? 0) === 0) return { ok: true, values: {} };
      try {
        const res = await sendRuntimeMessage({
          type: 'ct:getInputSnapshot',
          flowId: flow.id,
          flowDraftHash: flowDraftHash(flow),
          ...(opts.dryRun === true ? { dryRun: true } : {}),
        });
        if (res?.ok && res.values) return { ok: true, values: res.values };
        return { ok: false, reason: res?.ok === false ? res.reason : 'input-unavailable' };
      } catch {
        return { ok: false, reason: 'input-unavailable' };
      }
    };

    // Business-instance claims gate every submit-carrying entry — auto and dry run alike (a previewed
    // submit is a real submit; closing the sidepanel never releases the claim). `businessKey` passes a
    // pre-read value (the page-enter tracker's rising-edge read) instead of re-reading here. A claim
    // whose run never starts is given back (releaseBusinessRun) — it has no outcome to protect.
    type ClaimResult =
      | { kind: 'none' }
      | { kind: 'claimed'; key: string }
      | {
          kind: 'refused';
          reason: 'no-business-key' | 'business-key-unreadable' | 'business-instance-claimed' | 'page-left';
        };
    const claimBeforeRun = async (flow: Flow, businessKey?: string | null): Promise<ClaimResult> => {
      if (!needsBusinessClaim(flow)) return { kind: 'none' };
      if (businessKey === undefined) {
        if (flow.businessKey === undefined) return { kind: 'refused', reason: 'no-business-key' };
        businessKey = await readBusinessKey(flow);
      }
      if (businessKey === null) return { kind: 'refused', reason: 'business-key-unreadable' };
      if (!(await claimBusinessRun(flow, businessKey))) return { kind: 'refused', reason: 'business-instance-claimed' };
      // The claim round-trip (SW wake-up, up to seconds) can span an SPA navigation on the same
      // document: re-verify the route before starting, giving the claim back if it is gone
      if (!pageRouteMatches(doc, flow.page)) {
        void releaseBusinessRun(flow, businessKey);
        return { kind: 'refused', reason: 'page-left' };
      }
      return { kind: 'claimed', key: businessKey };
    };

    const readBusinessKey = async (flow: Flow): Promise<string | null> => {
      if (flow.businessKey === undefined) return null;
      const res = await readerDriver.read(
        flow.businessKey.read,
        { trigger: '', items: {} },
        new AbortController().signal,
      );
      if (!res.ok || typeof res.value !== 'string' || res.value.trim() === '') return null;
      return res.value.trim();
    };

    // Same-document auto runs queue behind each other: starting them concurrently would feed every
    // loser to the single-run mutex, burning its rising edge AND its business claim with no execution
    // at all
    let autoRunQueue: Promise<unknown> = Promise.resolve();
    const enqueueAutoRun = (start: () => Promise<void>): void => {
      autoRunQueue = autoRunQueue.then(start, start);
    };

    const startAutoRun = async (flow: Flow, businessKey: string | null) => {
      // The queue can hold this start behind a long run; re-check the flow is still enabled then
      if (!flows.some((r) => r.id === flow.id && r.status === 'enabled')) return;
      const gate = await gateFlowInputs(flow);
      if (!gate.ok) return;
      const claim = await claimBeforeRun(flow, businessKey);
      if (claim.kind === 'refused') {
        if (claim.reason !== 'business-instance-claimed' && claim.reason !== 'page-left') {
          void emitEvent({ type: 'ct:flowRunStatus', flowId: flow.id, flowDraftHash: flowDraftHash(flow),
            failure: { nodeId: 'trigger', iterationPath: '', stage: 'trigger', reason: claim.reason } });
        }
        return;
      }
      const res = await startRun(flow, { trigger: '', inputs: gate.values, businessKey: claim.kind === 'claimed' ? claim.key : null });
      if (!res.started) {
        // The run never started — the claim has no outcome to protect and goes back
        if (claim.kind === 'claimed') void releaseBusinessRun(flow, claim.key);
        return;
      }
      await res.done;
    };

    const startFieldChangeRun = async (flow: Flow, value: string) => {
      const gate = await gateFlowInputs(flow);
      if (!gate.ok) return;
      const claim = await claimBeforeRun(flow);
      if (claim.kind === 'refused') {
        if (claim.reason !== 'business-instance-claimed' && claim.reason !== 'page-left') {
          void emitEvent({ type: 'ct:flowRunStatus', flowId: flow.id, flowDraftHash: flowDraftHash(flow),
            failure: { nodeId: 'trigger', iterationPath: '', stage: 'trigger', reason: claim.reason } });
        }
        return;
      }
      const res = await startRun(flow, { trigger: value, inputs: gate.values, businessKey: claim.kind === 'claimed' ? claim.key : null });
      if (!res.started) {
        if (claim.kind === 'claimed') void releaseBusinessRun(flow, claim.key);
      }
    };

    const teardownAll = () => {
      for (const watcher of watchers.values()) watcher.stop();
      watchers.clear();
    };

    // Cross-page resume: this document claimed a handover and now becomes the run's host. The
    // staged context replaces the fresh start entirely — same runId, accumulated budget, carried
    // vars/loop state; the machine re-compiles entering after the navigate node.
    const recheckBusinessKey = async (
      flow: Flow,
      expected: string | null,
    ): Promise<'pass' | 'skip' | 'changed' | 'ambiguous'> => {
      if (flow.businessKey === undefined || expected === null) return 'skip';
      const res = await readerDriver.read(flow.businessKey.read, { trigger: '', items: {} }, new AbortController().signal);
      if (!res.ok) return res.reason === 'missing' ? 'skip' : 'ambiguous';
      if (typeof res.value !== 'string' || res.value.trim() === '') return 'ambiguous';
      return res.value.trim() === expected ? 'pass' : 'changed';
    };

    const runResumed = async (payload: PendingHandover): Promise<void> => {
      deadHandoverRuns.add(payload.runId);
      // Business-identity recheck (four states): a different or ambiguous value means the declared
      // page belongs to another business instance — cancel conservatively, page-silent
      const recheck = await recheckBusinessKey(payload.flow, payload.businessKey);
      if (recheck === 'changed' || recheck === 'ambiguous') return;
      pageEnterTracker.suppress(payload.flowId, null);
      if (payload.businessKey !== null) pageEnterTracker.suppress(payload.flowId, payload.businessKey);
      // Same orphaning guard as startRun: restore the live run's context when the mutex refuses —
      // nulling activeRun would strand a run that snuck in during the take round-trip
      const prevRun = activeRun;
      activeRun = { flow: payload.flow, runId: payload.runId, dryRun: payload.dryRun, businessKey: payload.businessKey };
      const start = runtime.tryStart(
        { steps: payload.flow.steps, budget: payload.flow.budget },
        { runId: payload.runId, resume: { afterNodeId: payload.resumeAfter, context: payload.context } },
      );
      if (!start.started) {
        // Claimed but the mutex went busy in the take round-trip: hold the payload, retry the
        // start on later arm cycles until the deadline (the serialized boundary — no jumping)
        activeRun = prevRun;
        pendingResume = payload;
        return;
      }
      void start.result.then((result) => settleRun(payload.flow, payload.runId, payload.dryRun, result));
    };

    // Local handover evaluation for the arm cycle: pick the first descriptor whose declared page
    // fingerprint (URL + content, late content waits naturally) matches this document.
    const matchingDescriptor = (): HandoverDescriptor | undefined => {
      const now = Date.now();
      return handovers.find(
        (d) => now <= d.deadline && !deadHandoverRuns.has(d.runId) && pageMatches(doc, d.page),
      );
    };

    // Reconcile observers and page-enter edges with the current flows + page fingerprint. Also the
    // cancellation poll: a run whose flow was paused/deleted/replaced (reloadFlows updated the list) or
    // whose business route was left stops immediately. Finally the handover claim pass: a matched
    // declared page tries to claim its staged run (the pre-claim seeding below keeps the same cycle's
    // pageEnter evaluation from firing the flow as a fresh entry on pathologically overlapping
    // fingerprints).
    const arm = async () => {
      const claimable = activeRun === null && pendingResume === null ? matchingDescriptor() : undefined;
      if (claimable !== undefined) {
        // Seed every dedup-key form the descriptor knows: a businessKey-carrying flow evaluates
        // under `${flowId}|${key}`, and this cycle's evaluate() runs before the claim pass — the
        // flow-level key alone would let a fresh entry double-fire on overlapping fingerprints
        pageEnterTracker.suppress(claimable.flowId, null);
        if (claimable.businessKey !== null) pageEnterTracker.suppress(claimable.flowId, claimable.businessKey);
      }

      if (activeRun !== null) {
        // Enabled-list supervision governs automatic runs only: a preview runs the flow as received
        // from the editor (typically a draft, never in the enabled-only list) and is stopped by its
        // own paths — the user abort and leaving the route
        const stillEnabled =
          activeRun.dryRun || flows.some((r) => r.id === activeRun!.flow.id && r.status === 'enabled');
        // "Leaving the route" for a multi-page flow means leaving every declared page, not just the
        // entry fingerprint: a resumed run sits on a continuation page whose URL the entry page
        // never matches, and the run's own later navigates hop between declared pages
        const inRoute =
          pageRouteMatches(doc, activeRun.flow.page) ||
          (activeRun.flow.pages ?? []).some((entry) => pageRouteMatches(doc, entry.page));
        if (!stillEnabled || !inRoute) {
          runtime.cancel();
        }
      }

      const liveIds = new Set<string>();
      for (const flow of flows) {
        if (flow.trigger.kind !== 'fieldChange') continue;
        liveIds.add(flow.id);
        const existing = watchers.get(flow.id) ?? null;
        // A watcher whose bound element left the DOM (host re-render replaced the node) observes a
        // detached node and would never fire again — drop it so this cycle rebinds the current field
        if (existing !== null && !existing.isAlive()) {
          existing.stop();
          watchers.delete(flow.id);
        }
        const mounted = watchers.has(flow.id);
        const pageOk = pageMatches(doc, flow.page);
        if (!pageOk) {
          if (mounted) {
            watchers.get(flow.id)?.stop();
            watchers.delete(flow.id);
          }
          continue;
        }
        if (!mounted) {
          const watcher = attachFieldChangeWatcher(doc, flow, {
            onFire: (value) => void startFieldChangeRun(flow, value),
            readValue: () => readTriggerValue(flow, readerDriver),
          });
          if (watcher) watchers.set(flow.id, watcher);
        }
      }
      for (const id of Array.from(watchers.keys())) {
        if (!liveIds.has(id)) {
          watchers.get(id)?.stop();
          watchers.delete(id);
        }
      }

      const evaluation = await pageEnterTracker.evaluate(flows, doc, readBusinessKey);
      for (const { flow, reason } of evaluation.skipped) {
        if (reason === 'business-key-unreadable' || reason === 'no-business-key') {
          // A handover claim in flight for this flow makes the skip an artifact of overlapping
          // fingerprints (the key field not yet rendered while the claim round-trip runs) — the
          // resume path owns the outcome, and recheckBusinessKey treats the same gap as 'skip'
          if (claimable?.flowId === flow.id || pendingResume?.flowId === flow.id) continue;
          void emitEvent({ type: 'ct:flowRunStatus', flowId: flow.id, flowDraftHash: flowDraftHash(flow),
            failure: { nodeId: 'trigger', iterationPath: '', stage: 'trigger', reason } });
        }
      }
      for (const { flow, businessKey } of evaluation.toFire) enqueueAutoRun(() => startAutoRun(flow, businessKey));

      // Claim pass. A held payload (claimed while busy) outranks new claims and retries its start
      // until the deadline; a matched descriptor claims atomically — exactly one arriver wins.
      if (pendingResume !== null) {
        const payload = pendingResume;
        pendingResume = null;
        if (Date.now() > payload.deadline) {
          // Never started before the deadline — the source already settled; fail honestly on both
          // run kinds (the dry-run terminal also lands the session fallback nothing else writes)
          if (payload.dryRun) {
            reportDryRunEnd(payload.flow, payload.runId, {
              outcome: 'failed',
              failure: { nodeId: payload.resumeAfter, iterationPath: '', stage: 'navigate', reason: 'timeout' },
              vars: payload.context.vars,
              executed: payload.context.executed,
            });
          } else {
            void emitEvent({ type: 'ct:flowRunStatus', flowId: payload.flowId, flowDraftHash: payload.flowDraftHash,
              failure: { nodeId: payload.resumeAfter, iterationPath: '', stage: 'navigate', reason: 'timeout' } });
          }
          return;
        }
        if (activeRun !== null) {
          pendingResume = payload;
          return;
        }
        await runResumed(payload);
        return;
      }
      if (claimable !== undefined && activeRun === null) {
        const taken = await sendRuntimeMessage({ type: 'ct:takeHandover', runId: claimable.runId }).catch(() => undefined);
        if (taken === undefined) return; // transient send failure — retried next cycle
        if (!taken.ok || taken.handover === undefined) {
          deadHandoverRuns.add(claimable.runId); // gone/expired/wrong-tab/flow-updated: stop trying
          return;
        }
        await runResumed(taken.handover);
      }
    };

    const fetchFlows = async () => {
      try {
        const res = await sendRuntimeMessage({ type: 'ct:getEnabledFlows' });
        if (res?.ok && res.flows) {
          flows = res.flows;
          handovers = res.handovers ?? [];
        } else if (res && res.ok === false) {
          // A definitive rejection (sender-guard failure, or a future background policy) clears the
          // flows so a rejected site executes nothing from now on
          flows = [];
          handovers = [];
        }
      } catch {
        // Keep existing observers when SW wake-up fails; the next arm cycle retries
      }
      await arm();
    };

    onMessage(async (msg, sender) => {
      if (!isFromExtension(sender)) return { ok: false, reason: 'bad-sender' };
      // content only handles bg:* delivered via tabs targeting; other messages are irrelevant to this context
      if (!msg.type.startsWith('bg:')) return undefined;

      switch (msg.type) {
        case 'bg:reloadFlows':
        // Compensation for the target=_blank race: a handover for a page this tab is already
        // showing was staged after this script started — re-pull descriptors and re-evaluate
        case 'bg:handoverStaged': {
          await fetchFlows();
          return { ok: true };
        }

        case 'bg:getContentState': {
          return {
            ok: true,
            state: {
              dryRun: activeRun?.dryRun === true,
              url: doc.location.href,
              origin: doc.location.origin,
              pageTarget: pageTargetOf(doc.location),
            },
          };
        }

        case 'bg:startDryRun': {
          // Shared mutex with automatic execution: one run per document, preview or not
          if (activeRun !== null) return { ok: false, reason: 'page-not-ready' };
          // A preview carries real side effects, so it must sit on the flow's full page fingerprint
          // (URL route AND contentIncludes) — background's tab routing cannot check content
          if (!pageMatches(doc, msg.flow.page)) return { ok: false, reason: 'page-mismatch' };
          // Same input gate as automatic runs: the preview consumes the saved snapshot, never the
          // sidepanel's unsaved draft values
          const gate = await gateFlowInputs(msg.flow, { dryRun: true });
          if (!gate.ok) return { ok: false, reason: gate.reason };
          const claim = await claimBeforeRun(msg.flow);
          if (claim.kind === 'refused') return { ok: false, reason: claim.reason };
          dryRunCleanup = highlightTrigger(doc, msg.flow);
          const res = await startRun(msg.flow, { dryRun: true, trigger: '', inputs: gate.values, businessKey: claim.kind === 'claimed' ? claim.key : null });
          if (!res.started) {
            dryRunCleanup?.();
            dryRunCleanup = null;
            if (claim.kind === 'claimed') void releaseBusinessRun(msg.flow, claim.key);
            return { ok: false, reason: 'page-not-ready' };
          }
          return { ok: true, started: true };
        }

        case 'bg:abortDryRun': {
          if (activeRun?.dryRun === true) {
            // The user said stop: a handover already staged for this run must not stay claimable —
            // the opened declared page would otherwise resume (and really execute) a cancelled
            // preview. Unload-driven cancels never reach this handler, so same-tab navigation
            // keeps its staged state.
            void sendRuntimeMessage({ type: 'ct:dropHandover', runId: activeRun.runId }).catch(() => undefined);
            runtime.cancel();
          }
          return { ok: true };
        }

        default:
          return undefined;
      }
    });

    window.setInterval(() => void arm(), POLL_MS);
    let debounceTimer: number | undefined;
    const observer = new MutationObserver(() => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => void arm(), OBSERVER_DEBOUNCE_MS);
    });
    if (doc.body) observer.observe(doc.body, { childList: true, subtree: true });

    // Document unload cancels the in-flight run and detaches every trigger watcher
    window.addEventListener('pagehide', () => {
      runtime.cancel();
      teardownAll();
    });

    void fetchFlows();
  },
});
