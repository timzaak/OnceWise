// Flows are data, not code: the system never accepts or executes AI-generated code, only structured data
// validated here. A flow is an envelope (name/site/page/trigger/status/provenance) around a constrained
// `steps` tree (lib/step-schema.ts). There is exactly one flow format: files carrying any other
// schemaVersion are rejected with a version error (no migration, DEC-019).
import { getLocale, t } from './i18n';
import {
  describeSteps,
  isFieldRef,
  isPlainObject,
  isSubmitForbiddenText,
  navigateTargetsOf,
  resolveStepBudget,
  validateEnvelopeReadSpec,
  validateSteps,
  IDENT,
  INPUT_DEFINITION_TYPES,
  type FieldClues,
  type FieldRef,
  type ComponentType,
  type InputDefinition,
  type InputDefinitionType,
  type InputOption,
  type ReadSpec,
  type StepBudget,
  type StepNode,
  STEP_BUDGET_CAPS,
} from './step-schema';

// Vocabulary primitives live in step-schema; re-exported so import sites of './flow-schema' keep
// resolving unchanged.
export {
  isPlainObject,
  isFieldRef,
  isSubmitLikeText,
  isSubmitForbiddenText,
  describeSteps,
  SUBMIT_ALLOWED_TERMS,
  SUBMIT_FORBIDDEN_TERMS,
  INPUT_DEFINITION_TYPES,
} from './step-schema';
export type { FieldClues, FieldRef, ComponentType, InputDefinition, InputDefinitionType, InputOption } from './step-schema';

export const SCHEMA_VERSION = 1;

export type TriggerCondition = { kind: 'anyChange' } | { kind: 'codeEquals'; code: string };

export type FlowTrigger =
  | { kind: 'fieldChange'; field: FieldRef; condition: TriggerCondition }
  | { kind: 'pageEnter' };

// Page fingerprint: URL substring over pathname+hash (query stripped) plus optional DOM content
// features; ambiguity counts as a miss (conservative)
export interface PageFingerprint {
  urlIncludes: string;
  contentIncludes?: FieldRef[];
}

// A declared continuation page: the run may navigate to this page (declared by a `navigate` step)
// and continue there. Ordered after the entry page; every declaration must be referenced by at
// least one navigate step (dead declarations are rejected at validation).
export interface DeclaredPage {
  id: string;
  page: PageFingerprint;
}

export interface FlowProvenance {
  source: 'import';
  description?: string;
  importedAt?: number;
  createdAt: number;
  updatedAt: number;
  enabledAt?: number;
}

// The constrained step tree replaces free-form step lists: reads, conditional branches, bounded loops,
// deadline waits and assertions, all within the engine budget. `budget` may only lower the engine caps
// (validated here, enforced by the compiler/runtime). `businessKey` declares the readable
// business-instance identifier (a scalar read) used for cross-tab claims — submit-carrying flows
// refuse to start without one (PRD §5.3).
export interface Flow {
  schemaVersion: 1;
  id: string;
  name: string;
  site: string;
  page: PageFingerprint;
  // Declared continuation pages (same site as `page`); absent = the classic single-page flow.
  // The trigger binding surface stays `page` alone — pageEnter/fieldChange are never evaluated
  // against continuation pages.
  pages?: DeclaredPage[];
  trigger: FlowTrigger;
  steps: StepNode;
  // Pre-run input declarations only — user-filled values never travel inside the Flow (they live in
  // local:flowInputValues and are shared with nobody)
  inputs?: InputDefinition[];
  budget?: Partial<StepBudget>;
  businessKey?: { read: ReadSpec };
  status: 'draft' | 'enabled' | 'paused';
  provenance: FlowProvenance;
}

// Run outcomes reported by the runtime's final states plus the non-execution 'skip' (dedup /
// already-claimed / busy / refused-start; PRD §4.2).
export type ExecOutcome = 'skip' | 'completed' | 'failed' | 'cancelled';

// Where a run stopped: node id, loop position, stage and machine-locatable reason. pageId is set
// when the failure happened on (or on the way to) a declared continuation page.
export interface RunFailureDetail {
  nodeId: string;
  stage: string;
  reason: string;
  detail?: string;
  iterationPath: string;
  pageId?: string;
}

export function deriveFlowId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `r_${Date.now().toString(36)}_${rand}`;
}

// Display-only short token for the sidepanel: the random tail of a deriveFlowId id (the 6 chars
// after the last underscore). The full id stays the storage/native-channel/CAS key; quoting the
// tail in an AI prompt is enough because the agent receives the full granted id via ping and
// suffix-matches. Total on any string so foreign/sync ids cannot break the UI.
export function shortFlowId(id: string): string {
  return id.length <= 6 ? id : id.slice(-6);
}

