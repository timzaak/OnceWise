import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  businessClaimKey,
  pendingHandoversItem,
  businessClaimsItem,
  claimBusinessInstance,
  deleteFlowCompletely,
  deleteFlowInputValues,
  loadFlows,
  nativeSaveRecord,
  onboardingItem,
  pruneOrphanFlowInputValues,
  readFlowInputValues,
  releaseBusinessInstance,
  flowFailuresItem,
  flowInputValuesItem,
  saveFlowRecord,
  setFlowStatusRecord,
  setFlowFailureNotice,
  writeFlowInputValues,
} from '@/lib/storage';
import { deriveFlowId, type InputDefinition, type Flow } from '@/lib/flow-schema';
import { inputDefinitionSignature } from '@/lib/flow-inputs';

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: deriveFlowId(),
    name: '发货仓库→联系电话',
    site: 'https://saas.example.com',
    page: { urlIncludes: '#/shipment-management/send-to-amazon/' },
    trigger: {
      kind: 'fieldChange',
      field: { clues: { id: 'form_item_tran_warehouse_id' }, componentType: 'antdSelect', displayLabel: '发货仓库' },
      condition: { kind: 'anyChange' },
    },
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'fill-phone',
          kind: 'action',
          action: {
            type: 'setInputValue',
            target: { clues: { id: 'form_item_source_address_phoneNumber' }, componentType: 'input', displayLabel: '联系电话' },
            value: '13147077604',
          },
        },
      ],
    },
    status: 'draft',
    provenance: { source: 'import', importedAt: now, createdAt: now, updatedAt: now },
    ...overrides,
  };
}

