// fieldChange trigger wiring: value reading through the real DOM-driver read path
// (antd bracket-code extraction included), fire conditions (anyChange / codeEquals, once per distinct
// value), debounced scheduling, auto-marker filtering (self-writes never re-trigger) and stop().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OBSERVER_DEBOUNCE_MS,
  attachFieldChangeWatcher,
  readTriggerValue,
  triggerFires,
} from '@/lib/flow-triggers';
import type { FlowDriver } from '@/lib/flow-compiler';
import type { FieldRef, Flow } from '@/lib/flow-schema';

class FakeInput {
  tagName = 'INPUT';
  id: string;
  visible = true;
  value = '';
  isConnected = true;
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Array<(ev: { type: string; target?: unknown }) => void>>();

  constructor(id: string) {
    this.id = id;
  }

  getClientRects(): unknown[] {
    return this.visible ? [{}] : [];
  }

  closest(sel: string): unknown {
    return sel === '[data-ssba-auto]' && this.attrs.has('data-ssba-auto') ? this : null;
  }

  setAttribute(name: string, v: string): void {
    this.attrs.set(name, v);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  addEventListener(type: string, fn: (ev: { type: string; target?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (ev: { type: string; target?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, target: this });
  }
}

function fakeDoc(map: Record<string, FakeInput[]> = {}, hash = ''): Document {
  return {
    querySelectorAll: (sel: string) => (map[sel] ?? []).slice(),
    location: { pathname: '/form-page.html', hash },
  } as unknown as Document;
}

const field = (id: string, componentType: FieldRef['componentType'] = 'input'): FieldRef => ({
  clues: { id },
  componentType,
  displayLabel: id,
});

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    schemaVersion: 1,
    id: 'r_fc',
    name: 'field change flow',
    site: 'https://www.example.com',
    page: { urlIncludes: '/form-page.html' },
    trigger: { kind: 'fieldChange', field: field('warehouse'), condition: { kind: 'anyChange' } },
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'a1', kind: 'action', action: { type: 'clickButton', target: field('go', 'button') } },
      ],
    },
    status: 'enabled',
    provenance: { source: 'import', createdAt: 0, updatedAt: 0 },
    ...overrides,
  };
}

function driverWithValue(value: string | null): FlowDriver {
  return {
    read: async () => (value === null ? { ok: false, reason: 'missing' } : { ok: true, value }),
    act: async () => 'ok',
    waitUntil: async () => ({ outcome: 'satisfied' }),
  };
}

describe('readTriggerValue', () => {
  it('reads the scalar through the driver and extracts the antd bracket code for selects', async () => {
    const plain = makeFlow();
    expect(await readTriggerValue(plain, driverWithValue('text-1'))).toBe('text-1');
    expect(await readTriggerValue(plain, driverWithValue(''))).toBeNull();
    expect(await readTriggerValue(plain, driverWithValue(null))).toBeNull();

    const selectFlow = makeFlow({
      trigger: { kind: 'fieldChange', field: field('warehouse', 'antdSelect'), condition: { kind: 'anyChange' } },
    });
    expect(await readTriggerValue(selectFlow, driverWithValue('London Warehouse[UKBHHC]'))).toBe('UKBHHC');
    expect(await readTriggerValue(selectFlow, driverWithValue('no code here'))).toBeNull();
  });

  it('pageEnter flows read an empty seed', async () => {
    const pageEnter = makeFlow({ trigger: { kind: 'pageEnter' } });
    expect(await readTriggerValue(pageEnter, driverWithValue(null))).toBe('');
  });
});

describe('triggerFires', () => {
  it('anyChange fires on every distinct new value; repeats and nulls do not', () => {
    const flow = makeFlow();
    const last = { value: null as string | null };
    expect(triggerFires(flow, 'a', last)).toBe(true);
    expect(triggerFires(flow, 'a', last)).toBe(false);
    expect(triggerFires(flow, null, last)).toBe(false);
    expect(triggerFires(flow, 'b', last)).toBe(true);
  });

  it('codeEquals fires only for the declared code, still once per distinct value', () => {
    const flow = makeFlow({
      trigger: { kind: 'fieldChange', field: field('warehouse'), condition: { kind: 'codeEquals', code: 'YES' } },
    });
    const last = { value: null as string | null };
    expect(triggerFires(flow, 'NO', last)).toBe(false);
    expect(triggerFires(flow, 'YES', last)).toBe(true);
    expect(triggerFires(flow, 'YES', last)).toBe(false);
  });
});