// Stable-content hash shared by flowDraftHash here and contentScriptIdFor in site-scripts — keep a single
// implementation so id/fingerprint derivations cannot drift apart
export function djb2(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

// The flow's stable content fields — everything that influences execution. One shared projection for
// the draft hash and the import page's optimize prefill, so a new content field can never be added to
// one consumer and silently dropped by the other. Envelope fields (id/status/provenance) stay out.
export function flowContentFields(
  flow: Pick<Flow, 'name' | 'site' | 'page' | 'pages' | 'trigger' | 'steps' | 'inputs' | 'budget' | 'businessKey'>,
) {
  return {
    name: flow.name,
    site: flow.site,
    page: flow.page,
    ...(flow.pages !== undefined ? { pages: flow.pages } : {}),
    trigger: flow.trigger,
    steps: flow.steps,
    ...(flow.inputs !== undefined ? { inputs: flow.inputs } : {}),
    ...(flow.budget !== undefined ? { budget: flow.budget } : {}),
    ...(flow.businessKey !== undefined ? { businessKey: flow.businessKey } : {}),
  };
}

// Ownership matching for dry-run results reopened in the sidepanel: hash only the flow's stable content
// (envelope fields like provenance/status change on every save) — the steps plus the budget, every
// field that influences execution (DEC-data-sync-011).
export function flowDraftHash(flow: Flow): string {
  return `h${djb2(JSON.stringify(flowContentFields(flow)))}`;
}

export function parseOrigin(site: string): string | null {
  try {
    const url = new URL(site);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch {
    return null;
  }
}

function isTriggerCondition(v: unknown): v is TriggerCondition {
  if (!isPlainObject(v)) return false;
  if (v.kind === 'anyChange') return true;
  return v.kind === 'codeEquals' && typeof v.code === 'string' && v.code.length > 0;
}

function isFlowTrigger(v: unknown): v is FlowTrigger {
  if (!isPlainObject(v)) return false;
  if (v.kind === 'pageEnter') return true;
  return v.kind === 'fieldChange' && isFieldRef(v.field) && isTriggerCondition(v.condition);
}

function pageErrors(page: unknown): string[] {
  if (!isPlainObject(page)) return [t('err.pageInvalid')];
  const errors: string[] = [];
  if (typeof page.urlIncludes !== 'string' || page.urlIncludes.length === 0) {
    errors.push(t('err.pageUrlIncludes'));
  }
  if (page.contentIncludes !== undefined) {
    if (
      !Array.isArray(page.contentIncludes) ||
      page.contentIncludes.length === 0 ||
      !page.contentIncludes.every((c: unknown) => isFieldRef(c))
    ) {
      errors.push(t('err.pageContentIncludes'));
    }
  }
  return errors;
}

const INPUT_ITEM_KEYS = ['key', 'label', 'type', 'required', 'options'] as const;

// Declared inputs are a closed shape on purpose: a definition carrying any other field (a value the
// user filled, a UI state) is rejected whole — values must never ride inside the shared flow object.
// Returns the normalized definitions; failures are reported as errors (the caller fails the flow).
function inputsErrors(raw: unknown, errors: string[]): InputDefinition[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push('inputs: must be an array of input definitions');
    return [];
  }
  const defs: InputDefinition[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    if (!isPlainObject(item)) {
      errors.push(`inputs[${i}]: must be an object`);
      return;
    }
    for (const field of Object.keys(item)) {
      if (!(INPUT_ITEM_KEYS as readonly string[]).includes(field)) {
        errors.push(`inputs[${i}]: unknown field "${field}" (definitions carry no values)`);
      }
    }
    const { key, label, type, required } = item;
    if (typeof key !== 'string' || !IDENT.test(key)) {
      errors.push(`inputs[${i}].key: must be an identifier`);
      return;
    }
    if (seen.has(key)) {
      errors.push(`inputs[${i}].key: "${key}" is declared more than once`);
      return;
    }
    seen.add(key);
    if (typeof label !== 'string' || label.trim().length === 0) {
      errors.push(`inputs[${i}].label: must be a non-empty string`);
      return;
    }
    if (typeof type !== 'string' || !(INPUT_DEFINITION_TYPES as readonly string[]).includes(type)) {
      errors.push(`inputs[${i}].type: must be one of ${INPUT_DEFINITION_TYPES.join('|')}`);
      return;
    }
    if (typeof required !== 'boolean') {
      errors.push(`inputs[${i}].required: must be a boolean`);
      return;
    }
    const defType = type as InputDefinitionType;
    let options: InputOption[] | undefined;
    if (defType === 'single' || defType === 'multi') {
      if (!Array.isArray(item.options) || item.options.length === 0) {
        errors.push(`inputs[${i}].options: required non-empty option array for ${defType}`);
        return;
      }
      const values = new Set<string>();
      options = [];
      for (const opt of item.options) {
        if (
          !isPlainObject(opt) ||
          typeof opt.value !== 'string' || opt.value.length === 0 ||
          typeof opt.label !== 'string' || opt.label.trim().length === 0
        ) {
          errors.push(`inputs[${i}].options: each option must be { "value": non-empty, "label": non-empty }`);
          return;
        }
        if (values.has(opt.value)) {
          errors.push(`inputs[${i}].options: duplicate option value "${opt.value}"`);
          return;
        }
        values.add(opt.value);
        options.push({ value: opt.value, label: opt.label });
      }
    } else if (item.options !== undefined) {
      errors.push(`inputs[${i}].options: only single/multi inputs declare options`);
      return;
    }
    defs.push({ key, label, type: defType, required, ...(options !== undefined ? { options } : {}) });
  });
  return defs;
}

