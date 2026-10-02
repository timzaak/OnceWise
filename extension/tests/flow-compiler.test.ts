// Steps compiler execution semantics over a fake driver (DEC-019). These tests pin the BUSINESS
// outcomes the machine must produce: runtime branches follow read results, waits may start from a
// missing target and never treat a timeout as success, asserts stop before any save, loops visit
// every member exactly once, budgets stop with a reason, and stopping the actor prevents any further
// side effects (PRD §5.1 / §8 acceptance matrix).
import { describe, expect, it } from 'vitest';
import {
  DriverFailure,
  evaluatePredicate,
  runFlow,
  type ActOutcome,
  type ReadOutcome,
  type WaitOutcome,
  type FlowDriver,
} from '@/lib/flow-compiler';
import type { ActionSpec, FieldRef, ReadSpec, WaitCondition, StepNode } from '@/lib/step-schema';

const field = (id: string, label = id): FieldRef => ({ clues: { id }, componentType: 'input', displayLabel: label });
const button = (id: string, label: string): FieldRef => ({ clues: { id }, componentType: 'button', displayLabel: label });

interface ScriptedDriverOptions {
  reads?: Record<string, unknown>;
  readOutcomes?: Record<string, 'missing' | 'ambiguous' | 'unreadable'>;
  actOutcomes?: Record<string, ActOutcome>;
  actDelayMs?: number;
  waits?: Record<string, 'satisfied' | 'timeout'>;
  hangOnWaitId?: string;
}

// Deterministic driver: reads are keyed by the target clue id, acts append to `calls` keyed by
// target id (with the resolved value), waits resolve from a script or hang forever (cancellation
// tests) while honoring the abort signal.
function scriptedDriver(opts: ScriptedDriverOptions = {}): FlowDriver & { calls: string[] } {
  const calls: string[] = [];
  const readKey = (spec: ReadSpec): string =>
    spec.kind === 'rows'
      ? spec.table.clues.id ?? spec.table.displayLabel
      : (spec as { target: FieldRef }).target.clues.id ?? (spec as { target: FieldRef }).target.displayLabel;
  const waitKey = (cond: WaitCondition): string =>
    cond.kind === 'readMatches'
      ? (cond.read as { target?: FieldRef }).target?.clues.id ?? 'readMatches'
      : cond.target.clues.id ?? cond.target.displayLabel;
  return {
    calls,
    async read(spec): Promise<ReadOutcome> {
      calls.push(`read:${readKey(spec)}`);
      const outcome = opts.readOutcomes?.[readKey(spec)];
      if (outcome) return { ok: false, reason: outcome };
      const value = opts.reads?.[readKey(spec)];
      return { ok: true, value };
    },
    async act(spec: ActionSpec, value): Promise<ActOutcome> {
      const targetId = spec.target.clues.id ?? spec.target.displayLabel;
      if (opts.actDelayMs) await new Promise((r) => setTimeout(r, opts.actDelayMs));
      calls.push(`act:${targetId}:${value ?? ''}`);
      return opts.actOutcomes?.[targetId] ?? 'ok';
    },
    async waitUntil(cond, _timeoutMs, _scope, evaluate, signal): Promise<WaitOutcome> {
      const key = waitKey(cond);
      calls.push(`wait:${key}`);
      if (opts.hangOnWaitId === key) {
        return new Promise<WaitOutcome>((resolve) => {
          signal.addEventListener('abort', () => resolve({ outcome: 'satisfied' }));
        });
      }
      if (opts.waits?.[key] === 'timeout') return { outcome: 'timeout' };
      if (cond.kind === 'readMatches') {
        const value = opts.reads?.[key];
        return { outcome: evaluate(value) ? 'satisfied' : 'timeout', value };
      }
      return { outcome: 'satisfied' };
    },
  };
}

const readGroups = (into = 'groups'): StepNode => ({
  id: 'read-groups',
  kind: 'read',
  read: { kind: 'collection', target: button('tabs', '包装组') },
  into,
});

const readRows = (into = 'rows'): StepNode => ({
  id: 'read-rows',
  kind: 'read',
  read: { kind: 'rows', table: field('packingTable', '装箱表'), columns: ['weight', 'length'] },
  into,
});

