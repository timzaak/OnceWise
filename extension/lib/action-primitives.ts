import {
  buttonDisabled,
  buttonOf,
  dispatchPointerClick,
  normalizeText,
  setReactInputValue,
  sleep,
  waitFor,
} from './dom';
import { isSubmitForbiddenText } from './flow-schema';

// Loop protection: mark target elements with a source attribute during automatic writes and remove it afterwards;
// observers ignore changes carrying the mark
export const AUTO_MARKER = 'data-ssba-auto';

// 'disabled' is a skip-worthy state (engine maps it to a logged skip, DEC-010), not a failure
export type PrimitiveResult = 'ok' | 'not-writable' | 'timeout' | 'option-not-found' | 'disabled' | 'submit-blacklisted';

export async function withAutoMarker<T>(el: Element, fn: () => Promise<T> | T): Promise<T> {
  el.setAttribute(AUTO_MARKER, '1');
  try {
    return await fn();
  } finally {
    el.removeAttribute(AUTO_MARKER);
  }
}

export function carriesAutoMarker(el: Element | null): boolean {
  return el !== null && el.closest(`[${AUTO_MARKER}]`) !== null;
}

export function applyInputValue(el: Element, value: string): PrimitiveResult {
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return 'not-writable';
  if (el.hasAttribute('disabled') || el.readOnly) return 'not-writable';
  setReactInputValue(el as HTMLInputElement, value);
  return 'ok';
}

export function applyCheckbox(el: Element, checked: boolean): PrimitiveResult {
  if (!(el instanceof HTMLInputElement) || el.type !== 'checkbox') return 'not-writable';
  if (el.disabled) return 'not-writable';
  if (el.checked !== checked) dispatchPointerClick(el);
  return 'ok';
}

// DEC-010: submit-class buttons (save/submit/confirm) are allowed to execute; the forbidden family
// (delete/remove/pay/order/publish) is rejected at validation time and re-checked here at run time — the
// resolved button can differ from the displayLabel the flow was validated against (clue drift, page
// redesign), and irreversible actions stay refused. A disabled button is reported as 'disabled' (skip),
// not a failure.
export function applyClickButton(el: Element): PrimitiveResult {
  const button = buttonOf(el);
  if (button.tagName !== 'BUTTON') return 'not-writable';
  if (buttonDisabled(button)) return 'disabled';
  if (isSubmitForbiddenText(button.textContent ?? '')) return 'submit-blacklisted';
  dispatchPointerClick(button);
  return 'ok';
}

export async function applyWaitForElement(probe: () => boolean, timeoutMs: number): Promise<'ok' | 'timeout'> {
  return (await waitFor(probe, { timeoutMs, intervalMs: 200 })) ? 'ok' : 'timeout';
}

function findOpenDropdown(doc: Document): Element | null {
  for (const dd of Array.from(doc.querySelectorAll('.ant-select-dropdown'))) {
    if (!dd.classList.contains('ant-select-dropdown-hidden') && dd.getBoundingClientRect().height > 0) {
      return dd;
    }
  }
  return null;
}

async function openDropdown(container: Element): Promise<Element | null> {
  const doc = container.ownerDocument;
  dispatchPointerClick(container.querySelector('.ant-select-selector') ?? container);
  const opened = await waitFor(() => findOpenDropdown(doc) !== null, { intervalMs: 100, timeoutMs: 3000 });
  return opened ? findOpenDropdown(doc) : null;
}

async function closeDropdown(container: Element): Promise<void> {
  const doc = container.ownerDocument;
  dispatchPointerClick(container.querySelector('.ant-select-selector') ?? container);
  await waitFor(() => findOpenDropdown(doc) === null, { intervalMs: 100, timeoutMs: 2000 });
}

function optionTextOf(option: Element): string {
  return (
    option.querySelector('.ant-select-item-option-content')?.textContent ??
    option.getAttribute('title') ??
    option.textContent ??
    ''
  );
}

// Scroll the rc-virtual-list to iterate all options (a single DOM snapshot only shows visible items).
// Returns the first option for which visit returned true (document order — the list scrolls top-down),
// or null when the scan completed without a match.
async function scanVirtualList(
  dropdown: Element,
  visit: (option: Element, text: string) => boolean,
): Promise<Element | null> {
  const holder = dropdown.querySelector('.rc-virtual-list-holder');
  let scrollTop = 0;
  const step = () => (holder ? holder.clientHeight : 200);
  let guard = 0;
  while (guard++ < 200) {
    if (holder) holder.scrollTop = scrollTop;
    await sleep(50);
    for (const option of Array.from(dropdown.querySelectorAll('.ant-select-item-option'))) {
      if (visit(option, optionTextOf(option))) return option;
    }
    if (!holder) return null;
    if (scrollTop + holder.clientHeight >= holder.scrollHeight - 1) return null;
    scrollTop += step();
  }
  return null;
}

export async function applySelectOption(container: Element, optionText: string): Promise<PrimitiveResult> {
  const doc = container.ownerDocument;
  const dropdown = await openDropdown(container);
  if (!dropdown) return 'timeout';
  const want = normalizeText(optionText);
  const option = await scanVirtualList(dropdown, (_o, text) => normalizeText(text) === want);
  if (!option) {
    await closeDropdown(container);
    return 'option-not-found';
  }
  dispatchPointerClick(option);
  const closed = await waitFor(() => findOpenDropdown(doc) === null, { intervalMs: 100, timeoutMs: 3000 });
  if (!closed) return 'timeout';
  return 'ok';
}
