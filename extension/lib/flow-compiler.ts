// Steps compiler: turns a validated step tree into an XState v5 machine
// (DEC-self-service-browser-automation-019). The machine owns the control flow — read/action/wait are
// `invoke` + fromPromise actors over a whitelist driver, `if`/`assert` are pure guards over context
// data, and `foreach` is the explicit take-item → body → increment → check structure. Nothing wraps
// the whole tree in one promise: every node is its own state, so cancellation and failure carry the
// exact node/loop position (runId wiring lands with the P3 runtime host).
//
// Anchors: every node state has id `n_<nodeId>`; loop-iterate states `y_<nodeId>`, branch joins
// `z_<nodeId>` and the terminals `__completed` / `__failed` use prefixes that cannot collide with the
// node-id charset. The driver is the only place that touches the DOM (fake driver in unit tests, the
// DOM driver in P2); it receives an AbortSignal so stopping the actor stops polling and pending side
// effects.
import { assign, createActor, createMachine, fromPromise } from 'xstate';
import {
  INPUTS_REF_PREFIX,
  MAX_STEP_NODES,
  countStepNodes,
  describePredicate,
  resolveStepBudget,
  type ActionSpec,
  type Predicate,
  type ReadSpec,
  type WaitCondition,
  type StepBudget,
  type StepNode,
  type StepValue,
} from './step-schema';

// Engine hard cap on total executed actor nodes per run (read/action/wait/navigate); flows cannot
// raise it.
export const MAX_EXECUTED_STEP_NODES = 2000;

export type DriverStage = 'read' | 'action' | 'wait' | 'navigate' | 'budget';

// Structured failure carried into onError and surfaced in run results and logs.
export class DriverFailure extends Error {
  constructor(
    public readonly stage: DriverStage,
    public readonly reason: string,
    public readonly detail?: string,
  ) {
    super(`${stage}:${reason}`);
    this.name = 'DriverFailure';
  }
}

// The current loop-item bindings the driver may use for scoped location (e.g. "within the active
// packing group"). Values only — the compiler owns all control state.
export interface DriverScope {
  trigger: string;
  items: Record<string, unknown>;
}

export type ReadOutcome = { ok: true; value: unknown } | { ok: false; reason: 'missing' | 'ambiguous' | 'unreadable' };

export type ActOutcome = 'ok' | 'missing' | 'ambiguous' | 'not-writable' | 'disabled';

export type WaitOutcome = { outcome: 'satisfied'; value?: unknown } | { outcome: 'timeout' };

// What a navigate node hands to the host's handover capability: the declared target page, the node
// to resume after, the readiness deadline and the full current context (the payload the next
// document resumes from). The host owns staging, claiming and resuming — the compiler only awaits.
export interface HandoverRequest {
  to: string;
  resumeAfter: string;
  timeoutMs: number;
  context: FlowContext;
}

// The whitelist driver seam: fake in unit tests, DOM-backed in P2. Every call re-locates its target;
// missing/ambiguous are reported, never guessed. `evaluate` (readMatches waits) is supplied by the
// compiler so predicate semantics stay in one place. `handover` is optional: a driver without it
// fails navigate nodes as unsupported (fake drivers in older tests, hosts without the cross-page
// capability).
export interface FlowDriver {
  read(spec: ReadSpec, scope: DriverScope, signal: AbortSignal): Promise<ReadOutcome>;
  act(
    spec: ActionSpec,
    value: string | undefined,
    scope: DriverScope,
    signal: AbortSignal,
  ): Promise<ActOutcome>;
  waitUntil(
    cond: WaitCondition,
    timeoutMs: number,
    scope: DriverScope,
    evaluate: (value: unknown) => boolean,
    signal: AbortSignal,
  ): Promise<WaitOutcome>;
  handover?(req: HandoverRequest, signal: AbortSignal): Promise<void>;
}

export interface FlowRunInput {
  steps: StepNode;
  trigger?: string;
  // Run-start input snapshot (form-support): a private copy for this one run — later saves are not
  // visible here, so every step of the run resolves the same values. Never written to logs or storage.
  inputs?: Record<string, unknown>;
  budget?: Partial<StepBudget>;
  // Host-side observability only (never serialized into flows): the runtime (P2+) uses it to log
  // per-node progress with loop position. Emitted from actions in document/execution order.
  hooks?: FlowHooks;
}

