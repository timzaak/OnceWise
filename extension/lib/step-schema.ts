// Constrained step vocabulary (the `steps` tree inside a schemaVersion 1 flow): nodes, typed predicates, structured data references, collection
// scoping and budgets (DEC-self-service-browser-automation-019). Flows are data, not code — this module
// defines the constrained node set the runtime may execute; no functions, expressions or script strings
// are ever accepted. flow-schema.ts owns the flow envelope and re-exports the shared primitives
// (FieldRef / submit term families / input definitions) defined here so existing import sites stay
// unchanged.
//
// Data references are plain strings scoped by prefix: `trigger.value` (the trigger seed), `inputs.<key>`
// (a user-filled pre-run input value), `vars.<slot>` (a read destination, dot-paths allowed for row
// fields) and `<itemVar>[.<field>]` (the current loop item). Value positions that also accept constants
// use `{ "ref": "<path>" }` instead of a bare string.
//
// Validation errors are stable English strings carrying node paths (`steps[n3].steps[1]`) — they are
// machine-locatable for the AI import loop; presentation i18n lands with the P4 UI pass.

export interface FieldClues {
  id?: string;
  name?: string;
  labelText?: string;
  placeholder?: string;
  ariaLabel?: string;
  cssPath?: string;
}

export type ComponentType = 'input' | 'antdSelect' | 'checkbox' | 'button' | 'other';

