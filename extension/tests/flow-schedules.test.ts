// Timed-trigger adjudication and lifecycle (support-scheduler): the pure wall-clock functions,
// the CRUD gates, the record-driven reconcile (grace-window misses, orphan cleanup, idempotent
// staging and alarm re-arm) and the atomic single-winner claim — over the real storage chain
// (fakeBrowser + wxt storage). fakeBrowser's in-memory alarms/tabs stand in for the platform;
// real service-worker lifecycle and actual alarm firing are the extension demo's evidence.
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  adjudicateDue,
  deleteSchedule,
  MAX_SCHEDULES,
  nextOccurrenceAfter,
  reconcileSchedules,
  saveSchedule,
  scheduleAlarmName,
  schedulesForFlow,
  takeTimedStart,
  timedStartDescriptorsFor,
  TIMED_START_WINDOW_MS,
  type FlowSchedule,
  type StagedTimedStart,
} from '@/lib/flow-schedules';
import {
  buildFlowStore,
  flowFailuresItem,
  flowSchedulesItem,
  flowStoreItem,
  pendingTimedStartsItem,
  saveFlowRecord,
} from '@/lib/storage';
import { deriveFlowId, isValidSchedulePeriod, type Flow } from '@/lib/flow-schema';

const SITE = 'https://saas.example.com';
const ENTRY_URL = `${SITE}/orders/new`;

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: deriveFlowId(),
    name: '定时发货流程',
    site: SITE,
    page: { urlIncludes: '/orders' },
    trigger: { kind: 'pageEnter' },
    steps: { id: 'root', kind: 'sequence', steps: [] },
    status: 'enabled',
    provenance: { source: 'import', importedAt: now, createdAt: now, updatedAt: now },
    ...overrides,
  };
}

