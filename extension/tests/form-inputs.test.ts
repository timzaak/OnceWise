// Pre-run input value semantics (lib/flow-inputs.ts). These tests pin the personal-data and
// skip-gating invariants: values exist only in their declared shape, a definition change invalidates
// old records instead of reinterpreting them, explicit invalid submissions never overwrite saved
// values, and "not filled" is expressed by key absence — an optional absent item must never be
// coerced into '', false or [] as if the user had filled it (US-SSBA-005).
import { describe, expect, it } from 'vitest';
import {
  buildStoredInputMap,
  evaluateFlowInputs,
  inputDefinitionSignature,
  normalizeInputValue,
  type FlowInputValueMap,
} from '@/lib/flow-inputs';
import type { InputDefinition } from '@/lib/flow-schema';

const def = (overrides: Partial<InputDefinition> = {}): InputDefinition => ({
  key: 'phone',
  label: '联系电话',
  type: 'text',
  required: false,
  ...overrides,
});

const singleDef = def({
  key: 'warehouse',
  label: '发货仓库',
  type: 'single',
  required: false,
  options: [
    { value: 'SZ', label: '深圳仓' },
    { value: 'GZ', label: '广州仓' },
  ],
});

const multiDef = def({
  key: 'channels',
  label: '报关渠道',
  type: 'multi',
  required: false,
  options: [
    { value: 'A', label: '渠道A' },
    { value: 'B', label: '渠道B' },
  ],
});

describe('normalizeInputValue: seven types', () => {
  it('text keeps the value verbatim; empty string means not filled', () => {
    expect(normalizeInputValue(def(), ' 13800001234 ')).toEqual({ ok: true, value: ' 13800001234 ' });
    expect(normalizeInputValue(def(), '')).toEqual({ ok: true, value: undefined });
    expect(normalizeInputValue(def(), 42)).toEqual({ ok: false });
  });

  it('number accepts finite decimals and stores the canonical form; 0 is a filled value', () => {
    expect(normalizeInputValue(def({ type: 'number' }), ' 42 ')).toEqual({ ok: true, value: '42' });
    expect(normalizeInputValue(def({ type: 'number' }), '3.140')).toEqual({ ok: true, value: '3.14' });
    expect(normalizeInputValue(def({ type: 'number' }), '+5')).toEqual({ ok: true, value: '5' });
    expect(normalizeInputValue(def({ type: 'number' }), '0')).toEqual({ ok: true, value: '0' });
    expect(normalizeInputValue(def({ type: 'number' }), '.5')).toEqual({ ok: true, value: '0.5' });
    expect(normalizeInputValue(def({ type: 'number' }), '')).toEqual({ ok: true, value: undefined });
    // NaN / hex / exponent forms are not finite decimal strings
    expect(normalizeInputValue(def({ type: 'number' }), 'abc').ok).toBe(false);
    expect(normalizeInputValue(def({ type: 'number' }), '0x1F').ok).toBe(false);
    expect(normalizeInputValue(def({ type: 'number' }), '1e3').ok).toBe(false);
    expect(normalizeInputValue(def({ type: 'number' }), 'Infinity').ok).toBe(false);
  });

  it('extreme magnitudes keep the validated literal — the stored form must survive its own revalidation', () => {
    const numberDef = def({ type: 'number', required: true });
    // String(Number(x)) drifts into exponent notation at these magnitudes; storing that form would
    // make every later snapshot gate refuse the flow (input-invalid, permanently — the user re-saves
    // the same number and it bricks again), so save and revalidate must agree on one form
    expect(normalizeInputValue(numberDef, '1000000000000000000000')).toEqual({ ok: true, value: '1000000000000000000000' });
    expect(normalizeInputValue(numberDef, '0.0000001')).toEqual({ ok: true, value: '0.0000001' });
    const built = buildStoredInputMap({ inputs: [numberDef] }, { phone: '1000000000000000000000' });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(evaluateFlowInputs({ inputs: [numberDef] }, built.map).issues).toEqual([]);
    }
  });

  it('date/time validate the real calendar and clock range, not just the shape', () => {
    expect(normalizeInputValue(def({ type: 'date' }), '2024-02-29')).toEqual({ ok: true, value: '2024-02-29' });
    expect(normalizeInputValue(def({ type: 'date' }), '2026-02-30').ok).toBe(false);
    expect(normalizeInputValue(def({ type: 'date' }), '2026-13-01').ok).toBe(false);
    expect(normalizeInputValue(def({ type: 'date' }), '2026-1-1').ok).toBe(false);
    expect(normalizeInputValue(def({ type: 'time' }), '23:59')).toEqual({ ok: true, value: '23:59' });
    expect(normalizeInputValue(def({ type: 'time' }), '00:00')).toEqual({ ok: true, value: '00:00' });
    expect(normalizeInputValue(def({ type: 'time' }), '24:00').ok).toBe(false);
    expect(normalizeInputValue(def({ type: 'time' }), '12:60').ok).toBe(false);
    expect(normalizeInputValue(def({ type: 'time' }), '')).toEqual({ ok: true, value: undefined });
  });

  it('single only accepts declared candidates; no selection means not filled', () => {
    expect(normalizeInputValue(singleDef, 'SZ')).toEqual({ ok: true, value: 'SZ' });
    expect(normalizeInputValue(singleDef, '')).toEqual({ ok: true, value: undefined });
    expect(normalizeInputValue(singleDef, 'DG').ok).toBe(false);
  });

  it('checkbox false is a FILLED valid value, not an empty one', () => {
    expect(normalizeInputValue(def({ type: 'checkbox' }), false)).toEqual({ ok: true, value: false });
    expect(normalizeInputValue(def({ type: 'checkbox' }), true)).toEqual({ ok: true, value: true });
    expect(normalizeInputValue(def({ type: 'checkbox' }), 'false').ok).toBe(false);
  });

  it('multi dedupes and rejects non-candidates; an empty array means not filled', () => {
    expect(normalizeInputValue(multiDef, ['B', 'A', 'B'])).toEqual({ ok: true, value: ['B', 'A'] });
    expect(normalizeInputValue(multiDef, [])).toEqual({ ok: true, value: undefined });
    expect(normalizeInputValue(multiDef, ['A', 'C']).ok).toBe(false);
    expect(normalizeInputValue(multiDef, ['A', 3]).ok).toBe(false);
  });
});