export interface FieldRef {
  clues: FieldClues;
  componentType: ComponentType;
  displayLabel: string;
  // Optional loop scoping (PRD §4.2 当前组/当前行作用域): names the loop `itemVar` whose current
  // collection member bounds this target's search. The driver resolves within that member's subtree
  // (the member element itself included), so same-labeled controls in other groups cannot be hit.
  within?: string;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Submit term families (DEC-010): the allowed family (save/submit/confirm) executes automatically once
// enabled; the forbidden family (irreversible actions) stays refused (PRD §2.2).
export const SUBMIT_ALLOWED_TERMS = ['save', 'submit', 'confirm', '保存', '提交', '确认', '确定'] as const;
export const SUBMIT_FORBIDDEN_TERMS = [
  'delete',
  'remove',
  'pay',
  'payment',
  'purchase',
  'checkout',
  'publish',
  '删除',
  '移除',
  '支付',
  '下单',
  '发布',
] as const;

export function isSubmitLikeText(text: string): boolean {
  const want = text.replace(/\s+/g, '').toLowerCase();
  return SUBMIT_ALLOWED_TERMS.some((term) => want.includes(term.toLowerCase()));
}

export function isSubmitForbiddenText(text: string): boolean {
  const want = text.replace(/\s+/g, '').toLowerCase();
  return SUBMIT_FORBIDDEN_TERMS.some((term) => want.includes(term.toLowerCase()));
}

const COMPONENT_TYPES: readonly ComponentType[] = ['input', 'antdSelect', 'checkbox', 'button', 'other'];

// Pre-run input declarations (form-support): AI declares what the user must fill in the flow detail;
// the values themselves live outside the Flow in local storage and reach the steps only as the
// run-start snapshot. Declared here so the step walk can type-check `inputs.<key>` references;
// re-exported by flow-schema like the other vocabulary primitives.
export type InputDefinitionType = 'text' | 'number' | 'single' | 'checkbox' | 'date' | 'time' | 'multi';

export const INPUT_DEFINITION_TYPES: readonly InputDefinitionType[] = [
  'text',
  'number',
  'single',
  'checkbox',
  'date',
  'time',
  'multi',
] as const;

export interface InputOption {
  value: string;
  label: string;
}

export interface InputDefinition {
  key: string;
  label: string;
  type: InputDefinitionType;
  required: boolean;
  options?: InputOption[];
}

// The runtime value shape a declared input resolves to: multi → string[], checkbox → boolean, rest →
// string. Drives the static type flows on reference positions.
export type InputRuntimeType = 'string' | 'boolean' | 'array';

export function inputRuntimeTypeOf(type: InputDefinitionType): InputRuntimeType {
  if (type === 'multi') return 'array';
  if (type === 'checkbox') return 'boolean';
  return 'string';
}

export const INPUTS_REF_PREFIX = 'inputs.';

export function isFieldRef(v: unknown): v is FieldRef {
  if (!isPlainObject(v)) return false;
  const clues = v.clues;
  const keys = ['id', 'name', 'labelText', 'placeholder', 'ariaLabel', 'cssPath'];
  const cluesOk = isPlainObject(clues) && keys.every((k) => clues[k] === undefined || typeof clues[k] === 'string');
  return (
    cluesOk &&
    typeof v.componentType === 'string' &&
    (COMPONENT_TYPES as readonly string[]).includes(v.componentType) &&
    typeof v.displayLabel === 'string' &&
    v.displayLabel.length > 0 &&
    (v.within === undefined || typeof v.within === 'string')
  );
}

// A target may only scope itself to an item variable that is definitely bound at that point (an
// enclosing loop's itemVar). Anything else — a typo, an outer slot, an unbound name — is rejected.
function checkFieldRefScope(field: unknown, scope: WalkScope, label: string, errors: string[]): void {
  if (!isFieldRef(field) || field.within === undefined) return;
  if (field.within.length === 0 || !IDENT.test(field.within)) {
    errors.push(`${label}.within: must be an identifier`);
  } else if (!scope.itemVars.has(field.within)) {
    errors.push(`${label}.within: "${field.within}" is not a loop item variable in scope`);
  }
}

// What a read produces and where it lands. `into` is a bare slot name (validated identifier) — the
// runtime prefixes it with `vars.`; row collections store records whose fields are addressed by
// `vars.<slot>.<field>` in predicates.
export type ReadSpec =
  // A single control's value as text (input value, select text, …)
  | { kind: 'scalar'; target: FieldRef }
  // A boolean state (checkbox checked, tab-active class presence, …)
  | { kind: 'boolean'; target: FieldRef }
  // A collection of stable member identifiers (group tabs, rows, …); the driver freezes members at
  // read time and re-locates by identifier on every iteration (PRD §4.2)
  | { kind: 'collection'; target: FieldRef }
  // Row records `{ [column]: string }[]` read from a table-like container
  | { kind: 'rows'; table: FieldRef; columns: string[] };

export type SlotType = 'scalar' | 'boolean' | 'collection' | 'rows';

export type StepActionKind = 'setInputValue' | 'selectOption' | 'setCheckbox' | 'clickButton';

// Value positions accept a constant string or a structured reference to runtime data.
export type StepValue = string | { ref: string };

export interface ActionSpec {
  type: StepActionKind;
  target: FieldRef;
  value?: StepValue;
  // Literal boolean, or a reference to a checkbox input whose snapshot value the compiler resolves to
  // the boolean the driver applies (never stringified)
  checked?: boolean | { ref: string };
  submitLike?: boolean;
}

// Typed predicates only (PRD §4.1 minimal set). Numeric comparison treats missing / empty / non-finite
// values as not passing — reads distinguish missing, empty, non-numeric and 0 by failing the check.
export type Predicate =
  | { kind: 'exists'; ref: string }
  | { kind: 'boolean'; ref: string; equals: boolean }
  | { kind: 'equals'; ref: string; value: string | number | boolean }
  | { kind: 'numberCompare'; ref: string; op: '>' | '>=' | '<' | '<='; value: number }
  | { kind: 'nonEmpty'; ref: string }
  // `item` inside the sub-predicate binds to the current collection member
  | { kind: 'every' | 'some'; ref: string; item: Predicate }
  | { kind: 'and' | 'or'; parts: Predicate[] }
  | { kind: 'not'; of: Predicate };

// Wait conditions are read-only DOM observations the driver polls (missing target = keep waiting,
// ambiguity = failure). The stability sampling window lives in the DOM driver (P2), not in the schema.
export type WaitCondition =
  | { kind: 'elementPresent'; target: FieldRef }
  | { kind: 'elementAbsent'; target: FieldRef }
  | { kind: 'readMatches'; read: ReadSpec; into: string; when: Predicate };

export type StepNode =
  | { id: string; kind: 'sequence'; steps: StepNode[] }
  | { id: string; kind: 'read'; read: ReadSpec; into: string }
  | { id: string; kind: 'action'; action: ActionSpec }
  | { id: string; kind: 'if'; when: Predicate; then: StepNode[]; else?: StepNode[] }
  | { id: string; kind: 'foreach'; over: string; itemVar: string; maxIterations?: number; do: StepNode[] }
  | { id: string; kind: 'wait'; timeoutMs: number; until: WaitCondition }
  | { id: string; kind: 'assert'; check: Predicate }
  // Declares that the run is about to leave this document for the declared page `to` and will
  // continue there. The navigation itself is caused by a preceding whitelisted click (submit button,
  // pagination link, possibly target=_blank) — navigate only declares and awaits the arrival.
  | { id: string; kind: 'navigate'; to: string; timeoutMs: number };

export type StepNodeKind = StepNode['kind'];
export const STEP_NODE_KINDS: readonly StepNodeKind[] = [
  'sequence',
  'read',
  'action',
  'if',
  'foreach',
  'wait',
  'assert',
  'navigate',
] as const;

// Flow-level budget: engine hard caps cannot be raised, only lowered (PRD §4.3 / FR12).
export interface StepBudget {
  loopItems: number;
  waitMs: number;
  runMs: number;
}

export const STEP_BUDGET_CAPS: StepBudget = {
  loopItems: 100,
  waitMs: 60_000,
  runMs: 15 * 60_000,
};

export function resolveStepBudget(declared?: Partial<StepBudget>): StepBudget {
  const clamp = (v: number | undefined, cap: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), cap) : cap;
  return {
    loopItems: clamp(declared?.loopItems, STEP_BUDGET_CAPS.loopItems),
    waitMs: clamp(declared?.waitMs, STEP_BUDGET_CAPS.waitMs),
    runMs: clamp(declared?.runMs, STEP_BUDGET_CAPS.runMs),
  };
}

export const MAX_STEP_NODES = 200;
export const MAX_STEP_DEPTH = 8;

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SLOT_PREFIX = 'vars.';
const TRIGGER_REF = 'trigger.value';

