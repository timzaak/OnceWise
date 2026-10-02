// Resolution order: id > name > labelText+componentType > placeholder/ariaLabel > cssPath; each level collects
// document-wide candidates filtered by isVisible, and the first clue matching exactly 1 visible element wins.
// If all clues are exhausted without a unique match, resolution fails (prefer no action over wrong action:
// never guess on multiple candidates, never degrade to fuzzy matching).
import { antSelectContainerOf, buttonOf, isVisible, normalizeText } from './dom';
import type { ComponentType, FieldClues, FieldRef } from './flow-schema';

export type ResolveResult =
  | { el: Element }
  | { error: 'not-found' | 'ambiguous' | 'no-clues' };

// The string page.urlIncludes is matched against: pathname + hash with the hash's query string stripped
export function pageTargetOf(location: { pathname: string; hash: string }): string {
  const hash = location.hash.split('?')[0] ?? '';
  return `${location.pathname}${hash}`;
}

export function urlIncludesMatches(target: string, urlIncludes: string): boolean {
  return target.includes(urlIncludes);
}

function escapeAttrValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The test environment (happy-dom/Node) may not provide the CSS global; fall back to an equivalent escape
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

// Fallback selector: tag + id/name only, avoiding nth-child and dynamic classes
export function buildCssPath(el: Element): string | undefined {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && parts.length < 8) {
    const tag = cur.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') break;
    let sel = tag;
    if (cur.id) {
      parts.unshift(`${tag}#${cssEscape(cur.id)}`);
      break;
    }
    const name = cur.getAttribute('name');
    if (name) sel += `[name=${escapeAttrValue(name)}]`;
    parts.unshift(sel);
    cur = cur.parentElement;
  }
  return parts.length > 0 ? parts.join('>') : undefined;
}

export function inferComponentType(el: Element): ComponentType {
  if (antSelectContainerOf(el)) return 'antdSelect';
  if (buttonOf(el).tagName === 'BUTTON') return 'button';
  const tag = el.tagName;
  if (tag === 'INPUT' && (el as HTMLInputElement).type === 'checkbox') return 'checkbox';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return 'input';
  return 'other';
}

function labelTextOf(el: Element): string | undefined {
  const formItem = el.closest('.ant-form-item');
  const label = formItem?.querySelector('.ant-form-item-label')?.textContent;
  if (label && label.trim()) return label.trim();
  const id = el.getAttribute('id');
  if (id) {
    const forLabel = el.ownerDocument?.querySelector(`label[for=${escapeAttrValue(id)}]`)?.textContent;
    if (forLabel && forLabel.trim()) return forLabel.trim();
  }
  return undefined;
}

export function collectFieldRef(el: Element): FieldRef {
  const clues: FieldClues = {};
  if (el.id) clues.id = el.id;
  const name = el.getAttribute('name');
  if (name) clues.name = name;
  const labelText = labelTextOf(el);
  if (labelText) clues.labelText = labelText;
  const placeholder = el.getAttribute('placeholder');
  if (placeholder) clues.placeholder = placeholder;
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) clues.ariaLabel = ariaLabel;
  const cssPath = buildCssPath(el);
  if (cssPath) clues.cssPath = cssPath;

  const componentType = inferComponentType(el);
  const displayLabel = labelText ?? placeholder ?? ariaLabel ?? name ?? el.id ?? el.tagName.toLowerCase();

  return { clues, componentType, displayLabel };
}

function componentSelector(componentType: ComponentType): string | null {
  switch (componentType) {
    case 'input':
      return 'input';
    case 'antdSelect':
      return '.ant-select';
    case 'checkbox':
      return 'input[type="checkbox"]';
    case 'button':
      return 'button';
    case 'other':
      return null;
  }
}

function formItemLabelNormalized(el: Element): string | undefined {
  const label = el.closest('.ant-form-item')?.querySelector('.ant-form-item-label')?.textContent;
  const normalized = label !== undefined && label !== null ? normalizeText(label) : undefined;
  return normalized || undefined;
}