describe('runtime branching follows read results (P1 completion condition)', () => {
  const steps: StepNode = {
    id: 'root',
    kind: 'sequence',
    steps: [
      { id: 'read-edited', kind: 'read', read: { kind: 'boolean', target: field('editState', '编辑态') }, into: 'edited' },
      {
        id: 'branch',
        kind: 'if',
        when: { kind: 'boolean', ref: 'vars.edited', equals: true },
        then: [{ id: 'skip-edit', kind: 'action', action: { type: 'clickButton', target: button('none-1', '不应点击') } }],
        else: [{ id: 'click-edit', kind: 'action', action: { type: 'clickButton', target: button('editBtn', '编 辑') } }],
      },
    ],
  };

  it('edited=true takes the then branch and never clicks 编辑', async () => {
    const driver = scriptedDriver({ reads: { editState: true } });
    const res = await runFlow({ steps }, driver).result;
    expect(res.outcome).toBe('completed');
    expect(driver.calls).toContain('read:editState');
    expect(driver.calls).toContain('act:none-1:');
    expect(driver.calls).not.toContain('act:editBtn:');
    expect(res.vars.edited).toBe(true);
  });

  it('edited=false takes the else branch (the same compiled machine, different page state)', async () => {
    const driver = scriptedDriver({ reads: { editState: false } });
    const res = await runFlow({ steps }, driver).result;
    expect(res.outcome).toBe('completed');
    expect(driver.calls).toContain('act:editBtn:');
    expect(driver.calls).not.toContain('act:none-1:');
  });
});

describe('wait semantics', () => {
  it('a satisfied wait continues to later actions; missing-then-present is the driver poll\'s job', async () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'w', kind: 'wait', timeoutMs: 5_000, until: { kind: 'elementPresent', target: button('preview', '货件预览') } },
        { id: 'confirm', kind: 'action', action: { type: 'clickButton', target: button('confirmBtn', '确定并装箱') } },
      ],
    };
    const driver = scriptedDriver({ waits: { preview: 'satisfied' } });
    const res = await runFlow({ steps }, driver).result;
    expect(res.outcome).toBe('completed');
    expect(driver.calls).toEqual(['wait:preview', 'act:confirmBtn:']);
  });

  it('a wait timeout fails with the node id and never runs the following action', async () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'save-wait', kind: 'wait', timeoutMs: 5_000, until: { kind: 'elementAbsent', target: button('saveBtn', '保 存') } },
        { id: 'confirm', kind: 'action', action: { type: 'clickButton', target: button('confirmBtn', '确定并装箱') } },
      ],
    };
    const driver = scriptedDriver({ waits: { saveBtn: 'timeout' } });
    const res = await runFlow({ steps }, driver).result;
    expect(res.outcome).toBe('failed');
    expect(res.failure?.stage).toBe('wait');
    expect(res.failure?.reason).toBe('timeout');
    expect(res.failure?.nodeId).toBe('save-wait');
    expect(driver.calls).not.toContain('act:confirmBtn:');
  });

  it('readMatches waits store the polled value into the slot on success', async () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'stable',
          kind: 'wait',
          timeoutMs: 5_000,
          until: {
            kind: 'readMatches',
            read: { kind: 'scalar', target: field('phone') },
            into: 'phone',
            when: { kind: 'numberCompare', ref: 'vars.phone', op: '>', value: 0 },
          },
        },
      ],
    };
    const driver = scriptedDriver({ reads: { phone: '42' } });
    const res = await runFlow({ steps }, driver).result;
    expect(res.outcome).toBe('completed');
    expect(res.vars.phone).toBe('42');
  });
});