// Loop item member kinds: 'string' for a foreach over a multi input (a bare `<itemVar>` IS a valid
// string value there), 'record' for object members ({id} records, row records)
type ItemVarKind = 'string' | 'record';

interface WalkScope {
  // Slot names definitely assigned on every path reaching this point → their read type
  slots: Map<string, SlotType>;
  // Loop item variables in scope → member kind; shadowing is rejected at validation time
  itemVars: Map<string, ItemVarKind>;
  // Declared pre-run inputs (key → declared type); empty when the flow declares none, which makes
  // every `inputs.<key>` reference an unknown reference — old flows are unaffected either way
  inputs: Map<string, InputDefinitionType>;
  // Foreach `over` targets that must be definite collections at this point
  budget: StepBudget;
}

function refBase(ref: string): string {
  return ref.split('.')[0] ?? '';
}

// The declared type behind an `inputs.<key>` reference, or undefined when the ref is not an inputs ref
// (or the key is not declared — checkRef reports that case).
function declaredInputType(scope: WalkScope, ref: string): InputDefinitionType | undefined {
  if (typeof ref !== 'string' || !ref.startsWith(INPUTS_REF_PREFIX)) return undefined;
  return scope.inputs.get(ref.slice(INPUTS_REF_PREFIX.length));
}

function checkRef(scope: WalkScope, ref: string, label: string, errors: string[]): void {
  if (typeof ref !== 'string' || ref.length === 0) {
    errors.push(`${label}: reference must be a non-empty string`);
    return;
  }
  if (ref === TRIGGER_REF) return;
  if (ref.startsWith(INPUTS_REF_PREFIX)) {
    const key = ref.slice(INPUTS_REF_PREFIX.length);
    if (!IDENT.test(key)) {
      errors.push(`${label}: invalid input reference "${ref}" (expected exactly inputs.<key>)`);
    } else if (!scope.inputs.has(key)) {
      errors.push(`${label}: reference "${ref}" uses an input key the flow does not declare`);
    }
    return;
  }
  if (ref.startsWith(SLOT_PREFIX)) {
    const slot = refBase(ref.slice(SLOT_PREFIX.length));
    if (!IDENT.test(slot)) {
      errors.push(`${label}: invalid slot name "${slot}"`);
    } else if (!scope.slots.has(slot)) {
      errors.push(`${label}: reference "${ref}" reads a slot that is not assigned on every path before it`);
    }
    return;
  }
  if (scope.itemVars.has(refBase(ref))) return;
  errors.push(`${label}: unknown reference "${ref}" (expected ${TRIGGER_REF}, inputs.<key>, vars.<slot> or a loop item)`);
}

// Value positions feed real form fields, so a reference must resolve to a string: a whole
// collection/rows/boolean reference would reach the driver as "[object Object]"/"true" garbage and
// pass the driver's read-back check (it wrote exactly that garbage).
function checkStringValueRef(scope: WalkScope, ref: string, label: string, errors: string[]): void {
  checkRef(scope, ref, label, errors);
  if (ref === TRIGGER_REF) return;
  const inputType = declaredInputType(scope, ref);
  if (inputType !== undefined) {
    const runtimeType = inputRuntimeTypeOf(inputType);
    if (runtimeType !== 'string') {
      errors.push(`${label}: "${ref}" is a ${inputType} input (${runtimeType} value), a value position requires a string input`);
    }
    return;
  }
  const base = refBase(ref);
  const itemKind = scope.itemVars.get(base);
  if (itemKind !== undefined) {
    if (itemKind === 'string') {
      // A multi-input loop member is a plain string: the bare itemVar is the value itself
      if (ref !== base) {
        errors.push(`${label}: "${ref}" addresses a field of "${base}", which is a string loop member, not a record`);
      }
      return;
    }
    if (ref === base) errors.push(`${label}: "${ref}" is a whole loop item, a value needs a string field`);
    return;
  }
  if (!ref.startsWith(SLOT_PREFIX)) return;
  const rest = ref.slice(SLOT_PREFIX.length);
  const slot = refBase(rest);
  const type = scope.slots.get(slot);
  if (type === undefined) return; // the unassigned slot is already reported by checkRef
  const isFieldPath = rest.length > slot.length;
  if ((type === 'scalar' && !isFieldPath) || (type === 'rows' && isFieldPath)) return;
  errors.push(`${label}: "${ref}" resolves to a ${type}, a value position requires a string`);
}

