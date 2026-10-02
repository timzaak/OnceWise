// Cross-page handover (DEC-cross-page-flow-001/002): the bridge that lets one run continue across
// documents. The SOURCE document stages a serializable run state at its navigate node (the only
// reliable moment — pagehide fires after the script is gone); the CLAIMING document arrives on the
// declared page, passes the declarative five-condition check and re-compiles the machine from the
// staged context. The staged state is NOT a recovery snapshot: it exists only for the flow's own
// declared navigation within the deadline window, and every other interruption cancels
// conservatively (user refresh, tab close, browser restart — session storage dies with the session,
// flow pause/delete/replace — the flows-write GC).
//
// Split of duties: this module owns the payload/descriptor types, the content-side driver decorator
// (stage/probe/drop) and the background-side adjudication (single writer via serializeStorageWrite).
// The compiler owns resume entry computation; content.ts owns claiming and resuming.
import { browser } from 'wxt/browser';
import type { Browser } from '@wxt-dev/browser';
import { flowDraftHash, validateFlow, type Flow, type PageFingerprint } from './flow-schema';
import { pageTargetOf, urlIncludesMatches } from './locator';
import { sendRuntimeMessage, sendTabMessage } from './messaging';
import { DriverFailure, type FlowContext, type FlowDriver, type HandoverRequest } from './flow-compiler';
import { abortableSleep } from './flow-dom';
import { flowFailuresItem, loadFlows, pendingHandoversItem, serializeStorageWrite } from './storage';

type Tab = Browser.tabs.Tab;

// The staged run state — everything the next document needs to continue THE SAME run (same runId,
// same business claim, accumulated budget). Holds runtime-read values (vars): session storage only,
// this machine only, cleared when the window closes (claim/expiry/cancel) — never logged, synced or
// exported. sourceTabId is stamped by the background from the staging message's sender.
export interface PendingHandover {
  runId: string;
  flowId: string;
  flowDraftHash: string;
  site: string;
  dryRun: boolean;
  businessKey: string | null;
  toPageId: string;
  resumeAfter: string;
  deadline: number;
  createdAt: number;
  sourceTabId: number;
  pageId: string;
  flow: Flow;
  context: FlowContext;
}

// The startup piggyback payload (ct:getEnabledFlows response): descriptors carry the declared page
// fingerprint so content can re-evaluate locally every arm cycle without waking the worker; the
// heavy payload (flow + context) is only handed over on a successful claim.
export interface HandoverDescriptor {
  runId: string;
  flowId: string;
  // The staged business identity (null when the flow declares none): lets the claimant seed the
  // L2 dedup key in BOTH forms before its same-cycle pageEnter evaluation runs
  businessKey: string | null;
  toPageId: string;
  deadline: number;
  page: PageFingerprint;
}

export const HANDOVER_POLL_MS = 500;

// What the content host closes over at navigate time: the run's identity and business claim. Supplied
// as a lazy provider because the decorator wraps the driver before the run id exists.
export interface HandoverHostMeta {
  runId: string;
  flow: Flow;
  dryRun: boolean;
  businessKey: string | null;
}

// Content-side driver decorator: adds the handover capability to a DOM driver (flow-dom stays
// DOM-pure). Stages before awaiting, polls until claimed/dropped, drops on deadline. Resolve means
// "another document owns the run now" (machine settles handed-over); reject means the declared page
// never arrived in time (regular failure path).
export function withHandover(
  driver: FlowDriver,
  metaOf: () => HandoverHostMeta | null,
): FlowDriver {
  return {
    read: (spec, scope, signal) => driver.read(spec, scope, signal),
    act: (spec, value, scope, signal) => driver.act(spec, value, scope, signal),
    waitUntil: (cond, timeoutMs, scope, evaluate, signal) =>
      driver.waitUntil(cond, timeoutMs, scope, evaluate, signal),
    handover: async (req: HandoverRequest, signal: AbortSignal): Promise<void> => {
      const meta = metaOf();
      if (meta === null) throw new DriverFailure('navigate', 'unsupported', req.to);
      const context = structuredClone(req.context);
      context.pageId = req.to;
      const handover: PendingHandover = {
        runId: meta.runId,
        flowId: meta.flow.id,
        flowDraftHash: flowDraftHash(meta.flow),
        site: meta.flow.site,
        dryRun: meta.dryRun,
        businessKey: meta.businessKey,
        toPageId: req.to,
        resumeAfter: req.resumeAfter,
        // The ct:stageHandover message guard requires a safe-integer deadline, and the schema
        // legitimately admits fractional timeoutMs values — round at the boundary
        deadline: Math.round(Date.now() + req.timeoutMs),
        createdAt: Date.now(),
        sourceTabId: -1,
        pageId: req.to,
        flow: meta.flow,
        context,
      };
      const staged = await sendRuntimeMessage({ type: 'ct:stageHandover', handover });
      if (!staged?.ok) throw new DriverFailure('navigate', staged?.reason ?? 'stage-failed', req.to);
      while (!signal.aborted) {
        const probe = await sendRuntimeMessage({ type: 'ct:probeHandover', runId: meta.runId }).catch(
          () => undefined,
        );
        if (probe?.ok && probe.status !== 'pending') return;
        if (Date.now() >= handover.deadline) {
          // The navigation never happened (SPA-intercepted submit, validation hold) or the declared
          // page never arrived — fail like a wait timeout and drop the staged state. No replay.
          void sendRuntimeMessage({ type: 'ct:dropHandover', runId: meta.runId }).catch(() => undefined);
          throw new DriverFailure('navigate', 'timeout', `${req.timeoutMs}ms`);
        }
        await abortableSleep(HANDOVER_POLL_MS, signal);
      }
    },
  };
}

