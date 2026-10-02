// Pre-run input values (form-support): normalization/validation of user-submitted values against the
// flow's input declarations, signature revalidation of stored records, and the issue computation shared
// by the sidepanel read/save paths and the content-start snapshot gate. Values live only in
// local:flowInputValues under the background single writer; they never enter Flow objects, sync
// payloads, run logs or page context beyond the one-run snapshot.
import { djb2, type InputDefinition, type InputOption, type Flow } from './flow-schema';

export type InputValue = string | boolean | string[];
export type InputSnapshot = Record<string, InputValue>;

export type InputIssueReason =
  | 'stale-definition'
  | 'invalid-stored-value'
  | 'required-missing'
  | 'invalid-submitted-value';

// Errors carry only key/label/reason — never the submitted or stored value itself.
export interface InputIssue {
  key: string;
  label: string;
  reason: InputIssueReason;
}

export interface StoredInputValue {
  definitionSignature: string;
  value: InputValue;
}

export type FlowInputValueMap = Record<string, StoredInputValue>;

// The signature covers every field of the declaration: any definition change (type, options, label,
// requiredness) invalidates the old stored record instead of letting it be reinterpreted.
export function inputDefinitionSignature(def: InputDefinition): string {
  return djb2(JSON.stringify([def.key, def.label, def.type, def.required, def.options ?? null]));
}

const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isRealDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// Normalize one value against its definition. Absent (empty text/number/date/time, no single
// selection, empty multi) resolves to value: undefined so callers express "not filled" by key absence;
// checkbox false is a FILLED value and stays. Values are stored in canonical form (numbers as finite
// decimal strings, multi deduped).
export function normalizeInputValue(
  def: InputDefinition,
  raw: unknown,
): { ok: true; value: InputValue | undefined } | { ok: false } {
  // checkbox and multi are the only non-string shapes; the five string shapes share both pre-checks —
  // a non-string rejects, an empty string means not filled (number additionally treats a
  // whitespace-only string as empty in its own case)
  if (def.type === 'checkbox') {
    if (typeof raw !== 'boolean') return { ok: false };
    return { ok: true, value: raw };
  }
  if (def.type === 'multi') {
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) return { ok: false };
    const allowed = optionValues(def);
    const out: string[] = [];
    for (const v of raw) {
      if (!allowed.includes(v)) return { ok: false };
      if (!out.includes(v)) out.push(v);
    }
    return { ok: true, value: out.length === 0 ? undefined : out };
  }
  if (typeof raw !== 'string') return { ok: false };
  if (raw === '') return { ok: true, value: undefined };
  switch (def.type) {
    case 'text':
      return { ok: true, value: raw };
    case 'number': {
      const trimmed = raw.trim();
      if (trimmed === '') return { ok: true, value: undefined };
      if (!DECIMAL_RE.test(trimmed)) return { ok: false };
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return { ok: false };
      // String(n) drifts into exponent notation at the magnitude extremes (1e21, 1e-7); a stored
      // record in that form would fail this same regex at snapshot revalidation and permanently gate
      // the flow — keep the validated literal wherever the canonical form is not itself a decimal.
      const canonical = String(n);
      return { ok: true, value: DECIMAL_RE.test(canonical) ? canonical : trimmed };
    }
    case 'date':
      return DATE_RE.test(raw) && isRealDate(raw) ? { ok: true, value: raw } : { ok: false };
    case 'time':
      return TIME_RE.test(raw) ? { ok: true, value: raw } : { ok: false };
    case 'single':
      return optionValues(def).includes(raw) ? { ok: true, value: raw } : { ok: false };
  }
}

function optionValues(def: InputDefinition): string[] {
  return (def.options ?? ([] as InputOption[])).map((o) => o.value);
}

export interface FlowInputsEvaluation {
  // Only entries valid under the CURRENT definitions; stale/invalid records are withheld
  values: InputSnapshot;
  // At most one issue per definition, priority: stale-definition > invalid-stored-value >
  // required-missing. A stale or invalid record blocks startup even when the item is optional — the
  // user must re-save before the flow runs again.
  issues: InputIssue[];
}

export function evaluateFlowInputs(
  flow: Pick<Flow, 'inputs'>,
  stored: FlowInputValueMap,
): FlowInputsEvaluation {
  const values: InputSnapshot = {};
  const issues: InputIssue[] = [];
  for (const def of flow.inputs ?? []) {
    const record = stored[def.key];
    if (record !== undefined && record.definitionSignature !== inputDefinitionSignature(def)) {
      issues.push({ key: def.key, label: def.label, reason: 'stale-definition' });
      continue;
    }
    if (record !== undefined) {
      const res = normalizeInputValue(def, record.value);
      if (!res.ok) {
        issues.push({ key: def.key, label: def.label, reason: 'invalid-stored-value' });
        continue;
      }
      if (res.value !== undefined) values[def.key] = res.value;
      else if (def.required) issues.push({ key: def.key, label: def.label, reason: 'required-missing' });
      continue;
    }
    if (def.required) issues.push({ key: def.key, label: def.label, reason: 'required-missing' });
  }
  return { values, issues };
}

// sp:saveFlowInputs: the submitted mapping is the WHOLE form. Explicit invalid values (wrong type,
// non-candidate, malformed number/date/time, unknown key) reject the save with zero writes; a valid
// mapping with unfilled required items saves fine — the flow detail keeps showing required-missing.
// One pass over the submitted keys: each key is normalized exactly once and the stored record is
// built from that same result, so validation and construction cannot drift apart.
export function buildStoredInputMap(
  flow: Pick<Flow, 'inputs'>,
  submitted: Record<string, unknown>,
): { ok: true; map: FlowInputValueMap } | { ok: false; issues: InputIssue[] } {
  const defs = flow.inputs ?? [];
  const known = new Map(defs.map((d) => [d.key, d] as const));
  const issues: InputIssue[] = [];
  const map: FlowInputValueMap = {};
  for (const [key, raw] of Object.entries(submitted)) {
    const def = known.get(key);
    if (def === undefined) {
      issues.push({ key, label: key, reason: 'invalid-submitted-value' });
      continue;
    }
    const res = normalizeInputValue(def, raw);
    if (!res.ok) {
      issues.push({ key, label: def.label, reason: 'invalid-submitted-value' });
    } else if (res.value !== undefined) {
      map[key] = { definitionSignature: inputDefinitionSignature(def), value: res.value };
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, map };
}