// every/some iterate members: the reference must be a whole collection/rows slot. A scalar/boolean
// reference would make "every" vacuously pass at runtime — the exact inversion of the empty-collection
// flow the compiler enforces on purpose (PRD §4.1).
function checkCollectionRef(scope: WalkScope, ref: string, label: string, errors: string[]): void {
  if (ref === TRIGGER_REF) {
    errors.push(`${label}: trigger.value is a string, every/some need a collection or rows slot`);
    return;
  }
  const inputType = declaredInputType(scope, ref);
  if (inputType !== undefined) {
    if (inputType !== 'multi') {
      errors.push(`${label}: "${ref}" is a ${inputType} input, every/some need a multi input (array value)`);
    }
    return;
  }
  const base = refBase(ref);
  if (scope.itemVars.has(base)) {
    errors.push(`${label}: "${ref}" is a single loop item, every/some need a collection or rows slot`);
    return;
  }
  if (!ref.startsWith(SLOT_PREFIX)) return; // unknown shape already flagged by checkRef
  const rest = ref.slice(SLOT_PREFIX.length);
  const slot = refBase(rest);
  const type = scope.slots.get(slot);
  if (type === undefined) return; // the unassigned slot is already reported by checkRef
  if (type !== 'collection' && type !== 'rows') {
    errors.push(`${label}: "${ref}" is a ${type} slot, every/some need a collection or rows slot`);
    return;
  }
  if (rest.length > slot.length) {
    errors.push(`${label}: "${ref}" addresses a member field, every/some need the whole collection`);
  }
}

function checkPredicate(
  pred: unknown,
  scope: WalkScope,
  label: string,
  errors: string[],
  itemBound: boolean,
): void {
  if (!isPlainObject(pred)) {
    errors.push(`${label}: predicate must be an object`);
    return;
  }
  switch (pred.kind) {
    case 'exists':
    case 'nonEmpty': {
      checkRef(scope, pred.ref as string, label, errors);
      return;
    }
    case 'boolean': {
      if (typeof pred.equals !== 'boolean') errors.push(`${label}: equals must be a boolean`);
      checkRef(scope, pred.ref as string, label, errors);
      const inputType = declaredInputType(scope, pred.ref as string);
      if (inputType !== undefined && inputType !== 'checkbox') {
        errors.push(`${label}: "${String(pred.ref)}" is a ${inputType} input, boolean predicates need a checkbox input`);
      }
      return;
    }
    case 'equals': {
      if (!['string', 'number', 'boolean'].includes(typeof pred.value)) {
        errors.push(`${label}: value must be a string, number or boolean`);
      }
      checkRef(scope, pred.ref as string, label, errors);
      return;
    }
    case 'numberCompare': {
      if (!['>', '>=', '<', '<='].includes(pred.op as string)) errors.push(`${label}: op must be > >= < <=`);
      if (typeof pred.value !== 'number' || !Number.isFinite(pred.value)) {
        errors.push(`${label}: value must be a finite number`);
      }
      checkRef(scope, pred.ref as string, label, errors);
      const inputType = declaredInputType(scope, pred.ref as string);
      if (inputType !== undefined && inputType !== 'number') {
        errors.push(`${label}: "${String(pred.ref)}" is a ${inputType} input, numberCompare needs a number input`);
      }
      return;
    }
    case 'every':
    case 'some': {
      if (!isPlainObject(pred.item)) errors.push(`${label}: item must be a predicate over the current item`);
      // The member sub-predicate sees `item` — check it against a scope where `item` is bound
      // (kind 'record' is a placeholder: predicates only test references, never value positions, so
      // the member kind of `item` is never consulted)
      const innerItems = itemBound ? new Map(scope.itemVars) : new Map<string, ItemVarKind>();
      innerItems.set('item', 'record');
      const inner: WalkScope = { ...scope, itemVars: innerItems };
      checkPredicate(pred.item, inner, `${label}.item`, errors, true);
      checkRef(scope, pred.ref as string, label, errors);
      checkCollectionRef(scope, pred.ref as string, label, errors);
      return;
    }
    case 'and':
    case 'or': {
      if (!Array.isArray(pred.parts) || pred.parts.length === 0) {
        errors.push(`${label}: parts must be a non-empty array`);
        return;
      }
      pred.parts.forEach((p, i) => checkPredicate(p, scope, `${label}.parts[${i}]`, errors, itemBound));
      return;
    }
    case 'not': {
      if (!isPlainObject(pred.of)) errors.push(`${label}: of must be a predicate`);
      checkPredicate(pred.of, scope, `${label}.of`, errors, itemBound);
      return;
    }
    default:
      errors.push(`${label}: unknown predicate kind "${String(pred.kind)}"`);
  }
}

function checkReadSpec(spec: unknown, scope: WalkScope, label: string, errors: string[]): SlotType | null {
  if (!isPlainObject(spec)) {
    errors.push(`${label}: read must be an object`);
    return null;
  }
  const checkTarget = (field: unknown, targetLabel: string): void => {
    if (!isFieldRef(field)) errors.push(`${targetLabel}: not a valid field reference`);
    else checkFieldRefScope(field, scope, targetLabel, errors);
  };
  switch (spec.kind) {
    case 'scalar':
      checkTarget(spec.target, `${label}.target`);
      return 'scalar';
    case 'boolean':
      checkTarget(spec.target, `${label}.target`);
      return 'boolean';
    case 'collection':
      checkTarget(spec.target, `${label}.target`);
      return 'collection';
    case 'rows':
      checkTarget(spec.table, `${label}.table`);
      if (
        !Array.isArray(spec.columns) ||
        spec.columns.length === 0 ||
        !spec.columns.every((c: unknown) => typeof c === 'string' && IDENT.test(c))
      ) {
        errors.push(`${label}.columns: must be a non-empty array of identifiers`);
      }
      return 'rows';
    default:
      errors.push(`${label}: unknown read kind "${String(spec.kind)}"`);
      return null;
  }
}