describe('attachFieldChangeWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const wire = (flow: Flow, doc: Document, value: { v: string | null }) => {
    const fired: string[] = [];
    const handle = attachFieldChangeWatcher(doc, flow, {
      onFire: (v) => fired.push(v),
      readValue: () => Promise.resolve(value.v),
    });
    return { handle, fired };
  };

  it('does not assemble when the page fingerprint misses or the field is unresolvable', () => {
    expect(wire(makeFlow(), fakeDoc({}, '/other.html'), { v: 'x' }).handle).toBeNull();
    expect(wire(makeFlow(), fakeDoc(), { v: 'x' }).handle).toBeNull();
  });

  it('seeds the mount-time value: an event whose value did not change never fires', async () => {
    const el = new FakeInput('warehouse');
    const doc = fakeDoc({ '#warehouse': [el] });
    const value = { v: 'W-0' };
    const { handle, fired } = wire(makeFlow(), doc, value);
    await vi.advanceTimersByTimeAsync(1);
    // The field already held W-0 when the watcher armed — observing it again is not a change
    value.v = 'W-0';
    el.dispatch('input');
    el.dispatch('change');
    await vi.advanceTimersByTimeAsync(OBSERVER_DEBOUNCE_MS + 10);
    expect(fired).toEqual([]);
    handle!.stop();
  });

  it('debounces input events and fires once per distinct changed value', async () => {
    const el = new FakeInput('warehouse');
    const doc = fakeDoc({ '#warehouse': [el] });
    const value = { v: 'W-0' };
    const { handle, fired } = wire(makeFlow(), doc, value);
    await vi.advanceTimersByTimeAsync(1);
    value.v = 'W-1';
    el.dispatch('input');
    el.dispatch('input');
    el.dispatch('change');
    await vi.advanceTimersByTimeAsync(OBSERVER_DEBOUNCE_MS + 10);
    expect(fired).toEqual(['W-1']);
    // A storm after the first fire with the same value stays silent
    el.dispatch('input');
    await vi.advanceTimersByTimeAsync(OBSERVER_DEBOUNCE_MS + 10);
    expect(fired).toEqual(['W-1']);
    // A later real change fires again
    value.v = 'W-2';
    el.dispatch('input');
    await vi.advanceTimersByTimeAsync(OBSERVER_DEBOUNCE_MS + 10);
    expect(fired).toEqual(['W-1', 'W-2']);
    handle!.stop();
  });

  it('native input/change events carrying the auto marker never fire (self-writes)', async () => {
    const el = new FakeInput('warehouse');
    const doc = fakeDoc({ '#warehouse': [el] });
    const value = { v: 'W-9' };
    const { handle, fired } = wire(makeFlow(), doc, value);
    await vi.advanceTimersByTimeAsync(1);
    // A self-write dispatches real input events while the marker sits on the field
    el.setAttribute('data-ssba-auto', '1');
    value.v = 'W-9';
    el.dispatch('input');
    await vi.advanceTimersByTimeAsync(OBSERVER_DEBOUNCE_MS + 10);
    expect(fired).toEqual([]);
    el.removeAttribute('data-ssba-auto');
    // Unmarked native events still schedule
    value.v = 'W-10';
    el.dispatch('input');
    await vi.advanceTimersByTimeAsync(OBSERVER_DEBOUNCE_MS + 10);
    expect(fired).toEqual(['W-10']);
    handle!.stop();
  });

  it('stop() detaches: later events never fire', async () => {
    const el = new FakeInput('warehouse');
    const doc = fakeDoc({ '#warehouse': [el] });
    const { handle, fired } = wire(makeFlow(), doc, { v: 'W-2' });
    handle!.stop();
    el.dispatch('input');
    await vi.advanceTimersByTimeAsync(OBSERVER_DEBOUNCE_MS + 10);
    expect(fired).toEqual([]);
  });

  it('isAlive() is false once the bound element left the DOM (host re-render replaces it)', async () => {
    const el = new FakeInput('warehouse');
    const doc = fakeDoc({ '#warehouse': [el] });
    const { handle } = wire(makeFlow(), doc, { v: 'W-5' });
    expect(handle!.isAlive()).toBe(true);
    el.isConnected = false;
    expect(handle!.isAlive()).toBe(false);
    handle!.stop();
    expect(handle!.isAlive()).toBe(false);
  });

  it('antdSelect triggers observe subtree mutations, ignoring records marked as this extension\'s own writes', async () => {
    const instances: Array<{ trigger(records: unknown[]): void }> = [];
    vi.stubGlobal(
      'MutationObserver',
      class {
        cb: (records: unknown[]) => void;
        constructor(cb: (records: unknown[]) => void) {
          this.cb = cb;
          instances.push(this as unknown as { trigger(records: unknown[]): void });
        }
        observe(): void {}
        disconnect(): void {}
        trigger(records: unknown[]): void {
          this.cb(records);
        }
      },
    );
    const el = new FakeInput('warehouse');
    const doc = fakeDoc({ '#warehouse': [el] });
    const flow = makeFlow({
      trigger: { kind: 'fieldChange', field: field('warehouse', 'antdSelect'), condition: { kind: 'anyChange' } },
    });
    const value = { v: 'W-3' };
    const { handle, fired } = wire(flow, doc, value);
    const obs = instances[instances.length - 1]!;
    await vi.advanceTimersByTimeAsync(1);

    // Foreign mutation (no auto marker) with a CHANGED value → debounced fire
    value.v = 'W-4';
    obs.trigger([{ target: el, type: 'childList' }]);
    await vi.advanceTimersByTimeAsync(OBSERVER_DEBOUNCE_MS + 10);
    expect(fired).toEqual(['W-4']);

    // Self-write (target inside the extension's auto marker) → ignored, no second fire
    const marked = { target: { closest: (sel: string) => (sel === '[data-ssba-auto]' ? {} : null) } };
    obs.trigger([marked]);
    await vi.advanceTimersByTimeAsync(OBSERVER_DEBOUNCE_MS + 10);
    expect(fired).toEqual(['W-4']);

    handle!.stop();
    vi.unstubAllGlobals();
  });
});