// Cross-page resume: replace the initial context with the staged one and enter the machine at the
// statically computed successor of `afterNodeId`. No XState snapshot is involved — the staged
// context IS the whole serializable run state, and re-entering the compiled machine keeps the
// resumed run on the same validated code path as a fresh start.
export interface FlowResume {
  afterNodeId: string;
  context: FlowContext;
}

export interface StepNodeEvent {
  phase: 'start' | 'ok';
  nodeId: string;
  kind: 'read' | 'action' | 'wait' | 'navigate';
  iterationPath: string;
  executed: number;
}

export interface FlowHooks {
  onNode?: (event: StepNodeEvent) => void;
}

interface LoopState {
  index: number;
  total: number;
}

export interface FlowContext {
  trigger: string;
  inputs: Record<string, unknown>;
  vars: Record<string, unknown>;
  itemVars: Record<string, unknown>;
  loops: Record<string, LoopState>;
  loopValues: Record<string, unknown[]>;
  iterationPath: string;
  executed: number;
  startedAt: number;
  budget: StepBudget;
  // Declared continuation page the run currently sits on (undefined = entry page). Set when a
  // handover is staged, carried into the resumed context, stamped on failures (page-located
  // visibility) — never part of the flow file itself.
  pageId?: string;
  failure?: { nodeId: string; stage: DriverStage; reason: string; detail?: string; iterationPath: string; pageId?: string };
}

// The run has left this document for a declared page: not a terminal report — the run continues in
// another document. The settling host cleans up (highlight, activeRun) without reporting a result.
export type FlowOutcome = 'completed' | 'failed' | 'cancelled' | 'handed-over';

export interface FlowRunResult {
  outcome: FlowOutcome;
  failure?: FlowContext['failure'];
  vars: Record<string, unknown>;
  executed: number;
}

export interface FlowRunHandle {
  stop(): void;
  result: Promise<FlowRunResult>;
}

type Resolver = (ref: string) => unknown;

function pathInto(root: unknown, segments: string[]): unknown {
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function makeResolver(ctx: FlowContext, itemOverride?: { name: string; value: unknown }): Resolver {
  return (ref: string): unknown => {
    if (ref === 'trigger.value') return ctx.trigger;
    if (ref.startsWith(INPUTS_REF_PREFIX)) {
      const key = ref.slice(INPUTS_REF_PREFIX.length);
      return Object.prototype.hasOwnProperty.call(ctx.inputs, key) ? ctx.inputs[key] : undefined;
    }
    const base = ref.split('.')[0] ?? '';
    if (itemOverride !== undefined && base === itemOverride.name) {
      const segments = ref.split('.').slice(1);
      return segments.length === 0 ? itemOverride.value : pathInto(itemOverride.value, segments);
    }
    if (Object.prototype.hasOwnProperty.call(ctx.itemVars, base)) {
      const segments = ref.split('.').slice(1);
      return segments.length === 0 ? ctx.itemVars[base] : pathInto(ctx.itemVars[base], segments);
    }
    if (ref.startsWith('vars.')) return pathInto(ctx.vars, ref.split('.').slice(1));
    return undefined;
  };
}

function asFiniteNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : Number.NaN;
  }
  return Number.NaN;
}

