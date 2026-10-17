// Timed trigger: device-local schedules that start enabled flows at wall-clock times
// (DEC-support-scheduler-001/002). The staged-descriptor structure mirrors cross-page handovers
// (atomic single-winner claims, deadline-windowed), but as an independent set — flow-handover.ts
// is untouched. The background only adjudicates and supplies a page; the run itself always
// executes in the target tab's content script through the regular automatic-run pipeline
// (input gate -> business claim -> single-run mutex), which stays unchanged.
//
// Record-driven truth: a schedule's nextDueAt is the idempotency token. Alarm fires and SW cold
// starts converge on the same reconcileSchedules() pass, which re-reads records inside the single
// serialized write section. No Chrome alarm-replay behavior is relied upon — occurrences woken too
// late or fallen due while the browser was closed are judged by the bounded grace window and
// become honest "missed" session notices; nothing is back-filled, nothing auto-retries.
import { browser } from 'wxt/browser';
import type { Browser } from '@wxt-dev/browser';
import {
  flowDraftHash,
  isValidSchedulePeriod,
  parseHm,
  parseOrigin,
  type Flow,
  type PageFingerprint,
  type SchedulePeriod,
} from './flow-schema';
import { pageTargetOf, urlIncludesMatches } from './locator';
import { sendTabMessage } from './messaging';
import { formatTime } from './ui-labels';
import {
  flowFailuresItem,
  flowSchedulesItem,
  flowStoreItem,
  loadFlows,
  pendingTimedStartsItem,
  serializeStorageWrite,
  type FlowFailureNotice,
} from './storage';

type Tab = Browser.tabs.Tab;

export interface FlowSchedule {
  id: string;
  flowId: string;
  // Snapshot of flow.site at save time (the entry URL's origin was verified against it); the
  // dispatch-time tabs.query uses it
  site: string;
  entryUrl: string;
  period: SchedulePeriod;
  createdAt: number;
  updatedAt: number;
  // The currently armed occurrence (epoch ms), maintained only by the background; the UI displays
  // it but never recomputes it (one calculation site, no drift)
  nextDueAt: number;
}

// A timed start handed to a page: staging is committed in the SAME serialized section as the
// record advance (crash between commit and dispatch leaves the descriptor in storage — the expiry
// GC then reports honestly instead of silently losing the occurrence). local: (not session:) so a
// browser restart mid-window still yields the honest expiry notice.
export interface StagedTimedStart {
  // `${scheduleId}@${occurrenceMs}` — the occurrence is part of the id, so a late claim of an old
  // occurrence can never consume the next one's slot
  triggerId: string;
  scheduleId: string;
  flowId: string;
  site: string;
  page: PageFingerprint;
  deadline: number;
  createdAt: number;
}

// The ct:getEnabledFlows piggyback payload: carries the entry page fingerprint so content can
// re-evaluate locally every arm cycle without waking the worker
export interface TimedStartDescriptor {
  triggerId: string;
  flowId: string;
  page: PageFingerprint;
  deadline: number;
}

// Wake later than this past the scheduled occurrence counts as missed (Chrome alarm delay is
// usually seconds, batch wakes at most ~1 minute; 2 minutes absorbs the platform jitter)
export const SCHEDULE_GRACE_MS = 120_000;
// Claim window for a staged timed start: covers a fresh tab load + document_idle injection + late
// contentIncludes. Anchored at STAGING time, not the occurrence: a wake up to SCHEDULE_GRACE_MS
// late must still leave a claimable window (an occurrence-anchored deadline would already be past)
export const TIMED_START_WINDOW_MS = 60_000;
export const MAX_SCHEDULES = 50;

const TIMED_START_GC_ALARM = 'ssba-timedstart-gc';

export function scheduleAlarmName(scheduleId: string): string {
  return `ssba-sched-${scheduleId}`;
}

