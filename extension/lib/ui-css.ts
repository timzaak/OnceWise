// Shared page-level CSS for the extension's own pages (sidepanel + import page): identical reset,
// typography, cards, badges, buttons and callout boxes behind a per-page class prefix, so the two
// surfaces share one set of design tokens. Page-specific layout flows stay in each entrypoint.
export interface BaseCssOptions {
  btnMinHeight: string;
  btnPaddingX: string;
  cardPadding: string;
  cardGap: string;
}

export function baseCss(p: string, opts: BaseCssOptions): string {
  return `
:root {
  color-scheme: light;
  --ow-ink: #151515;
  --ow-muted: #626262;
  --ow-canvas: #f7f7f5;
  --ow-surface: #ffffff;
  --ow-line: #e2e2e0;
  --ow-action: #151515;
  --ow-action-hover: #333333;
  --ow-accent: #008f83;
  --ow-accent-soft: #e8f7f4;
  --ow-success: #08786f;
  --ow-warning: #805d13;
  --ow-danger: #a43232;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.5; color: var(--ow-ink); background: var(--ow-canvas); }
#root { min-height: 100vh; display: flex; flex-direction: column; }
button, input, select, textarea { font: inherit; }
.${p}-card { background: var(--ow-surface); border: 1px solid var(--ow-line); border-radius: 6px; padding: ${opts.cardPadding}; display: flex; flex-direction: column; gap: ${opts.cardGap}; min-width: 0; }
.${p}-title { font-size: 16px; line-height: 1.35; font-weight: 700; margin: 0; overflow-wrap: anywhere; }
.${p}-sub { font-size: 12px; color: var(--ow-muted); margin: 0; overflow-wrap: anywhere; }
.${p}-desc { font-size: 13px; color: #3d3d3d; margin: 0; line-height: 1.6; overflow-wrap: anywhere; }
.${p}-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.${p}-badge { display: inline-flex; align-items: center; width: fit-content; min-height: 22px; font-size: 11px; line-height: 1.2; font-weight: 650; padding: 2px 8px; border-radius: 4px; border: 1px solid #cececa; color: #555; background: #f5f5f3; }
.${p}-badge.enabled { border-color: #b6dcd5; color: var(--ow-success); background: var(--ow-accent-soft); }
.${p}-badge.paused { border-color: #e9d39b; color: var(--ow-warning); background: #fff5d6; }
.${p}-btn { min-height: ${opts.btnMinHeight}; padding: 6px ${opts.btnPaddingX}; font-size: 13px; font-weight: 600; border-radius: 5px; border: 1px solid #cececa; background: var(--ow-surface); color: var(--ow-ink); cursor: pointer; transition: background-color .15s, border-color .15s; }
.${p}-btn:hover:not(:disabled) { background: #f2f2f0; border-color: #aaa9a5; }
.${p}-btn:focus-visible { outline: 2px solid var(--ow-accent); outline-offset: 2px; }
.${p}-btn:active:not(:disabled) { background: #e9e9e6; }
.${p}-btn:disabled { opacity: 0.5; cursor: default; }
.${p}-btn.primary { background: var(--ow-action); border-color: var(--ow-action); color: #ffffff; }
.${p}-btn.primary:hover:not(:disabled) { background: var(--ow-action-hover); border-color: var(--ow-action-hover); }
.${p}-btn.danger { border-color: #e2b8b8; color: var(--ow-danger); }
.${p}-btn.danger:hover:not(:disabled) { background: #fff1f0; border-color: #d89e9e; }
.${p}-error { font-size: 12px; color: var(--ow-danger); margin: 0; }
.${p}-hint { font-size: 12px; line-height: 1.5; color: var(--ow-muted); margin: 0; }
.${p}-warn { font-size: 12px; color: var(--ow-warning); background: #fff5d6; border: 1px solid #e9d39b; border-radius: 5px; padding: 8px 10px; margin: 0; }
@media (prefers-reduced-motion: reduce) { .${p}-btn { transition: none; } }
`;
}
