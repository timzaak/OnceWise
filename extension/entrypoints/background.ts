// background: message routing, the single writer for flows, the native-messaging channel, flow-site
// content-script lifecycle (registration sync after flows writes + cold start) and the pageEnter claim
// service.
import { browser } from 'wxt/browser';
import {
  isFromContentScript,
  isFromExtensionPage,
  onMessage,
  sendTabMessage,
  type ExtensionMessage,
  type ExtensionResponse,
  type MessageSender,
} from '@/lib/messaging';
import { parseOrigin, flowDraftHash, validateFlow, type Flow, type RunFailureDetail } from '@/lib/flow-schema';
import { createLogger } from '@/lib/logger';
import { openWelcomePage } from '@/lib/import-page';
import { connectNativeChannel, isNativeChannelConnected } from '@/lib/native-messaging';
import {
  buildStoredInputMap,
  evaluateFlowInputs,
  type InputIssue,
  type FlowInputValueMap,
} from '@/lib/flow-inputs';
import {
  businessClaimKey,
  claimBusinessInstance,
  deleteFlowCompletely,
  loadFlows,
  NATIVE_READ_GRANT_TTL_MS,
  pruneOrphanFlowInputValues,
  readFlowInputValues,
  releaseBusinessInstance,
  rollbackFlowRecord,
  flowFailuresItem,
  flowHistoryMeta,
  saveFlowRecord,
  setNativeReadGrant,
  setFlowStatusRecord,
  setFlowFailureNotice,
  writeLastDryRunResult,
  writeFlowInputValues,
} from '@/lib/storage';
import {
  afterFlowsWrite,
  pushReloadFlows,
  flowSiteOrigins,
  flowSiteTabs,
  syncFlowSiteScripts,
} from '@/lib/site-scripts';
import {
  cancelHandoversByTab,
  dropHandover,
  gcHandovers,
  handoverDescriptorsFor,
  probeHandover,
  pushHandoverStaged,
  stageHandover,
  takeHandover,
  type PendingHandover,
} from '@/lib/flow-handover';
import { handleSyncMessage } from '@/lib/sync-service';
import type { Browser } from '@wxt-dev/browser';

type Tab = Browser.tabs.Tab;

const log = createLogger('bg');

// The session notice for an input-gated skip: labels and issue reasons only, never the values.
function inputFailure(issues: InputIssue[]): RunFailureDetail {
  return {
    nodeId: 'inputs',
    iterationPath: '',
    stage: 'input',
    reason: 'input-invalid',
    detail: issues.map((i) => `${i.label} (${i.key}): ${i.reason}`).join('; '),
  };
}

// Saving inputs only settles input-related notices: a resolved input-invalid notice clears, a
// persisting one refreshes; unrelated run failures (locate/verify/…) stay untouched.
async function reconcileInputNotice(flow: Flow, issues: InputIssue[]): Promise<void> {
  const notice = (await flowFailuresItem.getValue())[flow.id];
  if (notice === undefined) return;
  if (notice.failure.reason !== 'input-invalid' && notice.failure.reason !== 'input-unavailable') return;
  if (issues.length === 0) {
    await setFlowFailureNotice(flow.id, null);
    return;
  }
  await setFlowFailureNotice(flow.id, {
    flowId: flow.id,
    flowDraftHash: flowDraftHash(flow),
    ts: Date.now(),
    failure: inputFailure(issues),
  });
}

// Routing target for bg:*: the active tab when it belongs to a flow site, else any flow-site tab
async function activeFlowSiteTab(): Promise<Tab | null> {
  const sites = new Set(await flowSiteOrigins());
  const active = await browser.tabs.query({ active: true, currentWindow: true }).catch(() => [] as Tab[]);
  const activeTab = active.find((t) => sites.has(parseOrigin(t.url ?? '') ?? ''));
  if (activeTab) return activeTab;
  const any = await flowSiteTabs();
  return any[0] ?? null;
}