describe('assert semantics (invalid packing data never reaches the save click)', () => {
  const stepsFor = (): StepNode => ({
    id: 'root',
    kind: 'sequence',
    steps: [
      readRows(),
      {
        id: 'assert-rows',
        kind: 'assert',
        check: {
          kind: 'every',
          ref: 'vars.rows',
          item: {
            kind: 'and',
            parts: [
              { kind: 'numberCompare', ref: 'item.weight', op: '>', value: 0 },
              { kind: 'numberCompare', ref: 'item.length', op: '>', value: 0 },
            ],
          },
        },
      },
      { id: 'save', kind: 'action', action: { type: 'clickButton', target: button('saveBtn', '保 存') } },
    ],
  });

  it('valid rows pass the assert and the save executes once', async () => {
    const driver = scriptedDriver({ reads: { packingTable: [{ weight: '6.55', length: '78' }] } });
    const res = await runFlow({ steps: stepsFor() }, driver).result;
    expect(res.outcome).toBe('completed');
    expect(driver.calls).toContain('act:saveBtn:');
  });

  it('zero-weight rows fail the assert; the save click never happens', async () => {
    const driver = scriptedDriver({ reads: { packingTable: [{ weight: '0', length: '78' }] } });
    const res = await runFlow({ steps: stepsFor() }, driver).result;
    expect(res.outcome).toBe('failed');
    expect(res.failure?.nodeId).toBe('assert-rows');
    expect(res.failure?.reason).toContain('assert-failed');
    expect(driver.calls).not.toContain('act:saveBtn:');
  });

  it('empty row collections fail the every-assert (an empty set is not "all valid")', async () => {
    const driver = scriptedDriver({ reads: { packingTable: [] } });
    const res = await runFlow({ steps: stepsFor() }, driver).result;
    expect(res.outcome).toBe('failed');
    expect(res.failure?.nodeId).toBe('assert-rows');
  });
});

describe('foreach semantics', () => {
  const loopSteps = (maxIterations?: number): StepNode => ({
    id: 'root',
    kind: 'sequence',
    steps: [
      readGroups(),
      {
        id: 'per-group',
        kind: 'foreach',
        over: 'vars.groups',
        itemVar: 'group',
        ...(maxIterations !== undefined ? { maxIterations } : {}),
        do: [
          { id: 'group-click', kind: 'action', action: { type: 'clickButton', target: button('groupBtn', '组'), value: { ref: 'group' } } },
        ],
      },
      { id: 'final', kind: 'action', action: { type: 'clickButton', target: button('confirmBtn', '确定并装箱') } },
    ],
  });

  it('visits every member exactly once, in order, then continues past the loop', async () => {
    const driver = scriptedDriver({ reads: { tabs: ['G1', 'G2', 'G3'] } });
    const res = await runFlow({ steps: loopSteps() }, driver).result;
    expect(res.outcome).toBe('completed');
    expect(driver.calls.filter((c) => c.startsWith('act:groupBtn'))).toEqual([
      'act:groupBtn:G1',
      'act:groupBtn:G2',
      'act:groupBtn:G3',
    ]);
    // the after-loop action runs exactly once regardless of member count
    expect(driver.calls.filter((c) => c === 'act:confirmBtn:')).toHaveLength(1);
  });

  it('an empty collection runs the body zero times and continues (the assert, not the loop, rejects empties)', async () => {
    const driver = scriptedDriver({ reads: { tabs: [] } });
    const res = await runFlow({ steps: loopSteps() }, driver).result;
    expect(res.outcome).toBe('completed');
    expect(driver.calls.filter((c) => c.startsWith('act:groupBtn'))).toHaveLength(0);
    expect(driver.calls).toContain('act:confirmBtn:');
  });

  it('a collection larger than maxIterations stops with a budget failure', async () => {
    const driver = scriptedDriver({ reads: { tabs: ['G1', 'G2', 'G3'] } });
    const res = await runFlow({ steps: loopSteps(2) }, driver).result;
    expect(res.outcome).toBe('failed');
    expect(res.failure?.stage).toBe('budget');
    expect(res.failure?.reason).toBe('loop-items');
    expect(res.failure?.nodeId).toBe('per-group');
  });

  it('a loop without its own ceiling is bounded by the declared loopItems budget', async () => {
    // The declared budget is the only ceiling this loop has — dropping it would let 3 real
    // side effects run under a budget of 2
    const driver = scriptedDriver({ reads: { tabs: ['G1', 'G2', 'G3'] } });
    const res = await runFlow({ steps: loopSteps(), budget: { loopItems: 2 } }, driver).result;
    expect(res.outcome).toBe('failed');
    expect(res.failure?.stage).toBe('budget');
    expect(res.failure?.reason).toBe('loop-items');
    expect(res.failure?.nodeId).toBe('per-group');
  });

  it('the engine cap bounds ceiling-less loops even when no budget is declared', async () => {
    const members = Array.from({ length: 101 }, (_, i) => `G${i}`);
    const driver = scriptedDriver({ reads: { tabs: members } });
    const res = await runFlow({ steps: loopSteps() }, driver).result;
    expect(res.outcome).toBe('failed');
    expect(res.failure?.stage).toBe('budget');
    expect(res.failure?.reason).toBe('loop-items');
  });

  it('item field references resolve inside the body (rows loop)', async () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readRows(),
        {
          id: 'per-row',
          kind: 'foreach',
          over: 'vars.rows',
          itemVar: 'row',
          do: [{ id: 'fill', kind: 'action', action: { type: 'setInputValue', target: field('out'), value: { ref: 'row.weight' } } }],
        },
      ],
    };
    const driver = scriptedDriver({ reads: { packingTable: [{ weight: '6.55' }, { weight: '3.1' }] } });
    const res = await runFlow({ steps }, driver).result;
    expect(res.outcome).toBe('completed');
    expect(driver.calls.filter((c) => c.startsWith('act:out'))).toEqual(['act:out:6.55', 'act:out:3.1']);
  });
});

