import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import { businessClaimsItem, onboardingItem, flowStoreItem } from '@/lib/storage';
import { syncConfigItem, syncLinksItem, syncUiItem } from '@/lib/sync-storage';

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
});
