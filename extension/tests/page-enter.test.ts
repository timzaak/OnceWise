// Page fingerprint evaluation: pageMatches hit/miss/ambiguity-is-miss, pageTargetOf query stripping,
// the L1 rising-edge latch, L2 document-level dedup keyed by business instance (same document,
// different 单据 → each allowed), submit flows without a businessKey refused, and the session
// business-instance claim (single writer, no TTL auto-release — refresh keeps the claim).
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  PageEnterTracker,
  claimBusinessRun,
  contentIncludesSatisfied,
  needsBusinessClaim,
  pageMatches,
  pageRouteMatches,
  releaseBusinessRun,
} from '@/lib/page-enter';
import { pageTargetOf, urlIncludesMatches } from '@/lib/locator';
import type { FieldRef, Flow } from '@/lib/flow-schema';
import { businessClaimKey, businessClaimsItem, claimBusinessInstance } from '@/lib/storage';
import type { ReadSpec, StepNode } from '@/lib/step-schema';

class FakeElement {
  visible: boolean;
  textContent: string | null;
  constructor(opts: { visible?: boolean; textContent?: string | null } = {}) {
    this.visible = opts.visible ?? true;
    this.textContent = opts.textContent ?? null;
  }
  getClientRects(): unknown[] {
    return this.visible ? [{}] : [];
  }
  closest(): null {
    return null;
  }
  querySelector(): FakeElement | null {
    return null;
  }
}

function fakeDoc(
  map: Record<string, FakeElement[]> = {},
  pathname = '/form-page.html',
  hash = '',
): Document {
  return {
    querySelectorAll: (sel: string) => (map[sel] ?? []).slice(),
    location: { pathname, hash },
  } as unknown as Document;
}

function ref(id: string, displayLabel = id): FieldRef {
  return { clues: { id }, componentType: 'other', displayLabel };
}

const bizRead = (id: string): { read: ReadSpec } => ({
  read: { kind: 'scalar', target: { clues: { id }, componentType: 'input', displayLabel: '单据号' } },
});

function plainSteps(): StepNode {
  return {
    id: 'root',
    kind: 'sequence',
    steps: [
      { id: 'a1', kind: 'action', action: { type: 'setCheckbox', checked: true, target: { clues: { id: 'urgent' }, componentType: 'checkbox', displayLabel: '加急' } } },
    ],
  };
}

function submitSteps(): StepNode {
  return {
    id: 'root',
    kind: 'sequence',
    steps: [
      { id: 'save', kind: 'action', action: { type: 'clickButton', submitLike: true, target: { clues: { id: 'saveBtn' }, componentType: 'button', displayLabel: '保 存' } } },
    ],
  };
}