function coreErrors(input: Record<string, unknown>): { errors: string[]; inputDefs: InputDefinition[] } {
  const errors: string[] = [];
  if (typeof input.name !== 'string' || input.name.trim().length === 0) errors.push(t('err.nameRequired'));

  if (typeof input.site !== 'string' || input.site.length === 0) {
    errors.push(t('err.siteRequired'));
  } else if (parseOrigin(input.site) !== input.site) {
    errors.push(t('err.siteOrigin'));
  }

  errors.push(...pageErrors(input.page));

  // Declared continuation pages: optional, but when present a non-empty array whose ids are unique
  // identifiers and whose fingerprints reuse the entry page's shape rules. The to↔pages cross-check
  // runs after the step walk (both sides must be known).
  const declaredIds = new Set<string>();
  if (input.pages !== undefined) {
    if (!Array.isArray(input.pages) || input.pages.length === 0) {
      errors.push('pages: must be a non-empty array of { id, page } when present');
    } else {
      input.pages.forEach((entry: unknown, i: number) => {
        if (!isPlainObject(entry)) {
          errors.push(`pages[${i}]: must be { id, page }`);
          return;
        }
        if (typeof entry.id !== 'string' || !IDENT.test(entry.id)) {
          errors.push(`pages[${i}].id: must be an identifier`);
        } else if (declaredIds.has(entry.id)) {
          errors.push(`pages[${i}].id: "${entry.id}" is declared more than once`);
        } else {
          declaredIds.add(entry.id);
        }
        errors.push(...pageErrors(entry.page).map((msg) => `pages[${i}]: ${msg}`));
      });
    }
  }

  if (!isFlowTrigger(input.trigger)) {
    errors.push('trigger: must be { kind: "fieldChange", field, condition } or { kind: "pageEnter" }');
  }

  if (input.budget !== undefined) {
    if (!isPlainObject(input.budget)) {
      errors.push('budget: must be an object of optional { loopItems, waitMs, runMs }');
    } else {
      for (const key of ['loopItems', 'waitMs', 'runMs'] as const) {
        const value = input.budget[key];
        if (value === undefined) continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
          errors.push(`budget.${key}: must be a positive number`);
        } else if (value > STEP_BUDGET_CAPS[key]) {
          // Engine hard caps cannot be raised, only lowered (PRD §4.3)
          errors.push(`budget.${key}: ${value} exceeds the engine cap ${STEP_BUDGET_CAPS[key]}`);
        }
      }
    }
  }

  // Inputs are parsed first so the step walk can scope `inputs.<key>` references against the
  // declared keys
  const inputDefs = inputsErrors(input.inputs, errors);
  errors.push(
    ...validateSteps(input.steps, resolveStepBudget(input.budget as Partial<StepBudget>), inputDefs).errors,
  );

  // to↔pages bidirectional reference check: a navigate may only target a declared page, and every
  // declared page must be awaited by at least one navigate. The dead-declaration rule is what keeps
  // an older extension (one without the navigate vocabulary) from silently running a multi-page flow
  // as single-page — it rejects the whole flow on the unknown node kind instead.
  const targets = navigateTargetsOf(input.steps as StepNode);
  const referenced = new Set<string>();
  for (const to of targets) {
    if (!declaredIds.has(to)) errors.push(`steps: navigate.to "${to}" is not a declared pages[].id`);
    referenced.add(to);
  }
  for (const id of declaredIds) {
    if (!referenced.has(id)) errors.push(`pages: declared page "${id}" is not referenced by any navigate step`);
  }

  if (input.businessKey !== undefined) {
    if (!isPlainObject(input.businessKey)) {
      errors.push('businessKey: must be { "read": ... }');
    } else {
      const type = validateEnvelopeReadSpec(input.businessKey.read, 'businessKey.read', errors);
      if (type !== null && type !== 'scalar') {
        errors.push('businessKey.read: must be a scalar read (the business instance identifier is a string)');
      }
    }
  }
  return { errors, inputDefs };
}

