// fieldChange triggers for flows (DEC-019 §5.2/L1): a lightweight watcher over the trigger
// field that debounces observer storms, ignores this extension's own marked writes, reads the trigger
// value through the same DOM driver the flow uses, and fires at most once per distinct value.
// This module only decides WHEN to start a run, never runs one.
import { carriesAutoMarker } from './action-primitives';
import { extractBracketCode } from './dom';
import { resolveField } from './locator';
import { pageMatches } from './page-enter';
import type { Flow } from './flow-schema';
import type { FlowDriver } from './flow-compiler';

export const OBSERVER_DEBOUNCE_MS = 150;

export interface TriggerWatcherHandle {
  stop(): void;
  // The bound element can be replaced by a host re-render; the arm loop re-attaches a dead watcher
  isAlive(): boolean;
}

// The trigger seed: the field's scalar text, with the antd Select bracket code extracted when the
// trigger is a select (`warehouse[CODE]` → CODE — the option code is the stable seed flows are
// authored against). Unreadable/missing → null (no fire; a flow cannot start blind).
export async function readTriggerValue(flow: Flow, driver: FlowDriver): Promise<string | null> {
  if (flow.trigger.kind !== 'fieldChange') return '';
  const res = await driver.read(
    { kind: 'scalar', target: flow.trigger.field },
    { trigger: '', items: {} },
    new AbortController().signal,
  );
  if (!res.ok) return null;
  const text = typeof res.value === 'string' ? res.value : '';
  if (flow.trigger.field.componentType === 'antdSelect') {
    const code = extractBracketCode(text);
    return code !== undefined && code !== '' ? code : null;
  }
  return text.length > 0 ? text : null;
}

// Fire condition: anyChange → the value changed since the last fire; codeEquals → the value equals the
// declared code AND changed since the last fire (a re-selected identical code does not re-run).
export function triggerFires(
  flow: Flow,
  value: string | null,
  last: { value: string | null },
): boolean {
  if (value === null || value === last.value) return false;
  last.value = value;
  if (flow.trigger.kind === 'fieldChange' && flow.trigger.condition.kind === 'codeEquals') {
    return value === flow.trigger.condition.code;
  }
  return true;
}

// Attach the fieldChange listener set: native input/change for plain fields, a subtree MutationObserver
// for antd Selects (their value lives in rendered text, not input events). Returns null when the
// trigger field cannot be resolved or the page fingerprint does not match (not armed on this page).
export function attachFieldChangeWatcher(
  doc: Document,
  flow: Flow,
  opts: { onFire: (value: string) => void; readValue: () => Promise<string | null> },
): TriggerWatcherHandle | null {
  if (flow.trigger.kind !== 'fieldChange') return null;
  if (!pageMatches(doc, flow.page)) return null;
  const resolved = resolveField(doc, flow.trigger.field);
  if ('error' in resolved) return null;
  const el = resolved.el as HTMLElement;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const last = { value: null as string | null };

  // Baseline: seed with the field's current value so an observed event whose value
  // equals the mount-time value never fires — opening a dropdown or a same-value re-render is not a
  // change. A first real fire wins the race (the guard keeps the stale baseline from overwriting it).
  void opts.readValue().then((baseline) => {
    if (!stopped && last.value === null && baseline !== null) last.value = baseline;
  });

  const fire = async () => {
    if (stopped) return;
    // The debounced read re-resolves through the driver, so a field replaced during the debounce is
    // still read correctly; the page fingerprint is re-checked the same way
    if (!pageMatches(doc, flow.page)) return;
    const value = await opts.readValue();
    if (stopped) return;
    if (value !== null && triggerFires(flow, value, last)) opts.onFire(value);
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void fire(), OBSERVER_DEBOUNCE_MS);
  };

  let observer: MutationObserver | null = null;
  let listener: ((event: Event) => void) | null = null;

  if (flow.trigger.field.componentType === 'antdSelect') {
    observer = new MutationObserver((records) => {
      // Self-writes carry the auto marker; they must not re-trigger the flow that made them (L1).
      // MutationRecord targets are Nodes; only element targets (duck-typed closest) can carry it.
      const fromUs = records.every((record) => {
        const raw = record.target as { closest?: unknown; parentElement?: unknown } | null;
        const target = (typeof raw?.closest === 'function' ? raw : (raw?.parentElement ?? null)) as Element | null;
        return carriesAutoMarker(target);
      });
      if (!fromUs) schedule();
    });
    observer.observe(el, { subtree: true, childList: true, characterData: true });
  } else {
    listener = (event: Event) => {
      // Self-writes dispatch native input/change while the auto marker is still on the field
      // (withAutoMarker removes it only after the apply settles) — they must not re-trigger (L1).
      // The target is duck-typed like the MutationObserver branch above.
      const raw = event.target as { closest?: unknown } | null;
      const target = typeof raw?.closest === 'function' ? (raw as Element) : null;
      if (target !== null && carriesAutoMarker(target)) return;
      schedule();
    };
    el.addEventListener('input', listener);
    el.addEventListener('change', listener);
  }

  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      observer?.disconnect();
      if (listener !== null) {
        el.removeEventListener('input', listener);
        el.removeEventListener('change', listener);
      }
    },
    isAlive: () => !stopped && el.isConnected,
  };
}
