// DOM driver for constrained flows (DEC-self-service-browser-automation-019 §0.1): the only
// module that touches the live DOM during a run. It implements the FlowDriver whitelist over the
// existing locator/dom/action-primitives seams — every call re-locates its target (no element is
// carried between calls), every poll and side effect is AbortSignal-aware, and results distinguish
// missing / ambiguous / unreadable / disabled instead of guessing (PRD §4.2: prefer stopping over
// acting on the wrong group).
//
// Read semantics (per ReadSpec.kind):
// - scalar: value text by componentType (input value, antd Select selection text, checkbox state,
//   element text). An absent antd selection reads as '' (a readable empty), not unreadable.
// - boolean: checkbox checked (incl. antd checked-class), aria-checked/selected/expanded, or an
//   active .ant-tabs-tab ancestor; an element without any carrier reads as true (its presence IS
//   the state). A target that resolves to nothing reads as false: page state is routinely expressed
//   by element presence (the pinned packing contract reads edit mode as "the auto-load button
//   exists"), and the acceptance matrix requires skipping already-satisfied states. A scoped target
//   whose member is gone stays a hard failure — a vanished group is not "state false" (PRD §4.2
//   changed-collection flow).
// - collection: ALL visible members of the first clue level with at least one visible match
//   (resolveFieldAll). Members are frozen as `{ id }` records at read time; the id is data-key > id >
//   name > aria-label > normalized text. `within: <itemVar>` targets re-locate the member by id on
//   every call and scope resolution to its subtree (the member itself included), so same-labeled
//   controls in other groups cannot be hit. Member ids must stay unique across scoped collections.
// - rows: visible `tr`s of the resolved table container; rows with zero readable controls are
//   skipped (header rows), rows whose control count differs from `columns` make the whole read
//   unreadable (a partially rendered table is not valid data — G4).
//
// Wait semantics: presence/absence poll at pollIntervalMs; missing targets keep waiting, ambiguity
// fails immediately (§5.1). readMatches waits additionally require a stability window — the value
// must be identical on stabilitySamples consecutive samples taken stabilityIntervalMs apart AND be
// non-empty data (rows: at least one non-empty field; scalar: non-empty string) before the flow's
// predicate is evaluated. Stable-but-all-zero data passes the wait and is caught by the assert
// (§5.1); an unreadable mid-transition table keeps waiting until the deadline.
import {
  antSelectContainerOf,
  extractBracketCode,
  isVisible,
  normalizeText,
  readAntSelectText,
} from './dom';
import {
  applyCheckbox,
  applyClickButton,
  applyInputValue,
  applySelectOption,
  withAutoMarker,
} from './action-primitives';
import { resolveField, resolveFieldAll, resolveWithCandidates, type ResolveResult } from './locator';
import type { ActionSpec, ComponentType, FieldRef, ReadSpec, WaitCondition } from './step-schema';
import { isPlainObject } from './step-schema';
import {
  DriverFailure,
  type ActOutcome,
  type DriverScope,
  type ReadOutcome,
  type WaitOutcome,
  type FlowDriver,
} from './flow-compiler';