// The next occurrence strictly after `after` in this machine's timezone. Daily/weekly build the
// target wall clock from local Date components (day/month/year rollover and DST normalization are
// native) — the re-arm after each fire recomputes the wall clock instead of adding a fixed
// periodInMinutes, which would drift an hour across DST transitions. A nonexistent wall time on
// the spring-forward day (e.g. 02:30) normalizes to the post-transition moment. Interval
// occurrences chain occurrence + interval from the creation-time anchor (each nextDueAt derives
// from the previous one), so the grid never drifts with processing time; an edit re-bases it.
export function nextOccurrenceAfter(after: number, period: SchedulePeriod): number {
  switch (period.kind) {
    case 'interval':
      return after + period.minutes * 60_000;
    case 'daily': {
      const hm = parseHm(period.time)!;
      const base = new Date(after);
      let candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hm.h, hm.m, 0, 0);
      if (candidate.getTime() <= after) {
        candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, hm.h, hm.m, 0, 0);
      }
      return candidate.getTime();
    }
    case 'weekly': {
      const hm = parseHm(period.time)!;
      const base = new Date(after);
      let candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hm.h, hm.m, 0, 0);
      let shift = (period.weekday - candidate.getDay() + 7) % 7;
      if (shift === 0 && candidate.getTime() <= after) shift = 7;
      candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + shift, hm.h, hm.m, 0, 0);
      return candidate.getTime();
    }
  }
}

export type AdjudicationResult =
  | { kind: 'execute'; occurrence: number; missedBefore: number[]; next: number }
  | { kind: 'missed'; missed: number[]; next: number };

// Walk from the armed occurrence forward to the LATEST occurrence at or before `now`: only that
// one is eligible to execute (when `now - occurrence` still fits the grace window); every earlier
// one is superseded and recorded as missed. This makes "interval shorter than the grace window"
// well-defined: a wake later than the grace window executes exactly the latest occurrence and
// misses all older ones — never a burst of back-fills.
export function adjudicateDue(armed: number, now: number, period: SchedulePeriod, graceMs = SCHEDULE_GRACE_MS): AdjudicationResult {
  const missedBefore: number[] = [];
  let due: number | null = null;
  let cur = armed;
  while (cur <= now) {
    due = cur;
    const next = nextOccurrenceAfter(cur, period);
    if (next > now) break;
    missedBefore.push(cur);
    cur = next;
  }
  if (due === null) {
    // Not due yet (spurious wake): nothing happened, the armed occurrence stands
    return { kind: 'missed', missed: [], next: armed };
  }
  const next = nextOccurrenceAfter(due, period);
  if (now - due <= graceMs) return { kind: 'execute', occurrence: due, missedBefore, next };
  return { kind: 'missed', missed: [...missedBefore, due], next };
}

function failureNotice(flow: Flow, reason: string, detail?: string): FlowFailureNotice {
  return {
    flowId: flow.id,
    flowDraftHash: flowDraftHash(flow),
    ts: Date.now(),
    failure: {
      nodeId: 'schedule',
      iterationPath: '',
      stage: 'trigger',
      reason,
      ...(detail !== undefined ? { detail } : {}),
    },
  };
}

// Notices are written straight to the item inside the surrounding serialized section — going
// through setFlowFailureNotice would re-enter the write chain and deadlock
async function writeNoticesLocked(notices: FlowFailureNotice[]): Promise<void> {
  if (notices.length === 0) return;
  const map = { ...(await flowFailuresItem.getValue()) };
  for (const notice of notices) map[notice.flowId] = notice;
  await flowFailuresItem.setValue(map);
}

export interface ScheduleInput {
  id?: string;
  flowId: string;
  entryUrl: string;
  period: unknown;
}

export type SaveScheduleResult =
  | { ok: true; nextDueAt: number }
  | { ok: false; reason: 'schedule-limit' | 'flow-not-found' | 'flow-not-enabled' | 'invalid-schedule' | 'invalid-entry-url' };

export async function schedulesForFlow(flowId: string): Promise<FlowSchedule[]> {
  return (await flowSchedulesItem.getValue()).filter((s) => s.flowId === flowId);
}