// The live revision path is the native save (flow.save with flowId + expectedUpdatedAt); each call
// mints a fresh clientRef exactly like the channel does, so repeated revisions never replay.
let refSeq = 0;
function saveRevision(id: string, expectedUpdatedAt: number, revision: Flow) {
  refSeq += 1;
  return nativeSaveRecord({
    draft: revision,
    text: JSON.stringify(revision),
    clientRef: `${Date.now()}.${refSeq.toString(16).padStart(32, '0')}`,
    issuedAt: Date.now(),
    flowId: id,
    expectedUpdatedAt,
  });
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe('flows CRUD', () => {
  it('saves and loads a flow', async () => {
    const flow = makeFlow();
    const outcome = await saveFlowRecord(flow);
    expect(outcome.created).toBe(true);
    const flows = await loadFlows();
    expect(flows).toHaveLength(1);
    expect(flows[0]!.name).toBe('发货仓库→联系电话');
  });

  it('update keeps createdAt and refreshes content', async () => {
    const flow = makeFlow();
    await saveFlowRecord(flow);
    const updated = { ...flow, name: '改名', provenance: { ...flow.provenance, updatedAt: Date.now() + 10 } };
    const outcome = await saveFlowRecord(updated);
    expect(outcome.created).toBe(false);
    const flows = await loadFlows();
    expect(flows).toHaveLength(1);
    expect(flows[0]!.name).toBe('改名');
    expect(flows[0]!.provenance.createdAt).toBe(flow.provenance.createdAt);
  });

  it('deletes a flow completely', async () => {
    const flow = makeFlow();
    await saveFlowRecord(flow);
    await deleteFlowCompletely(flow.id);
    expect(await loadFlows()).toHaveLength(0);
    // A missing id is a no-op, not an error
    await deleteFlowCompletely('missing');
  });
});

// Editor compare-and-swap (sp:saveFlow): an editor holding the stamp it opened with must not be able
// to roll back a flow that was revised underneath it — a silent lost update.
describe('saveFlowRecord compare-and-swap', () => {
  it('a save carrying the stale stamp it opened with refuses instead of rolling back the newer flow', async () => {
    const flow = makeFlow();
    await saveFlowRecord(flow);
    // A concurrent AI revision (or sync pull) lands while the editor is still open
    await saveFlowRecord({
      ...flow,
      name: 'AI 修订版',
      provenance: { ...flow.provenance, updatedAt: flow.provenance.updatedAt + 5 },
    });
    const outcome = await saveFlowRecord({ ...flow, name: '旧编辑器内容' }, flow.provenance.updatedAt);
    expect(outcome.changed).toBe(true);
    expect((await loadFlows())[0]).toMatchObject({ id: flow.id, name: 'AI 修订版' });
  });

  it('a save carrying the current stamp succeeds; an omitted stamp keeps the create/pull overwrite semantics', async () => {
    const flow = makeFlow();
    await saveFlowRecord(flow);
    await saveFlowRecord({ ...flow, name: '当前戳保存' }, flow.provenance.updatedAt);
    expect((await loadFlows())[0]!.name).toBe('当前戳保存');
    // No token (import create path, sync pull): deliberate full write, never refused
    await saveFlowRecord({ ...flow, name: '拉取覆盖' });
    expect((await loadFlows())[0]!.name).toBe('拉取覆盖');
  });

  it('a stamped save against a flow deleted while the editor was open refuses instead of resurrecting it', async () => {
    const flow = makeFlow();
    await saveFlowRecord(flow);
    await deleteFlowCompletely(flow.id);
    const outcome = await saveFlowRecord({ ...flow, name: '僵尸编辑器' }, flow.provenance.updatedAt);
    expect(outcome.changed).toBe(true);
    expect(await loadFlows()).toHaveLength(0);
  });
});

describe('revising an imported flow', () => {
  it('replaces the paused flow under its original ID and leaves it not enabled', async () => {
    const original = makeFlow({ status: 'paused' });
    await saveFlowRecord(original);
    const revision = makeFlow({ name: '修订后的流程', status: 'enabled' });

    const outcome = await saveRevision(original.id, original.provenance.updatedAt, revision);
    expect(outcome.ok).toBe(true);
    const flows = await loadFlows();
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ id: original.id, name: '修订后的流程', status: 'draft' });
    expect(flows[0]!.provenance.createdAt).toBe(original.provenance.createdAt);
    expect(flows[0]!.provenance.updatedAt).toBeGreaterThan(original.provenance.updatedAt);
  });

  it('rejects a stale revision or an enabled original without changing either flow', async () => {
    const original = makeFlow({ status: 'paused' });
    await saveFlowRecord(original);
    const revision = makeFlow({ name: '过期修订' });
    await saveFlowRecord({ ...original, provenance: { ...original.provenance, updatedAt: original.provenance.updatedAt + 10 } });
    expect(await saveRevision(original.id, original.provenance.updatedAt, revision)).toMatchObject({ ok: false, reason: 'revision-stale' });
    await setFlowStatusRecord(original.id, 'enabled');

    const enabled = (await loadFlows())[0]!;
    expect(await saveRevision(original.id, enabled.provenance.updatedAt, revision)).toMatchObject({ ok: false, reason: 'flow-enabled' });
    expect((await loadFlows())[0]).toMatchObject({ id: original.id, name: original.name, status: 'enabled' });
    expect(await saveRevision('missing', original.provenance.updatedAt, revision)).toMatchObject({ ok: false, reason: 'flow-not-found' });
  });

  // The personal-data boundary ends with the declaration: value records for definitions a revision
  // dropped must not outlive it in local:flowInputValues (the editor never renders a form for them
  // again, so nothing else would ever clean them up).
  it('a revision dropping some input definitions prunes exactly those stored value records', async () => {
    const phone: InputDefinition = { key: 'phone', label: '联系电话', type: 'text', required: true };
    const note: InputDefinition = { key: 'note', label: '备注', type: 'text', required: false };
    const original = makeFlow({ status: 'paused', inputs: [phone, note] });
    await saveFlowRecord(original);
    await writeFlowInputValues(original.id, {
      phone: { definitionSignature: inputDefinitionSignature(phone), value: '13800001234' },
      note: { definitionSignature: inputDefinitionSignature(note), value: '旧备注' },
    });

    const revision = makeFlow({ name: '修订版', status: 'paused', inputs: [phone] });
    expect((await saveRevision(original.id, original.provenance.updatedAt, revision)).ok).toBe(true);
    expect(await readFlowInputValues(original.id)).toEqual({
      phone: { definitionSignature: inputDefinitionSignature(phone), value: '13800001234' },
    });
  });

  it('a revision removing every input definition clears the whole value record', async () => {
    const phone: InputDefinition = { key: 'phone', label: '联系电话', type: 'text', required: true };
    const original = makeFlow({ status: 'paused', inputs: [phone] });
    await saveFlowRecord(original);
    await writeFlowInputValues(original.id, {
      phone: { definitionSignature: inputDefinitionSignature(phone), value: '13800001234' },
    });

    const revision = makeFlow({ name: '硬编码修订', status: 'paused' });
    expect((await saveRevision(original.id, original.provenance.updatedAt, revision)).ok).toBe(true);
    const all = await flowInputValuesItem.getValue();
    expect(all[original.id]).toBeUndefined();
  });

  it('a revision keeping the definitions leaves the value records untouched', async () => {
    const phone: InputDefinition = { key: 'phone', label: '联系电话', type: 'text', required: true };
    const original = makeFlow({ status: 'paused', inputs: [phone] });
    await saveFlowRecord(original);
    await writeFlowInputValues(original.id, {
      phone: { definitionSignature: inputDefinitionSignature(phone), value: '13800001234' },
    });

    const revision = makeFlow({ name: '同名定义修订', status: 'paused', inputs: [phone] });
    await saveRevision(original.id, original.provenance.updatedAt, revision);
    expect(await readFlowInputValues(original.id)).toEqual({
      phone: { definitionSignature: inputDefinitionSignature(phone), value: '13800001234' },
    });
  });
});

