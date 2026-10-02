// Cross-page handover adjudication (DEC-cross-page-flow-001/002): the background single writer
// decides staging validity, the five declarative claim conditions, atomic single-winner takes,
// lazy GC and tab-close cancellation — over the real storage chain (fakeBrowser + wxt storage).
// These tests pin the SAFETY invariants: exactly one claiming document, no claim past the
// deadline, no claim from an unrelated tab/site, and conservative cancellation on flow identity
// changes. The content-side poll loop and the claiming host are exercised by the extension demo
// (US-CPF-001); fakeBrowser cannot prove real service-worker lifecycle.
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
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
import {
  buildFlowStore,
  flowFailuresItem,
  flowStoreItem,
  pendingHandoversItem,
} from '@/lib/storage';
import { deriveFlowId, flowDraftHash, type Flow } from '@/lib/flow-schema';
import type { FlowContext } from '@/lib/flow-compiler';

const SITE = 'https://saas.example.com';

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: deriveFlowId(),
    name: '跨页向导',
    site: SITE,
    page: { urlIncludes: '/order/new' },
    pages: [{ id: 'confirm', page: { urlIncludes: '/order/confirm' } }],
    trigger: { kind: 'pageEnter' },
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'read-order',
          kind: 'read',
          read: { kind: 'scalar', target: { clues: { id: 'orderNo' }, componentType: 'input', displayLabel: '单据号' } },
          into: 'orderNo',
        },
        {
          id: 'click-submit',
          kind: 'action',
          action: { type: 'clickButton', target: { clues: { id: 'submitBtn' }, componentType: 'button', displayLabel: '提交' } },
        },
        { id: 'nav1', kind: 'navigate', to: 'confirm', timeoutMs: 8000 },
        {
          id: 'read-result',
          kind: 'read',
          read: { kind: 'scalar', target: { clues: { id: 'resultNo' }, componentType: 'input', displayLabel: '结果单号' } },
          into: 'resultNo',
        },
      ],
    },
    status: 'enabled',
    provenance: { source: 'import', importedAt: now, createdAt: now, updatedAt: now },
    ...overrides,
  };
}

function makeContext(overrides: Partial<FlowContext> = {}): FlowContext {
  return {
    trigger: '',
    inputs: {},
    vars: { orderNo: 'B-0001' },
    itemVars: {},
    loops: {},
    loopValues: {},
    iterationPath: '',
    executed: 3,
    startedAt: Date.now(),
    budget: { loopItems: 100, waitMs: 60_000, runMs: 900_000 },
    ...overrides,
  };
}

function makeHandover(flow: Flow, overrides: Partial<PendingHandover> = {}): PendingHandover {
  return {
    runId: 'run-1',
    flowId: flow.id,
    flowDraftHash: flowDraftHash(flow),
    site: flow.site,
    dryRun: false,
    businessKey: 'B-0001',
    toPageId: 'confirm',
    resumeAfter: 'nav1',
    deadline: Date.now() + 30_000,
    createdAt: Date.now(),
    sourceTabId: 11,
    pageId: 'confirm',
    flow,
    context: makeContext(),
    ...overrides,
  };
}

const sameTabSender = { origin: SITE, tabId: 11, url: `${SITE}/order/confirm` };

let openerOf: Map<number, number>;
let stagedMessages: number[];
let queriedTabs: { id: number; url?: string }[];

beforeEach(() => {
  fakeBrowser.reset();
  openerOf = new Map();
  stagedMessages = [];
  queriedTabs = [];
  const tabs = fakeBrowser.tabs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  tabs.get = async (tabId: unknown) => ({ id: tabId, openerTabId: openerOf.get(tabId as number) });
  tabs.query = async () => queriedTabs as unknown;
  tabs.sendMessage = async (tabId: unknown) => {
    stagedMessages.push(tabId as number);
    return { ok: true };
  };
});

async function seedStore(flows: Flow[]): Promise<void> {
  await flowStoreItem.setValue(buildFlowStore(flows));
}