describe('definition signatures', () => {
  it('any declaration change produces a different signature', () => {
    const base = singleDef;
    expect(inputDefinitionSignature(base)).not.toBe(inputDefinitionSignature({ ...base, label: '仓库' }));
    expect(inputDefinitionSignature(base)).not.toBe(inputDefinitionSignature({ ...base, type: 'text', options: undefined }));
    expect(inputDefinitionSignature(base)).not.toBe(inputDefinitionSignature({ ...base, required: true }));
    expect(inputDefinitionSignature(base)).not.toBe(
      inputDefinitionSignature({ ...base, options: [...base.options!, { value: 'DG', label: '东莞仓' }] }),
    );
    // identical declarations keep the signature stable across flow versions
    expect(inputDefinitionSignature(base)).toBe(inputDefinitionSignature({ ...base, options: base.options!.map((o) => ({ ...o })) }));
  });
});

describe('evaluateFlowInputs: issue priority and the startup gate', () => {
  const flow = (inputs: InputDefinition[]) => ({ inputs });

  const storedRecord = (d: InputDefinition, value: unknown): FlowInputValueMap => ({
    [d.key]: { definitionSignature: inputDefinitionSignature(d), value: value as never },
  });

  it('valid records produce values with no issues; optional absent items produce neither', () => {
    const stored = {
      ...storedRecord(def({ required: true }), '13800001234'),
      ...storedRecord(def({ key: 'insured', label: '保价', type: 'checkbox' }), false),
    };
    const res = evaluateFlowInputs(flow([def({ required: true }), def({ key: 'insured', label: '保价', type: 'checkbox' })]), stored);
    expect(res.issues).toEqual([]);
    expect(res.values).toEqual({ phone: '13800001234', insured: false });
  });

  it('a required item with no record reports required-missing; an optional one stays silent', () => {
    const res = evaluateFlowInputs(flow([def({ required: true }), singleDef]), {});
    expect(res.issues).toEqual([{ key: 'phone', label: '联系电话', reason: 'required-missing' }]);
    expect(res.values).toEqual({});
  });

  it('a stale record (definition changed) is withheld even though the value still parses — and even when optional', () => {
    // The stored record was signed by an older definition (options since changed)
    const oldDef = { ...singleDef, options: [{ value: 'SZ', label: '深圳仓' }] };
    const stored = { warehouse: { definitionSignature: inputDefinitionSignature(oldDef), value: 'SZ' } };
    const res = evaluateFlowInputs(flow([singleDef]), stored);
    expect(res.issues).toEqual([{ key: 'warehouse', label: '发货仓库', reason: 'stale-definition' }]);
    expect(res.values).toEqual({});
  });

  it('a signature-matching record whose value violates the definition reports invalid-stored-value', () => {
    const stored = { warehouse: { definitionSignature: inputDefinitionSignature(singleDef), value: 'OLD' } };
    const res = evaluateFlowInputs(flow([singleDef]), stored);
    expect(res.issues).toEqual([{ key: 'warehouse', label: '发货仓库', reason: 'invalid-stored-value' }]);
  });

  it('issues carry only key/label/reason — never the value itself', () => {
    const stored = { phone: { definitionSignature: inputDefinitionSignature(def()), value: '13800001234' } };
    const res = evaluateFlowInputs(flow([def({ type: 'number' })]), stored);
    expect(JSON.stringify(res.issues)).not.toContain('13800001234');
  });

  it('flows without inputs always evaluate clean (old flows keep their fast path)', () => {
    expect(evaluateFlowInputs({}, {})).toEqual({ values: {}, issues: [] });
    expect(evaluateFlowInputs({ inputs: [] }, { junk: { definitionSignature: 'x', value: 'y' } })).toEqual({
      values: {},
      issues: [],
    });
  });
});