// Unified upsert: with id = edit, without = create. Editing re-bases the next occurrence from now
// (no remembered past arrangement). Validation order: flow exists; creation requires enabled
// (editing stays open so a paused flow's plans remain maintainable); period within the closed
// set; entry URL on the flow's origin AND already matching the entry page's URL fingerprint — a
// URL outside the dynamic content-script registration could never be claimed, and one that cannot
// match at open time is a dead schedule. Device-wide cap checked on create only.
export async function saveSchedule(input: ScheduleInput): Promise<SaveScheduleResult> {
  let alarm: { name: string; when: number } | undefined;
  const result = await serializeStorageWrite(async () => {
    const flow = (await loadFlows()).find((r) => r.id === input.flowId);
    if (flow === undefined) return { ok: false as const, reason: 'flow-not-found' as const };
    const schedules = await flowSchedulesItem.getValue();
    const existing = input.id !== undefined ? schedules.find((s) => s.id === input.id) : undefined;
    if (input.id !== undefined && existing === undefined) return { ok: false as const, reason: 'invalid-schedule' as const };
    // An id owned by another flow must not rewire that flow's schedule onto this one (the id-keyed
    // alarm name included) — id and flowId stay a validated pair
    if (existing !== undefined && existing.flowId !== input.flowId) return { ok: false as const, reason: 'invalid-schedule' as const };
    if (existing === undefined && flow.status !== 'enabled') return { ok: false as const, reason: 'flow-not-enabled' as const };
    if (!isValidSchedulePeriod(input.period)) return { ok: false as const, reason: 'invalid-schedule' as const };
    let target: string;
    try {
      target = pageTargetOf(new URL(input.entryUrl));
    } catch {
      return { ok: false as const, reason: 'invalid-entry-url' as const };
    }
    if (parseOrigin(input.entryUrl) !== flow.site || !urlIncludesMatches(target, flow.page.urlIncludes)) {
      return { ok: false as const, reason: 'invalid-entry-url' as const };
    }
    if (existing === undefined && schedules.length >= MAX_SCHEDULES) {
      return { ok: false as const, reason: 'schedule-limit' as const };
    }
    const now = Date.now();
    const record: FlowSchedule = {
      id: existing?.id ?? crypto.randomUUID(),
      flowId: flow.id,
      site: flow.site,
      entryUrl: input.entryUrl,
      period: input.period,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      nextDueAt: nextOccurrenceAfter(now, input.period),
    };
    await flowSchedulesItem.setValue(
      existing !== undefined ? schedules.map((s) => (s.id === record.id ? record : s)) : [...schedules, record],
    );
    alarm = { name: scheduleAlarmName(record.id), when: record.nextDueAt };
    return { ok: true as const, nextDueAt: record.nextDueAt };
  });
  if (alarm !== undefined) await browser.alarms.create(alarm.name, { when: alarm.when }).catch(() => undefined);
  return result;
}

export async function deleteSchedule(id: string): Promise<void> {
  await serializeStorageWrite(async () => {
    const schedules = await flowSchedulesItem.getValue();
    if (!schedules.some((s) => s.id === id)) return;
    await flowSchedulesItem.setValue(schedules.filter((s) => s.id !== id));
    const starts = await pendingTimedStartsItem.getValue();
    const next = starts.filter((t) => t.scheduleId !== id);
    if (next.length !== starts.length) await pendingTimedStartsItem.setValue(next);
  });
  await browser.alarms.clear(scheduleAlarmName(id)).catch(() => undefined);
}

export type TakeTimedStartResult =
  | { ok: true; flow: Flow }
  | { ok: false; reason: 'gone' | 'expired' | 'wrong-tab' | 'site-mismatch' | 'flow-not-enabled' };

// Atomic claim inside one serialized section, entry removed before the payload is returned — a
// second arriver finds nothing (single winner, "at most one start per occurrence"). The claimant
// receives the flow as currently stored: a timed start has no prior run identity to pin, so
// current content under the same gates as every automatic trigger is the correct semantics.
export async function takeTimedStart(triggerId: string, sender: { origin: string; url: string }): Promise<TakeTimedStartResult> {
  return serializeStorageWrite(async () => {
    const list = await pendingTimedStartsItem.getValue();
    const staged = list.find((t) => t.triggerId === triggerId);
    if (staged === undefined) return { ok: false as const, reason: 'gone' as const };
    const remove = async (): Promise<void> => {
      await pendingTimedStartsItem.setValue(list.filter((t) => t.triggerId !== triggerId));
    };
    if (sender.origin !== staged.site) return { ok: false as const, reason: 'site-mismatch' as const };
    if (Date.now() > staged.deadline) {
      await remove();
      const flow = (await loadFlows()).find((r) => r.id === staged.flowId);
      if (flow !== undefined && flow.status === 'enabled') {
        await writeNoticesLocked([failureNotice(flow, 'timed-start-expired')]);
      }
      return { ok: false as const, reason: 'expired' as const };
    }
    let target = '';
    try {
      target = pageTargetOf(new URL(sender.url));
    } catch {
      target = '';
    }
    if (!urlIncludesMatches(target, staged.page.urlIncludes)) return { ok: false as const, reason: 'wrong-tab' as const };
    const flow = (await loadFlows()).find((r) => r.id === staged.flowId);
    if (flow === undefined) {
      await remove();
      return { ok: false as const, reason: 'gone' as const };
    }
    // Disabled at claim time is the zero-action semantics: the start dies silently here (nothing
    // retries it) — no failure notice, the user already switched the flow off
    if (flow.status !== 'enabled') {
      await remove();
      return { ok: false as const, reason: 'flow-not-enabled' as const };
    }
    await remove();
    return { ok: true as const, flow };
  });
}