describe('evaluatePredicate collection guards', () => {
  const itemNonEmpty = { kind: 'nonEmpty', ref: 'item' } as const;

  it('every on a non-array reference is false — data that is not a member set must not pass "all valid"', () => {
    // A scalar slot reaching an every-assert used to pass vacuously while an empty collection
    // failed — the exact inversion of PRD §4.1
    expect(evaluatePredicate({ kind: 'every', ref: 'vars.meta', item: itemNonEmpty }, () => 'some-string')).toBe(false);
  });

  it('some on a non-array reference is false', () => {
    expect(evaluatePredicate({ kind: 'some', ref: 'vars.meta', item: itemNonEmpty }, () => 'some-string')).toBe(false);
  });

  it('every on a real non-empty collection still evaluates members', () => {
    const resolve = (ref: string): unknown => (ref === 'vars.rows' ? [{ ok: 'y' }, { ok: 'y' }] : undefined);
    expect(evaluatePredicate({ kind: 'every', ref: 'vars.rows', item: { kind: 'nonEmpty', ref: 'item.ok' } }, resolve)).toBe(true);
  });
});

describe('failure classification and cancellation', () => {
  it('a missing read target fails at the read stage with the slot named', async () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups(),
        { id: 'noop', kind: 'assert', check: { kind: 'nonEmpty', ref: 'vars.groups' } },
      ],
    };
    const driver = scriptedDriver({ readOutcomes: { tabs: 'missing' } });
    const res = await runFlow({ steps }, driver).result;
    expect(res.outcome).toBe('failed');
    expect(res.failure?.stage).toBe('read');
    expect(res.failure?.reason).toBe('missing');
    expect(res.failure?.detail).toBe('groups');
  });

  it('a disabled button is a conservative stop, not a silent skip (skips are explicit if-branches)', async () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [{ id: 'click', kind: 'action', action: { type: 'clickButton', target: button('saveBtn', '保 存') } }],
    };
    const driver = scriptedDriver({ actOutcomes: { saveBtn: 'disabled' } });
    const res = await runFlow({ steps }, driver).result;
    expect(res.outcome).toBe('failed');
    expect(res.failure?.stage).toBe('action');
    expect(res.failure?.reason).toBe('button-disabled');
  });

  it('stopping the actor cancels the run: pending waits abort and no further side effects happen', async () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'hang', kind: 'wait', timeoutMs: 60_000, until: { kind: 'elementPresent', target: button('preview', '货件预览') } },
        { id: 'confirm', kind: 'action', action: { type: 'clickButton', target: button('confirmBtn', '确定并装箱') } },
      ],
    };
    const driver = scriptedDriver({ hangOnWaitId: 'preview' });
    const handle = runFlow({ steps }, driver);
    await new Promise((r) => setTimeout(r, 30));
    handle.stop();
    const res = await handle.result;
    expect(res.outcome).toBe('cancelled');
    // the queued confirm click must never fire after cancellation
    expect(driver.calls).not.toContain('act:confirmBtn:');
    await new Promise((r) => setTimeout(r, 30));
    expect(driver.calls).not.toContain('act:confirmBtn:');
  });

  it('the run-time budget stops long-running flows with a reason', async () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'slow', kind: 'action', action: { type: 'setInputValue', target: field('x'), value: 'v' } },
        { id: 'after', kind: 'action', action: { type: 'setInputValue', target: field('y'), value: 'v' } },
      ],
    };
    // The first action takes 10ms of real driver time; the run budget of 1ms makes the second node's
    // budget gate fire before any side effect happens
    const driver = scriptedDriver({ actDelayMs: 10 });
    const res = await runFlow({ steps, budget: { runMs: 1 } }, driver).result;
    expect(res.outcome).toBe('failed');
    expect(res.failure?.stage).toBe('budget');
    expect(res.failure?.reason).toBe('run-time');
    expect(driver.calls).toEqual(['act:x:v']);
  });
});