describe('buildStoredInputMap: the save contract', () => {
  const flow = (inputs: InputDefinition[]) => ({ inputs });

  it('a valid full mapping becomes the stored records; unfilled keys are simply absent', () => {
    const phone = def({ required: true });
    const res = buildStoredInputMap(flow([phone, singleDef]), { phone: '13800001234', warehouse: '' });
    expect(res).toEqual({
      ok: true,
      map: { phone: { definitionSignature: inputDefinitionSignature(phone), value: '13800001234' } },
    });
  });

  it('explicit invalid values reject the whole save with zero records built (old values survive untouched)', () => {
    const res = buildStoredInputMap(flow([def({ type: 'number', required: true }), singleDef]), {
      phone: 'not-a-number',
      warehouse: 'SZ',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toContainEqual({ key: 'phone', label: '联系电话', reason: 'invalid-submitted-value' });
    }
  });

  it('keys the flow never declared are rejected as invalid submissions', () => {
    const res = buildStoredInputMap(flow([def()]), { phone: 'x', mystery: 'y' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toContainEqual({ key: 'mystery', label: 'mystery', reason: 'invalid-submitted-value' });
    }
  });

  it('saving a required item empty is allowed — the gap shows up as required-missing at evaluation time', () => {
    const res = buildStoredInputMap(flow([def({ required: true })]), {});
    expect(res).toEqual({ ok: true, map: {} });
    expect(evaluateFlowInputs(flow([def({ required: true })]), res.ok ? res.map : {}).issues).toEqual([
      { key: 'phone', label: '联系电话', reason: 'required-missing' },
    ]);
  });

  it('checkbox false is persisted as a filled record (absent-vs-false is a storage-level distinction)', () => {
    const insured = def({ key: 'insured', label: '保价', type: 'checkbox' });
    const res = buildStoredInputMap(flow([insured]), { insured: false });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.map.insured).toEqual({ definitionSignature: inputDefinitionSignature(insured), value: false });
    }
  });
});
