// Flow-site dynamic content scripts (DEC-007): content scripts are never in the manifest; the
// background registers/unregisters them per flow site — every flow carries its own `site`, so the set
// of flow sites is the single source of the injection surface (no separate site-authorization state).
// All scripting.* privileged operations live here (background only).
import { browser } from 'wxt/browser';
import type { Browser } from '@wxt-dev/browser';
import { djb2 } from './flow-schema';
import { loadFlows } from './storage';
import { sendTabMessage } from './messaging';
import { gcHandovers } from './flow-handover';

type Tab = Browser.tabs.Tab;

const CONTENT_SCRIPT_FILE = '/content-scripts/content.js';

// Registration ids must not start with an underscore (Chrome rejects those)
export function contentScriptIdFor(origin: string): string {
  return `ssba-site-${djb2(origin)}`;
}

export async function flowSiteOrigins(): Promise<string[]> {
  return [...new Set((await loadFlows()).map((r) => r.site))];
}

async function queryFlowSiteTabs(origins: string[]): Promise<Tab[]> {
  return (
    await Promise.all(
      origins.map((origin) => browser.tabs.query({ url: `${origin}/*` }).catch(() => [] as Tab[])),
    )
  ).flat();
}

// Run `act` on every open flow-site tab; per-tab failures (unreachable/discarded tabs) are swallowed so
// one bad tab never blocks the others.
async function forFlowSiteTabs(origins: string[], act: (tabId: number) => Promise<unknown>): Promise<void> {
  const tabs = await queryFlowSiteTabs(origins);
  await Promise.all(
    tabs.map((tab) => (tab.id === undefined ? Promise.resolve() : act(tab.id).catch(() => undefined))),
  );
}

// Tabs on flow sites are told to reload their flow set after a flows write, so already-open pages pick
// up enable/pause/delete immediately (pages whose last flow was deleted converge through the content
// script's own polling: ct:getEnabledFlows returns an empty list and the supervision cancels runs).
// afterFlowsWrite passes the origins it already read for the registration sync.
export async function pushReloadFlows(origins?: string[]): Promise<void> {
  await forFlowSiteTabs(origins ?? (await flowSiteOrigins()), (tabId) =>
    sendTabMessage(tabId, { type: 'bg:reloadFlows' }),
  );
}

// Every open tab on a flow site — routing candidates for the background's bg:* forwarding
export async function flowSiteTabs(): Promise<Tab[]> {
  return queryFlowSiteTabs(await flowSiteOrigins());
}

async function registerSite(origin: string): Promise<void> {
  await browser.scripting.registerContentScripts([
    {
      id: contentScriptIdFor(origin),
      matches: [`${origin}/*`],
      js: [CONTENT_SCRIPT_FILE],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
}

// Already-open tabs never received the content script (it was not registered when they loaded); inject it
// directly. Idempotency is handled by the content script's own window flag.
async function injectIntoOpenTabs(origin: string): Promise<void> {
  await forFlowSiteTabs([origin], (tabId) =>
    browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] }),
  );
}

// Reconcile dynamic content-script registrations with the set of flow sites: register origins that
// gained their first flow (topping up already-open tabs) and unregister registrations whose last flow
// is gone. Runs after every flows write and on every SW cold start — persistAcrossSessions keeps
// registrations across restarts, so the cold-start pass only repairs drift (e.g. dropped registrations).
export async function syncFlowSiteScripts(origins?: string[]): Promise<void> {
  origins ??= await flowSiteOrigins();
  const registered = await browser.scripting.getRegisteredContentScripts().catch(() => []);
  const ours = new Set(registered.filter((s) => s.id.startsWith('ssba-site-')).map((s) => s.id));
  const expectedIds = new Set(origins.map(contentScriptIdFor));
  await Promise.all(
    origins.map(async (origin) => {
      if (ours.has(contentScriptIdFor(origin))) return;
      // Registration (serves future navigations) and the already-open-tab top-up are independent —
      // host permissions come from the manifest, not from the registration
      await Promise.all([registerSite(origin).catch(() => undefined), injectIntoOpenTabs(origin)]);
    }),
  );
  const stale = [...ours].filter((id) => !expectedIds.has(id));
  if (stale.length > 0) {
    await browser.scripting.unregisterContentScripts({ ids: stale }).catch(() => undefined);
  }
}

// The single ordered post-flows-write step shared by every flows-write path that can change the
// flow-site set (background save/delete, sync-service pull): reconcile dynamic registrations with the
// new site set, cancel handovers whose flow identity broke under the write (pause/delete/replace —
// the GC reads the post-write store), then tell already-open flow-site tabs to reload. Origins are
// read once and shared by all three halves.
export async function afterFlowsWrite(): Promise<void> {
  const origins = await flowSiteOrigins();
  await Promise.all([syncFlowSiteScripts(origins), gcHandovers()]);
  await pushReloadFlows(origins);
}