// Returns the slot type a readMatches condition writes (null for the presence/absence forms and for
// invalid reads) so the walk does not re-derive the read kind → slot type mapping.
function checkWaitCondition(cond: unknown, scope: WalkScope, label: string, errors: string[]): SlotType | null {
  if (!isPlainObject(cond)) {
    errors.push(`${label}: until must be an object`);
    return null;
  }
  switch (cond.kind) {
    case 'elementPresent':
    case 'elementAbsent':
      if (!isFieldRef(cond.target)) errors.push(`${label}.target: not a valid field reference`);
      else checkFieldRefScope(cond.target, scope, `${label}.target`, errors);
      return null;
    case 'readMatches': {
      const type = checkReadSpec(cond.read, scope, `${label}.read`, errors);
      if (typeof cond.into !== 'string' || !IDENT.test(cond.into)) {
        errors.push(`${label}.into: must be an identifier`);
      } else if (type !== null && scope.slots.get(cond.into) !== undefined && scope.slots.get(cond.into) !== type) {
        errors.push(`${label}.into: slot "${cond.into}" already holds a different type`);
      }
      // The `when` predicate may read the slot being written by this very wait
      const waitScope: WalkScope = { ...scope, slots: new Map(scope.slots) };
      if (type !== null && typeof cond.into === 'string') waitScope.slots.set(cond.into, type);
      checkPredicate(cond.when, waitScope, `${label}.when`, errors, false);
      return type;
    }
    default:
      errors.push(`${label}: unknown wait condition kind "${String(cond.kind)}"`);
      return null;
  }
}

function checkValue(value: unknown, scope: WalkScope, label: string, errors: string[]): void {
  if (typeof value === 'string') return;
  if (isPlainObject(value) && typeof value.ref === 'string') {
    checkStringValueRef(scope, value.ref, label, errors);
    return;
  }
  errors.push(`${label}: value must be a constant string or { "ref": "..." }`);
}

interface WalkResult {
  // Slots definitely assigned after this node on all paths
  slotsAfter: Map<string, SlotType>;
}

