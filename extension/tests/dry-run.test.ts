// Dry-run presentation adapter (DEC-019 §0.1): the preview is the same driver semantics plus pacing
// and highlight — these tests pin the pacing wrapper (side effects paused around, read-only waits
// untouched, failures propagate unchanged) using a fake base driver, so the preview's behavior cannot
// drift from the automatic runtime's.
import { describe, expect, it, vi } from 'vitest';
import { withPacing, highlightTrigger } from '@/lib/dry-run';
import type { FlowDriver } from '@/lib/flow-compiler';
import type { FieldRef, Flow } from '@/lib/flow-schema';

function makeBase(calls: string[] = []): FlowDriver {
  return {
    read: async () => {
      calls.push('read');
      return { ok: true, value: 'x' };
    },
    act: async () => {
      calls.push('act');
      return 'ok';
    },
    waitUntil: async () => {
      calls.push('wait');
      return { outcome: 'satisfied' };
    },
  };
}

const field = (id: string): FieldRef => ({ clues: { id }, componentType: 'input', displayLabel: id });
const signal = () => new AbortController().signal;
const emptyScope = { trigger: '', items: {} };

describe('withPacing (preview step rhythm)', () => {
  it('pauses around side effects and leaves read/wait calls untouched', async () => {
    const calls: string[] = [];
    const paced = withPacing(makeBase(calls), 20);
    const started = Date.now();
    await paced.act({ type: 'clickButton', target: field('b') }, undefined, emptyScope, signal());
    const actElapsed = Date.now() - started;
    expect(actElapsed).toBeGreaterThanOrEqual(35); // ~2 × 20ms pauses straddle the act
    const t0 = Date.now();
    await paced.read({ kind: 'scalar', target: field('x') }, emptyScope, signal());
    await paced.waitUntil({ kind: 'elementPresent', target: field('x') }, 100, emptyScope, () => true, signal());
    expect(Date.now() - t0).toBeLessThan(20); // no added theater on read-only paths
    expect(calls).toEqual(['act', 'read', 'wait']);
  }, 10000);

  it('propagates base failures unchanged after the trailing pause (same failure semantics as auto runs)', async () => {
    const calls: string[] = [];
    const base = makeBase(calls);
    base.act = async () => {
      calls.push('act');
      throw Object.assign(new Error('boom'), { name: 'DriverFailure' });
    };
    const paced = withPacing(base, 5);
    await expect(
      paced.act({ type: 'clickButton', target: field('b') }, undefined, emptyScope, signal()),
    ).rejects.toMatchObject({ name: 'DriverFailure' });
  });
});

describe('highlightTrigger', () => {
  it('returns a no-op for pageEnter flows and unresolved trigger fields (no throw, no overlay)', () => {
    const doc = { querySelectorAll: () => [] } as unknown as Document;
    const pageEnterFlow = {
      schemaVersion: 1,
      id: 'r',
      name: 'n',
      site: 'https://s.example.com',
      page: { urlIncludes: '/x' },
      trigger: { kind: 'pageEnter' },
      steps: { id: 'root', kind: 'sequence', steps: [] },
      status: 'draft',
      provenance: { source: 'import', createdAt: 0, updatedAt: 0 },
    } as unknown as Flow;
    expect(() => highlightTrigger(doc, pageEnterFlow)()).not.toThrow();
    const fieldChangeFlow = {
      ...pageEnterFlow,
      trigger: { kind: 'fieldChange', field: field('missing'), condition: { kind: 'anyChange' } },
    } as unknown as Flow;
    expect(() => highlightTrigger(doc, fieldChangeFlow)()).not.toThrow();
  });

  it('highlights a resolvable trigger field', () => {
    vi.stubGlobal('MutationObserver', class {
      observe(): void {}
      disconnect(): void {}
    });
    vi.stubGlobal('window', { requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined });
    const el = {
      isConnected: true,
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 10, height: 10 }),
    };
    const doc = {
      querySelectorAll: (sel: string) => (sel === '#phone' ? [el] : []),
      createElement: () => ({ className: '', style: { setProperty: () => undefined }, remove: () => undefined }),
      documentElement: { appendChild: () => undefined },
      body: {},
    } as unknown as Document;
    const flow = {
      schemaVersion: 1,
      id: 'r',
      name: 'n',
      site: 'https://s.example.com',
      page: { urlIncludes: '/x' },
      trigger: { kind: 'fieldChange', field: { clues: { id: 'phone' }, componentType: 'input', displayLabel: 'P' }, condition: { kind: 'anyChange' } },
      steps: { id: 'root', kind: 'sequence', steps: [] },
      status: 'draft',
      provenance: { source: 'import', createdAt: 0, updatedAt: 0 },
    } as unknown as Flow;
    expect(typeof highlightTrigger(doc, flow)).toBe('function');
    vi.unstubAllGlobals();
  });
});
