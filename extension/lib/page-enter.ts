// Page-enter machinery (DEC-019 §5.3): fingerprint evaluation, the L1 rising-edge latch and the L2
// document-level dedup keyed by business instance (same document, different 单据 → each allowed once).
// The business-instance claim itself lives in background storage (single writer); this module only
// asks over ct:claimBusiness. Claims are business-scoped and never TTL-released (no page-fingerprint token).
import { resolveField, urlIncludesMatches, pageTargetOf } from './locator';
import { type PageFingerprint, type Flow } from './flow-schema';
import { stepsHaveSubmitAction } from './step-schema';
import { sendRuntimeMessage } from './messaging';

// URL part of the fingerprint plus optional content features: every contentIncludes ref must resolve
// uniquely and visibly; ambiguity counts as a miss (prefer missing over misfiring)
export function pageMatches(doc: Document, page: PageFingerprint): boolean {
  if (!urlIncludesMatches(pageTargetOf(doc.location), page.urlIncludes)) return false;
  return contentIncludesSatisfied(doc, page);
}

// Runtime page identity (§5.2): the URL route only. contentIncludes features may legitimately vanish
// while editing/saving (the start button disappearing must not read as "left the page"), so they gate
// triggering but never cancel a running flow.
export function pageRouteMatches(doc: Document, page: PageFingerprint): boolean {
  return urlIncludesMatches(pageTargetOf(doc.location), page.urlIncludes);
}

export function contentIncludesSatisfied(doc: Document, page: PageFingerprint): boolean {
  const refs = page.contentIncludes;
  if (!refs || refs.length === 0) return true;
  return refs.every((ref) => {
    const resolved = resolveField(doc, ref);
    return !('error' in resolved);
  });
}

// L2 document-level dedup key: one fire per business instance when the flow declares one, per flow
// otherwise — evaluate() and suppress() must agree on this format
function l2DedupKey(flowId: string, businessKey: string | null): string {
  return businessKey !== null ? `${flowId}|${businessKey}` : flowId;
}

export interface PageEnterEvaluation {
  // toFire entries carry the business key read at the rising edge (null when the flow declares none)
  toFire: { flow: Flow; businessKey: string | null }[];
  // Rising edges blocked before a run starts; callers log them as skips
  skipped: { flow: Flow; reason: string }[];
}

// L1: per-flow hit boolean, only the false→true rising edge triggers an evaluation (observer storms
// while continuously matched never re-trigger). For flows declaring a businessKey, a KEY CHANGE while
// continuously matched re-arms the edge — the fingerprint covers many 单据 (a shared URL prefix), so
// "same document, different business instance" must still fire. L2: within one document lifetime each
// flow fires at most once PER BUSINESS INSTANCE. Submit-carrying flows without a businessKey
// declaration are refused here (PRD §5.3: 缺少可靠业务标识时保守拒绝启动).
export class PageEnterTracker {
  private matched = new Map<string, boolean>();
  private lastBusinessKey = new Map<string, string | null>();
  private firedInDocument = new Set<string>();

  async evaluate(
    flows: Flow[],
    doc: Document,
    readBusinessKey: (flow: Flow) => Promise<string | null>,
  ): Promise<PageEnterEvaluation> {
    const toFire: PageEnterEvaluation['toFire'] = [];
    const skipped: PageEnterEvaluation['skipped'] = [];
    for (const flow of flows) {
      if (flow.trigger.kind !== 'pageEnter') continue;
      const hit = pageMatches(doc, flow.page);
      const was = this.matched.get(flow.id) ?? false;
      this.matched.set(flow.id, hit);

      let businessKey: string | null;
      if (!hit) {
        // Left the fingerprint: the next match re-reads the business key from scratch
        this.lastBusinessKey.set(flow.id, null);
        continue;
      }
      if (was) {
        // Continuously matched: only a business-key change re-arms the edge
        if (flow.businessKey === undefined) continue;
        businessKey = await readBusinessKey(flow);
        const last = this.lastBusinessKey.get(flow.id) ?? null;
        this.lastBusinessKey.set(flow.id, businessKey);
        if (businessKey === last) continue;
      } else {
        businessKey =
          flow.businessKey !== undefined ? await readBusinessKey(flow) : null;
        this.lastBusinessKey.set(flow.id, businessKey);
      }

      if (flow.businessKey !== undefined && businessKey === null) {
        skipped.push({ flow, reason: 'business-key-unreadable' });
        continue;
      }
      if (flow.businessKey === undefined && stepsHaveSubmitAction(flow.steps)) {
        skipped.push({ flow, reason: 'no-business-key' });
        continue;
      }
      const dedupKey = l2DedupKey(flow.id, businessKey);
      if (this.firedInDocument.has(dedupKey)) {
        skipped.push({ flow, reason: 'page-enter-dedup' });
        continue;
      }
      this.firedInDocument.add(dedupKey);
      toFire.push({ flow, businessKey });
    }
    return { toFire, skipped };
  }

  // Cross-page resume support: a document that is about to claim (or has claimed) a handover for
  // this flow must not also fire it as a fresh entry — even when a pathological declaration makes
  // the continuation page's fingerprint overlap the entry fingerprint. Seeds the same L2 dedup key
  // evaluate() would compute; call once per business-key form the resume knows about.
  suppress(flowId: string, businessKey: string | null): void {
    this.firedInDocument.add(l2DedupKey(flowId, businessKey));
  }
}

// Cross-tab business-instance claim for submit-carrying flows: taken before execution and kept
// whether the run succeeds or fails (no retry, no auto-release). Unreachable background = refuse to
// execute (conservative abort). Dry runs share the same claim — a previewed submit is a real submit.
export async function claimBusinessRun(flow: Flow, businessKey: string): Promise<boolean> {
  try {
    const res = await sendRuntimeMessage({
      type: 'ct:claimBusiness',
      site: flow.site,
      flowId: flow.id,
      businessKey,
    });
    return Boolean(res?.ok && res.granted);
  } catch {
    return false;
  }
}

// Return a claim taken for a start that never happened (mutex refusal / route left mid round-trip):
// the instance was never acted on, so it must stay runnable. Best-effort — an unreachable background
// keeps the claim held, which only costs one already-doomed business instance.
export async function releaseBusinessRun(flow: Flow, businessKey: string): Promise<void> {
  try {
    await sendRuntimeMessage({
      type: 'ct:releaseBusiness',
      site: flow.site,
      flowId: flow.id,
      businessKey,
    });
  } catch {
    // conservative: the claim stays held
  }
}

export function needsBusinessClaim(flow: Flow): boolean {
  return stepsHaveSubmitAction(flow.steps);
}