// Fixed local wall-clock anchors keep the pure-function expectations readable
function atLocal(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

let scheduleSeq = 0;
function seedSchedule(overrides: Partial<FlowSchedule> = {}): FlowSchedule {
  scheduleSeq += 1;
  const schedule: FlowSchedule = {
    id: `sched-${scheduleSeq}`,
    flowId: 'r_target',
    site: SITE,
    entryUrl: ENTRY_URL,
    period: { kind: 'daily', time: '09:00' },
    createdAt: 1,
    updatedAt: 1,
    nextDueAt: atLocal(2026, 5, 10, 9, 0),
    ...overrides,
  };
  return schedule;
}

async function seedFlows(flows: Flow[]): Promise<void> {
  await flowStoreItem.setValue(buildFlowStore(flows));
}

async function seedSchedules(schedules: FlowSchedule[]): Promise<void> {
  await flowSchedulesItem.setValue([...(await flowSchedulesItem.getValue()), ...schedules]);
}

function seedStaged(starts: StagedTimedStart[]): Promise<void> {
  return pendingTimedStartsItem.setValue(starts);
}

function stagedOf(schedule: FlowSchedule, overrides: Partial<StagedTimedStart> = {}): StagedTimedStart {
  return {
    triggerId: `${schedule.id}@${schedule.nextDueAt}`,
    scheduleId: schedule.id,
    flowId: schedule.flowId,
    site: schedule.site,
    page: { urlIncludes: '/orders' },
    deadline: schedule.nextDueAt + TIMED_START_WINDOW_MS,
    createdAt: 1,
    ...overrides,
  };
}

let createdTabs: { url?: string; active?: boolean }[];
let tabMessages: { tabId: number; type: string }[];
let queryUrls: unknown[];

beforeEach(() => {
  fakeBrowser.reset();
  scheduleSeq = 0;
  createdTabs = [];
  tabMessages = [];
  queryUrls = [];
  const tabs = fakeBrowser.tabs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  tabs.query = async (query: unknown) => {
    queryUrls.push(query);
    return [];
  };
  tabs.create = async (props: unknown) => {
    createdTabs.push(props as { url?: string; active?: boolean });
    return { id: 101 };
  };
  tabs.sendMessage = async (tabId: unknown, msg: unknown) => {
    tabMessages.push({ tabId: tabId as number, type: (msg as { type: string }).type });
    return { ok: true };
  };
});

describe('isValidSchedulePeriod (closed set)', () => {
  it('accepts the three well-formed kinds and rejects everything else', () => {
    expect(isValidSchedulePeriod({ kind: 'daily', time: '09:00' })).toBe(true);
    expect(isValidSchedulePeriod({ kind: 'weekly', weekday: 0, time: '23:59' })).toBe(true);
    expect(isValidSchedulePeriod({ kind: 'interval', minutes: 1 })).toBe(true);
    expect(isValidSchedulePeriod({ kind: 'interval', minutes: 1440 })).toBe(true);
    expect(isValidSchedulePeriod({ kind: 'daily', time: '9:00' })).toBe(false);
    expect(isValidSchedulePeriod({ kind: 'daily', time: '24:00' })).toBe(false);
    expect(isValidSchedulePeriod({ kind: 'daily', time: '09:60' })).toBe(false);
    expect(isValidSchedulePeriod({ kind: 'weekly', weekday: 7, time: '09:00' })).toBe(false);
    expect(isValidSchedulePeriod({ kind: 'weekly', weekday: -1, time: '09:00' })).toBe(false);
    expect(isValidSchedulePeriod({ kind: 'weekly', weekday: 1.5, time: '09:00' })).toBe(false);
    expect(isValidSchedulePeriod({ kind: 'interval', minutes: 0 })).toBe(false);
    expect(isValidSchedulePeriod({ kind: 'interval', minutes: 1441 })).toBe(false);
    expect(isValidSchedulePeriod({ kind: 'interval', minutes: 30.5 })).toBe(false);
    expect(isValidSchedulePeriod({ kind: 'hourly' })).toBe(false);
    expect(isValidSchedulePeriod(null)).toBe(false);
    expect(isValidSchedulePeriod('daily')).toBe(false);
  });
});

describe('nextOccurrenceAfter (wall-clock reconstruction)', () => {
  it('daily: same-day when the time is still ahead, next day once passed — strictly later', () => {
    const daily = { kind: 'daily', time: '09:00' } as const;
    expect(nextOccurrenceAfter(atLocal(2026, 5, 10, 8, 0), daily)).toBe(atLocal(2026, 5, 10, 9, 0));
    expect(nextOccurrenceAfter(atLocal(2026, 5, 10, 9, 0), daily)).toBe(atLocal(2026, 5, 11, 9, 0));
    expect(nextOccurrenceAfter(atLocal(2026, 5, 10, 10, 30), daily)).toBe(atLocal(2026, 5, 11, 9, 0));
  });

  it('daily: rolls across month and year boundaries by wall clock, not by fixed 24h spans', () => {
    const daily = { kind: 'daily', time: '09:00' } as const;
    expect(nextOccurrenceAfter(atLocal(2026, 12, 31, 10, 0), daily)).toBe(atLocal(2027, 1, 1, 9, 0));
    expect(nextOccurrenceAfter(atLocal(2026, 1, 31, 10, 0), daily)).toBe(atLocal(2026, 2, 1, 9, 0));
  });

  it('weekly: advances to the next matching weekday, wrapping the week and past same-day times', () => {
    // 2026-03-02 is a Monday
    const weekly = { kind: 'weekly', weekday: 1, time: '09:00' } as const;
    expect(nextOccurrenceAfter(atLocal(2026, 3, 2, 8, 0), weekly)).toBe(atLocal(2026, 3, 2, 9, 0));
    expect(nextOccurrenceAfter(atLocal(2026, 3, 2, 9, 0), weekly)).toBe(atLocal(2026, 3, 9, 9, 0));
    expect(nextOccurrenceAfter(atLocal(2026, 3, 3, 10, 0), weekly)).toBe(atLocal(2026, 3, 9, 9, 0));
    expect(nextOccurrenceAfter(atLocal(2026, 3, 8, 10, 0), weekly)).toBe(atLocal(2026, 3, 9, 9, 0));
    const sunday = { kind: 'weekly', weekday: 0, time: '09:00' } as const;
    expect(nextOccurrenceAfter(atLocal(2026, 3, 6, 10, 0), sunday)).toBe(atLocal(2026, 3, 8, 9, 0));
  });

  it('interval: occurrence + interval exactly — the grid chains from the armed value, never from processing time', () => {
    const interval = { kind: 'interval', minutes: 30 } as const;
    const anchor = atLocal(2026, 5, 10, 8, 0);
    expect(nextOccurrenceAfter(anchor, interval)).toBe(anchor + 30 * 60_000);
    expect(nextOccurrenceAfter(anchor + 30 * 60_000, interval)).toBe(anchor + 60 * 60_000);
  });

  it('wall-clock alignment survives a spring-forward transition (observable only in a DST timezone)', () => {
    // Fixed-24h addition lands an hour off the wall clock on the day clocks jump forward; the
    // component reconstruction stays aligned. Machines without any offset change (e.g. UTC+8)
    // cannot discriminate the two implementations — this branch is inert there and real-DST
    // coverage relies on running the suite in a DST timezone.
    for (let day = 1; day <= 365; day++) {
      const before = new Date(2026, 0, day, 12, 0).getTimezoneOffset();
      const after = new Date(2026, 0, day + 1, 12, 0).getTimezoneOffset();
      if (before === after || after < before) continue; // no change, or fall-back
      // `day` springs forward: an occurrence armed the previous evening must land on the
      // transition day at the requested WALL-CLOCK time
      const armEvening = new Date(2026, 0, day - 1, 22, 0).getTime();
      const next = nextOccurrenceAfter(armEvening, { kind: 'daily', time: '09:00' });
      const landed = new Date(next);
      expect(landed.getFullYear()).toBe(2026);
      expect(landed.getMonth()).toBe(0);
      expect(landed.getDate()).toBe(day);
      expect(landed.getHours()).toBe(9);
      expect(landed.getMinutes()).toBe(0);
      return;
    }
    // No spring-forward day in this machine's timezone: keep the strictly-later invariant only
    expect(nextOccurrenceAfter(atLocal(2026, 5, 10, 9, 0), { kind: 'daily', time: '09:00' })).toBeGreaterThan(atLocal(2026, 5, 10, 9, 0));
  });
});

describe('adjudicateDue (grace window and the interval<grace interaction)', () => {
  const daily = { kind: 'daily', time: '09:00' } as const;

  it('wakes within the grace window execute the armed occurrence and re-arm the next', () => {
    const armed = atLocal(2026, 5, 10, 9, 0);
    const verdict = adjudicateDue(armed, armed + 90_000, daily);
    expect(verdict).toEqual({ kind: 'execute', occurrence: armed, missedBefore: [], next: atLocal(2026, 5, 11, 9, 0) });
  });

  it('the grace boundary itself still executes; past it the occurrence is missed, not executed late', () => {
    const armed = atLocal(2026, 5, 10, 9, 0);
    expect(adjudicateDue(armed, armed + 120_000, daily).kind).toBe('execute');
    const late = adjudicateDue(armed, armed + 120_001, daily);
    expect(late).toEqual({ kind: 'missed', missed: [armed], next: atLocal(2026, 5, 11, 9, 0) });
  });

  it('interval shorter than the grace window: a late wake executes exactly the latest occurrence, older ones are all missed — no back-fill burst', () => {
    const interval = { kind: 'interval', minutes: 1 } as const;
    const t0 = 1_000_000_000_000;
    // Five minutes late: occurrences t0..t0+5m are ≤ now; only t0+5m fits the grace window
    const verdict = adjudicateDue(t0, t0 + 5 * 60_000, interval);
    expect(verdict.kind).toBe('execute');
    if (verdict.kind !== 'execute') return;
    expect(verdict.occurrence).toBe(t0 + 5 * 60_000);
    expect(verdict.missedBefore).toEqual([t0, t0 + 60_000, t0 + 120_000, t0 + 180_000, t0 + 240_000]);
    expect(verdict.next).toBe(t0 + 6 * 60_000);
  });

  it('browser closed for days: every daily occurrence in the gap is missed, the next future one is armed', () => {
    const armed = atLocal(2026, 5, 10, 9, 0);
    const now = atLocal(2026, 5, 13, 10, 0);
    const verdict = adjudicateDue(armed, now, daily);
    expect(verdict).toEqual({
      kind: 'missed',
      missed: [atLocal(2026, 5, 10, 9, 0), atLocal(2026, 5, 11, 9, 0), atLocal(2026, 5, 12, 9, 0), atLocal(2026, 5, 13, 9, 0)],
      next: atLocal(2026, 5, 14, 9, 0),
    });
  });

  it('a spurious wake before the armed occurrence is a no-op: nothing missed, nothing moved', () => {
    const armed = atLocal(2026, 5, 10, 9, 0);
    expect(adjudicateDue(armed, armed - 60_000, daily)).toEqual({ kind: 'missed', missed: [], next: armed });
  });
});

describe('saveSchedule (CRUD gates)', () => {
  it('creates for an enabled flow, computes the next occurrence, and arms the alarm', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    const before = Date.now();
    const saved = await saveSchedule({ flowId: flow.id, entryUrl: ENTRY_URL, period: { kind: 'daily', time: '23:59' } });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.nextDueAt).toBeGreaterThan(before);
    const schedules = await schedulesForFlow(flow.id);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ flowId: flow.id, site: SITE, entryUrl: ENTRY_URL, nextDueAt: saved.nextDueAt });
    const alarm = await fakeBrowser.alarms.get(scheduleAlarmName(schedules[0]!.id));
    expect(alarm?.scheduledTime).toBe(saved.nextDueAt);
  });

  it('creation is reserved to enabled flows; editing a paused flow stays open (plans stay maintainable)', async () => {
    const paused = makeFlow({ status: 'paused' });
    await seedFlows([paused]);
    expect(await saveSchedule({ flowId: paused.id, entryUrl: ENTRY_URL, period: { kind: 'interval', minutes: 5 } })).toMatchObject({
      ok: false,
      reason: 'flow-not-enabled',
    });
    // Seed an existing plan as if created while enabled, then pause-verify the edit path
    const existing = seedSchedule({ flowId: paused.id });
    await seedSchedules([existing]);
    const edited = await saveSchedule({ id: existing.id, flowId: paused.id, entryUrl: ENTRY_URL, period: { kind: 'weekly', weekday: 3, time: '10:00' } });
    expect(edited.ok).toBe(true);
  });

  it('unknown flow, unknown edit target and malformed periods are refused with zero writes', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    expect(await saveSchedule({ flowId: 'missing', entryUrl: ENTRY_URL, period: { kind: 'daily', time: '09:00' } })).toMatchObject({ ok: false, reason: 'flow-not-found' });
    expect(await saveSchedule({ id: 'nope', flowId: flow.id, entryUrl: ENTRY_URL, period: { kind: 'daily', time: '09:00' } })).toMatchObject({ ok: false, reason: 'invalid-schedule' });
    for (const period of [{ kind: 'daily', time: '9:00' }, { kind: 'weekly', weekday: 9, time: '09:00' }, { kind: 'interval', minutes: 0 }, { kind: 'cron', expr: '* * *' }]) {
      expect(await saveSchedule({ flowId: flow.id, entryUrl: ENTRY_URL, period })).toMatchObject({ ok: false, reason: 'invalid-schedule' });
    }
    expect(await flowSchedulesItem.getValue()).toEqual([]);
  });

  it('entry URL must parse, sit on the flow origin, and already match the entry page fingerprint', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    for (const entryUrl of ['not a url', 'ftp://saas.example.com/orders', 'https://other.example.com/orders/new', `${SITE}/dashboard`]) {
      expect(await saveSchedule({ flowId: flow.id, entryUrl, period: { kind: 'daily', time: '09:00' } })).toMatchObject({ ok: false, reason: 'invalid-entry-url' });
    }
    expect(await flowSchedulesItem.getValue()).toEqual([]);
    expect(await saveSchedule({ flowId: flow.id, entryUrl: `${SITE}/orders/detail?id=7`, period: { kind: 'daily', time: '09:00' } })).toMatchObject({ ok: true });
  });

  it('the device-wide cap refuses the 51st creation but never touches existing plans; edits still pass at the cap', async () => {
    const flowA = makeFlow();
    const flowB = makeFlow();
    await seedFlows([flowA, flowB]);
    const crowded: FlowSchedule[] = [];
    for (let i = 0; i < MAX_SCHEDULES; i++) {
      crowded.push(seedSchedule({ flowId: i % 2 === 0 ? flowA.id : flowB.id, nextDueAt: Date.now() + 3_600_000 }));
    }
    await seedSchedules(crowded);
    expect(await saveSchedule({ flowId: flowA.id, entryUrl: ENTRY_URL, period: { kind: 'daily', time: '09:00' } })).toMatchObject({ ok: false, reason: 'schedule-limit' });
    expect((await flowSchedulesItem.getValue()).length).toBe(MAX_SCHEDULES);
    const edited = await saveSchedule({ id: crowded[0]!.id, flowId: flowA.id, entryUrl: ENTRY_URL, period: { kind: 'interval', minutes: 15 } });
    expect(edited.ok).toBe(true);
  });

  it('editing re-bases the next occurrence from now instead of keeping the old arrangement', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    const created = await saveSchedule({ flowId: flow.id, entryUrl: ENTRY_URL, period: { kind: 'interval', minutes: 1440 } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const [record] = await schedulesForFlow(flow.id);
    const edited = await saveSchedule({ id: record!.id, flowId: flow.id, entryUrl: ENTRY_URL, period: { kind: 'interval', minutes: 1 } });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    // Old plan pointed ~24h out; the re-based one must point ~1m out
    expect(edited.nextDueAt).toBeLessThan(Date.now() + 2 * 60_000);
    expect((await schedulesForFlow(flow.id))[0]!.period).toEqual({ kind: 'interval', minutes: 1 });
  });

  it('an edit quoting another flow\'s schedule id is refused instead of rewiring the schedule across flows', async () => {
    const flowA = makeFlow();
    const flowB = makeFlow();
    await seedFlows([flowA, flowB]);
    const owned = seedSchedule({ flowId: flowA.id, nextDueAt: Date.now() + 3_600_000 });
    await seedSchedules([owned]);
    expect(
      await saveSchedule({ id: owned.id, flowId: flowB.id, entryUrl: ENTRY_URL, period: { kind: 'daily', time: '09:00' } }),
    ).toMatchObject({ ok: false, reason: 'invalid-schedule' });
    expect((await schedulesForFlow(flowA.id))[0]!.flowId).toBe(flowA.id);
  });

  it('deleteSchedule removes the record and its staged starts, and clears the alarm', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    const schedule = seedSchedule({ flowId: flow.id, nextDueAt: Date.now() + 3_600_000 });
    await seedSchedules([schedule]);
    await seedStaged([stagedOf(schedule)]);
    await fakeBrowser.alarms.create(scheduleAlarmName(schedule.id), { when: schedule.nextDueAt });
    await deleteSchedule(schedule.id);
    expect(await flowSchedulesItem.getValue()).toEqual([]);
    expect(await pendingTimedStartsItem.getValue()).toEqual([]);
    expect(await fakeBrowser.alarms.get(scheduleAlarmName(schedule.id))).toBeUndefined();
  });
});