function walk(
  node: unknown,
  scope: WalkScope,
  path: string,
  errors: string[],
  nodeIds: Set<string>,
  depth: number,
  counts: { total: number },
): WalkResult | null {
  counts.total++;
  if (counts.total > MAX_STEP_NODES) {
    errors.push(`steps: more than ${MAX_STEP_NODES} nodes`);
    return null;
  }
  if (depth > MAX_STEP_DEPTH) {
    errors.push(`${path}: nesting deeper than ${MAX_STEP_DEPTH} levels`);
    return null;
  }
  if (!isPlainObject(node)) {
    errors.push(`${path}: node must be an object`);
    return null;
  }
  const id = node.id;
  if (typeof id !== 'string' || id.length === 0 || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    errors.push(`${path}.id: must be 1-64 chars of letters, digits, "_" or "-"`);
    return null;
  }
  // Reserved by the compiler: resumePathAfter returns raw node ids as the resume path and uses
  // '__completed' as its end-of-tree sentinel — a node with that id would be indistinguishable
  // from the sentinel and silently skip every step after the navigate
  if (id === '__completed') {
    errors.push(`${path}.id: "__completed" is reserved (cross-page resume sentinel)`);
    return null;
  }
  if (nodeIds.has(id)) errors.push(`${path}.id: duplicate node id "${id}"`);
  nodeIds.add(id);
  const label = `steps[${id}]`;

  const cloneSlots = (): Map<string, SlotType> => {
    const next = new Map<string, SlotType>();
    for (const [k, v] of scope.slots) next.set(k, v);
    return next;
  };

  switch (node.kind) {
    case 'sequence': {
      if (!Array.isArray(node.steps) || node.steps.length === 0) {
        errors.push(`${label}: steps must be a non-empty array`);
        return null;
      }
      let slots = cloneSlots();
      node.steps.forEach((child, i) => {
        const res = walk(child, { ...scope, slots }, `${path}.steps[${i}]`, errors, nodeIds, depth + 1, counts);
        if (res) slots = res.slotsAfter;
      });
      return { slotsAfter: slots };
    }

    case 'read': {
      const type = checkReadSpec(node.read, scope, `${label}.read`, errors);
      if (typeof node.into !== 'string' || !IDENT.test(node.into)) {
        errors.push(`${label}.into: must be an identifier`);
        return null;
      }
      const slots = cloneSlots();
      if (type !== null) {
        const existing = slots.get(node.into);
        if (existing !== undefined && existing !== type) {
          errors.push(`${label}.into: slot "${node.into}" already holds a different type`);
        }
        slots.set(node.into, type);
      }
      return { slotsAfter: slots };
    }

    case 'action': {
      const action = node.action;
      if (!isPlainObject(action)) {
        errors.push(`${label}.action: must be an object`);
        return null;
      }
      if (
        typeof action.type !== 'string' ||
        !(['setInputValue', 'selectOption', 'setCheckbox', 'clickButton'] as const).includes(
          action.type as StepActionKind,
        )
      ) {
        errors.push(`${label}.action.type: unknown action type "${String(action.type)}"`);
      }
      if (!isFieldRef(action.target)) errors.push(`${label}.action.target: not a valid field reference`);
      else checkFieldRefScope(action.target, scope, `${label}.action.target`, errors);
      if (action.type === 'setInputValue' || action.type === 'selectOption') {
        if (action.value === undefined) errors.push(`${label}.action.value: required for ${action.type}`);
        else checkValue(action.value, scope, `${label}.action.value`, errors);
      }
      if (action.type === 'setCheckbox') {
        if (isPlainObject(action.checked) && typeof action.checked.ref === 'string') {
          const ref = action.checked.ref;
          // Only input references resolve to a run-start boolean here — slot/item refs keep their
          // string-object semantics and are not a checked source
          if (!ref.startsWith(INPUTS_REF_PREFIX)) {
            errors.push(`${label}.action.checked: reference must be inputs.<key>`);
          } else {
            checkRef(scope, ref, `${label}.action.checked`, errors);
            const inputType = declaredInputType(scope, ref);
            if (inputType !== undefined && inputType !== 'checkbox') {
              errors.push(
                `${label}.action.checked: "${ref}" is a ${inputType} input, setCheckbox needs a checkbox input`,
              );
            }
          }
        } else if (typeof action.checked !== 'boolean') {
          errors.push(`${label}.action.checked: required boolean or { "ref": "inputs.<key>" } for setCheckbox`);
        }
      }
      if (action.submitLike !== undefined && typeof action.submitLike !== 'boolean') {
        errors.push(`${label}.action.submitLike: must be a boolean`);
      }
      if (isFieldRef(action.target) && action.type === 'clickButton' && isSubmitForbiddenText(action.target.displayLabel)) {
        errors.push(
          `${label}.action.target: "${action.target.displayLabel}" matches the forbidden irreversible-action terms (${SUBMIT_FORBIDDEN_TERMS.join('/')})`,
        );
      }
      return { slotsAfter: cloneSlots() };
    }

    case 'if': {
      checkPredicate(node.when, scope, `${label}.when`, errors, false);
      const branches: [string, unknown[] | undefined][] = [['then', node.then as unknown[] | undefined]];
      if (node.else !== undefined) branches.push(['else', node.else as unknown[] | undefined]);
      const branchOutcomes: Map<string, SlotType>[] = [];
      for (const [branchName, branchNodes] of branches) {
        if (!Array.isArray(branchNodes) || branchNodes.length === 0) {
          errors.push(`${label}.${branchName}: must be a non-empty array`);
          branchOutcomes.push(cloneSlots());
          continue;
        }
        let slots = cloneSlots();
        branchNodes.forEach((child, i) => {
          const res = walk(
            child,
            { ...scope, slots },
            `${path}.${branchName}[${i}]`,
            errors,
            nodeIds,
            depth + 1,
            counts,
          );
          if (res) slots = res.slotsAfter;
        });
        branchOutcomes.push(slots);
      }
      // Only slots assigned on EVERY branch stay definite after the if (PRD §4.3). A missing else
      // means the implicit skip path carries the pre-if slots.
      if (node.else === undefined) branchOutcomes.push(cloneSlots());
      const after = new Map<string, SlotType>();
      const [first, ...rest] = branchOutcomes;
      if (first !== undefined) {
        for (const [slot, type] of first) {
          if (rest.every((m) => m.get(slot) === type)) after.set(slot, type);
        }
      }
      return { slotsAfter: after };
    }

    case 'foreach': {
      checkRef(scope, node.over as string, `${label}.over`, errors);
      const overInputType = declaredInputType(scope, node.over as string);
      if (overInputType !== undefined && overInputType !== 'multi') {
        errors.push(
          `${label}.over: "${String(node.over)}" is a ${overInputType} input, foreach over an input requires a multi input (array value)`,
        );
      }
      const overSlot = typeof node.over === 'string' ? refBase(node.over.slice(SLOT_PREFIX.length)) : '';
      const overType = scope.slots.get(overSlot);
      if (overType !== undefined && overType !== 'collection' && overType !== 'rows') {
        errors.push(`${label}.over: "${node.over}" is a ${overType}, foreach requires a collection or rows slot`);
      }
      if (typeof node.itemVar !== 'string' || !IDENT.test(node.itemVar)) {
        errors.push(`${label}.itemVar: must be an identifier`);
        return null;
      }
      if (node.itemVar === 'inputs') {
        // Reserved: an itemVar named "inputs" would make `inputs.<field>` ambiguous with the pre-run
        // input reference domain
        errors.push(`${label}.itemVar: "inputs" is reserved and cannot be a loop variable`);
      }
      if (scope.itemVars.has(node.itemVar)) {
        errors.push(`${label}.itemVar: "${node.itemVar}" shadows an outer loop variable`);
      }
      if (node.maxIterations !== undefined) {
        if (typeof node.maxIterations !== 'number' || !Number.isInteger(node.maxIterations) || node.maxIterations < 1) {
          errors.push(`${label}.maxIterations: must be a positive integer`);
        } else if (node.maxIterations > scope.budget.loopItems) {
          errors.push(`${label}.maxIterations: ${node.maxIterations} exceeds the loop budget ${scope.budget.loopItems}`);
        }
      }
      if (!Array.isArray(node.do) || node.do.length === 0) {
        errors.push(`${label}.do: must be a non-empty array`);
        return null;
      }
      // The loop body is a sequence: assignments thread between its steps (a read earlier in the
      // body IS definite later in the same iteration). The body may run zero times — its slots do
      // not produce definite slots after the loop. Iterating a multi input yields plain string
      // members — the bare itemVar is a string value there.
      const bodyScope: WalkScope = {
        ...scope,
        itemVars: new Map(scope.itemVars).set(node.itemVar, overInputType === 'multi' ? 'string' : 'record'),
      };
      let bodySlots = cloneSlots();
      node.do.forEach((child, i) => {
        const res = walk(
          child,
          { ...bodyScope, slots: bodySlots },
          `${path}.do[${i}]`,
          errors,
          nodeIds,
          depth + 1,
          counts,
        );
        if (res) bodySlots = res.slotsAfter;
      });
      return { slotsAfter: cloneSlots() };
    }

    case 'wait': {
      if (typeof node.timeoutMs !== 'number' || !Number.isFinite(node.timeoutMs) || node.timeoutMs < 1) {
        errors.push(`${label}.timeoutMs: a deadline is required (positive milliseconds)`);
      } else if (node.timeoutMs > scope.budget.waitMs) {
        errors.push(`${label}.timeoutMs: ${node.timeoutMs} exceeds the wait budget ${scope.budget.waitMs}`);
      }
      const readType = checkWaitCondition(node.until, scope, `${label}.until`, errors);
      const slots = cloneSlots();
      // A satisfied readMatches wait has written its slot on the only continuing path (timeout is a
      // terminal failure), so the slot is definite afterwards.
      if (readType !== null && isPlainObject(node.until) && typeof node.until.into === 'string' && IDENT.test(node.until.into)) {
        slots.set(node.until.into, readType);
      }
      return { slotsAfter: slots };
    }

    case 'assert': {
      checkPredicate(node.check, scope, `${label}.check`, errors, false);
      return { slotsAfter: cloneSlots() };
    }

    case 'navigate': {
      if (typeof node.to !== 'string' || node.to.length === 0) {
        errors.push(`${label}.to: must be a non-empty declared page id`);
      }
      if (typeof node.timeoutMs !== 'number' || !Number.isFinite(node.timeoutMs) || node.timeoutMs < 1) {
        errors.push(`${label}.timeoutMs: a page-readiness deadline is required (positive milliseconds)`);
      } else if (node.timeoutMs > scope.budget.waitMs) {
        errors.push(`${label}.timeoutMs: ${node.timeoutMs} exceeds the wait budget ${scope.budget.waitMs}`);
      }
      // Slots and itemVars pass through unchanged: navigate neither assigns nor consumes data —
      // everything readable before the jump stays readable on the declared page (same context).
      return { slotsAfter: cloneSlots() };
    }

    default:
      errors.push(`${label}: unknown node kind "${String(node.kind)}"`);
      return null;
  }
}