describe('DriverFailure shape', () => {
  it('carries stage and reason for log attribution', () => {
    const failure = new DriverFailure('wait', 'timeout', '5000ms');
    expect(failure.stage).toBe('wait');
    expect(failure.reason).toBe('timeout');
    expect(failure.detail).toBe('5000ms');
  });
});

// Run-start input snapshot semantics (form-support): one private copy per run, every step resolves
// the same values, and an optional input consumed where a real value is required fails input-missing
// BEFORE the driver touches the page — an absent value must never fall through to an empty-string
// write, an unchecked click or a zero-iteration loop (US-SSBA-005).
describe('inputs snapshot semantics', () => {
  const twoStepSteps: StepNode = {
    id: 'root',
    kind: 'sequence',
    steps: [
      { id: 'fill-a', kind: 'action', action: { type: 'setInputValue', target: field('outA'), value: { ref: 'inputs.phone' } } },
      { id: 'fill-b', kind: 'action', action: { type: 'setInputValue', target: field('outB'), value: { ref: 'inputs.phone' } } },
    ],
  };

  it('two steps of the same run resolve the same snapshot value', async () => {
    const driver = scriptedDriver({});
    const res = await runFlow({ steps: twoStepSteps, inputs: { phone: '13800001234' } }, driver).result;
    expect(res.outcome).toBe('completed');
    expect(driver.calls.filter((c) => c.startsWith('act:'))).toEqual(['act:outA:13800001234', 'act:outB:13800001234']);
  });

  it('mutating the passed inputs object mid-run cannot leak into the running flow (private copy)', async () => {
    const inputs = { phone: 'A' };
    const driver = scriptedDriver({ actDelayMs: 5 });
    const handle = runFlow({ steps: twoStepSteps, inputs }, driver);
    inputs.phone = 'B';
    const res = await handle.result;
    expect(res.outcome).toBe('completed');
    expect(driver.calls.filter((c) => c.startsWith('act:'))).toEqual(['act:outA:A', 'act:outB:A']);
  });

  it('an optional input consumed by a value position fails input-missing before any driver call', async () => {
    const driver = scriptedDriver({});
    const res = await runFlow({ steps: twoStepSteps, inputs: {} }, driver).result;
    expect(res.outcome).toBe('failed');
    expect(res.failure?.stage).toBe('action');
    expect(res.failure?.reason).toBe('input-missing');
    expect(res.failure?.detail).toBe('inputs.phone');
    expect(driver.calls).toEqual([]);
  });

  it('setCheckbox consumes the resolved boolean; an absent checkbox input fails input-missing', async () => {
    const checkboxSteps = (checked: boolean | { ref: string }): StepNode => ({
      id: 'root',
      kind: 'sequence',
      steps: [{ id: 'set', kind: 'action', action: { type: 'setCheckbox', target: field('box'), checked: checked as never } }],
    });
    const seen: string[] = [];
    const recordingDriver: FlowDriver = {
      ...scriptedDriver({}),
      async act(spec) {
        seen.push(`checked:${(spec as { checked?: unknown }).checked === true}`);
        return 'ok';
      },
    };
    const res = await runFlow({ steps: checkboxSteps({ ref: 'inputs.insured' }), inputs: { insured: true } }, recordingDriver).result;
    expect(res.outcome).toBe('completed');
    expect(seen).toEqual(['checked:true']);

    const absent = await runFlow({ steps: checkboxSteps({ ref: 'inputs.insured' }), inputs: {} }, scriptedDriver({})).result;
    expect(absent.outcome).toBe('failed');
    expect(absent.failure?.reason).toBe('input-missing');
  });

  it('foreach over a multi input iterates the snapshot members; an absent one fails input-missing with zero body actions', async () => {
    const loopOverInputs: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'loop',
          kind: 'foreach',
          over: 'inputs.channels',
          itemVar: 'channel',
          do: [{ id: 'fill', kind: 'action', action: { type: 'setInputValue', target: field('out'), value: { ref: 'channel' } } }],
        },
      ],
    };
    const driver = scriptedDriver({});
    const res = await runFlow({ steps: loopOverInputs, inputs: { channels: ['A', 'B'] } }, driver).result;
    expect(res.outcome).toBe('completed');
    expect(driver.calls.filter((c) => c.startsWith('act:out'))).toEqual(['act:out:A', 'act:out:B']);

    // Absent optional input ≠ empty collection: silently running zero iterations would skip a body
    // the flow declared, so the run stops with the data gap named
    const empty = scriptedDriver({});
    const absent = await runFlow({ steps: loopOverInputs, inputs: {} }, empty).result;
    expect(absent.outcome).toBe('failed');
    expect(absent.failure?.stage).toBe('read');
    expect(absent.failure?.reason).toBe('input-missing');
    expect(empty.calls).toEqual([]);
  });

  it('an absent optional input reads as "no value" in predicates: exists is false, the else path runs', async () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'branch',
          kind: 'if',
          when: { kind: 'exists', ref: 'inputs.note' },
          then: [{ id: 'fill', kind: 'action', action: { type: 'setInputValue', target: field('out'), value: { ref: 'inputs.note' } } }],
          else: [{ id: 'skip', kind: 'action', action: { type: 'setInputValue', target: field('skipped'), value: 'yes' } }],
        },
      ],
    };
    const driver = scriptedDriver({});
    const res = await runFlow({ steps, inputs: {} }, driver).result;
    expect(res.outcome).toBe('completed');
    expect(driver.calls).toContain('act:skipped:yes');
    expect(driver.calls).not.toContain('act:out:');
  });

  it('checkbox false satisfies exists and boolean predicates (false is a filled value)', async () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'check', kind: 'assert', check: { kind: 'and', parts: [
          { kind: 'exists', ref: 'inputs.insured' },
          { kind: 'boolean', ref: 'inputs.insured', equals: false },
        ] } },
        { id: 'go', kind: 'action', action: { type: 'clickButton', target: button('goBtn', '确 定') } },
      ],
    };
    const driver = scriptedDriver({});
    const res = await runFlow({ steps, inputs: { insured: false } }, driver).result;
    expect(res.outcome).toBe('completed');
    expect(driver.calls).toContain('act:goBtn:');
  });
});