describe('staging (the only reliable moment is before the navigation)', () => {
  it('stages a coherent auto payload and leaves it pending', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    const res = await stageHandover(makeHandover(flow), sameTabSender);
    expect(res).toEqual({ ok: true });
    expect(await probeHandover('run-1')).toBe('pending');
    // The background stamps the real sender tab — the payload's placeholder never survives
    const stored = (await pendingHandoversItem.getValue())[0]!;
    expect(stored.sourceTabId).toBe(11);
  });

  it('rejects a sender whose origin is not the flow site', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    const res = await stageHandover(makeHandover(flow), { origin: 'https://evil.example', tabId: 11, url: 'https://evil.example/order/confirm' });
    expect(res).toEqual({ ok: false, reason: 'site-mismatch' });
    expect(await pendingHandoversItem.getValue()).toHaveLength(0);
  });

  it('defensively revalidates the flow — a broken flow never becomes a resumed run', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    const broken = makeHandover({ ...flow, name: '' }, { flowDraftHash: flowDraftHash(flow) });
    const res = await stageHandover(broken, sameTabSender);
    expect(res).toEqual({ ok: false, reason: 'invalid-flow' });
  });

  it('rejects an auto handover whose stored flow identity drifted (flow-updated)', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    const res = await stageHandover(makeHandover(flow, { flowDraftHash: 'h_stale' }), sameTabSender);
    expect(res).toEqual({ ok: false, reason: 'flow-updated' });
  });

  it('a dry-run handover stages without any stored record (preview runs the flow as received)', async () => {
    const flow = makeFlow({ status: 'draft' });
    await seedStore([]);
    const res = await stageHandover(makeHandover(flow, { dryRun: true }), sameTabSender);
    expect(res).toEqual({ ok: true });
  });
});

describe('claim adjudication (five declarative conditions, atomic single winner)', () => {
  it('same-tab claim wins and empties the staged list', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    await stageHandover(makeHandover(flow), sameTabSender);
    const taken = await takeHandover('run-1', sameTabSender);
    expect(taken.ok).toBe(true);
    if (taken.ok) expect(taken.handover.context.vars.orderNo).toBe('B-0001');
    expect(await pendingHandoversItem.getValue()).toHaveLength(0);
    expect(await probeHandover('run-1')).toBe('gone');
  });

  it('a tab opened by the source (target=_blank) may claim', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    await stageHandover(makeHandover(flow), sameTabSender);
    openerOf.set(12, 11);
    const taken = await takeHandover('run-1', { origin: SITE, tabId: 12, url: `${SITE}/order/confirm` });
    expect(taken.ok).toBe(true);
  });

  it('an unrelated tab is refused with the entry kept for the real claimant', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    await stageHandover(makeHandover(flow), sameTabSender);
    openerOf.set(12, 99);
    const taken = await takeHandover('run-1', { origin: SITE, tabId: 12, url: `${SITE}/order/confirm` });
    expect(taken).toEqual({ ok: false, reason: 'wrong-tab' });
    expect(await probeHandover('run-1')).toBe('pending');
  });

  it('a wrong-origin sender is refused with the entry kept', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    await stageHandover(makeHandover(flow), sameTabSender);
    const taken = await takeHandover('run-1', { origin: 'https://evil.example', tabId: 11, url: 'https://evil.example/x' });
    expect(taken).toEqual({ ok: false, reason: 'site-mismatch' });
    expect(await probeHandover('run-1')).toBe('pending');
  });

  it('a claim past the deadline is refused and the dead entry removed', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    await stageHandover(makeHandover(flow, { deadline: Date.now() - 1 }), sameTabSender);
    const taken = await takeHandover('run-1', sameTabSender);
    expect(taken).toEqual({ ok: false, reason: 'expired' });
    expect(await pendingHandoversItem.getValue()).toHaveLength(0);
  });

  it('a tab on the wrong URL is refused (defensive URL recheck of the content-side fingerprint)', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    await stageHandover(makeHandover(flow), sameTabSender);
    const taken = await takeHandover('run-1', { origin: SITE, tabId: 11, url: `${SITE}/somewhere/else` });
    expect(taken).toEqual({ ok: false, reason: 'wrong-tab' });
  });

  it('auto identity drift at claim time removes the entry (flow-updated)', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    await stageHandover(makeHandover(flow), sameTabSender);
    // The flow was replaced after staging: same id, different content
    const seq = flow.steps as { id: string; kind: 'sequence'; steps: unknown[] };
    const replaced = { ...flow, steps: { ...seq, steps: [...seq.steps, seq.steps[0]!] } };
    await seedStore([replaced as Flow]);
    const taken = await takeHandover('run-1', sameTabSender);
    expect(taken).toEqual({ ok: false, reason: 'flow-updated' });
    expect(await pendingHandoversItem.getValue()).toHaveLength(0);
  });

  it('two concurrent claimants produce exactly one winner (no double host)', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    await stageHandover(makeHandover(flow), sameTabSender);
    openerOf.set(12, 11);
    const results = await Promise.all([
      takeHandover('run-1', sameTabSender),
      takeHandover('run-1', { origin: SITE, tabId: 12, url: `${SITE}/order/confirm` }),
    ]);
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    expect(await pendingHandoversItem.getValue()).toHaveLength(0);
  });

  it('an unknown runId is gone', async () => {
    expect(await takeHandover('nope', sameTabSender)).toEqual({ ok: false, reason: 'gone' });
  });

  it('the source drops its staged run (timeout path) and later claims find nothing', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    await stageHandover(makeHandover(flow), sameTabSender);
    await dropHandover('run-1');
    expect(await probeHandover('run-1')).toBe('gone');
    expect(await takeHandover('run-1', sameTabSender)).toEqual({ ok: false, reason: 'gone' });
  });
});

