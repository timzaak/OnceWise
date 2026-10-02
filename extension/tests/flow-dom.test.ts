// DOM-driver acceptance: a packing-shaped page double exercises the
// real DOM driver over the real XState machine — multi-group sequential processing, per-group
// failure stopping later groups and the final confirm, waits for initially-absent elements,
// stability windows, save-completion signals and cancellation with no side effects afterwards.
// The environment has no DOM globals, so the file brings the codebase's hand-rolled fake DOM
// convention: a selector-supporting element tree plus vi.stubGlobal for the constructors the
// production primitives reference (HTMLInputElement etc. via Symbol.hasInstance).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DriverFailure, runFlow, type DriverScope, type FlowRunResult } from '@/lib/flow-compiler';
import { createDomFlowDriver, type DomDriverOptions } from '@/lib/flow-dom';
import type { ComponentType, FieldRef, StepNode } from '@/lib/step-schema';

// Compound selector matcher: tag, #id, .class, [attr], [attr="value"]; commas in querySelectorAll.
function matchCompound(el: TestEl, sel: string): boolean {
  if (sel === '') return false;
  let rest = sel;
  let tag: string | null = null;
  const conds: Array<(e: TestEl) => boolean> = [];
  const tagMatch = /^([a-zA-Z][\w-]*)/.exec(rest);
  if (tagMatch) {
    tag = tagMatch[1]!.toLowerCase();
    rest = rest.slice(tagMatch[1]!.length);
  }
  while (rest.length > 0) {
    if (rest.startsWith('#')) {
      const m = /^#([\w-]+)/.exec(rest)!;
      const id = m[1]!;
      conds.push((e) => e.id === id);
      rest = rest.slice(m[0]!.length);
    } else if (rest.startsWith('.')) {
      const m = /^\.([\w-]+)/.exec(rest)!;
      const cls = m[1]!;
      conds.push((e) => e.classes.has(cls));
      rest = rest.slice(m[0]!.length);
    } else if (rest.startsWith('[')) {
      const end = rest.indexOf(']');
      if (end < 0) return false;
      const inner = rest.slice(1, end);
      const eq = inner.indexOf('=');
      if (eq < 0) {
        const name = inner.trim();
        conds.push((e) => e.getAttribute(name) !== null);
      } else {
        const name = inner.slice(0, eq).trim();
        const raw = inner.slice(eq + 1).trim();
        const value = raw.replace(/^"(.*)"$/, '$1');
        conds.push((e) => e.getAttribute(name) === value);
      }
      rest = rest.slice(end + 1);
    } else {
      return false;
    }
  }
  if (tag !== null && el.tagName.toLowerCase() !== tag) return false;
  return conds.every((c) => c(el));
}

function matchesSelector(el: TestEl, sel: string): boolean {
  return sel.split(',').some((part) => matchCompound(el, part.trim()));
}

class TestEl {
  tagName: string;
  id = '';
  attrs = new Map<string, string>();
  classes = new Set<string>();
  children: TestEl[] = [];
  parent: TestEl | null = null;
  visible = true;
  text: string | null = null;
  __value = '';
  checked = false;
  disabled = false;
  readOnly = false;
  type = '';
  onClick: ((el: TestEl) => void) | null = null;
  private listenerMap = new Map<string, Array<(ev: Event) => void>>();

  constructor(
    tagName: string,
    opts: { id?: string; classes?: string[]; attrs?: Record<string, string>; text?: string; type?: string } = {},
  ) {
    this.tagName = tagName.toUpperCase();
    if (opts.id !== undefined) this.id = opts.id;
    for (const c of opts.classes ?? []) this.classes.add(c);
    for (const [k, v] of Object.entries(opts.attrs ?? {})) this.attrs.set(k, v);
    if (opts.text !== undefined) this.text = opts.text;
    if (opts.type !== undefined) this.type = opts.type;
  }

  get value(): string {
    return this.__value;
  }
  set value(v: string) {
    this.__value = String(v);
  }

  get classList(): {
    add: (...c: string[]) => void;
    remove: (...c: string[]) => void;
    contains: (c: string) => boolean;
  } {
    const self = this;
    return {
      add: (...cs) => cs.forEach((c) => self.classes.add(c)),
      remove: (...cs) => cs.forEach((c) => self.classes.delete(c)),
      contains: (c) => self.classes.has(c),
    };
  }

  get textContent(): string {
    return this.text ?? this.children.map((c) => c.textContent).join('');
  }

  getAttribute(name: string): string | null {
    if (name === 'id') return this.id !== '' ? this.id : null;
    if (name === 'class') return this.classes.size > 0 ? [...this.classes].join(' ') : null;
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  setAttribute(name: string, value: string): void {
    if (name === 'id') this.id = value;
    else if (name === 'class') this.classes = new Set(value.split(/\s+/).filter(Boolean));
    else this.attrs.set(name, value);
  }

  removeAttribute(name: string): void {
    if (name === 'id') this.id = '';
    else if (name === 'class') this.classes.clear();
    else this.attrs.delete(name);
  }

  getClientRects(): unknown[] {
    return this.visible ? [{}] : [];
  }

  getBoundingClientRect(): { height: number } {
    return { height: this.visible ? 10 : 0 };
  }

  appendChild(child: TestEl): TestEl {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (this.parent !== null) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
      this.parent = null;
    }
  }

