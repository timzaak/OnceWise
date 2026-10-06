// Single source for the extension's standalone page locations: import.html (sidepanel settings
// and welcome page) and welcome.html (background on install) — renaming a page must not require
// hunting literals across entrypoints.
import { browser } from 'wxt/browser';

const IMPORT_PAGE_URL = '/import.html';
const WELCOME_PAGE_URL = '/welcome.html';

// Opening the extension's own page needs no tabs permission; the click is a user gesture anyway.
// Failures propagate to the caller — call sites that cannot surface them catch explicitly.
// The URL carries no ?edit prefill: flow revisions travel over the native channel
// (flow.read + flow.save), never through the import page.
export async function openImportPage(): Promise<void> {
  await browser.tabs.create({ url: browser.runtime.getURL(IMPORT_PAGE_URL) });
}

export async function openWelcomePage(): Promise<void> {
  await browser.tabs.create({ url: browser.runtime.getURL(WELCOME_PAGE_URL) });
}
