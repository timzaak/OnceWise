// Single source for the import page location: the sidepanel settings open it via tabs.create and the
// background opens it once on install — renaming the page must not require hunting literals
// across entrypoints.
import { browser } from 'wxt/browser';

export const IMPORT_PAGE_URL = '/import.html';

// Opening the extension's own page needs no tabs permission; the click is a user gesture anyway.
// Failures propagate to the caller — call sites that cannot surface them catch explicitly.
// The URL carries no ?edit prefill: flow revisions travel over the native channel
// (flow.read + flow.save), never through the import page.
export async function openImportPage(): Promise<void> {
  await browser.tabs.create({ url: browser.runtime.getURL(IMPORT_PAGE_URL) });
}
