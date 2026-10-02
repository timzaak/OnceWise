// Dry-run presentation adapter (DEC-019 §0.1): the preview runs the SAME machine over the SAME DOM
// driver with the SAME business-instance claims as automatic execution — real side effects included —
// and only adds what a preview needs: highlighting the resolved action target, step pacing and
// progress events carrying the actually-executed path — never a pre-assumed loop-total: loop
// lengths are page data, unknown before the run.
import { highlightElements } from './overlay';
import { resolveField } from './locator';
import { abortableSleep, createDomFlowDriver, type DomDriverOptions } from './flow-dom';
import type { FlowDriver } from '@/lib/flow-compiler';
import type { Flow } from './flow-schema';

export const DRY_RUN_STEP_INTERVAL_MS = 800;

export interface DryRunDriverOptions extends DomDriverOptions {
  intervalMs?: number;
}

export interface DryRunDriverHooks {
  // Called with the highlighted action target's display label (progress rendering in the host)
  onHighlight?: (label: string) => void;
}

// Pacing decorator: pauses before and after every side effect so a human can follow the preview.
// Read-only waits are untouched — a 60s stability wait must not become minutes of theater. The pauses
// wake on abort so a stopped preview cleans up immediately instead of sleeping out its rhythm, and
// `afterAct` runs after the trailing pause (the preview uses it to drop the action highlight).
// The optional handover capability passes through so the decorator keeps the driver contract whole
// regardless of whether withHandover wraps inside or outside the pacing layer.
export function withPacing(
  base: FlowDriver,
  intervalMs: number,
  hooks?: { afterAct?: () => void },
): FlowDriver {
  return {
    read: (spec, scope, signal) => base.read(spec, scope, signal),
    act: async (spec, value, scope, signal) => {
      await abortableSleep(intervalMs, signal);
      try {
        return await base.act(spec, value, scope, signal);
      } finally {
        if (!signal.aborted) await abortableSleep(intervalMs, signal);
        hooks?.afterAct?.();
      }
    },
    waitUntil: (cond, timeoutMs, scope, evaluate, signal) =>
      base.waitUntil(cond, timeoutMs, scope, evaluate, signal),
    ...(base.handover !== undefined ? { handover: (req, signal) => base.handover!(req, signal) } : {}),
  };
}

// The preview driver: the DOM driver plus highlight (via its onActionTarget presentation seam) and
// pacing. Outcomes are untouched — a failing preview and a failing auto run fail for identical reasons.
export function createDryRunDriver(
  doc: Document,
  opts: DryRunDriverOptions & { hooks?: DryRunDriverHooks } = {},
): FlowDriver {
  let removeHighlight: (() => void) | null = null;
  const base = createDomFlowDriver(doc, {
    ...opts,
    onActionTarget: (el, label) => {
      removeHighlight?.();
      removeHighlight = highlightElements(doc, [el], { color: '#16a34a' });
      opts.hooks?.onHighlight?.(label);
    },
  });
  return withPacing(base, opts.intervalMs ?? DRY_RUN_STEP_INTERVAL_MS, {
    afterAct: () => {
      removeHighlight?.();
      removeHighlight = null;
    },
  });
}

// Trigger-field highlight before the run starts (the blue box shows what will seed the run)
export function highlightTrigger(doc: Document, flow: Flow): () => void {
  if (flow.trigger.kind !== 'fieldChange') return () => undefined;
  const resolved = resolveField(doc, flow.trigger.field);
  if ('error' in resolved) return () => undefined;
  return highlightElements(doc, [resolved.el], { color: '#2563eb' });
}
