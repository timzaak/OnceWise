import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import { businessClaimsItem, onboardingItem, flowStoreItem } from '@/lib/storage';
import { SYNC_AUTH_OP_TIMEOUT_MS, SYNC_SIGN_IN_TIMEOUT_MS, SYNC_TIMEOUT_MS } from '@/lib/messaging';
import { AUTHED_OP_BUDGET_MS, NONE_OP_BUDGET_MS, SIGN_IN_BUDGET_MS } from '@/lib/sync-auth';
import {
  isValidSyncAuthData,
  resetSyncForServer,
  spaceCategory,
  syncAuthItem,
  syncConfigItem,
  syncLinksItem,
  syncUiItem,
  type SyncSpaceEntry,
} from '@/lib/sync-storage';

describe('test pipeline smoke', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('storage reads and writes under WxtVitest', async () => {
    await storage.setItem('local:smoke', 'ok');
    expect(await storage.getItem('local:smoke')).toBe('ok');
  });

  it('storage keys carry their prefixes and fallbacks', async () => {
    expect(onboardingItem.key).toBe('local:onboarding');
    expect(businessClaimsItem.key).toBe('session:businessClaims');
    expect(await onboardingItem.getValue()).toEqual({ seen: false });
    expect(await businessClaimsItem.getValue()).toEqual([]);
  });

  it('the flows truth is the single-key flowStore with a fresh-install fallback', async () => {
    expect(flowStoreItem.key).toBe('local:flowStore');
    expect(await flowStoreItem.getValue()).toEqual({
      flows: [],
      history: {},
      receipts: [],
      expiredThrough: 0,
      maxAcceptedIssuedAt: 0,
    });
  });

  it('sync storage keys are local: with fresh-install fallbacks (never sync:)', async () => {
    expect(syncConfigItem.key).toBe('local:syncConfig');
    expect(syncLinksItem.key).toBe('local:syncLinks');
    expect(syncUiItem.key).toBe('local:syncUi');
    // Fresh installs are pre-configured against the official deployment (DEFAULT_SYNC_SERVER_URL)
    expect(await syncConfigItem.getValue()).toEqual({
      serverUrl: 'https://auto.fornetcode.com',
      spaces: [],
    });
    expect(await syncLinksItem.getValue()).toEqual([]);
    expect(await syncUiItem.getValue()).toEqual({ currentSpaceId: null });
  });

  // The additive evolution of SyncSpaceEntry: legacy key entries keep their exact shape while
  // org-bound entries carry role facts instead of a key — the read-side category rule is fixed
  // (key wins; neither field means a torn entry that callers skip but never delete)
  it('syncConfig holds both space categories side by side with a fixed typing rule', async () => {
    const keyEntry: SyncSpaceEntry = { id: 'sp-key000000000001', key: 'k'.repeat(32), name: 'Key', createdAt: 't' };
    const orgEntry: SyncSpaceEntry = {
      id: 'sp-org0000000000001',
      name: 'Org',
      createdAt: 't',
      myRole: 'owner',
      myUserId: '11111111-1111-1111-1111-111111111111',
    };
    await syncConfigItem.setValue({ serverUrl: 'https://a.example.com', spaces: [keyEntry, orgEntry] });
    const stored = await syncConfigItem.getValue();
    expect(stored.spaces[0]).toEqual(keyEntry);
    expect(stored.spaces[1]).toEqual(orgEntry);
    expect(spaceCategory(keyEntry)).toBe('key');
    expect(spaceCategory(orgEntry)).toBe('org-bound');
    // Defense against torn/foreign shapes: both fields → key semantics win; neither → skipped
    expect(spaceCategory({ ...orgEntry, key: 'k'.repeat(32) })).toBe('key');
    expect(spaceCategory({ id: 'sp-x00000000000001', name: 'x', createdAt: 't' })).toBe('invalid');
    expect(spaceCategory({ id: 'sp-x00000000000001', name: 'x', createdAt: 't', myRole: 'boss' as never })).toBe('invalid');
  });

  it('the sign-in credentials live in local:syncAuth with a signed-out fallback at epoch 0', async () => {
    expect(syncAuthItem.key).toBe('local:syncAuth');
    expect(await syncAuthItem.getValue()).toEqual({
      serverUrl: '',
      accessToken: '',
      refreshToken: '',
      accessTokenExpiresAt: 0,
      epoch: 0,
    });
  });

  it('syncAuth records are shape-validated — a malformed record is signed-out, never credentials', () => {
    const good = { serverUrl: 'https://s', accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: 1, epoch: 2 };
    expect(isValidSyncAuthData(good)).toBe(true);
    for (const bad of [
      null,
      {},
      { ...good, epoch: 1.5 },
      { ...good, accessTokenExpiresAt: 'soon' },
      { ...good, serverUrl: 7 },
    ]) {
      expect(isValidSyncAuthData(bad)).toBe(false);
    }
  });

  it('a server switch clears the sign-in state in the same reset, advancing the epoch (never back to 0)', async () => {
    await syncConfigItem.setValue({ serverUrl: 'https://a.example.com', spaces: [] });
    await syncAuthItem.setValue({
      serverUrl: 'https://a.example.com',
      accessToken: 'at',
      refreshToken: 'rt',
      accessTokenExpiresAt: 123,
      epoch: 5,
    });
    await resetSyncForServer('https://b.example.com');
    expect(await syncAuthItem.getValue()).toEqual({
      serverUrl: 'https://b.example.com',
      accessToken: '',
      refreshToken: '',
      accessTokenExpiresAt: 0,
      epoch: 6,
    });
  });

  it('UI hop timeouts outlive their background budgets — the background must answer before the hop dies', () => {
    expect(SYNC_AUTH_OP_TIMEOUT_MS).toBeGreaterThan(AUTHED_OP_BUDGET_MS);
    expect(SYNC_SIGN_IN_TIMEOUT_MS).toBeGreaterThan(SIGN_IN_BUDGET_MS);
    expect(SYNC_TIMEOUT_MS).toBeGreaterThan(NONE_OP_BUDGET_MS);
  });
});