export function validateSteps(
  root: unknown,
  budget = resolveStepBudget(),
  inputs: InputDefinition[] = [],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const inputScope = new Map<string, InputDefinitionType>();
  for (const def of inputs) inputScope.set(def.key, def.type);
  walk(
    root,
    { slots: new Map(), itemVars: new Map<string, ItemVarKind>(), inputs: inputScope, budget },
    'steps',
    errors,
    new Set(),
    1,
    { total: 0 },
  );
  return { ok: errors.length === 0, errors };
}

// Envelope-level read (the flow's businessKey declaration): the same shape checks as step reads,
// against an empty scope — `within` targets are rejected here because no loop exists at the envelope.
export function validateEnvelopeReadSpec(spec: unknown, label: string, errors: string[]): SlotType | null {
  const emptyScope: WalkScope = { slots: new Map(), itemVars: new Map<string, ItemVarKind>(), inputs: new Map(), budget: resolveStepBudget() };
  return checkReadSpec(spec, emptyScope, label, errors);
}

// Effective submit classification from flow data alone: explicit submitLike wins both ways
// (label without an allowed word can be marked; a false can correct a false positive).
export function isSubmitClassActionSpec(
  action: Pick<ActionSpec, 'submitLike'> & { target: Pick<FieldRef, 'displayLabel'> },
): boolean {
  if (action.submitLike === true) return true;
  if (action.submitLike === false) return false;
  return isSubmitLikeText(action.target.displayLabel);
}

// One child-container enumeration shared by every whole-tree walk so a new composite kind cannot be
// added to one consumer and missed by the other.
function walkStepNodes(root: StepNode, visit: (node: Record<string, unknown>) => void): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isPlainObject(node)) continue;
    visit(node);
    for (const key of ['steps', 'then', 'else', 'do'] as const) {
      const children = node[key];
      if (Array.isArray(children)) stack.push(...children);
    }
  }
}