describe('reconcileSchedules (record-driven convergence)', () => {
  it('a due occurrence commits record advance + descriptor staging in one pass, then re-arms the alarm and the janitor', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    const schedule = seedSchedule({ flowId: flow.id, nextDueAt: atLocal(2026, 5, 10, 9, 0) });
    await seedSchedules([schedule]);
    await reconcileSchedules(atLocal(2026, 5, 10, 9, 0) + 30_000);
    // Record advanced to the next future occurrence
    const [advanced] = await schedulesForFlow(flow.id);
    expect(advanced!.nextDueAt).toBe(atLocal(2026, 5, 11, 9, 0));
    // Descriptor staged with the occurrence-bearing triggerId and the entry page fingerprint
    const staged = await pendingTimedStartsItem.getValue();
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      triggerId: `${schedule.id}@${atLocal(2026, 5, 10, 9, 0)}`,
      scheduleId: schedule.id,
      flowId: flow.id,
      site: SITE,
      page: flow.page,
      deadline: atLocal(2026, 5, 10, 9, 0) + 30_000 + TIMED_START_WINDOW_MS,
    });
    // Alarm re-armed at the advanced occurrence; janitor armed just past the earliest deadline
    expect((await fakeBrowser.alarms.get(scheduleAlarmName(schedule.id)))?.scheduledTime).toBe(atLocal(2026, 5, 11, 9, 0));
    expect((await fakeBrowser.alarms.get('ssba-timedstart-gc'))?.scheduledTime).toBe(atLocal(2026, 5, 10, 9, 0) + 30_000 + TIMED_START_WINDOW_MS + 1000);
    // No distribution target existed: the entry URL opened in a foreground tab
    expect(createdTabs).toEqual([{ url: ENTRY_URL, active: true }]);
    expect(queryUrls).toEqual([{ url: `${SITE}/*` }]);
  });

  it('a wake 90s late (inside the grace window, past a 60s occurrence-anchored window) still stages a claimable start — never dead on arrival', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    const schedule = seedSchedule({ flowId: flow.id, nextDueAt: atLocal(2026, 5, 10, 9, 0) });
    await seedSchedules([schedule]);
    const wake = atLocal(2026, 5, 10, 9, 0) + 90_000;
    await reconcileSchedules(wake);
    const staged = await pendingTimedStartsItem.getValue();
    expect(staged).toHaveLength(1);
    // The claim window counts from staging, so the descriptor stays claimable after the late wake
    expect(staged[0]!.deadline).toBeGreaterThan(wake);
    expect(createdTabs).toEqual([{ url: ENTRY_URL, active: true }]);
  });

  it('reconciling again before the next occurrence stages nothing new (idempotency token)', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    const schedule = seedSchedule({ flowId: flow.id, nextDueAt: atLocal(2026, 5, 10, 9, 0) });
    await seedSchedules([schedule]);
    const first = atLocal(2026, 5, 10, 9, 0) + 10_000;
    await reconcileSchedules(first);
    await reconcileSchedules(first + 5_000);
    expect(await pendingTimedStartsItem.getValue()).toHaveLength(1);
    expect((await schedulesForFlow(flow.id))[0]!.nextDueAt).toBe(atLocal(2026, 5, 11, 9, 0));
    // One distribution per occurrence, not one per reconcile pass
    expect(createdTabs).toHaveLength(1);
  });

  it('occurrences missed while the browser was closed land one schedule-missed notice with the count and latest time', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    const schedule = seedSchedule({ flowId: flow.id, nextDueAt: atLocal(2026, 5, 10, 9, 0) });
    await seedSchedules([schedule]);
    await reconcileSchedules(atLocal(2026, 5, 13, 10, 0));
    const notices = await flowFailuresItem.getValue();
    const notice = notices[flow.id];
    expect(notice?.failure).toMatchObject({ nodeId: 'schedule', iterationPath: '', stage: 'trigger', reason: 'schedule-missed' });
    expect(notice?.failure.detail).toMatch(/^4× /);
    expect((await schedulesForFlow(flow.id))[0]!.nextDueAt).toBe(atLocal(2026, 5, 14, 9, 0));
    expect(await pendingTimedStartsItem.getValue()).toEqual([]);
  });

  it('a disabled flow is zero-action: no notice, plan kept, nextDueAt silently advances', async () => {
    const paused = makeFlow({ status: 'paused' });
    await seedFlows([paused]);
    const schedule = seedSchedule({ flowId: paused.id, nextDueAt: atLocal(2026, 5, 10, 9, 0) });
    await seedSchedules([schedule]);
    await reconcileSchedules(atLocal(2026, 5, 13, 10, 0));
    expect(await flowFailuresItem.getValue()).toEqual({});
    expect((await schedulesForFlow(paused.id))[0]!.nextDueAt).toBe(atLocal(2026, 5, 14, 9, 0));
    expect(await pendingTimedStartsItem.getValue()).toEqual([]);
  });

  it('a schedule whose flow is gone dies silently together with its staged start, and its alarm is cleared', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    const schedule = seedSchedule({ flowId: flow.id, nextDueAt: atLocal(2026, 5, 10, 9, 0) });
    await seedSchedules([schedule]);
    await seedStaged([stagedOf(schedule, { deadline: Date.now() + 60_000 })]);
    await fakeBrowser.alarms.create(scheduleAlarmName(schedule.id), { when: Date.now() + 3_600_000 });
    await flowStoreItem.setValue(buildFlowStore([]));
    await reconcileSchedules(Date.now());
    expect(await flowSchedulesItem.getValue()).toEqual([]);
    expect(await pendingTimedStartsItem.getValue()).toEqual([]);
    expect(await fakeBrowser.alarms.get(scheduleAlarmName(schedule.id))).toBeUndefined();
    expect(await flowFailuresItem.getValue()).toEqual({});
  });

  it('a schedule whose flow moved off the saved site is dormant: nothing staged, no notice, no tab, plan kept and re-editable', async () => {
    const flow = makeFlow({ site: 'https://moved.example.com' });
    await seedFlows([flow]);
    // Saved while the flow still lived on SITE; the flow record has since moved
    const schedule = seedSchedule({ flowId: flow.id, nextDueAt: atLocal(2026, 5, 10, 9, 0) });
    await seedSchedules([schedule]);
    await reconcileSchedules(atLocal(2026, 5, 13, 10, 0));
    expect(await pendingTimedStartsItem.getValue()).toEqual([]);
    expect(await flowFailuresItem.getValue()).toEqual({});
    expect(createdTabs).toEqual([]);
    expect((await schedulesForFlow(flow.id))[0]!.nextDueAt).toBe(atLocal(2026, 5, 14, 9, 0));
  });

  it('two missed schedules on one flow collapse into one schedule-missed notice with the summed count', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    const a = seedSchedule({ flowId: flow.id, nextDueAt: atLocal(2026, 5, 10, 9, 0) });
    const b = seedSchedule({ flowId: flow.id, period: { kind: 'daily', time: '09:30' }, nextDueAt: atLocal(2026, 5, 10, 9, 30) });
    await seedSchedules([a, b]);
    await reconcileSchedules(atLocal(2026, 5, 13, 10, 0));
    const notices = await flowFailuresItem.getValue();
    expect(Object.keys(notices)).toEqual([flow.id]);
    expect(notices[flow.id]!.failure.reason).toBe('schedule-missed');
    expect(notices[flow.id]!.failure.detail).toMatch(/^8× /);
  });

  it('a same-pass expiry outranks the schedule-missed notice: the dead entry page is the signal shown', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    const schedule = seedSchedule({ flowId: flow.id, nextDueAt: atLocal(2026, 5, 10, 9, 0) });
    await seedSchedules([schedule]);
    await seedStaged([stagedOf(schedule, { deadline: atLocal(2026, 5, 13, 9, 0) })]);
    await reconcileSchedules(atLocal(2026, 5, 13, 10, 0));
    expect((await flowFailuresItem.getValue())[flow.id]?.failure.reason).toBe('timed-start-expired');
  });

  it('an expired staged start lands the timed-start-expired notice only while the flow is enabled', async () => {
    const enabled = makeFlow();
    const paused = makeFlow({ status: 'paused' });
    await seedFlows([enabled, paused]);
    // Next occurrences sit in the future (nothing to adjudicate) — only the staged starts are
    // past their deadline, isolating the GC leg
    const a = seedSchedule({ flowId: enabled.id, nextDueAt: Date.now() + 3_600_000 });
    const b = seedSchedule({ flowId: paused.id, nextDueAt: Date.now() + 3_600_000 });
    await seedSchedules([a, b]);
    await seedStaged([stagedOf(a, { deadline: Date.now() - 1_000 }), stagedOf(b, { deadline: Date.now() - 1_000 })]);
    await reconcileSchedules();
    const notices = await flowFailuresItem.getValue();
    expect(notices[enabled.id]?.failure.reason).toBe('timed-start-expired');
    expect(notices[paused.id]).toBeUndefined();
    expect(await pendingTimedStartsItem.getValue()).toEqual([]);
  });

  it('distribution pushes to an already-matching tab and opens nothing; a non-matching tab does not count', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    const schedule = seedSchedule({ flowId: flow.id, nextDueAt: atLocal(2026, 5, 10, 9, 0) });
    await seedSchedules([schedule]);
    const tabs = fakeBrowser.tabs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    tabs.query = async () => [{ id: 7, url: `${SITE}/orders/detail` }, { id: 8, url: `${SITE}/dashboard` }];
    await reconcileSchedules(atLocal(2026, 5, 10, 9, 0) + 10_000);
    // Only the tab whose URL matches the entry fingerprint gets the compensation push
    expect(tabMessages).toEqual([{ tabId: 7, type: 'bg:timedStartStaged' }]);
    expect(createdTabs).toEqual([]);
  });

  it('a matching tab with no live receiver does not count as delivery — the entry URL still opens', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    const schedule = seedSchedule({ flowId: flow.id, nextDueAt: atLocal(2026, 5, 10, 9, 0) });
    await seedSchedules([schedule]);
    const tabs = fakeBrowser.tabs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    tabs.query = async () => [{ id: 7, url: `${SITE}/orders/detail` }];
    // Memory-saver discarded / never-injected tab: the send resolves nothing
    tabs.sendMessage = async () => undefined;
    await reconcileSchedules(atLocal(2026, 5, 10, 9, 0) + 10_000);
    expect(createdTabs).toEqual([{ url: ENTRY_URL, active: true }]);
  });
});