// Extension UI pages (sidepanel / import page — isFromExtensionPage guard)
async function handleUiPage(msg: ExtensionMessage): Promise<ExtensionResponse | undefined> {
  switch (msg.type) {
    case 'sp:getFlows':
      return { ok: true, flows: await loadFlows() };

    case 'sp:saveFlow': {
      const validated = validateFlow(msg.flow, 'full');
      if (!validated.ok || !validated.flow) {
        return { ok: false, reason: 'invalid-flow', errors: validated.errors };
      }
      const flow: Flow = {
        ...validated.flow,
        provenance: { ...validated.flow.provenance, updatedAt: Date.now() },
      };
      const outcome = await saveFlowRecord(flow, msg.expectedUpdatedAt);
      if (outcome.changed === true) return { ok: false, reason: 'changed' };
      await setFlowFailureNotice(flow.id, null);
      await afterFlowsWrite();
      // The stamped updatedAt is the editor's next CAS token — without it a second save from the
      // same session would conflict against its own first write
      return { ok: true, updatedAt: flow.provenance.updatedAt };
    }

    // Native channel UI surface: the read grant behind flow.read is issued only for an existing,
    // not-enabled flow — the sidepanel pauses it first as part of the "Improve with AI" flow. One
    // grant slot, 15-minute TTL, cleared by replace/delete/restart.
    case 'sp:grantNativeRead': {
      const flow = (await loadFlows()).find((r) => r.id === msg.flowId);
      if (!flow) return { ok: false, reason: 'flow-not-found' };
      if (flow.status === 'enabled') return { ok: false, reason: 'flow-enabled' };
      await setNativeReadGrant({ flowId: msg.flowId, grantedAt: Date.now() });
      return { ok: true, expiresInMs: NATIVE_READ_GRANT_TTL_MS };
    }

    case 'sp:getNativeChannelState':
      return { ok: true, connected: isNativeChannelConnected() };

    case 'sp:getFlowHistory': {
      const versions = await flowHistoryMeta(msg.flowId);
      if (versions === null) return { ok: false, reason: 'flow-not-found' };
      return { ok: true, versions };
    }

    // User-only rollback (DEC-009): revalidated snapshot as a new draft version; a failure changes
    // neither the flow nor its history. The record write clears the read grant in its own section.
    case 'sp:rollbackFlow': {
      const outcome = await rollbackFlowRecord(msg.flowId, msg.versionId);
      if (outcome !== 'ok') return { ok: false, reason: outcome };
      await setFlowFailureNotice(msg.flowId, null);
      await afterFlowsWrite();
      return { ok: true };
    }

    case 'sp:setFlowStatus': {
      const res = await setFlowStatusRecord(msg.id, msg.status);
      if (!res.ok) return { ok: false, reason: res.reason ?? 'unknown' };
      // A status flip never changes the flow-site set — only the reload push is needed. Pausing
      // cancels in-flight handovers of the flow (the run, cross-page included, stops now)
      await Promise.all([pushReloadFlows(), gcHandovers()]);
      return { ok: true };
    }

    case 'sp:deleteFlow': {
      // One serialized section removes the flow, its saved input values, its failure notice and any
      // read grant pointing at it — separate writes could be interrupted between them, orphaning the
      // values. The store delete also clears the flow's history and receipts.
      await deleteFlowCompletely(msg.id);
      await afterFlowsWrite();
      return { ok: true };
    }

    // Flow-detail input values: read recomputes issues against the CURRENT definitions (stale records
    // from an older definition are withheld from values); save validates the whole mapping first and
    // rejects explicit invalid values with zero writes.
    case 'sp:getFlowInputs': {
      const flow = (await loadFlows()).find((r) => r.id === msg.flowId);
      if (!flow) return { ok: false, reason: 'flow-not-found' };
      const evaluation = evaluateFlowInputs(flow, await readFlowInputValues(flow.id));
      return { ok: true, values: evaluation.values, inputIssues: evaluation.issues };
    }

    case 'sp:saveFlowInputs': {
      const flow = (await loadFlows()).find((r) => r.id === msg.flowId);
      if (!flow) return { ok: false, reason: 'flow-not-found' };
      const built = buildStoredInputMap(flow, msg.values);
      if (!built.ok) return { ok: false, reason: 'invalid-input', inputIssues: built.issues };
      await writeFlowInputValues(flow.id, built.map);
      const evaluation = evaluateFlowInputs(flow, built.map);
      await reconcileInputNotice(flow, evaluation.issues);
      return { ok: true, values: evaluation.values, inputIssues: evaluation.issues };
    }

    case 'bg:startDryRun':
    case 'bg:abortDryRun':
    case 'bg:getContentState': {
      // bg:* initiated by an extension page is routed to the active flow-site tab (same message names as
      // background->content; no extra protocol)
      const tab = await activeFlowSiteTab();
      if (!tab || tab.id === undefined) return { ok: false, reason: 'no-flow-site-tab' };
      const resp = await sendTabMessage(tab.id, msg).catch(() => undefined);
      return resp ?? { ok: false, reason: 'content-unreachable' };
    }

    default:
      return undefined;
  }
}

