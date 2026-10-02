export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Button labels contain embedded spaces (common in two-character CJK labels); strip all whitespace before matching
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, '');
}

export function isVisible(el: Element): boolean {
  return el.getClientRects().length > 0;
}

// Reduce a possibly-inner element to the button it belongs to (itself when already a button; unchanged
// when no button ancestor) — single authority for engine submit-class checks, primitive clicks and
// component-type inference so the three cannot drift apart
export function buttonOf(el: Element): Element {
  if (el.tagName === 'BUTTON') return el;
  return el.closest('button') ?? el;
}

export function buttonDisabled(el: Element): boolean {
  return el instanceof HTMLButtonElement ? el.disabled : el.hasAttribute('disabled');
}

// React controlled components: assigning input.value directly does not update form state; use the native setter and dispatch input/change events
export function setReactInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// antd buttons occasionally only gain focus on synthetic clicks without firing the request; dispatch the full pointer event sequence
export function dispatchPointerClick(el: Element): void {
  const init: MouseEventInit = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new PointerEvent('pointerdown', init));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  el.dispatchEvent(new PointerEvent('pointerup', init));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.dispatchEvent(new MouseEvent('click', init));
}

export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export async function waitFor(cond: () => boolean, opts: WaitOptions = {}): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  while (true) {
    if (cond()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

// antd select selected item text (format `name[code]`)
export function readAntSelectText(container: Element): string | null {
  return container.querySelector('.ant-select-selection-item')?.textContent ?? null;
}

// Extract the code inside the trailing brackets, e.g. `warehouse_name[UKBHHC_SHOPIFY]` -> UKBHHC_SHOPIFY
export function extractBracketCode(text: string): string | undefined {
  return text.match(/\[([^\[\]]+)\]\s*$/)?.[1];
}

// The antd Select id sits on the inner search input; the observe/read container must be the .ant-select ancestor
export function antSelectContainerOf(el: Element): Element | null {
  return el.closest('.ant-select');
}
