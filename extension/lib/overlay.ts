// Overlay nodes (highlight boxes) use ssba- prefixed classes + inline styles to stay
// independent of host page styles; they are removed on mode exit / page unload to prevent duplicate injection.
type Cleanup = () => void;

const Z_INDEX = '2147483000';

function baseStyle(el: HTMLElement, extra: Partial<CSSStyleDeclaration>): void {
  el.style.setProperty('all', 'initial');
  Object.assign(el.style, {
    position: 'fixed',
    zIndex: Z_INDEX,
    boxSizing: 'border-box',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    ...extra,
  });
}

function outlineBox(doc: Document, rect: DOMRect): HTMLElement {
  const box = doc.createElement('div');
  box.className = 'ssba-highlight';
  baseStyle(box, {
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    border: '2px solid #2563eb',
    borderRadius: '4px',
    background: 'rgba(37, 99, 235, 0.08)',
    pointerEvents: 'none',
  });
  return box;
}

// Highlight boxes track the element's current position; a box is removed automatically once its element leaves the document
export function highlightElements(doc: Document, els: Element[], opts: { color?: string } = {}): Cleanup {
  const boxes = new Map<Element, HTMLElement>();
  const sync = () => {
    // Batch all reads before all writes to avoid interleaved layout thrash
    const rects = new Map<Element, DOMRect>();
    for (const el of els) rects.set(el, (el as HTMLElement).getBoundingClientRect());
    for (const el of els) {
      const rect = rects.get(el);
      if (!rect) continue;
      const inDoc = el.isConnected && rect.width + rect.height > 0;
      let box = boxes.get(el);
      if (!inDoc) {
        box?.remove();
        boxes.delete(el);
        continue;
      }
      if (!box) {
        box = outlineBox(doc, rect);
        if (opts.color) {
          box.style.border = `2px solid ${opts.color}`;
          box.style.background = `${opts.color}14`;
        }
        doc.documentElement.appendChild(box);
        boxes.set(el, box);
      }
      box.style.top = `${rect.top}px`;
      box.style.left = `${rect.left}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    }
  };
  sync();
  // Observer storms coalesce to at most one sync per animation frame
  let frame: number | null = null;
  const schedule = () => {
    if (frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      sync();
    });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true });
  return () => {
    observer.disconnect();
    if (frame !== null) window.cancelAnimationFrame(frame);
    for (const box of boxes.values()) box.remove();
    boxes.clear();
  };
}