interface SenderFacts {
  origin: string;
  tabId: number | undefined;
  url: string;
}

function declaredPageOf(handover: PendingHandover): PageFingerprint | undefined {
  return handover.flow.pages?.find((entry) => entry.id === handover.toPageId)?.page;
}

// Auto-run identity: the staged flow must still be the stored, enabled flow it started from. A dry
// run previews the flow as received (typically an unsaved editor draft) — the store can only veto it
// when the record is gone outright (delete).
function autoHandoverStillValid(handover: PendingHandover, flows: Flow[]): boolean {
  if (handover.dryRun) return flows.some((flow) => flow.id === handover.flowId);
  return flows.some(
    (flow) => flow.id === handover.flowId && flow.status === 'enabled' && flowDraftHash(flow) === handover.flowDraftHash,
  );
}

export function stageHandover(
  payload: PendingHandover,
  sender: SenderFacts,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return (async () => {
    if (sender.origin !== payload.site) return { ok: false, reason: 'site-mismatch' };
    // Defensive full revalidation: the payload crosses a message boundary, and a flow that no
    // longer passes its own schema must never become a resumed run
    const validated = validateFlow(payload.flow, 'full');
    if (!validated.ok || validated.flow === undefined) return { ok: false, reason: 'invalid-flow' };
    if (!payload.dryRun) {
      const flows = await loadFlows();
      if (!autoHandoverStillValid(payload, flows)) return { ok: false, reason: 'flow-updated' };
    }
    await serializeStorageWrite(async () => {
      const list = [...(await pendingHandoversItem.getValue())];
      const next = { ...payload, sourceTabId: sender.tabId ?? -1 };
      const at = list.findIndex((entry) => entry.runId === payload.runId);
      if (at >= 0) list[at] = next;
      else list.push(next);
      await pendingHandoversItem.setValue(list);
    });
    return { ok: true };
  })();
}

export async function probeHandover(runId: string): Promise<'pending' | 'gone'> {
  const list = await pendingHandoversItem.getValue();
  return list.some((entry) => entry.runId === runId) ? 'pending' : 'gone';
}

export async function dropHandover(runId: string): Promise<void> {
  await serializeStorageWrite(async () => {
    const list = await pendingHandoversItem.getValue();
    const next = list.filter((entry) => entry.runId !== runId);
    if (next.length !== list.length) await pendingHandoversItem.setValue(next);
  });
}

export type TakeHandoverResult =
  | { ok: true; handover: PendingHandover }
  | { ok: false; reason: 'gone' | 'expired' | 'wrong-tab' | 'site-mismatch' | 'flow-updated' };