export async function timedStartDescriptorsFor(origin: string): Promise<TimedStartDescriptor[]> {
  const now = Date.now();
  const descriptors: TimedStartDescriptor[] = [];
  for (const staged of await pendingTimedStartsItem.getValue()) {
    if (staged.site !== origin || now > staged.deadline) continue;
    descriptors.push({ triggerId: staged.triggerId, flowId: staged.flowId, page: staged.page, deadline: staged.deadline });
  }
  return descriptors;
}

// One foreground tab supply pass: push to every open tab on the schedule's site already showing
// the entry page's URL fingerprint; only when NO tab matches does the extension open the saved
// entry URL in a foreground tab (DEC-support-scheduler-001). A failed open leaves the staged
// descriptor in place — the expiry GC reports it honestly.
async function distributeTimedStart(distribution: { site: string; entryUrl: string; page: PageFingerprint }): Promise<void> {
  const tabs = await browser.tabs.query({ url: `${distribution.site}/*` }).catch(() => [] as Tab[]);
  let matched = false;
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || typeof tab.url !== 'string') return;
      let target = '';
      try {
        target = pageTargetOf(new URL(tab.url));
      } catch {
        return;
      }
      if (!urlIncludesMatches(target, distribution.page.urlIncludes)) return;
      // Only a live receiver counts as delivery: a URL-matching tab whose script is not running
      // (memory-saver discarded, registration drift) answers nothing — resolved-undefined (no
      // receiver) and timeouts must fall through to the fresh-tab opening below
      const pushed = await sendTabMessage(tab.id, { type: 'bg:timedStartStaged' }).catch(() => undefined);
      if (pushed !== undefined) matched = true;
    }),
  );
  if (!matched) await browser.tabs.create({ url: distribution.entryUrl, active: true }).catch(() => undefined);
}

// Whether a saved schedule's entry still points into its flow's CURRENT site and page rule: the
// site snapshot and entry URL are validated at save time only, and a later flow edit (site move,
// page-rule change, sync pull) can silently invalidate them
function scheduleEntryLive(schedule: FlowSchedule, flow: Flow): boolean {
  if (schedule.site !== flow.site) return false;
  try {
    return urlIncludesMatches(pageTargetOf(new URL(schedule.entryUrl)), flow.page.urlIncludes);
  } catch {
    return false;
  }
}

