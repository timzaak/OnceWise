// P2 runtime host contract (§0.1): single-run mutex per document, runId-stamped event log with node
// ids / loop iteration paths / terminal reasons, cancellation settling as 'cancelled'.
import { describe, expect, it } from 'vitest';
import {
  createFlowRuntime,
  type FlowLogEvent,
} from '@/lib/flow-runtime';
import { DriverFailure, type FlowDriver, type FlowRunInput } from '@/lib/flow-compiler';
import type { StepNode } from '@/lib/step-schema';

function seqSteps(): StepNode {
  return {
    id: 'root',
    kind: 'sequence',
    steps: [
      { id: 'r1', kind: 'read', read: { kind: 'scalar', target: { clues: { cssPath: '.x' }, componentType: 'input', displayLabel: 'X' } }, into: 'v' },
      { id: 'a1', kind: 'action', action: { type: 'clickButton', target: { clues: { cssPath: '.b' }, componentType: 'button', displayLabel: '保 存' } } },
    ],
  };
}

const okDriver: FlowDriver = {
  read: async () => ({ ok: true, value: 'x' }),
  act: async () => 'ok',
  waitUntil: async () => ({ outcome: 'satisfied' }),
};

describe('createFlowRuntime', () => {
  it('runs to completion, logs start/node/end events carrying runId, and frees the mutex', async () => {
    const events: FlowLogEvent[] = [];
    const runtime = createFlowRuntime({
      driver: () => okDriver,
      onEvent: (e) => events.push(e),
      newRunId: () => 'run-42',
    });
    const start = runtime.tryStart({ steps: seqSteps() } satisfies FlowRunInput);
    if (!start.started) throw new Error('expected the first start to begin');
    const result = await start.result;
    expect(result.outcome).toBe('completed');
    expect(result.executed).toBe(2);
    expect(runtime.activeRunId).toBeNull();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run-start');
    expect(types[types.length - 1]).toBe('run-end');
    const nodes = events.filter((e) => e.type === 'node');
    expect(nodes.map((n) => (n.type === 'node' ? `${n.phase}:${n.nodeId}` : ''))).toEqual(['start:r1', 'ok:r1', 'start:a1', 'ok:a1']);
    for (const e of events) expect(e.runId).toBe('run-42');
    const end = events[events.length - 1]!;
    expect(end).toMatchObject({ type: 'run-end', outcome: 'completed', executed: 2 });
  });

  it('rejects a second start while a run is active (busy documents skip, never queue)', async () => {
    let releaseWait: (() => void) | undefined;
    const hangingDriver: FlowDriver = {
      ...okDriver,
      waitUntil: () =>
        new Promise((resolve) => {
          releaseWait = () => resolve({ outcome: 'satisfied' });
        }),
    };
    const runtime = createFlowRuntime({ driver: hangingDriver, newRunId: () => 'r1' });
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'w1',
          kind: 'wait',
          timeoutMs: 5000,
          until: { kind: 'elementPresent', target: { clues: { cssPath: '.x' }, componentType: 'other', displayLabel: 'X' } },
        },
      ],
    };
    const first = runtime.tryStart({ steps });
    if (!first.started) throw new Error('expected first start to begin');
    expect(runtime.activeRunId).toBe('r1');
    const second = runtime.tryStart({ steps: seqSteps() });
    expect(second).toEqual({ started: false, reason: 'busy', activeRunId: 'r1' });

    releaseWait?.();
    await first.result;
    expect(runtime.activeRunId).toBeNull();
    const third = runtime.tryStart({ steps: seqSteps() });
    expect(third.started).toBe(true);
  });

  it('cancel() settles the active run as cancelled and reports false when idle', async () => {
    const hangingDriver: FlowDriver = {
      ...okDriver,
      act: () => new Promise<never>(() => undefined),
    };
    const events: FlowLogEvent[] = [];
    const runtime = createFlowRuntime({ driver: () => hangingDriver, onEvent: (e) => events.push(e) });
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'a1', kind: 'action', action: { type: 'clickButton', target: { clues: { cssPath: '.b' }, componentType: 'button', displayLabel: '保 存' } } },
      ],
    };
    const start = runtime.tryStart({ steps });
    if (!start.started) throw new Error('expected start to begin');
    expect(runtime.cancel()).toBe(true);
    const result = await start.result;
    expect(result.outcome).toBe('cancelled');
    const end = events.find((e) => e.type === 'run-end');
    expect(end).toMatchObject({ type: 'run-end', outcome: 'cancelled' });
    expect(runtime.activeRunId).toBeNull();
    expect(runtime.cancel()).toBe(false);
  });

  it('failures reach run-end with nodeId, stage, reason and loop iterationPath', async () => {
    let calls = 0;
    const flaky: FlowDriver = {
      ...okDriver,
      read: async (spec) => {
        void spec;
        calls++;
        if (calls === 1) return { ok: true, value: [{ id: 'g1' }, { id: 'g2' }] };
        throw new DriverFailure('read', 'ambiguous', 'group rows');
      },
    };
    const events: FlowLogEvent[] = [];
    const runtime = createFlowRuntime({ driver: () => flaky, onEvent: (e) => events.push(e), newRunId: () => 'rx' });
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'groups', kind: 'read', read: { kind: 'collection', target: { clues: { cssPath: '.t' }, componentType: 'other', displayLabel: '组' } }, into: 'groups' },
        {
          id: 'loop',
          kind: 'foreach',
          over: 'vars.groups',
          itemVar: 'group',
          do: [
            { id: 'inner', kind: 'read', read: { kind: 'scalar', target: { clues: { cssPath: '.s' }, componentType: 'input', displayLabel: 'S' } }, into: 's' },
          ],
        },
      ],
    };
    const start = runtime.tryStart({ steps });
    if (!start.started) throw new Error('expected start to begin');
    const result = await start.result;
    expect(result.outcome).toBe('failed');
    expect(result.failure).toMatchObject({ nodeId: 'inner', stage: 'read', reason: 'ambiguous', iterationPath: '[0]' });
    const end = events.find((e) => e.type === 'run-end');
    expect(end).toMatchObject({ type: 'run-end', outcome: 'failed' });
  });
});
// Cross-page resume entry and the handed-over terminal (DEC-cross-page-flow-001/002).
import type { FlowContext } from '@/lib/flow-compiler';