// Content scripts on flow sites (isFromContentScript guard)
async function handleContent(
  msg: ExtensionMessage,
  sender: MessageSender,
): Promise<ExtensionResponse | undefined> {
  if (!isFromContentScript(sender)) return { ok: false, reason: 'bad-sender' };
  const origin = parseOrigin(sender.url ?? '') ?? '';

  switch (msg.type) {
    case 'ct:getEnabledFlows': {
      // The two storage reads are independent and run concurrently
      const [allFlows, handovers] = await Promise.all([loadFlows(), handoverDescriptorsFor(origin)]);
      const flows = allFlows.filter((r) => r.site === origin && r.status === 'enabled');
      // Startup piggyback: this site's in-flight handover descriptors ride the flows pull — the
      // claiming evaluation happens locally on the content side, zero extra round trips
      return { ok: true, flows, ...(handovers.length > 0 ? { handovers } : {}) };
    }
    // Cross-page handover ops — all adjudication lives in lib/flow-handover.ts under the single
    // writer; here we only forward the sender facts it cannot know (tab id, url)
    case 'ct:stageHandover': {
      const staged = await stageHandover(msg.handover as PendingHandover, {
        origin,
        tabId: sender.tab?.id,
        url: sender.url ?? '',
      });
      if (!staged.ok) return { ok: false, reason: staged.reason };
      await pushHandoverStaged(msg.handover as PendingHandover);
      return { ok: true };
    }
    case 'ct:probeHandover':
      return { ok: true, status: await probeHandover(msg.runId) };
    case 'ct:takeHandover': {
      const taken = await takeHandover(msg.runId, {
        origin,
        tabId: sender.tab?.id,
        url: sender.url ?? '',
      });
      return taken.ok ? { ok: true, handover: taken.handover } : { ok: false, reason: taken.reason };
    }
    case 'ct:dropHandover':
      await dropHandover(msg.runId);
      return { ok: true };
    // Run-start input snapshot: this site's flow, values revalidated against the current definitions.
    // Automatic runs additionally require the enabled status and a current draft hash — a stale script
    // pulls nothing. A dry-run preview (dryRun: true) carries the editor's flow (typically a draft,
    // often with unsaved edits), so only the site must match — and its gate refusals are preview-local:
    // the session failure notice records AUTOMATIC trigger outcomes, never user previews. Any issue (or
    // an unreadable store) refuses the snapshot — the content side then skips with zero page actions.
    // The two storage reads are independent and run concurrently; the response itself is
    // channel-cloned and the compiler takes the run's private copy, so no extra deep copy is made here.
    case 'ct:getInputSnapshot': {
      const [flows, storedOrError] = await Promise.all([
        loadFlows(),
        // null marks an unreadable store; a flow-mismatch response discards the read either way
        readFlowInputValues(msg.flowId).catch((): FlowInputValueMap | null => null),
      ]);
      const flow = flows.find((r) => r.id === msg.flowId);
      if (flow === undefined || flow.site !== origin) return { ok: false, reason: 'flow-mismatch' };
      if (msg.dryRun !== true && (flow.status !== 'enabled' || flowDraftHash(flow) !== msg.flowDraftHash)) {
        return { ok: false, reason: 'flow-mismatch' };
      }
      if ((flow.inputs?.length ?? 0) === 0) return { ok: true, values: {} };
      if (storedOrError === null) {
        if (msg.dryRun !== true) {
          await setFlowFailureNotice(flow.id, {
            flowId: flow.id,
            flowDraftHash: msg.flowDraftHash,
            ts: Date.now(),
            failure: { nodeId: 'inputs', iterationPath: '', stage: 'input', reason: 'input-unavailable' },
          });
        }
        return { ok: false, reason: 'input-unavailable' };
      }
      const evaluation = evaluateFlowInputs(flow, storedOrError);
      if (evaluation.issues.length > 0) {
        if (msg.dryRun !== true) {
          await setFlowFailureNotice(flow.id, {
            flowId: flow.id,
            flowDraftHash: msg.flowDraftHash,
            ts: Date.now(),
            failure: inputFailure(evaluation.issues),
          });
        }
        return { ok: false, reason: 'input-invalid', inputIssues: evaluation.issues };
      }
      return { ok: true, values: evaluation.values };
    }
    case 'ct:claimBusiness': {
      const granted = await claimBusinessInstance(
        businessClaimKey(msg.site, msg.flowId, msg.businessKey),
      );
      return { ok: true, granted };
    }
    case 'ct:releaseBusiness': {
      await releaseBusinessInstance(businessClaimKey(msg.site, msg.flowId, msg.businessKey));
      return { ok: true };
    }
    case 'ct:flowRunStatus': {
      const flow = (await loadFlows()).find((r) => r.id === msg.flowId);
      if (!flow || flow.site !== origin || flow.status !== 'enabled' || flowDraftHash(flow) !== msg.flowDraftHash) {
        return { ok: false, reason: 'flow-mismatch' };
      }
      await setFlowFailureNotice(flow.id, msg.failure === undefined ? null : {
        flowId: flow.id,
        flowDraftHash: msg.flowDraftHash,
        ts: Date.now(),
        failure: msg.failure,
      });
      return { ok: true };
    }
    // ct:dryRunProgress reaches the sidepanel directly; dryRunFinished is persisted to session as a fallback
    // so a dry run started while the sidepanel is closed still delivers its result (matched by flowDraftHash
    // on reopen; session display only)
    case 'ct:dryRunProgress':
      return { ok: true };
    case 'ct:dryRunFinished':
      await writeLastDryRunResult({
        flowDraftHash: msg.flowDraftHash,
        ok: msg.ok,
        ts: Date.now(),
        outcome: msg.outcome,
        ...(msg.detail !== undefined ? { detail: msg.detail } : {}),
      });
      return { ok: true };
    default:
      return undefined;
  }
}