describe('enabling is the user-click gate (DEC-015: no additional gate)', () => {
  it('enabling succeeds and stamps enabledAt', async () => {
    const flow = makeFlow();
    await saveFlowRecord(flow);
    const res = await setFlowStatusRecord(flow.id, 'enabled');
    expect(res.ok).toBe(true);
    const flows = await loadFlows();
    expect(flows[0]!.status).toBe('enabled');
    expect(flows[0]!.provenance.enabledAt).toBeGreaterThan(0);
  });

  it('enabled <-> paused toggles freely (US-SSBA-005)', async () => {
    const flow = makeFlow({ status: 'enabled' });
    await saveFlowRecord(flow);
    expect((await setFlowStatusRecord(flow.id, 'paused')).ok).toBe(true);
    expect((await loadFlows())[0]!.status).toBe('paused');
    expect((await setFlowStatusRecord(flow.id, 'enabled')).ok).toBe(true);
  });
});

describe('storage key surface', () => {
  it('flows live only in the flowStore key after plain usage', async () => {
    // storage snapshot after plain usage holds only the defined keys (flows written via the API)
    const flow = makeFlow();
    await saveFlowRecord(flow);
    const local = await fakeBrowser.storage.local.get(null);
    expect(Object.keys(local).sort()).toEqual(['flowStore']);
  });
});