// The single converging entry point: every alarm (schedule or janitor), every SW cold start and
// every schedule write run this same idempotent pass — expiry GC, orphan cleanup, grace-window
// adjudication, descriptor staging and alarm re-arm. All reads and the commit happen inside one
// serialized section; alarms/tabs side effects run after it.
export async function reconcileSchedules(now = Date.now()): Promise<void> {
  const distributions: { site: string; entryUrl: string; page: PageFingerprint }[] = [];
  const clearedAlarms: string[] = [];
  const surviving: FlowSchedule[] = [];
  let survivingStarts: StagedTimedStart[] = [];
  await serializeStorageWrite(async () => {
    const [schedules, store, staged] = await Promise.all([
      flowSchedulesItem.getValue(),
      flowStoreItem.getValue(),
      pendingTimedStartsItem.getValue(),
    ]);
    const flowById = new Map(store.flows.map((flow) => [flow.id, flow]));
    // Notice collapse: the store keeps ONE diagnostic per flow, so same-flow notices built in this
    // pass merge instead of silently overwriting each other — misses accumulate their count and
    // keep the latest time, and a timed-start-expired (the actionable dead-entry-page signal)
    // outranks the same pass's schedule-missed
    const expiredFlows = new Map<string, Flow>();
    const missesByFlow = new Map<string, { flow: Flow; count: number; latest: number }>();

    // Expiry GC: an unclaimed start past its deadline means no matching page was ready in time
    // (site redesign, expired login, dead entry URL, page never loaded) — one honest notice while
    // the flow is still enabled; disabled or deleted flows stay silent
    let starts: StagedTimedStart[] = [];
    let startsMutated = false;
    for (const start of staged) {
      if (now <= start.deadline) {
        starts.push(start);
        continue;
      }
      startsMutated = true;
      const flow = flowById.get(start.flowId);
      if (flow !== undefined && flow.status === 'enabled') {
        expiredFlows.set(start.flowId, flow);
      }
    }

    // Orphan cleanup: a schedule whose flow is gone dies silently together with its staged starts
    const orphanIds = new Set(schedules.filter((s) => !flowById.has(s.flowId)).map((s) => s.id));
    if (orphanIds.size > 0) {
      starts = starts.filter((start) => !orphanIds.has(start.scheduleId));
      startsMutated = true;
      for (const id of orphanIds) clearedAlarms.push(scheduleAlarmName(id));
    }

    // Adjudication per surviving schedule. A disabled flow is zero-action: no notice, plan kept,
    // nextDueAt silently advances to the next future occurrence (the current status is the honest
    // proxy — whether it was enabled during the missed window is not recoverable). A schedule whose
    // flow drifted off the saved site or page rule is equally dormant: it can neither claim (the
    // old origin's flow list no longer carries the flow) nor run from the saved entry URL — kept
    // and re-editable, silent until re-saved against the current flow.
    let schedulesMutated = orphanIds.size > 0;
    const nextSchedules: FlowSchedule[] = [];
    for (const schedule of schedules) {
      if (orphanIds.has(schedule.id)) continue;
      const flow = flowById.get(schedule.flowId)!;
      const verdict = adjudicateDue(schedule.nextDueAt, now, schedule.period);
      const enabled = flow.status === 'enabled' && scheduleEntryLive(schedule, flow);
      // Superseded occurrences are missed even when the latest one executes — each is a skipped
      // occurrence, reported once with its count and latest time
      const missedOccurrences = verdict.kind === 'execute' ? verdict.missedBefore : verdict.missed;
      if (enabled && missedOccurrences.length > 0) {
        const missed = missesByFlow.get(schedule.flowId) ?? { flow, count: 0, latest: 0 };
        missed.count += missedOccurrences.length;
        missed.latest = Math.max(missed.latest, missedOccurrences[missedOccurrences.length - 1]!);
        missesByFlow.set(schedule.flowId, missed);
      }
      if (verdict.kind === 'execute' && enabled) {
        starts.push({
          triggerId: `${schedule.id}@${verdict.occurrence}`,
          scheduleId: schedule.id,
          flowId: schedule.flowId,
          site: schedule.site,
          page: flow.page,
          deadline: now + TIMED_START_WINDOW_MS,
          createdAt: now,
        });
        startsMutated = true;
        distributions.push({ site: schedule.site, entryUrl: schedule.entryUrl, page: flow.page });
      }
      const advanced = { ...schedule, nextDueAt: verdict.next };
      if (advanced.nextDueAt !== schedule.nextDueAt) schedulesMutated = true;
      nextSchedules.push(advanced);
      surviving.push(advanced);
    }
    survivingStarts = starts;

    if (schedulesMutated) await flowSchedulesItem.setValue(nextSchedules);
    if (startsMutated) await pendingTimedStartsItem.setValue(starts);
    const notices: FlowFailureNotice[] = [];
    for (const { flow, count, latest } of missesByFlow.values()) {
      if (!expiredFlows.has(flow.id)) {
        notices.push(failureNotice(flow, 'schedule-missed', `${count}× ${formatTime(latest, { withSeconds: false })}`));
      }
    }
    for (const flow of expiredFlows.values()) notices.push(failureNotice(flow, 'timed-start-expired'));
    await writeNoticesLocked(notices);
  });

  await Promise.all(clearedAlarms.map((name) => browser.alarms.clear(name).catch(() => undefined)));
  // Idempotent re-arm covers every platform-side alarm loss (extension update, profile drift):
  // same name + same when simply overwrites
  await Promise.all(
    surviving.map((schedule) => browser.alarms.create(scheduleAlarmName(schedule.id), { when: schedule.nextDueAt }).catch(() => undefined)),
  );
  // Janitor self-wake: without it, an expiry notice could sleep until the next flow alarm (up to
  // 24h away) while the worker idles
  if (survivingStarts.length > 0) {
    const earliest = Math.min(...survivingStarts.map((s) => s.deadline));
    await browser.alarms.create(TIMED_START_GC_ALARM, { when: earliest + 1000 }).catch(() => undefined);
  }
  for (const distribution of distributions) {
    await distributeTimedStart(distribution).catch(() => undefined);
  }
}