// Cross-page semantics: navigate node, handed-over terminal, resume entry (DEC-cross-page-flow-001/002).
import { compileFlowMachine, resumePathAfter, type FlowContext } from '@/lib/flow-compiler';

// A driver whose handover capability resolves (claimed elsewhere -> the machine settles
// handed-over); rejecting models the timeout path.
function handoverDriver(error?: DriverFailure): FlowDriver & { calls: string[]; handoverCalls: string[]; stagedExecuted: number[] } {
  const handoverCalls: string[] = [];
  const stagedExecuted: number[] = [];
  const base = scriptedDriver({});
  return {
    ...base,
    calls: base.calls,
    handoverCalls,
    stagedExecuted,
    async handover(req) {
      handoverCalls.push(`${req.to}:${req.resumeAfter}:${req.timeoutMs}`);
      stagedExecuted.push(req.context.executed);
      if (error !== undefined) throw error;
    },
  };
}

const navSteps = (tail: 'none' | 'after' = 'after'): StepNode => ({
  id: 'root',
  kind: 'sequence',
  steps: [
    { id: 'read-order', kind: 'read', read: { kind: 'scalar', target: field('orderNo') }, into: 'orderNo' },
    { id: 'click-submit', kind: 'action', action: { type: 'clickButton', target: button('submitBtn', '提 交') } },
    { id: 'nav1', kind: 'navigate', to: 'confirm', timeoutMs: 500 },
    ...(tail === 'after' ? [{ id: 'read-result', kind: 'read', read: { kind: 'scalar', target: field('resultNo') }, into: 'resultNo' }] : []),
  ] as StepNode[],
});