  get parentElement(): TestEl | null {
    return this.parent;
  }

  matches(sel: string): boolean {
    return matchesSelector(this, sel);
  }

  querySelectorAll(sel: string): TestEl[] {
    const out: TestEl[] = [];
    const walk = (el: TestEl): void => {
      for (const child of el.children) {
        if (matchesSelector(child, sel)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(sel: string): TestEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }

  closest(sel: string): TestEl | null {
    let cur: TestEl | null = this;
    while (cur !== null) {
      if (cur.matches(sel)) return cur;
      cur = cur.parent;
    }
    return null;
  }

  addEventListener(type: string, fn: (ev: Event) => void): void {
    const list = this.listenerMap.get(type) ?? [];
    list.push(fn);
    this.listenerMap.set(type, list);
  }

  removeEventListener(type: string, fn: (ev: Event) => void): void {
    const list = this.listenerMap.get(type) ?? [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  dispatchEvent(ev: Event): boolean {
    for (const fn of this.listenerMap.get(ev.type) ?? []) fn(ev);
    if (ev.type === 'click' && this.onClick !== null) this.onClick(this);
    return true;
  }
}

class TestDoc {
  root = new TestEl('html');

  querySelectorAll(sel: string): TestEl[] {
    return this.root.querySelectorAll(sel);
  }

  getElementById(id: string): TestEl | null {
    let found: TestEl | null = null;
    const walk = (el: TestEl): void => {
      if (found !== null) return;
      if (el.id === id) {
        found = el;
        return;
      }
      el.children.forEach(walk);
    };
    walk(this.root);
    return found;
  }
}

beforeAll(() => {
  class FakePointerEvent extends Event {
    constructor(type: string) {
      super(type);
    }
  }
  vi.stubGlobal('PointerEvent', FakePointerEvent);
  vi.stubGlobal('MouseEvent', FakePointerEvent);
  vi.stubGlobal('window', {});

  // The production primitives instanceof-check these constructors and setReactInputValue reads the
  // value descriptor off HTMLInputElement.prototype; Symbol.hasInstance routes the checks to the
  // fake tree by tag name, and the prototype setter shares TestEl's __value backing field.
  const stubElementClass = (tagName: string, withValueAccessor: boolean): void => {
    const cls = class FakeFormControl {};
    if (withValueAccessor) {
      Object.defineProperty(cls.prototype, 'value', {
        get(this: TestEl) {
          return this.__value;
        },
        set(this: TestEl, v: string) {
          this.__value = v;
        },
        configurable: true,
      });
    }
    Object.defineProperty(cls, Symbol.hasInstance, {
      value: (inst: unknown): boolean => inst instanceof TestEl && inst.tagName === tagName,
    });
    vi.stubGlobal(`HTML${tagName.charAt(0)}${tagName.slice(1).toLowerCase()}Element`, cls);
  };
  stubElementClass('INPUT', true);
  stubElementClass('TEXTAREA', true);
  stubElementClass('BUTTON', false);
});

interface GroupSpec {
  key: string;
  autoLoadRows: string[][];
  preEdited?: boolean;
  preSelected?: boolean;
}

interface GroupState extends GroupSpec {
  tab: TestEl;
  editBtn: TestEl;
  autoloadBtn: TestEl;
  saveBtn: TestEl;
  statusEl: TestEl;
  selectAllEl: TestEl;
  rowInputs: TestEl[][];
  editMode: boolean;
  selected: boolean;
  saving: boolean;
  saved: boolean;
}

interface SimOptions {
  autoloadDelayMs?: number;
  slowAutoloadKeys?: string[];
  neverStableKeys?: string[];
  neverCompleteSaveKeys?: string[];
}

// All group panels are visible simultaneously with identical button labels/rows, so any unscoped
// resolution of a per-group control is ambiguous — within-group scoping is load-bearing, exactly
// like a page that keeps inactive groups rendered (PRD §4.2).
class PackingSim {
  doc = new TestDoc();
  groups: GroupState[] = [];
  activeKey = '';
  previewModal: TestEl;
  confirmBtn: TestEl;
  log: string[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private intervals = new Set<ReturnType<typeof setInterval>>();

  constructor(specs: GroupSpec[], private opts: SimOptions = {}) {
    const body = this.doc.root.appendChild(new TestEl('body'));
    const strip = body.appendChild(new TestEl('div', { classes: ['tab-strip'] }));
    for (const spec of specs) {
      const tab = strip.appendChild(
        new TestEl('button', {
          classes: ['group-tab', 'ant-tabs-tab'],
          attrs: { 'data-key': spec.key, 'aria-controls': `panel-${spec.key}`, role: 'tab', 'aria-selected': 'false' },
          text: `组 ${spec.key}`,
        }),
      );
      const state = {
        ...spec,
        tab,
        editMode: spec.preEdited === true,
        selected: spec.preSelected === true,
        saving: false,
        saved: false,
      } as GroupState;
      tab.onClick = () => {
        this.activeKey = spec.key;
        this.syncTabs();
        this.log.push(`switch:${spec.key}`);
      };
      this.groups.push(state);
    }
    for (const g of this.groups) this.buildPanel(body, g);
    this.confirmBtn = body.appendChild(new TestEl('button', { classes: ['confirm-btn'], text: '确定并装箱' }));
    this.confirmBtn.onClick = () => {
      this.log.push('confirm');
      this.later(20, () => {
        this.previewModal.visible = true;
      });
    };
    this.previewModal = body.appendChild(new TestEl('div', { classes: ['ant-modal', 'preview-modal'], text: '货件预览' }));
    this.previewModal.visible = false;
    this.activeKey = this.groups[0]!.key;
    this.syncTabs();
  }

  later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  close(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.intervals.forEach((iv) => clearInterval(iv));
  }

  private syncTabs(): void {
    for (const g of this.groups) {
      const active = g.key === this.activeKey;
      g.tab.attrs.set('aria-selected', active ? 'true' : 'false');
      if (active) g.tab.classes.add('ant-tabs-tab-active');
      else g.tab.classes.delete('ant-tabs-tab-active');
    }
  }

  private buildPanel(body: TestEl, g: GroupState): void {
    const panel = body.appendChild(new TestEl('div', { id: `panel-${g.key}`, classes: ['panel'] }));
    g.editBtn = panel.appendChild(new TestEl('button', { classes: ['edit-btn'], text: '编 辑' }));
    g.editBtn.onClick = () => {
      g.editMode = true;
      g.editBtn.visible = false;
      g.autoloadBtn.visible = true;
      g.saveBtn.visible = true;
      g.selectAllEl.visible = true;
      this.log.push(`edit:${g.key}`);
    };
    g.autoloadBtn = panel.appendChild(new TestEl('button', { classes: ['autoload-btn'], text: '自动加载箱规' }));
    g.autoloadBtn.onClick = () => this.runAutoload(g);

    g.selectAllEl = panel.appendChild(new TestEl('input', { classes: ['select-all'], type: 'checkbox' }));
    g.selectAllEl.checked = g.selected;
    g.selectAllEl.addEventListener('click', () => {
      g.selected = !g.selected;
      g.selectAllEl.checked = g.selected;
      this.log.push(`selectall:${g.key}:${g.selected}`);
    });

    const table = panel.appendChild(new TestEl('table', { classes: ['spec-table'] }));
    const theadRow = table.appendChild(new TestEl('thead')).appendChild(new TestEl('tr'));
    for (const h of ['重量', '长', '宽', '高']) theadRow.appendChild(new TestEl('th', { text: h }));
    const tbody = table.appendChild(new TestEl('tbody'));
    g.rowInputs = [];
    for (const _row of g.autoLoadRows) {
      const tr = tbody.appendChild(new TestEl('tr'));
      const inputs: TestEl[] = [];
      for (let c = 0; c < 4; c++) {
        inputs.push(tr.appendChild(new TestEl('td')).appendChild(new TestEl('input', { classes: ['num'] })));
      }
      g.rowInputs.push(inputs);
    }

    g.saveBtn = panel.appendChild(new TestEl('button', { classes: ['save-btn'], text: '保 存' }));
    g.saveBtn.onClick = () => {
      if (g.saving) return;
      g.saving = true;
      g.saveBtn.classes.add('ant-btn-loading');
      this.log.push(`save:${g.key}`);
      if (this.opts.neverCompleteSaveKeys?.includes(g.key)) return;
      this.later(25, () => {
        g.saving = false;
        g.saveBtn.classes.delete('ant-btn-loading');
        g.saved = true;
        g.statusEl.visible = true;
      });
    };
    g.statusEl = panel.appendChild(new TestEl('div', { classes: ['save-status'], text: '已保存' }));
    g.statusEl.visible = false;

    g.editBtn.visible = !g.editMode;
    g.autoloadBtn.visible = g.editMode;
    g.saveBtn.visible = g.editMode;
    g.selectAllEl.visible = g.editMode;
  }

  private runAutoload(g: GroupState): void {
    this.log.push(`autoload:${g.key}`);
    if (this.opts.neverStableKeys?.includes(g.key)) {
      let n = 0;
      // Writes faster than the 10ms sampling interval, so consecutive samples never match
      const iv = setInterval(() => {
        n++;
        g.rowInputs.forEach((row, ri) => row.forEach((inp, ci) => (inp.value = `${ri}${ci}.${n}`)));
      }, 5);
      this.intervals.add(iv);
      return;
    }
    const delay = this.opts.slowAutoloadKeys?.includes(g.key)
      ? (this.opts.autoloadDelayMs ?? 300)
      : (this.opts.autoloadDelayMs ?? 20);
    this.later(delay, () => {
      g.autoLoadRows.forEach((row, ri) => row.forEach((v, ci) => (g.rowInputs[ri]![ci]!.value = v)));
    });
  }
}

const DRIVER_OPTS: DomDriverOptions = { pollIntervalMs: 5, stabilityIntervalMs: 10, stabilitySamples: 2 };
const COLUMNS = ['weight', 'length', 'width', 'height'];

const ref = (
  cssPath: string,
  componentType: ComponentType,
  displayLabel: string,
  within?: string,
): FieldRef => ({ clues: { cssPath }, componentType, displayLabel, within });

const tabRef = (within?: string): FieldRef => ref('.group-tab', 'other', '包装组页签', within);
const rowsTableRef = (within?: string): FieldRef => ref('tbody', 'other', '装箱行', within);

function packingSteps(opts: { stableTimeoutMs?: number; saveTimeoutMs?: number } = {}): StepNode {
  const rowsRead = { kind: 'rows' as const, table: rowsTableRef('group'), columns: COLUMNS };
  return {
    id: 'root',
    kind: 'sequence',
    steps: [
      { id: 'read-groups', kind: 'read', read: { kind: 'collection', target: tabRef() }, into: 'groups' },
      {
        id: 'per-group',
        kind: 'foreach',
        over: 'vars.groups',
        itemVar: 'group',
        do: [
          { id: 'switch', kind: 'action', action: { type: 'clickButton', target: tabRef('group') } },
          {
            id: 'active',
            kind: 'wait',
            timeoutMs: 1500,
            until: {
              kind: 'readMatches',
              read: { kind: 'boolean', target: tabRef('group') },
              into: 'tabActive',
              when: { kind: 'boolean', ref: 'vars.tabActive', equals: true },
            },
          },
          {
            id: 'edit-state',
            kind: 'read',
            read: { kind: 'boolean', target: ref('.autoload-btn', 'other', '自动加载箱规', 'group') },
            into: 'editing',
          },
          {
            id: 'need-edit',
            kind: 'if',
            when: { kind: 'boolean', ref: 'vars.editing', equals: false },
            then: [
              {
                id: 'click-edit',
                kind: 'action',
                action: { type: 'clickButton', target: ref('.edit-btn', 'button', '编 辑', 'group') },
              },
              {
                id: 'wait-edit',
                kind: 'wait',
                timeoutMs: 1500,
                until: { kind: 'elementPresent', target: ref('.autoload-btn', 'other', '自动加载箱规', 'group') },
              },
            ],
          },
          {
            id: 'sel-state',
            kind: 'read',
            read: { kind: 'boolean', target: ref('.select-all', 'checkbox', '全选', 'group') },
            into: 'selected',
          },
          {
            id: 'need-select',
            kind: 'if',
            when: { kind: 'boolean', ref: 'vars.selected', equals: false },
            then: [
              {
                id: 'click-select',
                kind: 'action',
                action: { type: 'setCheckbox', checked: true, target: ref('.select-all', 'checkbox', '全选', 'group') },
              },
            ],
          },
          {
            id: 'auto-load',
            kind: 'action',
            action: { type: 'clickButton', target: ref('.autoload-btn', 'button', '自动加载箱规', 'group') },
          },
          {
            id: 'stable',
            kind: 'wait',
            timeoutMs: opts.stableTimeoutMs ?? 1500,
            until: {
              kind: 'readMatches',
              read: rowsRead,
              into: 'rows',
              when: { kind: 'nonEmpty', ref: 'vars.rows' },
            },
          },
          { id: 'read-rows', kind: 'read', read: rowsRead, into: 'rows' },
          {
            id: 'assert-rows',
            kind: 'assert',
            check: {
              kind: 'and',
              parts: [
                { kind: 'nonEmpty', ref: 'vars.rows' },
                {
                  kind: 'every',
                  ref: 'vars.rows',
                  item: {
                    kind: 'and',
                    parts: COLUMNS.map((col) => ({ kind: 'numberCompare', ref: `item.${col}`, op: '>' as const, value: 0 })),
                  },
                },
              ],
            },
          },
          {
            id: 'save',
            kind: 'action',
            action: { type: 'clickButton', submitLike: true, target: ref('.save-btn', 'button', '保 存', 'group') },
          },
          {
            id: 'saved',
            kind: 'wait',
            timeoutMs: opts.saveTimeoutMs ?? 1500,
            until: { kind: 'elementPresent', target: ref('.save-status', 'other', '保存完成信号', 'group') },
          },
        ],
      },
      {
        id: 'confirm',
        kind: 'action',
        action: { type: 'clickButton', submitLike: true, target: ref('.confirm-btn', 'button', '确定并装箱') },
      },
      {
        id: 'preview',
        kind: 'wait',
        timeoutMs: 1500,
        until: { kind: 'elementPresent', target: ref('.preview-modal', 'other', '货件预览') },
      },
    ],
  };
}

const asDoc = (sim: PackingSim): Document => sim.doc as unknown as Document;

async function runOnSim(sim: PackingSim, steps: StepNode): Promise<FlowRunResult> {
  const handle = runFlow({ steps }, createDomFlowDriver(asDoc(sim), DRIVER_OPTS));
  return handle.result;
}

describe('packing flow over the DOM driver', () => {
  it('processes two groups sequentially and confirms exactly once (每组的保存完成后再进入下一组)', async () => {
    const sim = new PackingSim([
      { key: 'g1', autoLoadRows: [['1.2', '30', '20', '10']] },
      { key: 'g2', autoLoadRows: [['2.5', '40', '30', '20'], ['0.8', '25', '15', '12']] },
    ]);
    const result = await runOnSim(sim, packingSteps());
    expect(result.outcome).toBe('completed');
    expect(sim.log).toEqual([
      'switch:g1',
      'edit:g1',
      'selectall:g1:true',
      'autoload:g1',
      'save:g1',
      'switch:g2',
      'edit:g2',
      'selectall:g2:true',
      'autoload:g2',
      'save:g2',
      'confirm',
    ]);
    expect(sim.previewModal.visible).toBe(true);
    expect(sim.groups.every((g) => g.saved)).toBe(true);
    expect(result.vars.groups).toEqual([{ id: 'g1' }, { id: 'g2' }]);
    expect(result.vars.rows).toEqual([
      { weight: '2.5', length: '40', width: '30', height: '20' },
      { weight: '0.8', length: '25', width: '15', height: '12' },
    ]);
    expect(result.executed).toBeGreaterThan(10);
    sim.close();
  }, 10000);

  it('a group with invalid row data fails the assert and stops later groups and the final confirm (不自动回滚已完成组)', async () => {
    const sim = new PackingSim([
      { key: 'g1', autoLoadRows: [['1.2', '30', '20', '10']] },
      { key: 'g2', autoLoadRows: [['0', '30', '20', '10']] },
      { key: 'g3', autoLoadRows: [['1.0', '20', '20', '10']] },
    ]);
    const result = await runOnSim(sim, packingSteps());
    expect(result.outcome).toBe('failed');
    expect(result.failure?.nodeId).toBe('assert-rows');
    expect(result.failure?.iterationPath).toBe('[1]');
    expect(result.failure?.reason).toContain('assert-failed');
    // g1 was fully processed (kept, not rolled back); g2 unsaved; g3 and the confirm never touched
    expect(sim.log).toContain('save:g1');
    expect(sim.log).not.toContain('save:g2');
    expect(sim.log).not.toContain('switch:g3');
    expect(sim.log).not.toContain('confirm');
    expect(sim.previewModal.visible).toBe(false);
    sim.close();
  }, 10000);

  it('already-edited and already-selected groups skip the corresponding actions (不能把已勾选状态切回未勾选)', async () => {
    const sim = new PackingSim([
      { key: 'g1', autoLoadRows: [['1.2', '30', '20', '10']] },
      { key: 'g2', autoLoadRows: [['2.5', '40', '30', '20']], preEdited: true, preSelected: true },
    ]);
    const result = await runOnSim(sim, packingSteps());
    expect(result.outcome).toBe('completed');
    expect(sim.log).not.toContain('edit:g2');
    expect(sim.log).not.toContain('selectall:g2:true');
    expect(sim.log).toContain('save:g2');
    expect(sim.log.filter((l) => l === 'confirm')).toHaveLength(1);
    sim.close();
  }, 10000);

  it('waits succeed for elements that appear only after a delay (等待最初不存在的元素)', async () => {
    // autoloadDelayMs bumps both the edit-mode button reveal timer base and the fill; edit-mode
    // buttons become visible 15ms after the edit click in this variant
    const sim = new PackingSim([{ key: 'g1', autoLoadRows: [['1.2', '30', '20', '10']] }], { autoloadDelayMs: 25 });
    const groups = sim.groups[0]!;
    groups.autoloadBtn.visible = false;
    sim.later(15, () => {
      groups.autoloadBtn.visible = true;
    });
    const result = await runOnSim(sim, packingSteps());
    expect(result.outcome).toBe('completed');
    expect(sim.log).toContain('save:g1');
    sim.close();
  }, 10000);

  it('cancelling during a wait stops all further side effects (取消后不再发生副作用)', async () => {
    const sim = new PackingSim([{ key: 'g1', autoLoadRows: [['1.2', '30', '20', '10']] }], {
      slowAutoloadKeys: ['g1'],
    });
    const handle = runFlow({ steps: packingSteps() }, createDomFlowDriver(asDoc(sim), DRIVER_OPTS));
    // The auto-load fill lands at ~300ms; stop while the stability wait polls empty rows
    await new Promise((r) => setTimeout(r, 120));
    handle.stop();
    const result = await handle.result;
    expect(result.outcome).toBe('cancelled');
    const logAtStop = [...sim.log];
    expect(logAtStop).toContain('autoload:g1');
    expect(logAtStop).not.toContain('save:g1');
    expect(logAtStop).not.toContain('confirm');
    // Nothing further happens even after every pending page timer has fired
    await new Promise((r) => setTimeout(r, 380));
    expect(sim.log).toEqual(logAtStop);
    sim.close();
  }, 10000);

  it('values that keep changing never satisfy the stability wait and time out without saving', async () => {
    const sim = new PackingSim([{ key: 'g1', autoLoadRows: [['1.2', '30', '20', '10']] }], {
      neverStableKeys: ['g1'],
    });
    const result = await runOnSim(sim, packingSteps({ stableTimeoutMs: 120 }));
    expect(result.outcome).toBe('failed');
    expect(result.failure?.nodeId).toBe('stable');
    expect(result.failure?.stage).toBe('wait');
    expect(result.failure?.reason).toBe('timeout');
    expect(sim.log).not.toContain('save:g1');
    expect(sim.log).not.toContain('confirm');
    sim.close();
  }, 10000);

  it('an unprovable save-completion signal stops the run before the next group and the confirm (无法证明完成则停止)', async () => {
    const sim = new PackingSim(
      [
        { key: 'g1', autoLoadRows: [['1.2', '30', '20', '10']] },
        { key: 'g2', autoLoadRows: [['2.5', '40', '30', '20']] },
      ],
      { neverCompleteSaveKeys: ['g1'] },
    );
    const result = await runOnSim(sim, packingSteps({ saveTimeoutMs: 120 }));
    expect(result.outcome).toBe('failed');
    expect(result.failure?.nodeId).toBe('saved');
    expect(sim.log).toContain('save:g1');
    expect(sim.groups[0]!.saving).toBe(true);
    expect(sim.log).not.toContain('switch:g2');
    expect(sim.log).not.toContain('confirm');
    sim.close();
  }, 10000);
});

const emptyScope: DriverScope = { trigger: '', items: {} };
const scopeWith = (name: string, id: string): DriverScope => ({ trigger: '', items: { [name]: { id } } });
const signal = (): AbortSignal => new AbortController().signal;

describe('DOM driver primitives', () => {
  it('writes an input value and verifies the postcondition', async () => {
    const doc = new TestDoc();
    const input = doc.root.appendChild(new TestEl('input', { classes: ['phone'] }));
    const driver = createDomFlowDriver(doc as unknown as Document, DRIVER_OPTS);
    const res = await driver.act(
      { type: 'setInputValue', target: ref('.phone', 'input', '电话') },
      '13800001234',
      emptyScope,
      signal(),
    );
    expect(res).toBe('ok');
    expect(input.value).toBe('13800001234');
  });

  it('a readOnly input is not writable and a reverting input fails the postcondition', async () => {
    const doc = new TestDoc();
    doc.root.appendChild(new TestEl('input', { classes: ['ro'] })).readOnly = true;
    const reverting = doc.root.appendChild(new TestEl('input', { classes: ['snap'] }));
    reverting.addEventListener('input', () => {
      reverting.__value = 'locked';
    });
    const driver = createDomFlowDriver(doc as unknown as Document, DRIVER_OPTS);
    await expect(
      driver.act({ type: 'setInputValue', target: ref('.ro', 'input', '只读') }, 'x', emptyScope, signal()),
    ).resolves.toBe('not-writable');
    await expect(
      driver.act({ type: 'setInputValue', target: ref('.snap', 'input', '回弹') }, 'typed', emptyScope, signal()),
    ).rejects.toMatchObject({ name: 'DriverFailure', reason: 'verify-failed' });
  });

  it('clickButton distinguishes disabled and forbidden buttons from plain clicks', async () => {
    const doc = new TestDoc();
    doc.root.appendChild(new TestEl('button', { classes: ['plain'] })).onClick = () => doc.root.setAttribute('data-clicked', '1');
    const disabled = doc.root.appendChild(new TestEl('button', { classes: ['dis'] }));
    disabled.disabled = true;
    doc.root.appendChild(new TestEl('button', { classes: ['forbidden'], text: '删 除' }));
    doc.root.appendChild(new TestEl('div', { classes: ['notabutton'], text: '编 辑' }));
    const driver = createDomFlowDriver(doc as unknown as Document, DRIVER_OPTS);
    await expect(
      driver.act({ type: 'clickButton', target: ref('.plain', 'button', '编 辑') }, undefined, emptyScope, signal()),
    ).resolves.toBe('ok');
    expect(doc.root.getAttribute('data-clicked')).toBe('1');
    await expect(
      driver.act({ type: 'clickButton', target: ref('.dis', 'button', '保 存') }, undefined, emptyScope, signal()),
    ).resolves.toBe('disabled');
    await expect(
      driver.act({ type: 'clickButton', target: ref('.forbidden', 'button', '删 除') }, undefined, emptyScope, signal()),
    ).rejects.toMatchObject({ name: 'DriverFailure', reason: 'submit-blacklisted' });
    await expect(
      driver.act({ type: 'clickButton', target: ref('.notabutton', 'button', '编 辑') }, undefined, emptyScope, signal()),
    ).resolves.toBe('not-writable');
  });

  it('collection reads freeze member ids and reject duplicate ids as ambiguous', async () => {
    const doc = new TestDoc();
    const strip = doc.root.appendChild(new TestEl('div'));
    strip.appendChild(new TestEl('button', { classes: ['member'], attrs: { 'data-key': 'g1' } }));
    strip.appendChild(new TestEl('button', { classes: ['member'], attrs: { 'data-key': 'g2' } }));
    const driver = createDomFlowDriver(doc as unknown as Document, DRIVER_OPTS);
    const res = await driver.read(
      { kind: 'collection', target: ref('.member', 'other', '组') },
      emptyScope,
      signal(),
    );
    expect(res).toEqual({ ok: true, value: [{ id: 'g1' }, { id: 'g2' }] });

    strip.appendChild(new TestEl('button', { classes: ['member'], attrs: { 'data-key': 'g1' } }));
    await expect(
      driver.read({ kind: 'collection', target: ref('.member', 'other', '组') }, emptyScope, signal()),
    ).resolves.toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('rows reads skip header rows, read values by column, and refuse mismatched control counts', async () => {
    const doc = new TestDoc();
    const tbody = doc.root.appendChild(new TestEl('tbody', { classes: ['rows'] }));
    const head = tbody.appendChild(new TestEl('tr'));
    for (const h of ['重量', '长']) head.appendChild(new TestEl('th', { text: h }));
    const tr = tbody.appendChild(new TestEl('tr'));
    const w = tr.appendChild(new TestEl('td')).appendChild(new TestEl('input'));
    const l = tr.appendChild(new TestEl('td')).appendChild(new TestEl('input'));
    w.value = '1.5';
    l.value = '30';
    const driver = createDomFlowDriver(doc as unknown as Document, DRIVER_OPTS);
    await expect(
      driver.read(
        { kind: 'rows', table: ref('.rows', 'other', '行'), columns: ['weight', 'length'] },
        emptyScope,
        signal(),
      ),
    ).resolves.toEqual({ ok: true, value: [{ weight: '1.5', length: '30' }] });
    await expect(
      driver.read(
        { kind: 'rows', table: ref('.rows', 'other', '行'), columns: ['weight', 'length', 'width'] },
        emptyScope,
        signal(),
      ),
    ).resolves.toEqual({ ok: false, reason: 'unreadable' });
  });

  it('boolean reads cover aria state, checkboxes and antd checked-class; absent targets read false', async () => {
    const doc = new TestDoc();
    const tab = doc.root.appendChild(
      new TestEl('button', { classes: ['b-tab'], attrs: { 'aria-selected': 'true', 'data-key': 't1' } }),
    );
    const checkbox = doc.root.appendChild(new TestEl('input', { classes: ['b-cb'], type: 'checkbox' }));
    checkbox.checked = true;
    const plain = doc.root.appendChild(new TestEl('div', { classes: ['b-plain'] }));
    const driver = createDomFlowDriver(doc as unknown as Document, DRIVER_OPTS);
    await expect(driver.read({ kind: 'boolean', target: ref('.b-tab', 'other', '页签') }, emptyScope, signal())).resolves.toEqual(
      { ok: true, value: true },
    );
    tab.attrs.set('aria-selected', 'false');
    await expect(driver.read({ kind: 'boolean', target: ref('.b-tab', 'other', '页签') }, emptyScope, signal())).resolves.toEqual(
      { ok: true, value: false },
    );
    await expect(driver.read({ kind: 'boolean', target: ref('.b-cb', 'checkbox', '勾选') }, emptyScope, signal())).resolves.toEqual(
      { ok: true, value: true },
    );
    await expect(driver.read({ kind: 'boolean', target: ref('.b-plain', 'other', '普通') }, emptyScope, signal())).resolves.toEqual(
      // No boolean carrier: presence itself is the state (edit-mode style signal)
      { ok: true, value: true },
    );
    await expect(driver.read({ kind: 'boolean', target: ref('.b-missing', 'other', '缺位') }, emptyScope, signal())).resolves.toEqual(
      { ok: true, value: false },
    );
    // Declared checkbox resolving to a non-checkbox must not read a bogus presence-true
    await expect(driver.read({ kind: 'boolean', target: ref('.b-plain', 'checkbox', '伪勾选') }, emptyScope, signal())).resolves.toEqual(
      { ok: false, reason: 'unreadable' },
    );
  });

  it('within-scoped actions resolve same-labeled buttons per group while unscoped resolution stays ambiguous', async () => {
    const doc = new TestDoc();
    const clicks: string[] = [];
    for (const key of ['g1', 'g2']) {
      const tab = doc.root.appendChild(
        new TestEl('button', { classes: ['member'], attrs: { 'data-key': key, 'aria-controls': `p-${key}` } }),
      );
      void tab;
      const panel = doc.root.appendChild(new TestEl('div', { id: `p-${key}`, classes: ['panel'] }));
      const act = panel.appendChild(new TestEl('button', { classes: ['act-btn'], text: '保 存' }));
      act.onClick = () => clicks.push(key);
    }
    const driver = createDomFlowDriver(doc as unknown as Document, DRIVER_OPTS);
    await driver.read({ kind: 'collection', target: ref('.member', 'other', '组') }, emptyScope, signal());
    await expect(
      driver.act({ type: 'clickButton', target: ref('.act-btn', 'button', '保 存') }, undefined, emptyScope, signal()),
    ).resolves.toBe('ambiguous');
    await expect(
      driver.act(
        { type: 'clickButton', target: ref('.act-btn', 'button', '保 存', 'group') },
        undefined,
        scopeWith('group', 'g2'),
        signal(),
      ),
    ).resolves.toBe('ok');
    expect(clicks).toEqual(['g2']);
  });

  it('elementAbsent waits until a present target disappears; ambiguity during elementPresent fails immediately', async () => {
    const doc = new TestDoc();
    const banner = doc.root.appendChild(new TestEl('div', { classes: ['banner'] }));
    const driver = createDomFlowDriver(doc as unknown as Document, DRIVER_OPTS);
    setTimeout(() => {
      banner.visible = false;
    }, 15);
    await expect(
      driver.waitUntil({ kind: 'elementAbsent', target: ref('.banner', 'other', '横幅') }, 500, emptyScope, () => true, signal()),
    ).resolves.toEqual({ outcome: 'satisfied' });

    doc.root.appendChild(new TestEl('div', { classes: ['dupe'] }));
    doc.root.appendChild(new TestEl('div', { classes: ['dupe'] }));
    await expect(
      driver.waitUntil({ kind: 'elementPresent', target: ref('.dupe', 'other', '重复') }, 100, emptyScope, () => true, signal()),
    ).rejects.toMatchObject({ name: 'DriverFailure', reason: 'ambiguous', stage: 'wait' });
  });

  it('elementAbsent ambiguity fails immediately, not as a full-timeout "absence timeout"', async () => {
    // Two live matches cannot be waited away: burning the whole timeout would report the wrong
    // failure (absence timeout) and hide the real problem — the locator is not unique (§5.1)
    const doc = new TestDoc();
    doc.root.appendChild(new TestEl('div', { classes: ['dupe-absent'] }));
    doc.root.appendChild(new TestEl('div', { classes: ['dupe-absent'] }));
    const driver = createDomFlowDriver(doc as unknown as Document, DRIVER_OPTS);
    const startedAt = Date.now();
    await expect(
      driver.waitUntil({ kind: 'elementAbsent', target: ref('.dupe-absent', 'other', '重复') }, 3000, emptyScope, () => true, signal()),
    ).rejects.toMatchObject({ name: 'DriverFailure', reason: 'ambiguous', stage: 'wait' });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('a member id produced by a second collection stops the run instead of silently re-binding scope', async () => {
    // Two scoped collections sharing a member id (two "基本信息" tabs) would otherwise aim
    // `within` actions of the first loop at whichever collection read last (PRD §4.2: prefer
    // stopping over acting on the wrong group)
    const doc = new TestDoc();
    doc.root.appendChild(new TestEl('button', { classes: ['group-tab'], attrs: { 'data-key': '基本信息' } }));
    doc.root.appendChild(new TestEl('button', { classes: ['block-tab'], attrs: { 'data-key': '基本信息' } }));
    const driver = createDomFlowDriver(doc as unknown as Document, DRIVER_OPTS);
    await expect(
      driver.read({ kind: 'collection', target: ref('.group-tab', 'other', '组页签') }, emptyScope, signal()),
    ).resolves.toEqual({ ok: true, value: [{ id: '基本信息' }] });
    await expect(
      driver.read({ kind: 'collection', target: ref('.block-tab', 'other', '区块页签') }, emptyScope, signal()),
    ).resolves.toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('readMatches waits require stable non-empty samples before the predicate is consulted', async () => {
    const doc = new TestDoc();
    const status = doc.root.appendChild(new TestEl('input', { classes: ['status'] }));
    const driver = createDomFlowDriver(doc as unknown as Document, DRIVER_OPTS);
    let writes = 0;
    const iv = setInterval(() => {
      writes++;
      status.value = writes < 3 ? `loading-${writes}` : 'done';
    }, 12);
    const res = await driver.waitUntil(
      {
        kind: 'readMatches',
        read: { kind: 'scalar', target: ref('.status', 'input', '状态') },
        into: 'status',
        when: { kind: 'equals', ref: 'vars.status', value: 'done' },
      },
      2000,
      emptyScope,
      (value) => value === 'done',
      signal(),
    );
    clearInterval(iv);
    expect(res).toEqual({ outcome: 'satisfied', value: 'done' });
    // 'done' itself was written at write #3; satisfaction needed it stable for one more sample
    expect(writes).toBeGreaterThanOrEqual(4);
  });
});

// DriverFailure shape sanity (stage/reason/detail contract used in logs)
describe('DriverFailure', () => {
  it('carries stage, reason and detail', () => {
    const err = new DriverFailure('read', 'ambiguous', 'vars.rows');
    expect(err.stage).toBe('read');
    expect(err.reason).toBe('ambiguous');
    expect(err.detail).toBe('vars.rows');
    expect(err.name).toBe('DriverFailure');
  });
});