export type ImportDraft = Pick<Flow, 'name' | 'site' | 'page' | 'pages' | 'trigger' | 'steps'> & {
  inputs?: InputDefinition[];
  budget?: Partial<StepBudget>;
  businessKey?: { read: ReadSpec };
};

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  flow?: Flow;
  draft?: ImportDraft;
}

// mode 'import' validates external flow files; envelope fields (id/status/provenance) are ignored there
// — the background rewrites them so external files can never inject an enabled state (DEC-015).
// mode 'full' additionally validates the stored-flow envelope.
export function validateFlow(input: unknown, mode: 'full' | 'import' = 'full'): ValidateResult {
  if (!isPlainObject(input)) return { ok: false, errors: [t('err.notObject')] };

  if (input.schemaVersion !== SCHEMA_VERSION) {
    const found =
      input.schemaVersion === undefined ? t('err.schemaVersionMissing') : String(input.schemaVersion);
    return {
      ok: false,
      errors: [t('err.schemaVersion', { expected: SCHEMA_VERSION, found })],
    };
  }

  const errors: string[] = [];

  if (mode === 'full') {
    if (typeof input.id !== 'string' || input.id.length === 0) errors.push(t('err.idRequired'));
    if (typeof input.status !== 'string' || !['draft', 'enabled', 'paused'].includes(input.status)) {
      errors.push(t('err.statusInvalid'));
    }
    if (
      !isPlainObject(input.provenance) ||
      input.provenance.source !== 'import' ||
      typeof input.provenance.createdAt !== 'number' ||
      typeof input.provenance.updatedAt !== 'number'
    ) {
      errors.push(t('err.provenanceInvalid'));
    }
  }

  const coreResult = coreErrors(input);
  errors.push(...coreResult.errors);
  if (errors.length > 0) return { ok: false, errors };

  const core: ImportDraft = {
    name: input.name as string,
    site: input.site as string,
    page: input.page as PageFingerprint,
    ...(Array.isArray(input.pages) ? { pages: input.pages as DeclaredPage[] } : {}),
    trigger: input.trigger as FlowTrigger,
    steps: input.steps as StepNode,
    ...(coreResult.inputDefs.length > 0 ? { inputs: coreResult.inputDefs } : {}),
    ...(isPlainObject(input.budget) ? { budget: input.budget as Partial<StepBudget> } : {}),
    ...(isPlainObject(input.businessKey) ? { businessKey: input.businessKey as { read: ReadSpec } } : {}),
  };
  if (mode === 'import') return { ok: true, errors: [], draft: core };
  return {
    ok: true,
    errors: [],
    flow: {
      schemaVersion: SCHEMA_VERSION,
      id: input.id as string,
      status: input.status as Flow['status'],
      provenance: input.provenance as FlowProvenance,
      ...core,
    },
  };
}

// Envelope for a freshly imported flow: import always lands as draft (DEC-015)
export function buildImportedFlow(draft: ImportDraft, now = Date.now()): Flow {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: deriveFlowId(),
    ...draft,
    status: 'draft',
    provenance: { source: 'import', importedAt: now, createdAt: now, updatedAt: now },
  };
}

export function describeTrigger(flow: Pick<Flow, 'trigger'>): string {
  if (flow.trigger.kind === 'pageEnter') return t('desc.trigger.pageEnter');
  const field = flow.trigger.field.displayLabel;
  if (flow.trigger.condition.kind === 'codeEquals') {
    return t('desc.trigger.codeEquals', { field, code: flow.trigger.condition.code });
  }
  return t('desc.trigger.fieldChange', { field });
}

export function describePage(flow: Pick<Flow, 'page'>): string {
  const contentCount = flow.page.contentIncludes?.length ?? 0;
  return contentCount > 0
    ? t('desc.pageWithContent', { url: flow.page.urlIncludes, count: contentCount })
    : t('desc.page', { url: flow.page.urlIncludes });
}

// Entry page plus the declared continuation pages, one shared rendering for the import summary,
// the native-channel summary, the sync version preview and the editor detail.
export function describePages(flow: Pick<Flow, 'page' | 'pages'>): string {
  const pages = flow.pages ?? [];
  if (pages.length === 0) return describePage(flow);
  const sep = getLocale() === 'zh' ? '；' : '; ';
  const list = pages
    .map((entry) => `${entry.id} (${describePage({ page: entry.page })})`)
    .join(sep);
  return t('desc.pages', { entry: describePage(flow), count: pages.length, list });
}

export function describeFlow(flow: Flow): string {
  const sep = getLocale() === 'zh' ? '；' : '; ';
  const steps = describeSteps(flow.steps).map((s) => s.text).join(sep);
  return `${describeTrigger(flow)} → ${steps}`;
}