export function evaluatePredicate(pred: Predicate, resolve: Resolver): boolean {
  switch (pred.kind) {
    case 'exists':
      return resolve(pred.ref) !== undefined;
    case 'boolean':
      return resolve(pred.ref) === pred.equals;
    case 'equals': {
      const v = resolve(pred.ref);
      if (typeof pred.value === 'number') return asFiniteNumber(v) === pred.value;
      return v === pred.value;
    }
    case 'numberCompare': {
      const v = asFiniteNumber(resolve(pred.ref));
      if (Number.isNaN(v)) return false;
      switch (pred.op) {
        case '>':
          return v > pred.value;
        case '>=':
          return v >= pred.value;
        case '<':
          return v < pred.value;
        case '<=':
          return v <= pred.value;
      }
      return false;
    }
    case 'nonEmpty': {
      const v = resolve(pred.ref);
      if (Array.isArray(v)) return v.length > 0;
      return typeof v === 'string' && v.length > 0;
    }
    case 'every':
    case 'some': {
      const collection = resolve(pred.ref);
      // A reference that did not resolve to a collection is not a valid member set: passing "every"
      // vacuously would invert the empty-collection flow right below (PRD §4.1)
      if (!Array.isArray(collection)) return false;
      const itemRefBase = 'item';
      const test = (member: unknown): boolean =>
        evaluatePredicate(pred.item, (ref) =>
          ref.split('.')[0] === itemRefBase
            ? ref === itemRefBase
              ? member
              : pathInto(member, ref.split('.').slice(1))
            : resolve(ref),
        );
      // "every" requires a non-empty member set — an empty collection must not pass a "each row is
      // valid" assert (PRD §4.1: 空集合不能通过「每行有效」断言)
      return pred.kind === 'every'
        ? collection.length > 0 && collection.every(test)
        : collection.some(test);
    }
    case 'and':
      return pred.parts.every((p) => evaluatePredicate(p, resolve));
    case 'or':
      return pred.parts.some((p) => evaluatePredicate(p, resolve));
    case 'not':
      return !evaluatePredicate(pred.of, resolve);
  }
}

// An optional input consumed by a value position or a checkbox ref must fail BEFORE THAT NODE's page
// action — falling through to an empty-string write or an unchecked click would act on data the user
// never provided. The check is deliberately per-node, not a run-start preflight: a guard branch
// (`if exists(inputs.x) then …`) legitimately consumes an absent optional input, and a
// path-insensitive preflight would veto that. Sibling actions earlier in the run may already have
// executed when a later node fails — mid-run abort with partial writes is the engine-wide failure
// semantic (PRD §4.1). Missing refs are surfaced as input-missing; vars/item references keep the
// legacy undefined-behaves-as-empty semantics.
function isMissingInputRef(ref: string, resolved: unknown): boolean {
  return ref.startsWith(INPUTS_REF_PREFIX) && resolved === undefined;
}

interface ResolvedAction {
  action: ActionSpec;
  value: string | undefined;
  missingRef?: string;
}

function resolveActionForRun(ctx: FlowContext, action: ActionSpec): ResolvedAction {
  let value: string | undefined;
  let missingRef: string | undefined;
  if (typeof action.value === 'string') {
    value = action.value;
  } else if (action.value !== undefined) {
    const ref = action.value.ref;
    const resolved = makeResolver(ctx)(ref);
    if (isMissingInputRef(ref, resolved)) missingRef = ref;
    else if (resolved !== undefined) value = typeof resolved === 'string' ? resolved : String(resolved);
  }
  let spec = action;
  if (action.checked !== undefined && typeof action.checked !== 'boolean') {
    const ref = action.checked.ref;
    const resolved = makeResolver(ctx)(ref);
    if (resolved === undefined) missingRef = missingRef ?? ref;
    else spec = { ...action, checked: resolved === true };
  }
  return missingRef === undefined ? { action: spec, value } : { action: spec, value, missingRef };
}

function scopeOf(ctx: FlowContext): DriverScope {
  return { trigger: ctx.trigger, items: ctx.itemVars };
}

type CtxEvent = { context: FlowContext; event: { output?: unknown; error?: unknown; [k: string]: unknown } };

const failAction = (nodeId: string) =>
  assign(({ context, event }: CtxEvent) => {
    const error = event.error;
    const stage: DriverStage = error instanceof DriverFailure ? error.stage : 'action';
    const reason = error instanceof DriverFailure ? error.reason : 'actor-error';
    const detail = error instanceof DriverFailure ? error.detail : error instanceof Error ? error.message : String(error);
    return {
      failure: {
        nodeId,
        stage,
        reason,
        detail,
        iterationPath: context.iterationPath,
        ...(context.pageId !== undefined ? { pageId: context.pageId } : {}),
      },
    } as Partial<FlowContext>;
  });