export default defineBackground(() => {
  // All listeners are registered synchronously inside main without awaiting async init (MV3 SW is event-driven).
  // Routing order: ct:* passes isFromContentScript first, sp:*/bg:* pass isFromExtensionPage;
  // sp:sync* forwards to the sync service (all sync fetches + space bookkeeping live in lib/sync-service.ts).
  onMessage(async (msg, sender) => {
    if (msg.type.startsWith('ct:')) return handleContent(msg, sender);
    if (!isFromExtensionPage(sender)) return { ok: false, reason: 'bad-sender' };
    // sp:syncPullVersion enters local flows via saveFlowRecord inside the sync service, whose handler
    // runs the post-write step (registration reconcile + reload push) itself — no router-level hook
    if (msg.type.startsWith('sp:sync')) return handleSyncMessage(msg);
    return handleUiPage(msg);
  });

  // Toolbar icon click opens the sidepanel workbench directly (the popup middleman is gone); the
  // sidepanel's default view is the flows list, so one click lands on the work page.
  void browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => undefined);

  // Native Messaging port: connect synchronously at cold start; disconnects reconnect with backoff
  // inside lib/native-messaging.ts. Chrome launches the host on this connect.
  connectNativeChannel();

  // Closing the source tab cancels its waiting run's in-flight handovers (registered synchronously
  // in main — no permission required; the event wakes the worker)
  browser.tabs.onRemoved.addListener((closedTabId) => {
    void cancelHandoversByTab(closedTabId);
  });

  // On install (not update — reopening after upgrades would be disruptive) the welcome page opens
  // once: first-run tutorial plus the repository star CTA. The import page stays reachable from the
  // sidepanel settings and the welcome page's own link.
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      void openWelcomePage();
    }
  });

  // Every SW cold start: re-align dynamic content-script registrations with the flow-site set
  // (repairs drift such as registrations dropped by the profile), sweep value records orphaned by
  // an interrupted delete (writes only when orphans exist), and lazily GC expired or invalidated
  // handovers (one leg of the deadline's three-way enforcement). All consume the same single store
  // read and have no data dependency, so they run concurrently.
  void (async () => {
    const flows = await loadFlows();
    await Promise.all([
      syncFlowSiteScripts([...new Set(flows.map((r) => r.site))]),
      pruneOrphanFlowInputValues(new Set(flows.map((r) => r.id))),
      gcHandovers(),
    ]);
  })().catch((error) => {
    // A silent failure here would leave stale site injections until the next successful cold start
    log.error('cold-start reconcile failed', error);
  });
});