describe('businessClaims (business-instance claim, background single writer)', () => {
  it('claims once per business key for the whole session — no TTL auto-release', async () => {
    const t0 = 10_000;
    const key = businessClaimKey('https://s.example.com', 'r1', 'B-001');
    expect(await claimBusinessInstance(key, t0)).toBe(true);
    // Re-claim refused immediately, after "a long time", and from another tab path (same key)
    expect(await claimBusinessInstance(key, t0 + 5_000)).toBe(false);
    expect(await claimBusinessInstance(key, t0 + 24 * 60 * 60 * 1000)).toBe(false);
    // A different business instance (or flow) claims independently
    expect(await claimBusinessInstance(businessClaimKey('https://s.example.com', 'r1', 'B-002'), t0 + 5_000)).toBe(true);
    expect(await claimBusinessInstance(businessClaimKey('https://s.example.com', 'r2', 'B-001'), t0 + 5_000)).toBe(true);
    const claims = await businessClaimsItem.getValue();
    expect(claims).toHaveLength(3);
    expect(claims.every((c) => typeof c.claimedAt === 'number')).toBe(true);
  });

  it('two claims for the same key racing in the same tick: exactly one wins (serialized read-modify-write)', async () => {
    const key = businessClaimKey('https://s.example.com', 'r_submit', 'B-009');
    const [first, second] = await Promise.all([claimBusinessInstance(key, 1), claimBusinessInstance(key, 1)]);
    expect(first === second).toBe(false);
    expect(await claimBusinessInstance(key, 2)).toBe(false);
  });

  it('releaseBusinessInstance gives back a never-started claim so the instance stays runnable', async () => {
    // A claim taken for a start the mutex refused has no outcome to protect: without the give-back
    // the business instance would be locked out for the whole session without ever being acted on
    const key = businessClaimKey('https://s.example.com', 'r1', 'B-100');
    expect(await claimBusinessInstance(key, 1)).toBe(true);
    await releaseBusinessInstance(key);
    expect(await businessClaimsItem.getValue()).toHaveLength(0);
    // the instance can be claimed again afterwards
    expect(await claimBusinessInstance(key, 2)).toBe(true);
    // releasing a key nobody holds is a no-op, not an error
    await expect(releaseBusinessInstance(businessClaimKey('https://s.example.com', 'r1', 'B-999'))).resolves.toBeUndefined();
    expect(await businessClaimsItem.getValue()).toHaveLength(1);
  });
});

