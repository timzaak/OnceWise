// Steps run host (DEC-self-service-browser-automation-019 §0.1): one runtime per document. It owns
// the actor lifecycle around the compiler — start, single-run mutex, cancellation — and turns the
// compiler's hooks plus the settled result into a flat event log carrying runId, nodeId, loop
// iterationPath and terminal reason (consumed by the dry-run progress feed; the business-instance
// claim that produces the 'skipped' terminal is taken by the content host before starting).
//
// The runtime never touches the DOM itself: drivers are injected (DOM driver in production, fakes in
// tests). A driver FACTORY gives each run a fresh instance so per-run registries (collection member
// ids) never leak across runs; passing an instance directly reuses it for every run instead.
import {
  runFlow,
  type FlowDriver,
  type FlowRunHandle,
  type FlowRunInput,
  type FlowRunResult,
  type FlowResume,
} from './flow-compiler';

export type FlowLogEvent =
  | { type: 'run-start'; runId: string; trigger: string; resumed?: boolean }
  | {
      type: 'node';
      runId: string;
      phase: 'start' | 'ok';
      nodeId: string;
      kind: 'read' | 'action' | 'wait' | 'navigate';
      iterationPath: string;
      executed: number;
    }
  | {
      type: 'run-end';
      runId: string;
      outcome: FlowRunResult['outcome'];
      executed: number;
      failure?: FlowRunResult['failure'];
    };

export interface FlowRuntimeOptions {
  driver: FlowDriver | (() => FlowDriver);
  onEvent?: (event: FlowLogEvent) => void;
  newRunId?: () => string;
}

export type FlowStart =
  | { started: true; runId: string; result: Promise<FlowRunResult> }
  | { started: false; reason: 'busy'; activeRunId: string };

// Cross-page resume entry: the SAME runId continues (the claiming document is the run's new host),
// the machine is compiled from the staged context entering after the navigate node, and the
// run-start event carries resumed:true so progress consumers can render the continuation.
export interface RuntimeResume {
  runId: string;
  resume: FlowResume;
}

export interface FlowRuntime {
  readonly activeRunId: string | null;
  // Busy documents record a skip instead of queueing a replay of the trigger (§5.2)
  tryStart(input: FlowRunInput, resume?: RuntimeResume): FlowStart;
  // Stop the active run (user stop, flow pause, page unload); resolves as 'cancelled'
  cancel(): boolean;
}

export function createFlowRuntime(opts: FlowRuntimeOptions): FlowRuntime {
  const driverOf = typeof opts.driver === 'function' ? opts.driver : () => opts.driver as FlowDriver;
  const newRunId = opts.newRunId ?? ((): string => crypto.randomUUID());

  let active: { runId: string; handle: FlowRunHandle } | null = null;

  const runtime: FlowRuntime = {
    get activeRunId(): string | null {
      return active?.runId ?? null;
    },

    tryStart(input: FlowRunInput, resume?: RuntimeResume): FlowStart {
      if (active !== null) return { started: false, reason: 'busy', activeRunId: active.runId };
      const runId = resume?.runId ?? newRunId();
      // Emitted before runFlow: the actor starts synchronously and its first node event would
      // otherwise precede the run-start log line.
      opts.onEvent?.({
        type: 'run-start',
        runId,
        trigger: input.trigger ?? '',
        ...(resume !== undefined ? { resumed: true } : {}),
      });
      const handle = runFlow(
        { ...input, hooks: { onNode: (node) => opts.onEvent?.({ type: 'node', runId, ...node }) } },
        driverOf(),
        resume?.resume,
      );
      active = { runId, handle };
      void handle.result.then((result) => {
        if (active?.runId === runId) active = null;
        opts.onEvent?.({
          type: 'run-end',
          runId,
          outcome: result.outcome,
          executed: result.executed,
          failure: result.failure,
        });
      });
      return { started: true, runId, result: handle.result };
    },

    cancel(): boolean {
      if (active === null) return false;
      active.handle.stop();
      return true;
    },
  };
  return runtime;
}