describe('takeTimedStart (atomic single-winner claim)', () => {
  async function claimableFixture(flowOverride: Partial<Flow> = {}): Promise<{ flow: Flow; schedule: FlowSchedule }> {
    const flow = makeFlow(flowOverride);
    await seedFlows([flow]);
    const schedule = seedSchedule({ flowId: flow.id });
    await seedSchedules([schedule]);
    await seedStaged([stagedOf(schedule, { deadline: Date.now() + 60_000 })]);
    return { flow, schedule };
  }

  it('two racing claims for one trigger: exactly one winner walks away with the stored flow', async () => {
    const { flow, schedule } = await claimableFixture();
    const sender = { origin: SITE, url: `${SITE}/orders/detail` };
    const [a, b] = await Promise.all([
      takeTimedStart(`${schedule.id}@${schedule.nextDueAt}`, sender),
      takeTimedStart(`${schedule.id}@${schedule.nextDueAt}`, sender),
    ]);
    expect(a.ok !== b.ok).toBe(true);
    const winner = a.ok ? a : b;
    expect(winner.ok).toBe(true);
    if (winner.ok) expect(winner.flow.id).toBe(flow.id);
    expect(await pendingTimedStartsItem.getValue()).toEqual([]);
  });

  it('a claim from the wrong origin or a URL off the entry fingerprint is refused but the start stays claimable', async () => {
    const { schedule } = await claimableFixture();
    const triggerId = `${schedule.id}@${schedule.nextDueAt}`;
    expect(await takeTimedStart(triggerId, { origin: 'https://elsewhere.example.com', url: `${SITE}/orders/detail` })).toMatchObject({ ok: false, reason: 'site-mismatch' });
    expect(await takeTimedStart(triggerId, { origin: SITE, url: `${SITE}/dashboard` })).toMatchObject({ ok: false, reason: 'wrong-tab' });
    expect(await pendingTimedStartsItem.getValue()).toHaveLength(1);
  });

  it('a claim past the deadline removes the start and reports the expiry honestly while the flow is enabled', async () => {
    const { flow, schedule } = await claimableFixture();
    await seedStaged([stagedOf(schedule, { deadline: Date.now() - 1 })]);
    expect(await takeTimedStart(`${schedule.id}@${schedule.nextDueAt}`, { origin: SITE, url: `${SITE}/orders/detail` })).toMatchObject({ ok: false, reason: 'expired' });
    expect(await pendingTimedStartsItem.getValue()).toEqual([]);
    expect((await flowFailuresItem.getValue())[flow.id]?.failure.reason).toBe('timed-start-expired');
  });

  it('a disabled flow at claim time consumes the start silently — zero-action semantics, no notice, nothing retries', async () => {
    const paused = makeFlow({ status: 'paused' });
    await seedFlows([paused]);
    const schedule = seedSchedule({ flowId: paused.id });
    await seedSchedules([schedule]);
    await seedStaged([stagedOf(schedule, { deadline: Date.now() + 60_000 })]);
    expect(await takeTimedStart(`${schedule.id}@${schedule.nextDueAt}`, { origin: SITE, url: `${SITE}/orders/detail` })).toMatchObject({ ok: false, reason: 'flow-not-enabled' });
    expect(await pendingTimedStartsItem.getValue()).toEqual([]);
    expect(await flowFailuresItem.getValue()).toEqual({});
  });

  it('a stale triggerId from an older occurrence never consumes the newer occurrence slot', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    const schedule = seedSchedule({ flowId: flow.id, nextDueAt: atLocal(2026, 5, 10, 9, 0) });
    await seedSchedules([schedule]);
    await reconcileSchedules(atLocal(2026, 5, 10, 9, 0) + 10_000);
    // The record has advanced; the staged start belongs to today's occurrence. A late-arriving
    // claim quoting YESTERDAY's occurrence id must not eat it.
    const staleId = `${schedule.id}@${atLocal(2026, 5, 9, 9, 0)}`;
    expect(await takeTimedStart(staleId, { origin: SITE, url: `${SITE}/orders/detail` })).toMatchObject({ ok: false, reason: 'gone' });
    expect(await pendingTimedStartsItem.getValue()).toHaveLength(1);
  });
});

describe('timedStartDescriptorsFor (startup piggyback)', () => {
  it('filters by sender origin and drops anything past its deadline', async () => {
    const flow = makeFlow();
    await seedFlows([flow]);
    const live = seedSchedule({ flowId: flow.id });
    const expired = seedSchedule({ flowId: flow.id });
    await seedSchedules([live, expired]);
    await seedStaged([
      stagedOf(live, { deadline: Date.now() + 60_000 }),
      stagedOf(expired, { deadline: Date.now() - 1 }),
    ]);
    const descriptors = await timedStartDescriptorsFor(SITE);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({ triggerId: `${live.id}@${live.nextDueAt}`, flowId: flow.id });
    expect(await timedStartDescriptorsFor('https://other.example.com')).toEqual([]);
  });
});
