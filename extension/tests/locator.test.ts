import { describe, expect, it } from 'vitest';
import {
  pageTargetOf,
  resolveField,
  urlIncludesMatches,
  type ResolveResult,
} from '@/lib/locator';
import type { FieldRef } from '@/lib/flow-schema';

// fakeDoc pattern: plain objects answer by exact selector strings; detection must prefer no action.

class FakeElement {
  matches: Set<string>;
  visible: boolean;
  closestMap: Record<string, FakeElement | null> = {};
  queryMap: Record<string, FakeElement | null> = {};
  textContent: string | null;

  constructor(opts: { selectors: string[]; visible?: boolean; textContent?: string | null }) {
    this.matches = new Set(opts.selectors);
    this.visible = opts.visible ?? true;
    this.textContent = opts.textContent ?? null;
  }

  getClientRects(): unknown[] {
    return this.visible ? [{}] : [];
  }

  closest(sel: string): FakeElement | null {
    return this.closestMap[sel] ?? null;
  }

  querySelector(sel: string): FakeElement | null {
    return this.queryMap[sel] ?? null;
  }
}

function fakeDoc(map: Record<string, FakeElement[]>, hash = '#/shipment-management/send-to-amazon/temp_123'): Document {
  return {
    querySelectorAll: (sel: string) => (map[sel] ?? []).slice(),
    location: { pathname: '/app.html', hash },
  } as unknown as Document;
}

function fieldRef(clues: Record<string, string>, componentType: FieldRef['componentType'] = 'input', displayLabel = '字段'): FieldRef {
  return { clues, componentType, displayLabel };
}

function errorOf(result: ResolveResult): string | null {
  return 'error' in result ? result.error : null;
}

describe('clue priority resolution', () => {
  it('id uniquely and visibly matches', () => {
    const el = new FakeElement({ selectors: ['#form_item_tran_warehouse_id'] });
    const doc = fakeDoc({ '#form_item_tran_warehouse_id': [el] });
    const res = resolveField(doc, fieldRef({ id: 'form_item_tran_warehouse_id' }, 'antdSelect'));
    expect(errorOf(res)).toBeNull();
    expect(res).toHaveProperty('el', el);
  });

  it('multiple id candidates fall back to a unique name match', () => {
    const a = new FakeElement({ selectors: ['#dup'] });
    const b = new FakeElement({ selectors: ['#dup'] });
    const winner = new FakeElement({ selectors: ['#dup', '[name="phone"]'] });
    const doc = fakeDoc({ '#dup': [a, b, winner], '[name="phone"]': [winner] });
    const res = resolveField(doc, fieldRef({ id: 'dup', name: 'phone' }));
    expect(errorOf(res)).toBeNull();
    expect(res).toHaveProperty('el', winner);
  });

  it('labelText + componentType matches and antdSelect normalizes to the .ant-select container', () => {
    const container = new FakeElement({ selectors: ['.ant-select'] });
    const inner = new FakeElement({ selectors: ['#form_item_tran_warehouse_id'] });
    inner.closestMap['.ant-select'] = container;
    const other = new FakeElement({ selectors: ['.ant-select'] });
    // labelText filtering: only the container's form-item label is the trigger label
    const formItem = new FakeElement({ selectors: [] });
    const label = new FakeElement({ selectors: [], textContent: '发货仓库' });
    formItem.queryMap['.ant-form-item-label'] = label;
    container.closestMap['.ant-form-item'] = formItem;
    const otherFormItem = new FakeElement({ selectors: [] });
    otherFormItem.queryMap['.ant-form-item-label'] = new FakeElement({ selectors: [], textContent: '目的仓库' });
    other.closestMap['.ant-form-item'] = otherFormItem;

    const doc = fakeDoc({ '.ant-select': [container, other] });
    const res = resolveField(doc, fieldRef({ labelText: '发货仓库' }, 'antdSelect', '发货仓库'));
    expect(errorOf(res)).toBeNull();
    // The matched element normalizes to the .ant-select ancestor container (observe/read container, not the inner input)
    expect(res).toHaveProperty('el', container);
  });

  it('zero candidates (no clue matches) -> not-found', () => {
    const doc = fakeDoc({});
    const res = resolveField(doc, fieldRef({ id: 'missing', cssPath: 'div>input' }));
    expect(errorOf(res)).toBe('not-found');
  });

  it('all clues ambiguous -> ambiguous (abort on ambiguity, no guessing)', () => {
    const a = new FakeElement({ selectors: ['#dup', '[name="x"]'] });
    const b = new FakeElement({ selectors: ['#dup', '[name="x"]'] });
    const doc = fakeDoc({ '#dup': [a, b], '[name="x"]': [a, b] });
    const res = resolveField(doc, fieldRef({ id: 'dup', name: 'x' }));
    expect(errorOf(res)).toBe('ambiguous');
  });

  it('invisible elements filtered away for a unique match', () => {
    const hidden = new FakeElement({ selectors: ['#form_item_phone'], visible: false });
    const visible = new FakeElement({ selectors: ['#form_item_phone'] });
    const doc = fakeDoc({ '#form_item_phone': [hidden, visible] });
    const res = resolveField(doc, fieldRef({ id: 'form_item_phone' }));
    expect(errorOf(res)).toBeNull();
    expect(res).toHaveProperty('el', visible);
  });

  it('only invisible candidates left does not degrade to a match (zero-candidate failure)', () => {
    const hidden = new FakeElement({ selectors: ['#only'], visible: false });
    const doc = fakeDoc({ '#only': [hidden] });
    const res = resolveField(doc, fieldRef({ id: 'only' }));
    expect(errorOf(res)).toBe('not-found');
  });

  it('no clues at all -> no-clues', () => {
    const res = resolveField(fakeDoc({}), fieldRef({}));
    expect(errorOf(res)).toBe('no-clues');
  });

  it('placeholder / ariaLabel clues work', () => {
    const el = new FakeElement({ selectors: ['[placeholder="请输入电话"]'] });
    const doc = fakeDoc({ '[placeholder="请输入电话"]': [el] });
    const res = resolveField(doc, fieldRef({ placeholder: '请输入电话' }));
    expect(errorOf(res)).toBeNull();
    expect(res).toHaveProperty('el', el);
  });
});

describe('page fingerprint base functions', () => {
  it('urlIncludesMatches is substring matching on the fingerprint target', () => {
    expect(urlIncludesMatches('/app.html#/shipment/send-to-amazon/temp_1789891250876', '#/shipment/send-to-amazon/')).toBe(true);
    expect(urlIncludesMatches('/app.html#/warehouse/list', '#/shipment/send-to-amazon/')).toBe(false);
    expect(urlIncludesMatches('', '#/shipment/send-to-amazon/')).toBe(false);
  });

  it('pageTargetOf joins pathname + hash with the hash query stripped (generalized, no temp_* special case)', () => {
    expect(pageTargetOf({ pathname: '/app.html', hash: '#/shipment/send-to-amazon/temp_9999?x=1' })).toBe(
      '/app.html#/shipment/send-to-amazon/temp_9999',
    );
    expect(pageTargetOf({ pathname: '/form-page.html', hash: '' })).toBe('/form-page.html');
  });
});