describe('concurrent writers (MV3 async handlers share no lock but share storage)', () => {
  it('two saves racing in the same tick both persist (no lost update)', async () => {
    const a = makeFlow();
    const b = makeFlow();
    await Promise.all([saveFlowRecord(a), saveFlowRecord(b)]);
    const flows = await loadFlows();
    expect(flows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('a save racing a delete keeps the save (writers serialize instead of clobbering)', async () => {
    const existing = makeFlow();
    await saveFlowRecord(existing);
    const fresh = makeFlow();
    await Promise.all([
      saveFlowRecord(fresh),
      deleteFlowCompletely(existing.id),
    ]);
    const flows = await loadFlows();
    expect(flows.map((r) => r.id)).toEqual([fresh.id]);
  });
});

describe('storage keys', () => {
  it('onboarding defaults to unseen', async () => {
    expect(await onboardingItem.getValue()).toEqual({ seen: false });
  });
});

describe('current flow failure notice', () => {
  it('keeps only the current failure per flow and clears it after success', async () => {
    const first = { flowId: 'r1', flowDraftHash: 'h1', ts: 1,
      failure: { nodeId: 'fill-phone', iterationPath: '', stage: 'locate', reason: 'missing' } };
    const second = { ...first, ts: 2, failure: { ...first.failure, reason: 'ambiguous' } };
    await setFlowFailureNotice('r1', first);
    await setFlowFailureNotice('r1', second);
    expect(await flowFailuresItem.getValue()).toEqual({ r1: second });
    await setFlowFailureNotice('r1', null);
    expect(await flowFailuresItem.getValue()).toEqual({});
  });
});

// Pre-run input value records (form-support): replace-semantics writes under the single-writer chain,
// delete-on-flow-delete, and the orphan self-heal for the interrupted-delete window (flows and values
// are separate keys — no cross-key transaction exists, so readers always revalidate by signature).
describe('flowInputValues lifecycle', () => {
  const record = (sig: string, value: string | boolean | string[]) => ({ definitionSignature: sig, value });

  it('writes replace the whole per-flow map and read back only that flow\'s records', async () => {
    await writeFlowInputValues('r1', { phone: record('s1', '13800001234') });
    await writeFlowInputValues('r2', { phone: record('s2', 'other') });
    await writeFlowInputValues('r1', { count: record('s3', '5') }); // replaces r1 wholesale
    expect(await readFlowInputValues('r1')).toEqual({ count: record('s3', '5') });
    expect(await readFlowInputValues('r2')).toEqual({ phone: record('s2', 'other') });
    expect(await readFlowInputValues('missing')).toEqual({});
  });

  it('deleting a flow\'s values removes only that flow\'s entry', async () => {
    await writeFlowInputValues('r1', { phone: record('s1', 'x') });
    await writeFlowInputValues('r2', { phone: record('s1', 'y') });
    await deleteFlowInputValues('r1');
    const all = await flowInputValuesItem.getValue();
    expect(Object.keys(all)).toEqual(['r2']);
    // deleting an unknown flow is a no-op, not an error
    await expect(deleteFlowInputValues('nope')).resolves.toBeUndefined();
  });

  it('prune drops only records whose flow no longer exists', async () => {
    await writeFlowInputValues('keep', { phone: record('s1', 'x') });
    await writeFlowInputValues('orphan', { phone: record('s1', 'y') });
    await pruneOrphanFlowInputValues(new Set(['keep']));
    const all = await flowInputValuesItem.getValue();
    expect(Object.keys(all)).toEqual(['keep']);
    // a clean store triggers no write churn (idempotent)
    await expect(pruneOrphanFlowInputValues(new Set(['keep']))).resolves.toBeUndefined();
  });

  it('concurrent value saves for different flows both persist (serialized read-modify-write)', async () => {
    await Promise.all([
      writeFlowInputValues('r1', { phone: record('s1', 'a') }),
      writeFlowInputValues('r2', { phone: record('s1', 'b') }),
      writeFlowInputValues('r3', { phone: record('s1', 'c') }),
    ]);
    const all = await flowInputValuesItem.getValue();
    expect(Object.keys(all).sort()).toEqual(['r1', 'r2', 'r3']);
  });
});

// Cross-page pendingHandovers session item (DEC-cross-page-flow-001/002).
describe('session:pendingHandovers (cross-page handover store)', () => {
  it('defaults to an empty list and round-trips entries', async () => {
    expect(await pendingHandoversItem.getValue()).toEqual([]);
    const entry = {
      runId: 'run-1',
      flowId: 'r_x',
      flowDraftHash: 'h1',
      site: 'https://saas.example.com',
      dryRun: false,
      businessKey: null,
      toPageId: 'confirm',
      resumeAfter: 'nav1',
      deadline: Date.now() + 1000,
      createdAt: Date.now(),
      sourceTabId: 11,
      pageId: 'confirm',
      flow: makeFlow(),
      context: { trigger: '', inputs: {}, vars: {}, itemVars: {}, loops: {}, loopValues: {}, iterationPath: '', executed: 0, startedAt: Date.now(), budget: { loopItems: 100, waitMs: 60000, runMs: 900000 } },
    };
    await pendingHandoversItem.setValue([entry]);
    expect((await pendingHandoversItem.getValue())[0]!.runId).toBe('run-1');
    await pendingHandoversItem.setValue([]);
  });

  it('handover state never leaks into local storage — session only, this machine only', async () => {
    const entry = {
      runId: 'run-2',
      flowId: 'r_x',
      flowDraftHash: 'h1',
      site: 'https://saas.example.com',
      dryRun: false,
      businessKey: null,
      toPageId: 'confirm',
      resumeAfter: 'nav1',
      deadline: Date.now() + 1000,
      createdAt: Date.now(),
      sourceTabId: 11,
      pageId: 'confirm',
      flow: makeFlow(),
      context: { trigger: '', inputs: {}, vars: {}, itemVars: {}, loops: {}, loopValues: {}, iterationPath: '', executed: 0, startedAt: Date.now(), budget: { loopItems: 100, waitMs: 60000, runMs: 900000 } },
    };
    await pendingHandoversItem.setValue([entry]);
    const sessionArea = (await fakeBrowser.storage.session.get(null)) as Record<string, unknown>;
    expect(Object.keys(sessionArea)).toContain('pendingHandovers');
    const localArea = (await fakeBrowser.storage.local.get(null)) as Record<string, unknown>;
    expect(Object.keys(localArea)).not.toContain('pendingHandovers');
  });
});