// Atomic claim: all five declarative conditions adjudicated inside one serialized section, entry
// removed before the payload is returned — a second arriver finds nothing (single winner).
// site-mismatch/wrong-tab keep the entry (the claimant was not entitled, the real one may still
// come); expired/flow-updated remove it (the handover is dead either way).
export async function takeHandover(runId: string, sender: SenderFacts): Promise<TakeHandoverResult> {
  return serializeStorageWrite(async () => {
    const list = await pendingHandoversItem.getValue();
    const at = list.findIndex((entry) => entry.runId === runId);
    if (at < 0) return { ok: false, reason: 'gone' };
    const handover = list[at]!;
    const remove = async (): Promise<void> => {
      await pendingHandoversItem.setValue(list.filter((entry) => entry.runId !== runId));
    };
    if (sender.origin !== handover.site) return { ok: false, reason: 'site-mismatch' };
    if (Date.now() > handover.deadline) {
      await remove();
      return { ok: false, reason: 'expired' };
    }
    let related = sender.tabId === handover.sourceTabId;
    if (!related && sender.tabId !== undefined) {
      const tab = await browser.tabs.get(sender.tabId).catch(() => null);
      related = tab?.openerTabId === handover.sourceTabId;
    }
    if (!related) return { ok: false, reason: 'wrong-tab' };
    const declared = declaredPageOf(handover);
    if (declared === undefined) {
      await remove();
      return { ok: false, reason: 'flow-updated' };
    }
    // URL-side defensive recheck of the content side's full fingerprint match (Tab.url is readable
    // under the existing host_permissions; no tabs permission involved)
    let target = '';
    try {
      target = pageTargetOf(new URL(sender.url));
    } catch {
      target = '';
    }
    if (!urlIncludesMatches(target, declared.urlIncludes)) return { ok: false, reason: 'wrong-tab' };
    if (!autoHandoverStillValid(handover, await loadFlows())) {
      await remove();
      return { ok: false, reason: 'flow-updated' };
    }
    await pendingHandoversItem.setValue(list.filter((entry) => entry.runId !== runId));
    return { ok: true, handover };
  });
}

// Failure notice for a handover that expired unclaimed with a dead source page (the alive-source
// path reports through the regular failure chain). Cancel-class endings (tab closed, flow updated,
// browser restart) stay silent — cancelling is not an error.
async function writeNavigationTimeoutNotice(handover: PendingHandover): Promise<void> {
  const notices = { ...(await flowFailuresItem.getValue()) };
  notices[handover.flowId] = {
    flowId: handover.flowId,
    flowDraftHash: handover.flowDraftHash,
    ts: Date.now(),
    failure: {
      nodeId: handover.resumeAfter,
      iterationPath: handover.context.iterationPath,
      stage: 'navigate',
      reason: 'navigation-timeout',
    },
  };
  await flowFailuresItem.setValue(notices);
}

// Lazy GC — cold start, every flows write, every status flip and each claim pass. Deadline expiry
// is the three-way enforcement's background leg (source polling and the claim check are the other
// two); flow identity changes cancel in-flight handovers of that flow (pause/delete/replace).
export async function gcHandovers(): Promise<void> {
  await serializeStorageWrite(async () => {
    const list = await pendingHandoversItem.getValue();
    if (list.length === 0) return;
    const flows = await loadFlows();
    const now = Date.now();
    const kept: PendingHandover[] = [];
    for (const handover of list) {
      if (now > handover.deadline) {
        if (!handover.dryRun) await writeNavigationTimeoutNotice(handover);
        continue;
      }
      if (!autoHandoverStillValid(handover, flows)) continue;
      kept.push(handover);
    }
    if (kept.length !== list.length) await pendingHandoversItem.setValue(kept);
  });
}

// Closing the source tab cancels its in-flight handovers (the waiting run's host face is gone).
// A claimed run is already removed from the list — closing the source AFTER a claim no longer
// affects the run, whose host is the claiming tab from then on.
export async function cancelHandoversByTab(closedTabId: number): Promise<void> {
  await serializeStorageWrite(async () => {
    const list = await pendingHandoversItem.getValue();
    const next = list.filter((entry) => entry.sourceTabId !== closedTabId);
    if (next.length !== list.length) await pendingHandoversItem.setValue(next);
  });
}

export async function handoverDescriptorsFor(origin: string): Promise<HandoverDescriptor[]> {
  const now = Date.now();
  const descriptors: HandoverDescriptor[] = [];
  for (const handover of await pendingHandoversItem.getValue()) {
    if (handover.site !== origin || now > handover.deadline) continue;
    const page = declaredPageOf(handover);
    if (page === undefined) continue;
    descriptors.push({ runId: handover.runId, flowId: handover.flowId, businessKey: handover.businessKey, toPageId: handover.toPageId, deadline: handover.deadline, page });
  }
  return descriptors;
}

// Compensation push for the target=_blank race: the new tab's content script may have started (and
// probed) before staging completed. Tabs already showing the declared page URL get told to re-pull.
export async function pushHandoverStaged(handover: PendingHandover): Promise<void> {
  const declared = declaredPageOf(handover);
  if (declared === undefined) return;
  const tabs = await browser.tabs.query({ url: `${handover.site}/*` }).catch(() => [] as Tab[]);
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || typeof tab.url !== 'string') return;
      let target = '';
      try {
        target = pageTargetOf(new URL(tab.url));
      } catch {
        return;
      }
      if (!urlIncludesMatches(target, declared.urlIncludes)) return;
      await sendTabMessage(tab.id, { type: 'bg:handoverStaged' }).catch(() => undefined);
    }),
  );
}