describe('navigate compilation (handover seam)', () => {
  it('a claimed handover settles the source run as handed-over — a non-report terminal', async () => {
    const driver = handoverDriver();
    const res = await runFlow({ steps: navSteps() }, driver).result;
    expect(res.outcome).toBe('handed-over');
    // The post-navigate sibling never executes on the source document
    expect(driver.calls).not.toContain('read:resultNo');
    expect(driver.handoverCalls).toEqual(['confirm:nav1:500']);
  });

  it('the staged context already counts the navigate — its +1 assign lands on a context the handed-over run discards', async () => {
    const driver = handoverDriver();
    const res = await runFlow({ steps: navSteps() }, driver).result;
    expect(res.outcome).toBe('handed-over');
    // read-order + click-submit executed before nav1; the staging copy must carry the navigate
    // itself, or every handover undercounts the cross-page executed total (and the engine's hard
    // cap) by one per navigation
    expect(driver.stagedExecuted).toEqual([3]);
  });

  it('a handover timeout fails like a wait timeout — stage navigate, reason timeout, no replay', async () => {
    const driver = handoverDriver(new DriverFailure('navigate', 'timeout', '500ms'));
    const res = await runFlow({ steps: navSteps() }, driver).result;
    expect(res.outcome).toBe('failed');
    expect(res.failure).toMatchObject({ nodeId: 'nav1', stage: 'navigate', reason: 'timeout', detail: '500ms' });
  });

  it('a driver without the handover capability fails navigate as unsupported', async () => {
    const res = await runFlow({ steps: navSteps() }, scriptedDriver({})).result;
    expect(res.outcome).toBe('failed');
    expect(res.failure).toMatchObject({ nodeId: 'nav1', stage: 'navigate', reason: 'unsupported' });
  });
});

const readNode = (id: string): StepNode => ({ id, kind: 'read', read: { kind: 'scalar', target: field(id) }, into: id });
const navNode = (id: string, to = 'confirm'): StepNode => ({ id, kind: 'navigate', to, timeoutMs: 100 });

describe('resumePathAfter (static successor computation, exported for pinning)', () => {
  const read = readNode;
  const nav = navNode;

  it('mid-sequence: the next sibling state', () => {
    const steps: StepNode = { id: 'root', kind: 'sequence', steps: [read('a'), nav('n1'), read('b'), read('c')] };
    expect(resumePathAfter(steps, 'n1')).toEqual(['b']);
  });

  it('sequence tail at the root: __completed', () => {
    const steps: StepNode = { id: 'root', kind: 'sequence', steps: [read('a'), nav('n1')] };
    expect(resumePathAfter(steps, 'n1')).toEqual(['__completed']);
  });

  it('if-branch tail: the join anchor z_<id>', () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'branch', kind: 'if', when: { kind: 'exists', ref: 'vars.a' }, then: [nav('n1')], else: [read('x')] },
        read('after'),
      ],
    };
    expect(resumePathAfter(steps, 'n1')).toEqual(['branch', 'z_branch']);
  });

  it('foreach body tail: the pop anchor y_<id> (its entry is idempotent on staged values)', () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'loop', kind: 'foreach', over: 'vars.items', itemVar: 'it', do: [read('a'), nav('n1')] },
        read('after'),
      ],
    };
    expect(resumePathAfter(steps, 'n1')).toEqual(['loop', 'y_loop']);
  });

  it('nested: navigate inside a foreach inside an if branch resumes at the next body sibling', () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'branch',
          kind: 'if',
          when: { kind: 'exists', ref: 'vars.a' },
          then: [
            { id: 'loop', kind: 'foreach', over: 'vars.items', itemVar: 'it', do: [nav('n1'), read('mid'), read('last')] },
          ],
        },
      ],
    };
    expect(resumePathAfter(steps, 'n1')).toEqual(['branch', 'then', 'loop', 'body', 'mid']);
  });

  it('the root node itself: __completed; unknown ids: null', () => {
    expect(resumePathAfter(nav('n1'), 'n1')).toEqual(['__completed']);
    expect(resumePathAfter(read('a'), 'n1')).toBeNull();
  });
});

