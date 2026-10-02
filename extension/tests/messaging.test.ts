// Payload-guard contract for the extended messages: sp:saveFlow's optional compare-and-swap
// stamp, ct:getInputSnapshot's optional dryRun flag, and the native-channel UI surface
// (sp:grantNativeRead / sp:getNativeChannelState / sp:getFlowHistory / sp:rollbackFlow). A too-strict guard silently rejects a live
// message as bad-payload (the ListVersions lesson in messaging.ts) — the create path must keep
// working without the stamp, and a malformed stamp must never reach the writer.
import { describe, expect, it } from 'vitest';
import { isExtensionMessage } from '@/lib/messaging';

describe('sp:saveFlow payload guard', () => {
  it('accepts the create path without a stamp and the editor path with an integer stamp', () => {
    expect(isExtensionMessage({ type: 'sp:saveFlow', flow: { schemaVersion: 1 } })).toBe(true);
    expect(isExtensionMessage({ type: 'sp:saveFlow', flow: {}, expectedUpdatedAt: 123 })).toBe(true);
  });

  it('rejects a malformed stamp — it is a CAS token, not free-form data', () => {
    expect(isExtensionMessage({ type: 'sp:saveFlow', flow: {}, expectedUpdatedAt: '123' })).toBe(false);
    expect(isExtensionMessage({ type: 'sp:saveFlow', flow: {}, expectedUpdatedAt: 1.5 })).toBe(false);
    expect(isExtensionMessage({ type: 'sp:saveFlow', flow: 'not-an-object' })).toBe(false);
  });
});

describe('ct:getInputSnapshot payload guard', () => {
  it('accepts the automatic-run shape and the dry-run shape', () => {
    expect(isExtensionMessage({ type: 'ct:getInputSnapshot', flowId: 'r1', flowDraftHash: 'h' })).toBe(true);
    expect(isExtensionMessage({ type: 'ct:getInputSnapshot', flowId: 'r1', flowDraftHash: 'h', dryRun: true })).toBe(true);
  });

  it('rejects a non-boolean dryRun flag', () => {
    expect(isExtensionMessage({ type: 'ct:getInputSnapshot', flowId: 'r1', flowDraftHash: 'h', dryRun: 'yes' })).toBe(false);
  });
});

describe('native-channel UI message guards', () => {
  it('sp:grantNativeRead / sp:getFlowHistory take a flowId string', () => {
    expect(isExtensionMessage({ type: 'sp:grantNativeRead', flowId: 'r1' })).toBe(true);
    expect(isExtensionMessage({ type: 'sp:grantNativeRead' })).toBe(false);
    expect(isExtensionMessage({ type: 'sp:grantNativeRead', flowId: 7 })).toBe(false);
    expect(isExtensionMessage({ type: 'sp:getFlowHistory', flowId: 'r1' })).toBe(true);
    expect(isExtensionMessage({ type: 'sp:getFlowHistory', flowId: null })).toBe(false);
  });

  it('sp:getNativeChannelState carries no payload', () => {
    expect(isExtensionMessage({ type: 'sp:getNativeChannelState' })).toBe(true);
  });

  it('sp:rollbackFlow needs a flowId and a safe-integer versionId', () => {
    expect(isExtensionMessage({ type: 'sp:rollbackFlow', flowId: 'r1', versionId: 3 })).toBe(true);
    expect(isExtensionMessage({ type: 'sp:rollbackFlow', flowId: 'r1' })).toBe(false);
    expect(isExtensionMessage({ type: 'sp:rollbackFlow', flowId: 'r1', versionId: '3' })).toBe(false);
    expect(isExtensionMessage({ type: 'sp:rollbackFlow', flowId: 'r1', versionId: 1.5 })).toBe(false);
  });

  it('the removed browser-import surface stays rejected', () => {
    expect(isExtensionMessage({ type: 'sp:importFlow', text: '{}' })).toBe(false);
  });
});

// Cross-page handover message guards (DEC-cross-page-flow-001).
describe('ct:stageHandover / probe / take / drop payload guards', () => {
  const handover = {
    runId: 'run-1',
    flowId: 'r_x',
    flowDraftHash: 'h1',
    site: 'https://saas.example.com',
    dryRun: false,
    businessKey: 'B-0001',
    toPageId: 'confirm',
    resumeAfter: 'nav1',
    deadline: 1_900_000_000_000,
    createdAt: 1_900_000_000_000,
    sourceTabId: -1,
    pageId: 'confirm',
    flow: { schemaVersion: 1 },
    context: { vars: {} },
  };

  it('accepts a coherent staging payload and the three runId-only ops', () => {
    expect(isExtensionMessage({ type: 'ct:stageHandover', handover })).toBe(true);
    expect(isExtensionMessage({ type: 'ct:probeHandover', runId: 'run-1' })).toBe(true);
    expect(isExtensionMessage({ type: 'ct:takeHandover', runId: 'run-1' })).toBe(true);
    expect(isExtensionMessage({ type: 'ct:dropHandover', runId: 'run-1' })).toBe(true);
    expect(isExtensionMessage({ type: 'bg:handoverStaged' })).toBe(true);
  });

  it('rejects malformed staging payloads — ids, deadlines and object shapes are guarded', () => {
    expect(isExtensionMessage({ type: 'ct:stageHandover' })).toBe(false);
    expect(isExtensionMessage({ type: 'ct:stageHandover', handover: { ...handover, runId: '' } })).toBe(false);
    expect(isExtensionMessage({ type: 'ct:stageHandover', handover: { ...handover, deadline: 'soon' } })).toBe(false);
    expect(isExtensionMessage({ type: 'ct:stageHandover', handover: { ...handover, deadline: 1.5 } })).toBe(false);
    expect(isExtensionMessage({ type: 'ct:stageHandover', handover: { ...handover, dryRun: 'yes' } })).toBe(false);
    expect(isExtensionMessage({ type: 'ct:stageHandover', handover: { ...handover, flow: 'not-an-object' } })).toBe(false);
    expect(isExtensionMessage({ type: 'ct:stageHandover', handover: { ...handover, context: null } })).toBe(false);
    expect(isExtensionMessage({ type: 'ct:stageHandover', handover: { ...handover, businessKey: 7 } })).toBe(false);
  });

  it('rejects runId-less probe/take/drop', () => {
    expect(isExtensionMessage({ type: 'ct:probeHandover' })).toBe(false);
    expect(isExtensionMessage({ type: 'ct:takeHandover', runId: '' })).toBe(false);
    expect(isExtensionMessage({ type: 'ct:dropHandover', runId: 3 })).toBe(false);
  });

  it('ct:flowRunStatus accepts an optional string pageId and rejects other shapes', () => {
    const base = { type: 'ct:flowRunStatus', flowId: 'r_x', flowDraftHash: 'h1' };
    const failure = { nodeId: 'n1', iterationPath: '', stage: 'navigate', reason: 'timeout' };
    expect(isExtensionMessage({ ...base, failure: { ...failure, pageId: 'confirm' } })).toBe(true);
    expect(isExtensionMessage({ ...base, failure: { ...failure, pageId: 3 } })).toBe(false);
  });
});