function makeFlow(id = 'r1', overrides: Partial<Flow> = {}): Flow {
  return {
    schemaVersion: 1,
    id,
    name: '进入页面执行',
    site: 'https://www.example.com',
    page: { urlIncludes: '/form-page.html' },
    trigger: { kind: 'pageEnter' },
    steps: plainSteps(),
    status: 'enabled',
    provenance: { source: 'import', createdAt: 0, updatedAt: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe('page fingerprint target and URL matching', () => {
  it('pageTargetOf joins pathname + hash with the hash query stripped', () => {
    expect(pageTargetOf({ pathname: '/app-spa.html', hash: '#/step1?tab=2' })).toBe('/app-spa.html#/step1');
    expect(pageTargetOf({ pathname: '/form-page.html', hash: '' })).toBe('/form-page.html');
  });

  it('urlIncludesMatches is plain substring matching on the target', () => {
    expect(urlIncludesMatches('/form-page.html', '/form-page.html')).toBe(true);
    expect(urlIncludesMatches('/other-page.html', '/form-page.html')).toBe(false);
    expect(urlIncludesMatches('/app-spa.html#/step1', '#/step1')).toBe(true);
  });
});

describe('pageMatches', () => {
  it('hits by URL substring', () => {
    expect(pageMatches(fakeDoc(), makeFlow().page)).toBe(true);
  });

  it('misses on a different path (isolation sample)', () => {
    expect(pageMatches(fakeDoc({}, '/other-page.html'), makeFlow().page)).toBe(false);
  });

  it('content features: all resolve uniquely and visibly → hit', () => {
    const headline = new FakeElement({ textContent: '受控表单页' });
    const doc = fakeDoc({ '#headline': [headline] });
    const page = { urlIncludes: '/form-page.html', contentIncludes: [ref('headline')] };
    expect(pageMatches(doc, page)).toBe(true);
  });

  it('content features: ambiguity (two visible candidates) counts as a miss — prefer missing over misfiring', () => {
    const doc = fakeDoc({ '#headline': [new FakeElement(), new FakeElement()] });
    const page = { urlIncludes: '/form-page.html', contentIncludes: [ref('headline')] };
    expect(pageMatches(doc, page)).toBe(false);
    expect(contentIncludesSatisfied(doc, page)).toBe(false);
  });

  it('content features: unresolved or invisible element → miss', () => {
    const missing = fakeDoc();
    const hidden = fakeDoc({ '#headline': [new FakeElement({ visible: false })] });
    const page = { urlIncludes: '/form-page.html', contentIncludes: [ref('headline')] };
    expect(pageMatches(missing, page)).toBe(false);
    expect(pageMatches(hidden, page)).toBe(false);
  });
});

describe('L1 rising edge + L2 business-instance dedup', () => {
  const noKey = async () => null;

  it('first hit fires once; continuous matching does not re-fire (no observer-storm re-trigger)', async () => {
    const tracker = new PageEnterTracker();
    const doc = fakeDoc();
    const first = await tracker.evaluate([makeFlow()], doc, noKey);
    expect(first.toFire).toHaveLength(1);
    expect(first.skipped).toHaveLength(0);
    const again = await tracker.evaluate([makeFlow()], doc, noKey);
    expect(again.toFire).toHaveLength(0);
    expect(again.skipped).toHaveLength(0);
  });

  it('SPA leave-and-return within one document: rising edge blocked by L2 with a skip record', async () => {
    const tracker = new PageEnterTracker();
    const hit = fakeDoc();
    const miss = fakeDoc({}, '/other-page.html');
    await tracker.evaluate([makeFlow()], hit, noKey);
    await tracker.evaluate([makeFlow()], miss, noKey);
    const returned = await tracker.evaluate([makeFlow()], hit, noKey);
    expect(returned.toFire).toHaveLength(0);
    expect(returned.skipped).toEqual([
      { flow: expect.objectContaining({ id: 'r1' }), reason: 'page-enter-dedup' },
    ]);
  });

  it('same document, different business instances: each fires once (L2 keyed by businessKey)', async () => {
    const tracker = new PageEnterTracker();
    const doc = fakeDoc();
    const flow = makeFlow('r_biz', { businessKey: bizRead('orderNo'), steps: submitSteps() });
    let businessKey = 'B-001';
    const readKey = async () => businessKey;
    const first = await tracker.evaluate([flow], doc, readKey);
    expect(first.toFire).toEqual([{ flow: expect.objectContaining({ id: 'r_biz' }), businessKey: 'B-001' }]);
    // Same 单据 again after a leave-and-return cycle → deduped
    await tracker.evaluate([flow], fakeDoc({}, '/other-page.html'), readKey);
    const sameAgain = await tracker.evaluate([flow], doc, readKey);
    expect(sameAgain.toFire).toHaveLength(0);
    expect(sameAgain.skipped.map((s) => s.reason)).toEqual(['page-enter-dedup']);
    // A different 单据 on the same document → a fresh fire
    businessKey = 'B-002';
    const other = await tracker.evaluate([flow], doc, readKey);
    expect(other.toFire).toEqual([{ flow: expect.objectContaining({ id: 'r_biz' }), businessKey: 'B-002' }]);
  });

  it('submit-carrying flow without a businessKey declaration is refused at the edge (保守拒绝启动)', async () => {
    const tracker = new PageEnterTracker();
    const flow = makeFlow('r_submit', { steps: submitSteps() });
    const evaluation = await tracker.evaluate([flow], fakeDoc(), noKey);
    expect(evaluation.toFire).toHaveLength(0);
    expect(evaluation.skipped.map((s) => s.reason)).toEqual(['no-business-key']);
  });

  it('declared but unreadable business key skips with its own reason', async () => {
    const tracker = new PageEnterTracker();
    const flow = makeFlow('r_biz', { businessKey: bizRead('orderNo'), steps: submitSteps() });
    const evaluation = await tracker.evaluate([flow], fakeDoc(), async () => null);
    expect(evaluation.toFire).toHaveLength(0);
    expect(evaluation.skipped.map((s) => s.reason)).toEqual(['business-key-unreadable']);
  });

  it('a fresh document (browser refresh) starts a new tracker — non-submit flows may fire again', async () => {
    const first = new PageEnterTracker();
    await first.evaluate([makeFlow()], fakeDoc(), noKey);
    const second = new PageEnterTracker();
    const fired = await second.evaluate([makeFlow()], fakeDoc(), noKey);
    expect(fired.toFire).toHaveLength(1);
  });

  it('fieldChange flows are ignored by the tracker', async () => {
    const tracker = new PageEnterTracker();
    const flow = makeFlow('r_field', {
      trigger: { kind: 'fieldChange', field: ref('warehouse', '发货仓库'), condition: { kind: 'anyChange' } },
    });
    expect((await tracker.evaluate([flow], fakeDoc(), noKey)).toFire).toHaveLength(0);
  });
});

describe('run-time page identity', () => {
  it('pageRouteMatches uses the URL route only — contentIncludes jitter never reads as "left the page"', () => {
    const page = { urlIncludes: '/form-page.html', contentIncludes: [ref('headline')] };
    expect(pageRouteMatches(fakeDoc(), page)).toBe(true);
    // The content feature vanished (edit mode hid the start button) but the route still matches
    expect(pageRouteMatches(fakeDoc({}, '/form-page.html'), page)).toBe(true);
    expect(pageRouteMatches(fakeDoc({}, '/other-page.html'), page)).toBe(false);
  });
});

describe('business-instance claim (needsBusinessClaim + session storage)', () => {
  it('needsBusinessClaim: only submit-carrying flows, regardless of trigger kind', () => {
    expect(needsBusinessClaim(makeFlow('r_s', { steps: submitSteps() }))).toBe(true);
    expect(needsBusinessClaim(makeFlow('r_s_field', { steps: submitSteps(), trigger: { kind: 'fieldChange', field: ref('w'), condition: { kind: 'anyChange' } } }))).toBe(true);
    expect(needsBusinessClaim(makeFlow())).toBe(false);
  });

  it('claim then re-claim is refused within the session; another business key still claims', async () => {
    const key = businessClaimKey('https://www.example.com', 'r_s', 'B-001');
    expect(await claimBusinessInstance(key)).toBe(true);
    expect(await claimBusinessInstance(key)).toBe(false);
    // No TTL: the claim survives any clock advance (outcome-unknown businesses are never auto-unlocked)
    expect(await claimBusinessInstance(key, Date.now() + 24 * 60 * 60 * 1000)).toBe(false);
    expect(await claimBusinessInstance(businessClaimKey('https://www.example.com', 'r_s', 'B-002'))).toBe(true);
    const claims = await businessClaimsItem.getValue();
    expect(claims.map((c) => c.key)).toEqual([
      businessClaimKey('https://www.example.com', 'r_s', 'B-001'),
      businessClaimKey('https://www.example.com', 'r_s', 'B-002'),
    ]);
  });

  it('claimBusinessRun without a background listener is a conservative refusal, never a pass', async () => {
    // fakeBrowser has no runtime.onMessage handler → the client must report not-granted
    const flow = makeFlow('r_s', { businessKey: bizRead('orderNo'), steps: submitSteps() });
    expect(await claimBusinessRun(flow, 'B-001')).toBe(false);
  });

  it('releaseBusinessRun without a background listener resolves silently (best-effort give-back)', async () => {
    // An unreachable background must not turn a never-started run into an unhandled rejection
    const flow = makeFlow('r_s', { businessKey: bizRead('orderNo'), steps: submitSteps() });
    await expect(releaseBusinessRun(flow, 'B-001')).resolves.toBeUndefined();
  });
});

// Cross-page pageEnter suppression on the claiming document (DEC-cross-page-flow-001).
describe('cross-page claim suppression (a continuation page never re-fires the entry)', () => {
  it('a suppressed flow does not fire on a matching page — either dedup-key form', async () => {
    const flow = makeFlow();
    const tracker = new PageEnterTracker();
    tracker.suppress(flow.id, null);
    const first = await tracker.evaluate([flow], fakeDoc(), async () => null);
    expect(first.toFire).toHaveLength(0);

    const withKey = makeFlow('r2', { businessKey: bizRead('orderNo') });
    const tracker2 = new PageEnterTracker();
    tracker2.suppress(withKey.id, 'B-0001');
    const second = await tracker2.evaluate([withKey], fakeDoc(), async () => 'B-0001');
    expect(second.toFire).toHaveLength(0);

    // Without suppression the same rising edge fires — the guard is the suppress call, nothing else
    const tracker3 = new PageEnterTracker();
    const third = await tracker3.evaluate([withKey], fakeDoc(), async () => 'B-0001');
    expect(third.toFire).toHaveLength(1);
  });
});
