// The single-key flowStore: flows, per-flow history, receipts and
// ref watermarks commit through ONE setValue. What these tests stand for: a failed write leaves the
// previous store fully intact (no partial cross-key histories), the 10-version/10-receipt caps and
// watermarks hold, and rollback is a new-version transaction — never a partial rewrite.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  buildFlowStore,
  deleteFlowCompletely,
  loadFlows,
  nativeSaveRecord,
  rollbackFlowRecord,
  flowStoreItem,
  saveFlowRecord,
  setFlowStatusRecord,
  type FlowStore,
  type SaveReceipt,
} from '@/lib/storage';
import { deriveFlowId, type Flow } from '@/lib/flow-schema';

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: deriveFlowId(),
    name: '发货流程',
    site: 'https://saas.example.com',
    page: { urlIncludes: '#/shipment/' },
    trigger: { kind: 'pageEnter' },
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'fill-phone',
          kind: 'action',
          action: {
            type: 'setInputValue',
            target: { clues: { id: 'phone' }, componentType: 'input', displayLabel: '联系电话' },
            value: '13147077604',
          },
        },
      ],
    },
    status: 'draft',
    provenance: { source: 'import', createdAt: now, updatedAt: now },
    ...overrides,
  } as Flow;
}

function makeRef(issuedAt: number, seq: number): string {
  return `${issuedAt}.${seq.toString(16).padStart(32, '0')}`;
}