describe('cross-page resume (context replacement, no snapshot restore)', () => {
  const resumedContext = (over: Partial<FlowContext> = {}): FlowContext => ({
    trigger: 'seed',
    inputs: {},
    vars: { orderNo: 'B-0001' },
    itemVars: {},
    loops: {},
    loopValues: {},
    iterationPath: '',
    executed: 5,
    startedAt: Date.now(),
    budget: { loopItems: 100, waitMs: 60_000, runMs: 900_000 },
    pageId: 'confirm',
    ...over,
  });

  it('resumes after the navigate node with the staged context — same run continues, budget accumulates', async () => {
    const driver = scriptedDriver({ reads: { resultNo: 'R-9' } });
    const res = await runFlow({ steps: navSteps() }, driver, { afterNodeId: 'nav1', context: resumedContext() }).result;
    expect(res.outcome).toBe('completed');
    // The pre-navigate nodes never re-ran; only the successor executed
    expect(driver.calls).toEqual(['read:resultNo']);
    expect(res.vars.resultNo).toBe('R-9');
    expect(res.vars.orderNo).toBe('B-0001');
    expect(res.executed).toBe(6);
  });

  it('the accumulated run deadline carries over — an expired staged startedAt fails the first resumed node', async () => {
    const driver = scriptedDriver({});
    const res = await runFlow(
      { steps: navSteps() },
      driver,
      { afterNodeId: 'nav1', context: resumedContext({ startedAt: Date.now() - 16 * 60_000 }) },
    ).result;
    expect(res.outcome).toBe('failed');
    expect(res.failure).toMatchObject({ stage: 'budget', reason: 'run-time', pageId: 'confirm' });
  });

  it('a navigate ending the tree resumes straight into __completed', async () => {
    const driver = scriptedDriver({});
    const res = await runFlow({ steps: navSteps('none') }, driver, { afterNodeId: 'nav1', context: resumedContext() }).result;
    expect(res.outcome).toBe('completed');
    expect(driver.calls).toEqual([]);
  });

  it('a foreach over-not-a-collection failure on the continuation page carries the pageId (f_ state)', async () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [navNode('nav1'), { id: 'loop', kind: 'foreach', over: 'vars.items', itemVar: 'it', do: [readNode('x')] }],
    };
    const res = await runFlow({ steps }, scriptedDriver({}), { afterNodeId: 'nav1', context: resumedContext() }).result;
    expect(res.outcome).toBe('failed');
    // Same page attribution as read/action/assert failures on a declared continuation page
    expect(res.failure).toMatchObject({ nodeId: 'loop', reason: 'foreach-over-not-a-collection', pageId: 'confirm' });
  });

  it('a foreach loop-budget failure on the continuation page carries the pageId (failState)', async () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [navNode('nav1'), { id: 'loop', kind: 'foreach', over: 'vars.items', itemVar: 'it', do: [readNode('x')] }],
    };
    const res = await runFlow(
      // The foreach ceiling is compiled from the run input's budget — the same field runResumed
      // must forward for a resumed run's loop guard to see the declared budget
      { steps, budget: { loopItems: 1, waitMs: 60_000, runMs: 900_000 } },
      scriptedDriver({}),
      { afterNodeId: 'nav1', context: resumedContext({ vars: { items: ['a', 'b', 'c'] } }) },
    ).result;
    expect(res.outcome).toBe('failed');
    expect(res.failure).toMatchObject({ nodeId: 'loop', stage: 'budget', reason: 'loop-items', pageId: 'confirm' });
  });

  it('resuming mid-loop continues the remaining items exactly once (advance/body split)', async () => {
    // Loop of three items; each body = navigate then a marker read. Stage right after nav1 for
    // item 0 — the resume must finish item 0's read and run items 1 and 2, each exactly once.
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'read-lines', kind: 'read', read: { kind: 'collection', target: field('lines') }, into: 'lines' },
        {
          id: 'loop',
          kind: 'foreach',
          over: 'vars.lines',
          itemVar: 'it',
          do: [navNode('n1'), { id: 'touch', kind: 'read', read: { kind: 'scalar', target: field('marker') }, into: 'm' }],
        },
      ],
    };
    const staged = resumedContext({
      vars: {},
      loops: { loop: { index: 0, total: 3 } },
      loopValues: { loop: ['a', 'b', 'c'] },
      itemVars: { it: 'a' },
      iterationPath: 'loop[0]',
      executed: 3,
      pageId: undefined,
    });
    const driver = scriptedDriver({});
    const res = await runFlow({ steps }, driver, { afterNodeId: 'n1', context: staged }).result;
    expect(res.outcome).toBe('completed');
    // item0's remaining body read + items 1 and 2 (navigate resolves immediately, then read) —
    // exactly three reads after the resume, and the collection read never re-ran
    expect(driver.calls.filter((c) => c === 'read:marker')).toHaveLength(3);
    expect(driver.calls).not.toContain('read:lines');
  });

  it('a resume naming an unknown node is refused loudly (payload/tree coherence)', () => {
    expect(() => compileFlowMachine({ steps: navSteps() }, scriptedDriver({}), { afterNodeId: 'nope', context: resumedContext() })).toThrow();
  });
});