export interface DomDriverOptions {
  // Presence/absence polling interval
  pollIntervalMs?: number;
  // Stability sampling interval for readMatches waits (reference packing uses 400ms)
  stabilityIntervalMs?: number;
  // Consecutive identical samples required for stability
  stabilitySamples?: number;
  // Presentation hook for the dry-run adapter: called with the resolved element right before a
  // whitelisted side effect is applied. Production leaves it unset — it never influences outcomes.
  onActionTarget?: (el: Element, label: string) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_STABILITY_INTERVAL_MS = 400;
const DEFAULT_STABILITY_SAMPLES = 2;

// Sleep that wakes early on abort so stopped runs stop polling immediately; the caller re-checks the
// signal (stopping the actor never stops underlying async code by itself — §5.2).
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

// Stable member identifier for collection reads: prefer DOM attributes over text (G2: DOM 标识优先)
function memberIdOf(el: Element): string | undefined {
  const attr = el.getAttribute('data-key') ?? el.getAttribute('id') ?? el.getAttribute('name') ?? el.getAttribute('aria-label');
  if (attr && attr.trim() !== '') return attr;
  const text = el.textContent;
  if (text && normalizeText(text) !== '') return normalizeText(text);
  return undefined;
}

type ScopedResolve = ResolveResult | { error: 'scope-missing' };

function readFail(error: 'not-found' | 'ambiguous' | 'no-clues' | 'scope-missing'): ReadOutcome {
  if (error === 'ambiguous') return { ok: false, reason: 'ambiguous' };
  if (error === 'no-clues') return { ok: false, reason: 'unreadable' };
  return { ok: false, reason: 'missing' };
}

function scalarText(el: Element, componentType: ComponentType): string {
  switch (componentType) {
    case 'input':
      return String((el as HTMLInputElement).value ?? '');
    case 'antdSelect': {
      const container = antSelectContainerOf(el) ?? el;
      return readAntSelectText(container) ?? '';
    }
    case 'checkbox':
      return String((el as HTMLInputElement).checked === true);
    case 'button':
    case 'other':
      return (el.textContent ?? '').trim();
  }
}

// Boolean state carriers, checked in order; null = no known carrier on this element
function booleanState(el: Element): boolean | null {
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox') {
    if ((el as HTMLInputElement).checked) return true;
    if (el.closest('.ant-checkbox')?.classList.contains('ant-checkbox-checked')) return true;
    return false;
  }
  for (const attr of ['aria-checked', 'aria-selected', 'aria-expanded'] as const) {
    const v = el.getAttribute(attr);
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  if (el.closest('.ant-tabs-tab')?.classList.contains('ant-tabs-tab-active')) return true;
  return null;
}

function readableControls(row: Element): Element[] {
  return Array.from(row.querySelectorAll('input, textarea, .ant-select')).filter((el) => {
    if (!isVisible(el)) return false;
    if (el.tagName === 'INPUT') {
      const type = (el as HTMLInputElement).type;
      if (type === 'checkbox' || type === 'radio' || type === 'hidden') return false;
    }
    return true;
  });
}

// Row-cell text: antd Select cells read through scalarText's antd branch, everything else is an
// input value (readableControls only collects inputs, textareas and .ant-select containers)
function controlText(control: Element): string {
  const isAntSelect = antSelectContainerOf(control) !== null || control.matches('.ant-select');
  return scalarText(control, isAntSelect ? 'antdSelect' : 'input');
}

// Non-empty data requirement of the stability definition (§5.1): what counts as "there is data at
// all". Zero-valued strings ARE data — positivity is the assert's job, not the wait's.
function nonEmptyData(kind: ReadSpec['kind'], value: unknown): boolean {
  switch (kind) {
    case 'rows':
      return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.some((row) => isPlainObject(row) && Object.values(row).some((f) => typeof f === 'string' && f !== ''))
      );
    case 'collection':
      return Array.isArray(value) && value.length > 0;
    case 'scalar':
      return typeof value === 'string' && value.length > 0;
    case 'boolean':
      return typeof value === 'boolean';
  }
}