const handoverDriver: FlowDriver = {
  ...okDriver,
  handover: async () => undefined,
};

const navThenRead = (): StepNode => ({
  id: 'root',
  kind: 'sequence',
  steps: [
    { id: 'nav1', kind: 'navigate', to: 'confirm', timeoutMs: 100 },
    { id: 'r2', kind: 'read', read: { kind: 'scalar', target: { clues: { cssPath: '.y' }, componentType: 'input', displayLabel: 'Y' } }, into: 'v2' },
  ],
});

const stagedContext = (over: Partial<FlowContext> = {}): FlowContext => ({
  trigger: '',
  inputs: {},
  vars: { v: 'carried' },
  itemVars: {},
  loops: {},
  loopValues: {},
  iterationPath: '',
  executed: 2,
  startedAt: Date.now(),
  budget: { loopItems: 100, waitMs: 60_000, runMs: 900_000 },
  pageId: 'confirm',
  ...over,
});

describe('createFlowRuntime cross-page resume', () => {
  it('a resume reuses the claimed runId and marks the run-start event resumed', async () => {
    const events: FlowLogEvent[] = [];
    const runtime = createFlowRuntime({ driver: () => okDriver, onEvent: (e) => events.push(e) });
    const start = runtime.tryStart(
      { steps: navThenRead() },
      { runId: 'run-resumed', resume: { afterNodeId: 'nav1', context: stagedContext() } },
    );
    if (!start.started) throw new Error('expected the resume to begin');
    expect(start.runId).toBe('run-resumed');
    const result = await start.result;
    expect(result.outcome).toBe('completed');
    // The resumed context replaced the fresh one: the pre-navigate read never ran, the carried var did
    expect(result.vars.v).toBe('carried');
    expect(result.executed).toBe(3);
    const runStart = events.find((e) => e.type === 'run-start');
    expect(runStart).toMatchObject({ type: 'run-start', runId: 'run-resumed', resumed: true });
    // Fresh starts stay unmarked
    const fresh = createFlowRuntime({ driver: () => okDriver, onEvent: () => undefined });
    const freshEvents: FlowLogEvent[] = [];
    const freshRuntime = createFlowRuntime({ driver: () => okDriver, onEvent: (e) => freshEvents.push(e) });
    void fresh;
    const s2 = freshRuntime.tryStart({ steps: seqSteps() });
    if (!s2.started) throw new Error('expected start');
    await s2.result;
    expect(freshEvents.find((e) => e.type === 'run-start')?.resumed).toBeUndefined();
  });

  it('the resumed run holds the document mutex like any run', async () => {
    let releaseHandover: (() => void) | undefined;
    const waitingDriver: FlowDriver = {
      ...okDriver,
      handover: () =>
        new Promise<void>((resolve) => {
          releaseHandover = resolve;
        }),
    };
    const runtime = createFlowRuntime({ driver: () => waitingDriver });
    // A fresh run enters at the navigate node and hangs inside the handover poll — the waiting
    // source document holds the mutex exactly like a running one
    const start = runtime.tryStart({ steps: navThenRead() });
    if (!start.started) throw new Error('expected the run to begin');
    const second = runtime.tryStart({ steps: seqSteps() });
    expect(second.started).toBe(false);
    if (!second.started) expect(typeof second.activeRunId).toBe('string');
    releaseHandover?.();
    const result = await start.result;
    expect(result.outcome).toBe('handed-over');
    expect(runtime.activeRunId).toBeNull();
  });

  it('the handed-over terminal flows through the event log and frees the mutex without a failure', async () => {
    const events: FlowLogEvent[] = [];
    const runtime = createFlowRuntime({ driver: () => handoverDriver, onEvent: (e) => events.push(e) });
    const start = runtime.tryStart({ steps: navThenRead() });
    if (!start.started) throw new Error('expected start');
    const result = await start.result;
    expect(result.outcome).toBe('handed-over');
    expect(result.failure).toBeUndefined();
    const end = events.find((e) => e.type === 'run-end');
    expect(end).toMatchObject({ type: 'run-end', outcome: 'handed-over' });
    // The post-navigate sibling never ran on this host
    expect(events.some((e) => e.type === 'node' && e.nodeId === 'r2')).toBe(false);
    expect(runtime.activeRunId).toBeNull();
  });
});