// Budget gate shared by every invoked node: total executed nodes and the wall-clock run deadline.
function budgetGuard(input: { executed: number; startedAt: number; budget: StepBudget; nodeId: string }): void {
  if (input.executed >= MAX_EXECUTED_STEP_NODES) {
    throw new DriverFailure('budget', 'executed-nodes', `${input.executed} >= ${MAX_EXECUTED_STEP_NODES}`);
  }
  if (Date.now() - input.startedAt > input.budget.runMs) {
    throw new DriverFailure('budget', 'run-time', `${Date.now() - input.startedAt}ms > ${input.budget.runMs}ms`);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the machine config is assembled recursively;
   XState's heavily generic setup() types add no safety here beyond what the validated tree provides. */

function readActor(node: Extract<StepNode, { kind: 'read' }>, driver: FlowDriver) {
  return fromPromise(async ({ input, signal }: any): Promise<unknown> => {
    const inp = input as { scope: DriverScope; executed: number; startedAt: number; budget: StepBudget };
    budgetGuard({ ...inp, nodeId: node.id });
    const res = await driver.read(node.read, inp.scope, signal);
    if (!res.ok) throw new DriverFailure('read', res.reason, node.into);
    return res.value;
  });
}

function actionActor(node: Extract<StepNode, { kind: 'action' }>, driver: FlowDriver) {
  return fromPromise(async ({ input, signal }: any): Promise<void> => {
    const inp = input as {
      scope: DriverScope;
      value: string | undefined;
      action: ActionSpec;
      missingRef?: string;
      executed: number;
      startedAt: number;
      budget: StepBudget;
    };
    if (inp.missingRef !== undefined) throw new DriverFailure('action', 'input-missing', inp.missingRef);
    budgetGuard({ ...inp, nodeId: node.id });
    const res = await driver.act(inp.action, inp.value, inp.scope, signal);
    if (res === 'ok') return;
    if (res === 'disabled') throw new DriverFailure('action', 'button-disabled', inp.action.target.displayLabel);
    throw new DriverFailure('action', res, inp.action.target.displayLabel);
  });
}

function waitActor(node: Extract<StepNode, { kind: 'wait' }>, driver: FlowDriver) {
  return fromPromise(async ({ input, signal }: any): Promise<{ value?: unknown }> => {
    const inp = input as {
      scope: DriverScope;
      executed: number;
      startedAt: number;
      budget: StepBudget;
      evaluate: (value: unknown) => boolean;
    };
    budgetGuard({ ...inp, nodeId: node.id });
    const res = await driver.waitUntil(node.until, node.timeoutMs, inp.scope, inp.evaluate, signal);
    if (res.outcome === 'timeout') throw new DriverFailure('wait', 'timeout', `${node.timeoutMs}ms`);
    return { value: res.value };
  });
}

function navigateActor(node: Extract<StepNode, { kind: 'navigate' }>, driver: FlowDriver) {
  return fromPromise(async ({ input, signal }: any): Promise<void> => {
    const inp = input as { context: FlowContext; executed: number; startedAt: number; budget: StepBudget };
    budgetGuard({ ...inp, nodeId: node.id });
    if (driver.handover === undefined) throw new DriverFailure('navigate', 'unsupported', node.to);
    // The handover decorator stamps pageId = node.to on its private staged copy, so failures on the
    // next page attribute there — while a timeout HERE still carries this document's pageId.
    await driver.handover(
      { to: node.to, resumeAfter: node.id, timeoutMs: node.timeoutMs, context: inp.context },
      signal,
    );
  });
}

const invokeInput = (extra?: (ctx: FlowContext) => Record<string, unknown>) =>
  ({ context }: { context: FlowContext }): Record<string, unknown> => ({
    scope: scopeOf(context),
    executed: context.executed,
    startedAt: context.startedAt,
    budget: context.budget,
    ...extra?.(context),
  });

function stateOf(
  node: StepNode,
  next: string,
  driver: FlowDriver,
  budget: StepBudget,
  hooks?: FlowHooks,
  entryPath?: readonly string[],
): Record<string, any> {
  const nextTarget = next ?? '#__completed';
  const emitStart =
    (kind: 'read' | 'action' | 'wait' | 'navigate') =>
    ({ context }: { context: FlowContext }): void => {
      hooks?.onNode?.({ phase: 'start', nodeId: node.id, kind, iterationPath: context.iterationPath, executed: context.executed });
    };
  const emitOk =
    (kind: 'read' | 'action' | 'wait' | 'navigate') =>
    ({ context }: { context: FlowContext }): void => {
      hooks?.onNode?.({ phase: 'ok', nodeId: node.id, kind, iterationPath: context.iterationPath, executed: context.executed });
    };
  switch (node.kind) {
    case 'sequence':
      return { id: `n_${node.id}`, ...seqConfig(node.steps, nextTarget, driver, budget, hooks, entryPath) };

    case 'read':
      return {
        id: `n_${node.id}`,
        entry: emitStart('read'),
        invoke: {
          src: readActor(node, driver),
          input: invokeInput(),
          onDone: {
            target: nextTarget,
            actions: [
              assign(({ context, event }: CtxEvent) => ({
                vars: { ...context.vars, [node.into]: event.output },
                executed: context.executed + 1,
              }) as Partial<FlowContext>),
              emitOk('read'),
            ],
          },
          onError: { target: '#__failed', actions: failAction(node.id) },
        },
      };

    case 'action':
      return {
        id: `n_${node.id}`,
        entry: emitStart('action'),
        invoke: {
          src: actionActor(node, driver),
          input: invokeInput((ctx) => {
            const resolved = resolveActionForRun(ctx, node.action);
            return {
              action: resolved.action,
              value: resolved.value,
              ...(resolved.missingRef !== undefined ? { missingRef: resolved.missingRef } : {}),
            };
          }),
          onDone: {
            target: nextTarget,
            actions: [
              assign(({ context }: CtxEvent) => ({
                executed: context.executed + 1,
              }) as Partial<FlowContext>),
              emitOk('action'),
            ],
          },
          onError: { target: '#__failed', actions: failAction(node.id) },
        },
      };

    case 'wait': {
      const until = node.until;
      return {
        id: `n_${node.id}`,
        entry: emitStart('wait'),
        invoke: {
          src: waitActor(node, driver),
          input: invokeInput((ctx) => ({
            evaluate:
              until.kind === 'readMatches'
                ? (value: unknown) =>
                    evaluatePredicate(
                      until.when,
                      makeResolver({ ...ctx, vars: { ...ctx.vars, [until.into]: value } }),
                    )
                : () => true,
          })),
          onDone: {
            target: nextTarget,
            actions: [
              assign(({ context, event }: CtxEvent) => {
                const patch: Partial<FlowContext> = {
                  executed: context.executed + 1,
                };
                if (until.kind === 'readMatches') {
                  patch.vars = { ...context.vars, [until.into]: (event.output as { value?: unknown } | undefined)?.value };
                }
                return patch;
              }),
              emitOk('wait'),
            ],
          },
          onError: { target: '#__failed', actions: failAction(node.id) },
        },
      };
    }

    case 'assert':
      return {
        id: `n_${node.id}`,
        initial: 'check',
        states: {
          check: {
            always: [
              {
                guard: ({ context }: { context: FlowContext }) =>
                  evaluatePredicate(node.check, makeResolver(context)),
                target: nextTarget,
              },
              { target: `f_${node.id}` },
            ],
          },
          [`f_${node.id}`]: {
            entry: assign(({ context }: CtxEvent) => ({
              failure: {
                nodeId: node.id,
                stage: 'action' as DriverStage,
                reason: `assert-failed: ${describePredicate(node.check)}`,
                iterationPath: context.iterationPath,
                ...(context.pageId !== undefined ? { pageId: context.pageId } : {}),
              },
            }) as Partial<FlowContext>),
            always: { target: '#__failed' },
          },
        },
      };

    case 'navigate':
      return {
        id: `n_${node.id}`,
        entry: emitStart('navigate'),
        invoke: {
          src: navigateActor(node, driver),
          // The staged copy must already count this navigate: the source machine's own executed+1
          // assign runs only after the claim resolves, on a context the handed-over run discards —
          // without the bump here every handover undercounts the cross-page total by one
          input: invokeInput((ctx) => ({ context: { ...ctx, executed: ctx.executed + 1 } })),
          onDone: {
            // The handover was claimed elsewhere — this document's part in the run ends without a
            // report; the claiming document resumes at this node's successor.
            target: '#__handedOver',
            actions: [
              assign(({ context }: CtxEvent) => ({
                executed: context.executed + 1,
              }) as Partial<FlowContext>),
              emitOk('navigate'),
            ],
          },
          onError: { target: '#__failed', actions: failAction(node.id) },
        },
      };

    case 'if': {
      const states: Record<string, any> = {
        check: {
          always: [
            { guard: ({ context }: { context: FlowContext }) => evaluatePredicate(node.when, makeResolver(context)), target: 'then' },
            ...(node.else !== undefined ? [{ target: 'else' }] : []),
            { target: nextTarget },
          ],
        },
        then: {
          id: `n_${node.id}__then`,
          ...seqConfig(node.then, `#z_${node.id}`, driver, budget, hooks, enterChild(entryPath, 'then')),
        },
        [`z_${node.id}`]: { id: `z_${node.id}`, always: { target: nextTarget } },
      };
      if (node.else !== undefined) {
        states.else = {
          id: `n_${node.id}__else`,
          ...seqConfig(node.else, `#z_${node.id}`, driver, budget, hooks, enterChild(entryPath, 'else')),
        };
      }
      return { id: `n_${node.id}`, initial: entryPath?.[0] ?? 'check', states };
    }

    case 'foreach': {
      // A loop without its own ceiling is bounded by the declared per-run loop budget —
      // resolveStepBudget always produces a value (the engine cap when undeclared), so the
      // fallback can never be unbounded
      const maxIterations = node.maxIterations ?? budget.loopItems;
      const loopOf = (ctx: FlowContext): LoopState | undefined => ctx.loops[node.id];
      const valuesOf = (ctx: FlowContext): unknown[] => ctx.loopValues[node.id] ?? [];
      const failState = (stage: DriverStage, reason: string, detail: (ctx: FlowContext) => string) => ({
        entry: assign(({ context }: CtxEvent) => ({
          failure: {
            nodeId: node.id,
            stage,
            reason,
            detail: detail(context),
            iterationPath: context.iterationPath,
            ...(context.pageId !== undefined ? { pageId: context.pageId } : {}),
          },
        }) as Partial<FlowContext>),
        always: { target: '#__failed' },
      });
      return {
        id: `n_${node.id}`,
        initial: entryPath?.[0] ?? 'init',
        states: {
          init: {
            entry: assign(({ context }: CtxEvent) => {
              const over = makeResolver(context)(node.over);
              const items = Array.isArray(over) ? over : [];
              return {
                loops: { ...context.loops, [node.id]: { index: -1, total: items.length } },
                loopValues: { ...context.loopValues, [node.id]: items },
              } as Partial<FlowContext>;
            }),
            always: [
              // A non-array `over` cannot be iterated — stop instead of guessing (PRD §4.2). An
              // optional input absent at run start is a data gap, not an empty collection: the fail
              // state below separates the two reasons without a second guard
              {
                guard: ({ context }: { context: FlowContext }) => !Array.isArray(makeResolver(context)(node.over)),
                target: `f_${node.id}`,
              },
              {
                guard: ({ context }: { context: FlowContext }) => (loopOf(context)?.total ?? 0) > maxIterations,
                target: `b_${node.id}`,
              },
              { target: 'check' },
            ],
          },
          [`f_${node.id}`]: {
            entry: assign(({ context }: CtxEvent) => ({
              failure: {
                nodeId: node.id,
                stage: 'read' as DriverStage,
                reason: isMissingInputRef(node.over, makeResolver(context)(node.over))
                  ? 'input-missing'
                  : 'foreach-over-not-a-collection',
                detail: node.over,
                iterationPath: context.iterationPath,
                ...(context.pageId !== undefined ? { pageId: context.pageId } : {}),
              },
            }) as Partial<FlowContext>),
            always: { target: '#__failed' },
          },
          [`b_${node.id}`]: failState('budget', 'loop-items', (ctx) => `${loopOf(ctx)?.total ?? 0} > ${maxIterations}`),
          check: {
            always: [
              {
                guard: ({ context }: { context: FlowContext }) => {
                  const loop = loopOf(context);
                  return (loop?.index ?? -1) + 1 < (loop?.total ?? 0);
                },
                target: 'advance',
              },
              { target: nextTarget },
            ],
          },
          // advance and body are separate so a cross-page resume can enter `body` directly with the
          // staged bindings (index, itemVars, iterationPath) without re-advancing the loop — the
          // normal flow check→advance→body→y→check is unchanged
          advance: {
            entry: assign(({ context }: CtxEvent) => {
              const loop = loopOf(context);
              const index = (loop?.index ?? -1) + 1;
              return {
                loops: { ...context.loops, [node.id]: { index, total: loop?.total ?? 0 } },
                itemVars: { ...context.itemVars, [node.itemVar]: valuesOf(context)[index] },
                iterationPath: `${context.iterationPath}[${index}]`,
              } as Partial<FlowContext>;
            }),
            always: { target: 'body' },
          },
          body: {
            ...seqConfig(node.do, `#y_${node.id}`, driver, budget, hooks, enterChild(entryPath, 'body')),
          },
          [`y_${node.id}`]: {
            id: `y_${node.id}`,
            entry: assign(({ context }: CtxEvent) => ({
              iterationPath: context.iterationPath.replace(/\[\d+\]$/, ''),
            }) as Partial<FlowContext>),
            always: { target: 'check' },
          },
        },
      };
    }
  }
}

// Remaining entry path for the child whose config key is `key`, when a resume enters through it.
function enterChild(entryPath: readonly string[] | undefined, key: string): readonly string[] | undefined {
  return entryPath !== undefined && entryPath[0] === key ? entryPath.slice(1) : undefined;
}

// Children of a node list, chained left to right; the last child continues at `next` (an anchor).
// `entryPath` (resume only) names the child key to enter instead of the first child.
function seqConfig(
  nodes: StepNode[],
  next: string,
  driver: FlowDriver,
  budget: StepBudget,
  hooks?: FlowHooks,
  entryPath?: readonly string[],
): { initial: string; states: Record<string, any> } {
  const states: Record<string, any> = {};
  nodes.forEach((node, i) => {
    const nextNode = i + 1 < nodes.length ? nodes[i + 1] : undefined;
    const nextAnchor = nextNode !== undefined ? `#n_${nextNode.id}` : next;
    states[node.id] = stateOf(node, nextAnchor, driver, budget, hooks, enterChild(entryPath, node.id));
  });
  const first = nodes[0];
  if (first === undefined) throw new Error('steps node list must not be empty');
  const entry = entryPath?.[0];
  return { initial: entry !== undefined && states[entry] !== undefined ? entry : first.id, states };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// State-key path (relative to the root steps state, exclusive of 'run') where a resumed machine
// should start so it continues right after `afterNodeId` — the successor sibling, the container's
// join anchor (if-branch tail → z_<id>, foreach body tail → y_<id>), or __completed when the node
// ends the whole tree. null = the node is not in the tree. Entering y_/z_ directly is safe: their
// entry actions (iterationPath pop, unconditional hop) are idempotent on staged context values.
export function resumePathAfter(steps: StepNode, afterNodeId: string): string[] | null {
  if (steps.id === afterNodeId) return ['__completed'];
  // One child list, left to right: the hit child — or a sub-scan that ran to its end, meaning the
  // child container finished and normal flow would continue after it — lands on the next sibling,
  // or the list's end anchor when there is none; a deeper hit is relative to the child's own
  // config, which sits under this list's child key ('then'/'else'/'body').
  const scanList = (
    nodes: StepNode[],
    prefix: readonly string[],
    end: string[] | 'END',
  ): string[] | 'END' | null => {
    const landed = (i: number): string[] | 'END' => {
      const next = nodes[i + 1];
      return next !== undefined ? [...prefix, next.id] : end;
    };
    for (let i = 0; i < nodes.length; i++) {
      const child = nodes[i]!;
      if (child.id === afterNodeId) return landed(i);
      const sub = scan(child);
      if (sub === null) continue;
      if (sub === 'END') return landed(i);
      return [...prefix, child.id, ...sub];
    }
    return null;
  };
  const scan = (node: StepNode): string[] | 'END' | null => {
    switch (node.kind) {
      case 'sequence':
        return scanList(node.steps, [], 'END');
      case 'if': {
        const branches: [string, StepNode[]][] =
          node.else !== undefined
            ? [['then', node.then], ['else', node.else]]
            : [['then', node.then]];
        for (const [key, nodes] of branches) {
          const res = scanList(nodes, [key], [`z_${node.id}`]);
          if (res !== null) return res;
        }
        return null;
      }
      case 'foreach':
        return scanList(node.do, ['body'], [`y_${node.id}`]);
      default:
        return null;
    }
  };
  const res = scan(steps);
  if (res === null) return null;
  return res === 'END' ? ['__completed'] : res;
}

export function compileFlowMachine(input: FlowRunInput, driver: FlowDriver, resume?: FlowResume) {
  const budget = resolveStepBudget(input.budget);
  // A resumed run replaces the whole initial context with the staged one (budget included —
  // executed counts and the run deadline accumulate across pages) and enters at the navigate
  // successor instead of the tree root.
  const context: FlowContext =
    resume !== undefined
      ? structuredClone(resume.context)
      : {
          trigger: input.trigger ?? '',
          // Private deep copy: a later save cannot leak into the running flow
          inputs: input.inputs === undefined ? {} : structuredClone(input.inputs),
          vars: {},
          itemVars: {},
          loops: {},
          loopValues: {},
          iterationPath: '',
          executed: 0,
          startedAt: Date.now(),
          budget,
        };
  // The step tree must have cleared validateSteps before reaching the compiler; the node count
  // re-check keeps the compiled machine within its structural budget even on internal callers.
  if (countStepNodes(input.steps) > MAX_STEP_NODES) {
    throw new Error('steps exceed the node budget');
  }
  let entryPath: readonly string[] | undefined;
  let rootInitial = 'run';
  if (resume !== undefined) {
    const path = resumePathAfter(input.steps, resume.afterNodeId);
    if (path === null) throw new Error(`resume node "${resume.afterNodeId}" not found in steps`);
    if (path[0] === '__completed') rootInitial = '__completed';
    else entryPath = path;
  }
  return createMachine({
    id: 'steps',
    initial: rootInitial,
    context,
    states: {
      run: stateOf(input.steps, '#__completed', driver, budget, input.hooks, entryPath),
      __completed: { id: '__completed', type: 'final' },
      __failed: { id: '__failed', type: 'final' },
      __handedOver: { id: '__handedOver', type: 'final' },
    },
  });
}

// Start a run and settle when the machine reaches a terminal state (or is stopped). The actor handle
// stays exposed so hosts can subscribe to progress / stop on navigation away (P3).
export function runFlow(input: FlowRunInput, driver: FlowDriver, resume?: FlowResume): FlowRunHandle {
  const machine = compileFlowMachine(input, driver, resume);
  const actor = createActor(machine);
  let settled = false;
  let settleResult: ((r: FlowRunResult) => void) | undefined;
  const settle = (r: FlowRunResult): void => {
    if (settled) return;
    settled = true;
    settleResult?.(r);
  };
  const result = new Promise<FlowRunResult>((resolve) => {
    settleResult = resolve;
    actor.subscribe((snapshot) => {
      if (snapshot.status === 'done') {
        const ctx = snapshot.context as FlowContext;
        if (snapshot.matches('__failed')) {
          settle({ outcome: 'failed', failure: ctx.failure, vars: ctx.vars, executed: ctx.executed });
        } else if (snapshot.matches('__handedOver')) {
          settle({ outcome: 'handed-over', vars: ctx.vars, executed: ctx.executed });
        } else {
          settle({ outcome: 'completed', vars: ctx.vars, executed: ctx.executed });
        }
      } else if (snapshot.status === 'error') {
        const ctx = snapshot.context as FlowContext;
        settle({
          outcome: 'failed',
          failure: ctx.failure ?? { nodeId: '', stage: 'action', reason: 'machine-error', iterationPath: '' },
          vars: ctx.vars,
          executed: ctx.executed,
        });
      }
    });
    actor.start();
  });
  return {
    stop: () => {
      const ctx = actor.getSnapshot().context as FlowContext;
      actor.stop();
      // Stopped actors may not emit a final snapshot to subscribers — settle cancellation here so
      // hosts awaiting the result never hang
      settle({ outcome: 'cancelled', vars: ctx.vars, executed: ctx.executed });
    },
    result,
  };
}