export function createDomFlowDriver(doc: Document, opts: DomDriverOptions = {}): FlowDriver {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const stabilityIntervalMs = opts.stabilityIntervalMs ?? DEFAULT_STABILITY_INTERVAL_MS;
  const stabilitySamples = opts.stabilitySamples ?? DEFAULT_STABILITY_SAMPLES;
  const onActionTarget = opts.onActionTarget;

  // Collection member registry: member id -> the collection FieldRef that produced it. Members are
  // re-located from the FieldRef on every scoped use, never cached as element references (PRD §4.2).
  const memberRegistry = new Map<string, FieldRef>();

  // Resolve the element that anchors a `within` scope for this call, or null when the item is not a
  // registered collection member (rows items carry no id) or the member is gone (tab set changed).
  const memberAnchor = (within: string, scope: DriverScope): Element | null => {
    const item = scope.items[within];
    const id = isPlainObject(item) && typeof item.id === 'string' ? item.id : undefined;
    if (id === undefined) return null;
    const collectionField = memberRegistry.get(id);
    if (collectionField === undefined) return null;
    const all = resolveFieldAll(doc, collectionField);
    if ('error' in all) return null;
    return all.els.find((el) => memberIdOf(el) === id) ?? null;
  };

  // The member's scope region: the element its aria-controls points at (antd tab → its tabpane; a
  // standard ARIA relation, not an antd special case), or the member itself. Content targets resolve
  // inside the region while the member itself (e.g. the group tab as a click target) stays reachable.
  const memberRegion = (member: Element): Element => {
    const regionId = member.getAttribute('aria-controls');
    if (!regionId) return member;
    return doc.getElementById(regionId) ?? member;
  };

  const resolveTarget = (field: FieldRef, scope: DriverScope): ScopedResolve => {
    if (field.within === undefined) return resolveField(doc, field);
    const member = memberAnchor(field.within, scope);
    if (member === null) return { error: 'scope-missing' };
    const region = memberRegion(member);
    return resolveWithCandidates(field, (sel) => {
      const out: Element[] = [];
      const seen = new Set<Element>();
      const push = (el: Element | undefined): void => {
        if (el && !seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      };
      const roots = region !== member ? [region, member] : [member];
      for (const root of roots) {
        try {
          for (const el of Array.from(root.querySelectorAll(sel))) push(el);
          if (typeof root.matches === 'function' && root.matches(sel)) push(root);
        } catch {
          return null;
        }
      }
      return out;
    });
  };

  const read = (spec: ReadSpec, scope: DriverScope, signal: AbortSignal): Promise<ReadOutcome> =>
    Promise.resolve().then(async () => {
      if (signal.aborted) return { ok: false, reason: 'missing' } as ReadOutcome;
      switch (spec.kind) {
        case 'scalar': {
          const r = resolveTarget(spec.target, scope);
          if ('error' in r) return readFail(r.error);
          return { ok: true, value: scalarText(r.el, spec.target.componentType) };
        }
        case 'boolean': {
          const r = resolveTarget(spec.target, scope);
          if ('error' in r) {
            // Presence-expressed state: an absent target IS the false state (edit mode etc.). A gone
            // scope member or an ambiguous match is never "false" — it stops the run.
            if (r.error === 'not-found') return { ok: true, value: false };
            if (r.error === 'ambiguous') return { ok: false, reason: 'ambiguous' };
            if (r.error === 'scope-missing') return { ok: false, reason: 'missing' };
            return { ok: false, reason: 'unreadable' };
          }
          const state = booleanState(r.el);
          if (state !== null) return { ok: true, value: state };
          // No boolean carrier on the element: presence itself is the state (the auto-load button
          // existing IS edit mode). A flow that declared a checkbox but resolved something else must
          // not read a bogus true.
          if (spec.target.componentType === 'checkbox') return { ok: false, reason: 'unreadable' };
          return { ok: true, value: true };
        }
        case 'collection': {
          const all = resolveFieldAll(doc, spec.target);
          if ('error' in all) return readFail(all.error);
          const members: { id: string }[] = [];
          const seen = new Set<string>();
          for (const el of all.els) {
            const id = memberIdOf(el);
            if (id === undefined) return { ok: false, reason: 'unreadable' };
            if (seen.has(id)) return { ok: false, reason: 'ambiguous' };
            seen.add(id);
            members.push({ id });
            const known = memberRegistry.get(id);
            if (known !== undefined && known !== spec.target) {
              // The same member id from a second collection cannot be told apart at scoped use —
              // silently re-binding would aim `within` actions at whichever collection read last.
              // Stopping beats acting on the wrong group (PRD §4.2); re-reading the same node is fine.
              return { ok: false, reason: 'ambiguous' };
            }
            memberRegistry.set(id, spec.target);
          }
          return { ok: true, value: members };
        }
        case 'rows': {
          const r = resolveTarget(spec.table, scope);
          if ('error' in r) return readFail(r.error);
          const rows: Record<string, string>[] = [];
          for (const tr of Array.from(r.el.querySelectorAll('tr'))) {
            if (!isVisible(tr)) continue;
            const controls = readableControls(tr);
            if (controls.length === 0) continue;
            if (controls.length !== spec.columns.length) return { ok: false, reason: 'unreadable' };
            const record: Record<string, string> = {};
            spec.columns.forEach((column, i) => {
              record[column] = controlText(controls[i]!);
            });
            rows.push(record);
          }
          return { ok: true, value: rows };
        }
      }
    });

  const act = (
    spec: ActionSpec,
    value: string | undefined,
    scope: DriverScope,
    signal: AbortSignal,
  ): Promise<ActOutcome> =>
    Promise.resolve().then(async () => {
      // Side-effect guard: cancellation must never let a queued click through (§5.2)
      if (signal.aborted) throw new DriverFailure('action', 'aborted', spec.target.displayLabel);
      const r = resolveTarget(spec.target, scope);
      if ('error' in r) {
        if (r.error === 'ambiguous') return 'ambiguous';
        if (r.error === 'no-clues') throw new DriverFailure('action', 'no-clues', spec.target.displayLabel);
        return 'missing';
      }
      onActionTarget?.(r.el, spec.target.displayLabel);
      switch (spec.type) {
        case 'setInputValue': {
          const res = await withAutoMarker(r.el, () => applyInputValue(r.el, value ?? ''));
          if (res !== 'ok') return 'not-writable';
          if (String((r.el as HTMLInputElement).value ?? '') !== (value ?? '')) {
            throw new DriverFailure('action', 'verify-failed', `expected "${value}", got "${String((r.el as HTMLInputElement).value ?? '')}"`);
          }
          return 'ok';
        }
        case 'selectOption': {
          const container = antSelectContainerOf(r.el) ?? r.el;
          const res = await withAutoMarker(container, () => applySelectOption(container, value ?? ''));
          if (res === 'option-not-found') throw new DriverFailure('action', 'option-not-found', value ?? '');
          if (res !== 'ok') throw new DriverFailure('action', 'select-timeout', value ?? '');
          const text = readAntSelectText(container) ?? '';
          const wantCode = extractBracketCode(value ?? '');
          const gotCode = extractBracketCode(text);
          const matched =
            wantCode !== undefined ? gotCode === wantCode : normalizeText(text) === normalizeText(value ?? '');
          if (!matched) throw new DriverFailure('action', 'verify-failed', `expected "${value}", got "${text}"`);
          return 'ok';
        }
        case 'setCheckbox': {
          const res = await withAutoMarker(r.el, () => applyCheckbox(r.el, spec.checked === true));
          if (res !== 'ok') return 'not-writable';
          if (((r.el as HTMLInputElement).checked === true) !== (spec.checked === true)) {
            throw new DriverFailure('action', 'verify-failed', `expected checked=${String(spec.checked)}`);
          }
          return 'ok';
        }
        case 'clickButton': {
          const res = applyClickButton(r.el);
          if (res === 'ok') return 'ok';
          if (res === 'disabled') return 'disabled';
          if (res === 'submit-blacklisted') throw new DriverFailure('action', 'submit-blacklisted', spec.target.displayLabel);
          return 'not-writable';
        }
      }
    });
  const waitUntil = (
    cond: WaitCondition,
    timeoutMs: number,
    scope: DriverScope,
    evaluate: (value: unknown) => boolean,
    signal: AbortSignal,
  ): Promise<WaitOutcome> =>
    Promise.resolve().then(async () => {
      const deadline = Date.now() + timeoutMs;
      let lastSample: string | undefined;
      let stableCount = 0;
      while (true) {
        if (signal.aborted) return { outcome: 'timeout' };
        if (cond.kind === 'elementPresent') {
          const r = resolveTarget(cond.target, scope);
          if (!('error' in r)) return { outcome: 'satisfied' };
          if (r.error === 'ambiguous') throw new DriverFailure('wait', 'ambiguous', cond.target.displayLabel);
        } else if (cond.kind === 'elementAbsent') {
          const r = resolveTarget(cond.target, scope);
          if ('error' in r && r.error === 'not-found') return { outcome: 'satisfied' };
          // Ambiguity fails immediately (§5.1), same as presence: waiting it out would burn the whole
          // timeout and report a misleading "absence timeout" instead of the real locator problem
          if ('error' in r && r.error === 'ambiguous') {
            throw new DriverFailure('wait', 'ambiguous', cond.target.displayLabel);
          }
        } else {
          const sample = await read(cond.read, scope, signal);
          if (sample.ok) {
            if (nonEmptyData(cond.read.kind, sample.value)) {
              const serialized = JSON.stringify(sample.value);
              stableCount = serialized === lastSample ? stableCount + 1 : 1;
              lastSample = serialized;
              if (stableCount >= stabilitySamples && evaluate(sample.value)) {
                return { outcome: 'satisfied', value: sample.value };
              }
            } else {
              lastSample = undefined;
              stableCount = 0;
            }
          } else if (sample.reason === 'ambiguous') {
            throw new DriverFailure('wait', 'ambiguous', cond.read.kind);
          }
          if (Date.now() >= deadline) return { outcome: 'timeout' };
          await abortableSleep(stabilityIntervalMs, signal);
          continue;
        }
        if (Date.now() >= deadline) return { outcome: 'timeout' };
        await abortableSleep(pollIntervalMs, signal);
      }
    });

  return { read, act, waitUntil };
}