async function snapshotStore(): Promise<FlowStore> {
  return structuredClone(await flowStoreItem.getValue());
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe('single-commit atomicity', () => {
  it('a failed store write during a native save leaves flows, history, receipts and watermarks unchanged', async () => {
    const seed = makeFlow();
    await flowStoreItem.setValue(buildFlowStore([seed]));
    const before = await snapshotStore();

    const spy = vi.spyOn(flowStoreItem, 'setValue').mockRejectedValueOnce(new Error('boom'));
    await expect(
      nativeSaveRecord({ draft: makeFlow(), text: '{}', clientRef: makeRef(Date.now(), 1), issuedAt: Date.now() }),
    ).rejects.toThrow('boom');
    spy.mockRestore();

    expect(await flowStoreItem.getValue()).toEqual(before);
  });

  it('a failed store write during an editor save leaves the store unchanged', async () => {
    const seed = makeFlow();
    await flowStoreItem.setValue(buildFlowStore([seed]));
    const before = await snapshotStore();

    const spy = vi.spyOn(flowStoreItem, 'setValue').mockRejectedValueOnce(new Error('boom'));
    await expect(saveFlowRecord(makeFlow())).rejects.toThrow('boom');
    spy.mockRestore();

    expect(await flowStoreItem.getValue()).toEqual(before);
  });
});

describe('history cap and version semantics', () => {
  it('keeps the last 10 versions after 11 successful saves, with monotonic versionIds', async () => {
    const flow = makeFlow();
    await flowStoreItem.setValue(buildFlowStore([flow]));
    // Unstamped saves are the deliberate full-write semantics (create / sync pull): one flow, many saves
    for (let i = 1; i <= 10; i += 1) {
      await saveFlowRecord({ ...flow, name: `v${i}`, provenance: { ...flow.provenance, updatedAt: flow.provenance.updatedAt + i } });
    }
    const store = await flowStoreItem.getValue();
    const versions = store.history[flow.id]!;
    expect(versions).toHaveLength(10);
    // Initial version was trimmed; ids stay monotonic (2..11), not restart-from-1
    expect(versions.map((v) => v.versionId)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(versions[versions.length - 1]!.flow.name).toBe('v10');
  });

  it('a status flip never adds a version', async () => {
    const flow = makeFlow();
    await flowStoreItem.setValue(buildFlowStore([flow]));
    await setFlowStatusRecord(flow.id, 'enabled');
    await setFlowStatusRecord(flow.id, 'paused');
    expect((await flowStoreItem.getValue()).history[flow.id]).toHaveLength(1);
  });
});

describe('rollback (user-only, from flow detail)', () => {
  function seededWithVersions(): { flow: Flow; store: FlowStore } {
    const now = Date.now();
    const flow = makeFlow({ provenance: { source: 'import', createdAt: now, updatedAt: now } });
    const v1: Flow = { ...flow, name: '第一版' };
    const v2: Flow = { ...flow, name: '第二版' };
    const v3: Flow = { ...flow, name: '第三版' };
    const store: FlowStore = {
      flows: [v3],
      history: {
        [flow.id]: [
          { versionId: 1, savedAt: now, flow: v1 },
          { versionId: 2, savedAt: now + 1, flow: v2 },
          { versionId: 3, savedAt: now + 2, flow: v3 },
        ],
      },
      receipts: [],
      expiredThrough: 0,
      maxAcceptedIssuedAt: 0,
    };
    return { flow: v3, store };
  }

  it('restores the chosen snapshot as a new not-enabled version and keeps the rolled-back content', async () => {
    const { flow, store } = seededWithVersions();
    await flowStoreItem.setValue(store);

    expect(await rollbackFlowRecord(flow.id, 1)).toBe('ok');

    const after = await flowStoreItem.getValue();
    expect(after.flows).toHaveLength(1);
    expect(after.flows[0]).toMatchObject({ id: flow.id, name: '第一版', status: 'draft' });
    expect(after.flows[0]!.provenance.updatedAt).toBeGreaterThan(flow.provenance.updatedAt);
    // v4 is the restored snapshot; the pre-rollback current (v3) survives for a roll-forward
    const versions = after.history[flow.id]!;
    expect(versions.map((v) => v.versionId)).toEqual([1, 2, 3, 4]);
    expect(versions[3]!.flow.name).toBe('第一版');
    expect(versions[2]!.flow.name).toBe('第三版');
  });

  it('a missing flow or version refuses without touching the store', async () => {
    const { flow, store } = seededWithVersions();
    await flowStoreItem.setValue(store);
    const before = await snapshotStore();

    expect(await rollbackFlowRecord('missing', 1)).toBe('not-found');
    expect(await rollbackFlowRecord(flow.id, 999)).toBe('version-not-found');
    expect(await flowStoreItem.getValue()).toEqual(before);
  });

  it('a snapshot that no longer validates refuses as invalid-snapshot with zero writes', async () => {
    const { flow, store } = seededWithVersions();
    // Corrupt one history snapshot the way a foreign writer would (schema drift)
    store.history[flow.id]![0]!.flow = { ...store.history[flow.id]![0]!.flow, name: '' } as Flow;
    await flowStoreItem.setValue(store);
    const before = await snapshotStore();

    expect(await rollbackFlowRecord(flow.id, 1)).toBe('invalid-snapshot');
    expect(await flowStoreItem.getValue()).toEqual(before);
  });
});

describe('delete cleanup', () => {
  it('removes the flow, its history and its receipts, and advances the expiry watermark', async () => {
    const flow = makeFlow();
    const receipts: SaveReceipt[] = [
      { clientRef: makeRef(1_000, 1), issuedAt: 1_000, flowId: flow.id, savedAt: 1_000, updatedAt: 1_000, payloadHash: 'h1' },
      { clientRef: makeRef(2_000, 2), issuedAt: 2_000, flowId: flow.id, savedAt: 2_000, updatedAt: 2_000, payloadHash: 'h2' },
      { clientRef: makeRef(3_000, 3), issuedAt: 3_000, flowId: 'other', savedAt: 3_000, updatedAt: 3_000, payloadHash: 'h3' },
    ];
    const store = { ...buildFlowStore([flow]), receipts };
    await flowStoreItem.setValue(store);

    await deleteFlowCompletely(flow.id);

    const after = await flowStoreItem.getValue();
    expect(after.flows).toEqual([]);
    expect(after.history[flow.id]).toBeUndefined();
    // Only the deleted flow's receipts went; the watermark covers their max issuedAt
    expect(after.receipts.map((r) => r.flowId)).toEqual(['other']);
    expect(after.expiredThrough).toBe(2_000);
    expect(await loadFlows()).toEqual([]);
  });
});
