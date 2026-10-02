// Sync persistence (data-sync): local:syncConfig / local:syncLinks / local:syncUi, never sync:.
// Writes happen only from background (single writer) plus unit tests, via serializeStorageWrite.
//
// No-account model: the server keeps no identity, so the set of spaces a device knows is itself local
// state — {id, key, name} triples, where the key is the device's only copy of the space credential
// (the server stores a hash). Space membership lives nowhere else; losing this profile loses access.
import { storage } from 'wxt/utils/storage';
import { serializeStorageWrite } from './storage';

export interface SyncSpaceEntry {
  id: string;
  // The space access key — the only recoverable copy lives here (server stores a SHA-256 hash)
  key: string;
  name: string;
  createdAt: string;
}

export interface SyncConfigData {
  // The official deployment by default; only ever rewritten to a parsed origin
  serverUrl: string;
  spaces: SyncSpaceEntry[];
}

// Local version pinning (pure client-side concept): never stored on the Flow object (the Flow
// schema is hard-validated with no migration path). flowId ↔ (spaceId, scriptId) is 1:1 both ways.
export interface SyncLink {
  flowId: string;
  spaceId: string;
  scriptId: string;
  // Display fallback when the local flow has been deleted but the link remains
  scriptName: string;
  pinnedVersionNumber: number;
  pinnedContentHash: string;
}

export interface SyncUiData {
  currentSpaceId: string | null;
}

// The shipped default sync server: fresh installs start pre-configured against the official
// deployment (the user can still point the extension at any other origin from the sync panel).
export const DEFAULT_SYNC_SERVER_URL = 'https://auto.fornetcode.com';

export const syncConfigItem = storage.defineItem('local:syncConfig', {
  fallback: { serverUrl: DEFAULT_SYNC_SERVER_URL, spaces: [] } as SyncConfigData,
});
export const syncLinksItem = storage.defineItem('local:syncLinks', { fallback: [] as SyncLink[] });
export const syncUiItem = storage.defineItem('local:syncUi', { fallback: { currentSpaceId: null } as SyncUiData });

export async function loadSyncConfig(): Promise<SyncConfigData> {
  return syncConfigItem.getValue();
}

export function writeSyncConfig(data: SyncConfigData): Promise<void> {
  return serializeStorageWrite(() => syncConfigItem.setValue(data));
}

// Switching servers: everything fetched from the old server (spaces, links, selection) is
// meaningless for the new one; local flows are untouched
export function resetSyncForServer(serverUrl: string): Promise<void> {
  return serializeStorageWrite(async () => {
    await syncConfigItem.setValue({ serverUrl, spaces: [] });
    await syncLinksItem.setValue([]);
    await syncUiItem.setValue({ currentSpaceId: null });
  });
}

export function findSpace(config: SyncConfigData, spaceId: string): SyncSpaceEntry | undefined {
  return config.spaces.find((s) => s.id === spaceId);
}

export function upsertSyncSpace(entry: SyncSpaceEntry): Promise<void> {
  return serializeStorageWrite(async () => {
    const config = await syncConfigItem.getValue();
    const spaces = config.spaces.filter((s) => s.id !== entry.id);
    await syncConfigItem.setValue({ ...config, spaces: [...spaces, entry] });
  });
}

// Local forget also drops that space's links and clears the selection pointing at it (callers pass
// the current selection back in so the UI state stays consistent in one write)
export function forgetSpace(spaceId: string): Promise<void> {
  return serializeStorageWrite(async () => {
    const config = await syncConfigItem.getValue();
    await syncConfigItem.setValue({
      ...config,
      spaces: config.spaces.filter((s) => s.id !== spaceId),
    });
    await syncLinksItem.setValue((await syncLinksItem.getValue()).filter((l) => l.spaceId !== spaceId));
    const ui = await syncUiItem.getValue();
    if (ui.currentSpaceId === spaceId) await syncUiItem.setValue({ currentSpaceId: null });
  });
}

export async function loadSyncLinks(): Promise<SyncLink[]> {
  return syncLinksItem.getValue();
}

export function findLinkByFlow(links: SyncLink[], flowId: string): SyncLink | undefined {
  return links.find((l) => l.flowId === flowId);
}

export function findLinkByScript(links: SyncLink[], spaceId: string, scriptId: string): SyncLink | undefined {
  return links.find((l) => l.spaceId === spaceId && l.scriptId === scriptId);
}

// Upsert while enforcing the 1:1 mapping: a flow links to at most one script and a script to at most
// one flow — a conflicting link on either side is replaced, not duplicated
export function upsertSyncLink(link: SyncLink): Promise<void> {
  return serializeStorageWrite(async () => {
    const links = (await syncLinksItem.getValue()).filter(
      (l) => l.flowId !== link.flowId && !(l.spaceId === link.spaceId && l.scriptId === link.scriptId),
    );
    await syncLinksItem.setValue([...links, link]);
  });
}

export function removeSyncLink(flowId: string): Promise<void> {
  return serializeStorageWrite(async () => {
    await syncLinksItem.setValue((await syncLinksItem.getValue()).filter((l) => l.flowId !== flowId));
  });
}

export function setSyncCurrentSpace(spaceId: string | null): Promise<void> {
  return serializeStorageWrite(async () => {
    await syncUiItem.setValue({ currentSpaceId: spaceId });
  });
}

export async function loadSyncUi(): Promise<SyncUiData> {
  return syncUiItem.getValue();
}
