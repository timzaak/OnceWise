// Shared display vocabulary for the extension pages (sidepanel + import page): status labels and time
// formatting live here once so the two surfaces cannot drift apart on wording.
// The label strings themselves come from lib/i18n (English-first, zh available).
import { statusLabel } from './i18n';

export { statusLabel };

export function formatTime(ts: number, opts: { withYear?: boolean; withSeconds?: boolean } = {}): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = opts.withYear
    ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return opts.withSeconds === false ? `${date} ${clock}` : `${date} ${clock}:${pad(d.getSeconds())}`;
}