describe('lazy GC (cold start / flows write / status flip / claim pass)', () => {
  it('an expired auto handover is removed with a navigation-timeout failure notice (FR3 visibility)', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    await pendingHandoversItem.setValue([makeHandover(flow, { deadline: Date.now() - 1 })]);
    await gcHandovers();
    expect(await pendingHandoversItem.getValue()).toHaveLength(0);
    const notice = (await flowFailuresItem.getValue())[flow.id];
    expect(notice).toBeDefined();
    expect(notice!.failure).toMatchObject({ nodeId: 'nav1', stage: 'navigate', reason: 'navigation-timeout' });
  });

  it('an expired dry-run handover is removed silently (cancelled previews are not errors)', async () => {
    const flow = makeFlow({ status: 'draft' });
    await pendingHandoversItem.setValue([makeHandover(flow, { dryRun: true, deadline: Date.now() - 1 })]);
    await gcHandovers();
    expect(await pendingHandoversItem.getValue()).toHaveLength(0);
    expect(await flowFailuresItem.getValue()).toEqual({});
  });

  it('pausing the flow cancels its in-flight handover without a failure notice', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    await pendingHandoversItem.setValue([makeHandover(flow)]);
    const paused = { ...flow, status: 'paused' as const };
    await seedStore([paused]);
    await gcHandovers();
    expect(await pendingHandoversItem.getValue()).toHaveLength(0);
    expect(await flowFailuresItem.getValue()).toEqual({});
  });

  it('deleting the flow cancels its in-flight handover; a dry-run handover of a deleted flow too', async () => {
    const flow = makeFlow();
    await pendingHandoversItem.setValue([makeHandover(flow), makeHandover(flow, { runId: 'run-2', dryRun: true })]);
    await seedStore([]);
    await gcHandovers();
    expect(await pendingHandoversItem.getValue()).toHaveLength(0);
  });

  it('a live, identity-matching handover survives the GC', async () => {
    const flow = makeFlow();
    await seedStore([flow]);
    await pendingHandoversItem.setValue([makeHandover(flow)]);
    await gcHandovers();
    expect(await pendingHandoversItem.getValue()).toHaveLength(1);
  });
});

describe('tab close cancels the waiting run (DEC-002)', () => {
  it('cancelHandoversByTab removes only the closed tab’s handovers', async () => {
    const flow = makeFlow();
    await pendingHandoversItem.setValue([
      makeHandover(flow),
      makeHandover(flow, { runId: 'run-2', sourceTabId: 42 }),
    ]);
    await cancelHandoversByTab(11);
    const left = await pendingHandoversItem.getValue();
    expect(left.map((h) => h.runId)).toEqual(['run-2']);
  });
});

describe('descriptors (startup piggyback)', () => {
  it('filters by site and deadline and carries the declared page fingerprint', async () => {
    const flow = makeFlow();
    await pendingHandoversItem.setValue([
      makeHandover(flow),
      makeHandover(flow, { runId: 'run-2', site: 'https://other.example', toPageId: 'x' }),
      makeHandover(flow, { runId: 'run-3', deadline: Date.now() - 1 }),
    ]);
    const descriptors = await handoverDescriptorsFor(SITE);
    expect(descriptors).toHaveLength(1);
    // businessKey rides along so the claimant can seed the L2 dedup key in both forms before its
    // same-cycle pageEnter evaluation runs (overlapping-fingerprint double-fire guard)
    expect(descriptors[0]).toMatchObject({ runId: 'run-1', flowId: flow.id, businessKey: 'B-0001', toPageId: 'confirm' });
    expect(descriptors[0]!.page.urlIncludes).toBe('/order/confirm');
  });
});

describe('bg:handoverStaged compensation push (target=_blank race)', () => {
  it('notifies only tabs already showing the declared page URL', async () => {
    const flow = makeFlow();
    const handover = makeHandover(flow);
    queriedTabs = [
      { id: 1, url: `${SITE}/order/confirm` },
      { id: 2, url: `${SITE}/order/new` },
      { id: 3 },
    ];
    await pushHandoverStaged(handover);
    expect(stagedMessages).toEqual([1]);
  });
});