export function stepsHaveSubmitAction(root: StepNode): boolean {
  let found = false;
  walkStepNodes(root, (node) => {
    if (node.kind === 'action' && isPlainObject(node.action) && isSubmitClassActionSpec(node.action as unknown as ActionSpec)) {
      found = true;
    }
  });
  return found;
}

// Every navigate.to in the tree, in walk order — the envelope cross-check pairs this with the
// declared `pages[].id` set (each to must be declared; each declaration must be referenced).
export function navigateTargetsOf(root: StepNode): string[] {
  const targets: string[] = [];
  walkStepNodes(root, (node) => {
    if (node.kind === 'navigate' && typeof node.to === 'string') targets.push(node.to);
  });
  return targets;
}

export function countStepNodes(root: StepNode): number {
  let total = 0;
  walkStepNodes(root, () => {
    total++;
  });
  return total;
}

function describeRead(spec: ReadSpec): string {
  switch (spec.kind) {
    case 'scalar':
      return `read ${spec.target.displayLabel}`;
    case 'boolean':
      return `read state of ${spec.target.displayLabel}`;
    case 'collection':
      return `read collection ${spec.target.displayLabel}`;
    case 'rows':
      return `read rows of ${spec.table.displayLabel} (${spec.columns.join(', ')})`;
  }
}

// Exported for the compiler's assert-failure reason and the sync version diff summaries.
export function describePredicate(pred: Predicate): string {
  switch (pred.kind) {
    case 'exists':
      return `${pred.ref} exists`;
    case 'boolean':
      return `${pred.ref} is ${pred.equals}`;
    case 'equals':
      return `${pred.ref} = ${pred.value}`;
    case 'numberCompare':
      return `${pred.ref} ${pred.op} ${pred.value}`;
    case 'nonEmpty':
      return `${pred.ref} is non-empty`;
    case 'every':
      return `every item of ${pred.ref}: (${describePredicate(pred.item)})`;
    case 'some':
      return `some item of ${pred.ref}: (${describePredicate(pred.item)})`;
    case 'and':
      return pred.parts.map(describePredicate).join(' and ');
    case 'or':
      return pred.parts.map(describePredicate).join(' or ');
    case 'not':
      return `not (${describePredicate(pred.of)})`;
  }
}

// One summary line per actionable/observable node, indented for branches and loops. Shared by the
// import summary and the sync version preview (both go through redactText at the presentation layer).
export function describeSteps(root: StepNode): { text: string; submit: boolean }[] {
  const out: { text: string; submit: boolean }[] = [];
  const visit = (node: unknown, indent: number): void => {
    if (!isPlainObject(node)) return;
    const pad = '  '.repeat(indent);
    const push = (text: string, submit = false): void => {
      out.push({ text: pad + text, submit });
    };
    switch (node.kind) {
      case 'sequence':
        (node.steps as unknown[]).forEach((child) => visit(child, indent));
        return;
      case 'read':
        push(`${describeRead(node.read as ReadSpec)} → ${node.into}`);
        return;
      case 'action': {
        const action = node.action as ActionSpec;
        const submit = isSubmitClassActionSpec(action);
        const value = typeof action.value === 'string' ? action.value : typeof action.value === 'object' ? `{${action.value.ref}}` : '';
        const checked =
          typeof action.checked === 'object' && action.checked !== null
            ? `{${action.checked.ref}}`
            : action.checked === true;
        const detail =
          action.type === 'setInputValue' || action.type === 'selectOption'
            ? ` = ${value}`
            : action.type === 'setCheckbox'
              ? ` = ${checked}`
              : '';
        push(`${action.type} ${action.target.displayLabel}${detail}`, submit);
        return;
      }
      case 'if':
        push(`if ${describePredicate(node.when as Predicate)}`);
        (node.then as unknown[]).forEach((child) => visit(child, indent + 1));
        if (Array.isArray(node.else)) {
          push('else', false);
          node.else.forEach((child) => visit(child, indent + 1));
        }
        return;
      case 'foreach':
        push(`foreach ${node.over} as ${node.itemVar}${node.maxIterations !== undefined ? ` (max ${node.maxIterations})` : ''}`);
        (node.do as unknown[]).forEach((child) => visit(child, indent + 1));
        return;
      case 'wait': {
        const until = node.until as WaitCondition;
        const cond =
          until.kind === 'elementPresent'
            ? `${until.target.displayLabel} present`
            : until.kind === 'elementAbsent'
              ? `${until.target.displayLabel} absent`
              : `${describeRead(until.read)} matches (${describePredicate(until.when)})`;
        push(`wait up to ${node.timeoutMs}ms until ${cond}`);
        return;
      }
      case 'assert':
        push(`assert ${describePredicate(node.check as Predicate)}`);
        return;
      case 'navigate':
        push(`navigate to page ${node.to} (≤ ${node.timeoutMs}ms)`);
        return;
      default:
        return;
    }
  };
  visit(root, 0);
  return out;
}
