// Sync persistence (data-sync): local:syncConfig / local:syncLinks / local:syncUi / local:syncAuth,
// never sync:. Writes happen only from background (single writer) plus unit tests, via
// serializeStorageWrite.
//
// No-account model: the server keeps no identity, so the set of spaces a device knows is itself local
// state — {id, key, name} triples, where the key is the device's only copy of the space credential
// (the server stores a hash). Space membership lives nowhere else; losing this profile loses access.
import { storage } from 'wxt/utils/storage';
import { isPlainObject } from './flow-schema';
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

// The device's sign-in credentials for one sync server (Herald-gated deployments). Tokens live
// here and nowhere else — never in flows, sync payloads, URLs or logs. `epoch` invalidates stale
// async writers: every sign-out / server switch / new sign-in bumps it, and a guarded write only
// lands while the snapshot it was based on is still current (A→B→A and late refreshes cannot
// resurrect or clobber a session).
export interface SyncAuthData {
  serverUrl: string;
  accessToken: string;
  refreshToken: string;
  // ms epoch when the access token expires (receivedAt + remaining seconds); 0 when signed out
  accessTokenExpiresAt: number;
  epoch: number;
}

export const EMPTY_SYNC_AUTH: SyncAuthData = {
  serverUrl: '',
  accessToken: '',
  refreshToken: '',
  accessTokenExpiresAt: 0,
  epoch: 0,
};

export const syncAuthItem = storage.defineItem('local:syncAuth', { fallback: { ...EMPTY_SYNC_AUTH } });

export function isValidSyncAuthData(v: unknown): v is SyncAuthData {
  return (
    isPlainObject(v) &&
    typeof v.serverUrl === 'string' &&
    typeof v.accessToken === 'string' &&
    typeof v.refreshToken === 'string' &&
    typeof v.accessTokenExpiresAt === 'number' &&
    Number.isFinite(v.accessTokenExpiresAt) &&
    Number.isSafeInteger(v.epoch)
  );
}

// A malformed record is treated as signed out, never thrown: it can only come from a torn or
// foreign write, and treating it as credentials would be worse than asking for a fresh sign-in.
export async function loadSyncAuth(): Promise<SyncAuthData> {
  const v = await syncAuthItem.getValue();
  return isValidSyncAuthData(v) ? v : { ...EMPTY_SYNC_AUTH };
}

export function clearedSyncAuth(serverUrl: string, epoch: number): SyncAuthData {
  return { serverUrl, accessToken: '', refreshToken: '', accessTokenExpiresAt: 0, epoch };
}

// The snapshot a guarded auth write must still match: the config server plus the auth record's
// server/epoch (and the refresh token for rotations), re-read inside the storage lock.
export interface AuthWriteGuard {
  serverUrl: string;
  epoch: number;
  refreshToken?: string;
}

// Guarded full-record write: nothing lands unless the config server and the current auth snapshot
// still match the guard — a late async writer can neither resurrect a signed-out session nor
// clobber a newer sign-in. Returns false when the guard no longer matched.
export function commitAuthIfCurrent(record: SyncAuthData, guard: AuthWriteGuard): Promise<boolean> {
  return serializeStorageWrite(async () => {
    const [config, auth] = await Promise.all([syncConfigItem.getValue(), syncAuthItem.getValue()]);
    if (config.serverUrl !== guard.serverUrl) return false;
    if (auth.serverUrl !== guard.serverUrl || auth.epoch !== guard.epoch) return false;
    if (guard.refreshToken !== undefined && auth.refreshToken !== guard.refreshToken) return false;
    await syncAuthItem.setValue(record);
    return true;
  });
}

// Unguarded epoch bump-and-clear shared by the two serialized sections below — they cannot call
// clearAuthForServer itself because serializeStorageWrite forbids re-entry (nested sections would
// deadlock). Returns the new epoch.
async function bumpAndClearAuth(serverUrl: string): Promise<number> {
  const auth = await syncAuthItem.getValue();
  const epoch = (isValidSyncAuthData(auth) ? auth.epoch : 0) + 1;
  await syncAuthItem.setValue(clearedSyncAuth(serverUrl, epoch));
  return epoch;
}

// Clear the sign-in state while keeping the epoch monotonically increasing (never reset to 0) —
// in-flight writers of the old session go stale the moment this lands. Returns the new epoch.
export async function clearAuthForServer(serverUrl: string): Promise<number> {
  return serializeStorageWrite(() => bumpAndClearAuth(serverUrl));
}

export async function loadSyncConfig(): Promise<SyncConfigData> {
  return syncConfigItem.getValue();
}

export function writeSyncConfig(data: SyncConfigData): Promise<void> {
  return serializeStorageWrite(() => syncConfigItem.setValue(data));
}

// Switching servers: everything fetched from the old server (spaces, links, selection) is
// meaningless for the new one; local flows are untouched. The old server's sign-in state is
// cleared in the same serialized section (epoch bumped) so config and auth never diverge.
export function resetSyncForServer(serverUrl: string): Promise<void> {
  return serializeStorageWrite(async () => {
    await syncConfigItem.setValue({ serverUrl, spaces: [] });
    await syncLinksItem.setValue([]);
    await syncUiItem.setValue({ currentSpaceId: null });
    await bumpAndClearAuth(serverUrl);
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