// antdSelect normalization: the matched element (its id sits on the Select inner search input) resolves to the
// closest .ant-select ancestor as the read/observe container
function normalizeResolved(el: Element, componentType: ComponentType): { el: Element } {
  if (componentType === 'antdSelect') {
    const container = antSelectContainerOf(el) ?? el;
    return { el: container };
  }
  return { el };
}

function clueLevels(field: FieldRef): { sel: string | null; kind: string }[] {
  const clues = field.clues ?? {};
  const levels: { sel: string | null; kind: string }[] = [];
  if (clues.id) levels.push({ sel: `#${cssEscape(clues.id)}`, kind: 'id' });
  if (clues.name) levels.push({ sel: `[name=${escapeAttrValue(clues.name)}]`, kind: 'name' });
  if (clues.labelText && field.componentType !== 'other') {
    const compSel = componentSelector(field.componentType);
    if (compSel) levels.push({ sel: compSel, kind: 'labelText' });
  }
  if (clues.placeholder) levels.push({ sel: `[placeholder=${escapeAttrValue(clues.placeholder)}]`, kind: 'placeholder' });
  if (clues.ariaLabel) levels.push({ sel: `[aria-label=${escapeAttrValue(clues.ariaLabel)}]`, kind: 'ariaLabel' });
  if (clues.cssPath) levels.push({ sel: clues.cssPath, kind: 'cssPath' });
  return levels;
}

// The clue-ladder walk over an injectable candidate collector: yields each level's visible matches
// strongest-first. `collect` returns the raw candidates for a selector (null = selector invalid at
// runtime, level skipped). Document-wide resolution passes querySelectorAll; scoped resolution
// (flow-dom `within`) passes a member + region collector. Consumers only decide what a level's
// visible hits mean — the level order and the labelText/visibility filters exist once.
function* visibleLevelCandidates(
  field: FieldRef,
  collect: (sel: string) => Element[] | null,
): Generator<Element[]> {
  const clues = field.clues ?? {};
  for (const level of clueLevels(field)) {
    if (!level.sel) continue;
    const candidates = collect(level.sel);
    if (candidates === null) continue;
    let filtered = candidates;
    if (level.kind === 'labelText' && clues.labelText) {
      const want = normalizeText(clues.labelText);
      filtered = filtered.filter((el) => formItemLabelNormalized(el) === want);
    }
    yield filtered.filter(isVisible);
  }
}

// Unique visible match wins, ambiguity is remembered, no guessing.
export function resolveWithCandidates(field: FieldRef, collect: (sel: string) => Element[] | null): ResolveResult {
  if (clueLevels(field).length === 0) return { error: 'no-clues' };

  let sawAmbiguous = false;
  for (const visible of visibleLevelCandidates(field, collect)) {
    if (visible.length === 1) {
      const winner = visible[0];
      if (winner) return normalizeResolved(winner, field.componentType);
    }
    if (visible.length > 1) sawAmbiguous = true;
  }
  return sawAmbiguous ? { error: 'ambiguous' } : { error: 'not-found' };
}

export function resolveField(doc: ParentNode, field: FieldRef): ResolveResult {
  return resolveWithCandidates(field, (sel) => {
    try {
      return Array.from(doc.querySelectorAll(sel));
    } catch {
      return null;
    }
  });
}

export type ResolveAllResult = { els: Element[] } | { error: 'not-found' | 'no-clues' };

// Collection members: the first clue level with at least one visible match returns ALL its visible
// matches — multiple hits are the point here, not an ambiguity. Use for `read { kind: 'collection' }`
// targets whose clues match every member (typically cssPath/ariaLabel).
export function resolveFieldAll(doc: ParentNode, field: FieldRef): ResolveAllResult {
  if (clueLevels(field).length === 0) return { error: 'no-clues' };
  for (const visible of visibleLevelCandidates(field, (sel) => {
    try {
      return Array.from(doc.querySelectorAll(sel));
    } catch {
      return null;
    }
  })) {
    if (visible.length > 0) return { els: visible };
  }
  return { error: 'not-found' };
}
