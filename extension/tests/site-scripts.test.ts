// Flow-site dynamic content-script chain (DEC-007): a flow's own site drives the registration set —
// first flow for a site registers (with a top-up for already-open tabs), the last flow leaving a site
// unregisters, cold-start reconcile repairs dropped registrations. fakeBrowser.shipping.* exists but
// throws "not implemented", so this suite provides the in-memory implementation the library's error
// message asks for.
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { contentScriptIdFor, syncFlowSiteScripts, pushReloadFlows } from '@/lib/site-scripts';
import { buildFlowStore, flowStoreItem } from '@/lib/storage';
import type { Flow } from '@/lib/flow-schema';

interface RegisteredScript {
  id: string;
  matches: string[];
  js: string[];
  runAt?: string;
  persistAcrossSessions?: boolean;
}

function makeFlow(site: string, id: string): Flow {
  return {
    id,
    schemaVersion: 1,
    name: `flow ${id}`,
    site,
    page: { urlIncludes: '/form' },
    trigger: { kind: 'pageEnter' },
    steps: { id: 'root', kind: 'sequence', steps: [] },
    status: 'draft',
    provenance: { source: 'import', createdAt: 1, updatedAt: 1 },
  } as unknown as Flow;
}

const registrations = new Map<string, RegisteredScript>();
let executeScriptCalls: number[] = [];
let reloadMessages: number[] = [];

beforeEach(() => {
  fakeBrowser.reset();
  registrations.clear();
  executeScriptCalls = [];
  reloadMessages = [];
  const scripting = fakeBrowser.scripting as unknown as Record<string, (arg: unknown) => Promise<unknown>>;
  scripting.getRegisteredContentScripts = async () => [...registrations.values()];
  scripting.registerContentScripts = async (scripts: unknown) => {
    for (const s of scripts as RegisteredScript[]) registrations.set(s.id, { ...s });
  };
  scripting.unregisterContentScripts = async (filter: unknown) => {
    for (const id of (filter as { ids: string[] }).ids) registrations.delete(id);
  };
  scripting.executeScript = async (arg: unknown) => {
    executeScriptCalls.push((arg as { target: { tabId: number } }).target.tabId);
    return [];
  };
  (fakeBrowser.tabs as unknown as Record<string, (arg: unknown) => Promise<unknown[]>>).query = async () => [
    { id: 7 },
  ];
  (fakeBrowser.tabs as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>).sendMessage = async (
    tabId: unknown,
  ) => {
    reloadMessages.push(tabId as number);
    return { ok: true };
  };
});

describe('registration parameters', () => {
  it('contentScriptIdFor never starts with an underscore (Chrome rejects those)', () => {
    const id = contentScriptIdFor('https://www.example.com');
    expect(id.startsWith('ssba-site-')).toBe(true);
    expect(id.startsWith('_')).toBe(false);
  });

  it('the first flow of a site registers the content script with per-origin matches and tops up open tabs', async () => {
    await flowStoreItem.setValue(buildFlowStore([makeFlow('https://www.example.com', 'r1')]));
    await syncFlowSiteScripts();
    expect(registrations.size).toBe(1);
    const script = [...registrations.values()][0]!;
    expect(script.matches).toEqual(['https://www.example.com/*']);
    expect(script.js).toEqual(['/content-scripts/content.js']);
    expect(script.runAt).toBe('document_idle');
    expect(script.persistAcrossSessions).toBe(true);
    // the tab already open before the registration existed gets the direct injection
    expect(executeScriptCalls).toEqual([7]);
  });

  it('sync is idempotent and does not re-inject already-registered sites', async () => {
    await flowStoreItem.setValue(buildFlowStore([makeFlow('https://www.example.com', 'r1')]));
    await syncFlowSiteScripts();
    await syncFlowSiteScripts();
    expect(registrations.size).toBe(1);
    expect(executeScriptCalls).toEqual([7]);
  });

  it('the last flow leaving a site unregisters its content script', async () => {
    await flowStoreItem.setValue(buildFlowStore([makeFlow('https://a.example.com', 'r1'), makeFlow('https://b.example.com', 'r2')]));
    await syncFlowSiteScripts();
    await flowStoreItem.setValue(buildFlowStore([makeFlow('https://b.example.com', 'r2')]));
    await syncFlowSiteScripts();
    expect([...registrations.values()].map((s) => s.matches)).toEqual([['https://b.example.com/*']]);
  });

  it('cold-start reconcile repairs registrations the profile dropped', async () => {
    await flowStoreItem.setValue(buildFlowStore([makeFlow('https://www.example.com', 'r1')]));
    await syncFlowSiteScripts();
    registrations.clear(); // drift: registration lost while the flow (and its site) remains
    await syncFlowSiteScripts();
    expect(registrations.size).toBe(1);
    expect([...registrations.values()][0]!.matches).toEqual(['https://www.example.com/*']);
  });

  it('pushReloadFlows tells flow-site tabs to reload their flow set', async () => {
    await flowStoreItem.setValue(buildFlowStore([makeFlow('https://www.example.com', 'r1')]));
    await pushReloadFlows();
    expect(reloadMessages).toEqual([7]);
  });
});
