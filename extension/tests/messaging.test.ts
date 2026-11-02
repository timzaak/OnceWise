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

// Timed-trigger message guards (support-scheduler): the schedule upsert's period is a closed set —
// per-kind fields must arrive in exactly the guarded shape or the writer never sees the message
// (bad-payload). The claim op is triggerId-only; the compensation push carries no payload.
describe('schedule message guards', () => {
  it('sp:getSchedules / sp:deleteSchedule take their id strings; bg:timedStartStaged carries no payload', () => {
    expect(isExtensionMessage({ type: 'sp:getSchedules', flowId: 'r1' })).toBe(true);
    expect(isExtensionMessage({ type: 'sp:getSchedules' })).toBe(false);
    expect(isExtensionMessage({ type: 'sp:deleteSchedule', id: 'sched-1' })).toBe(true);
    expect(isExtensionMessage({ type: 'sp:deleteSchedule', id: 7 })).toBe(false);
    expect(isExtensionMessage({ type: 'bg:timedStartStaged' })).toBe(true);
  });

  it('sp:saveSchedule accepts each period kind, with and without the edit id', () => {
    expect(
      isExtensionMessage({ type: 'sp:saveSchedule', schedule: { flowId: 'r1', entryUrl: 'https://s.example.com/orders', period: { kind: 'daily', time: '09:00' } } }),
    ).toBe(true);
    expect(
      isExtensionMessage({ type: 'sp:saveSchedule', schedule: { id: 'sched-1', flowId: 'r1', entryUrl: 'https://s.example.com/orders', period: { kind: 'weekly', weekday: 0, time: '23:59' } } }),
    ).toBe(true);
    expect(
      isExtensionMessage({ type: 'sp:saveSchedule', schedule: { flowId: 'r1', entryUrl: 'https://s.example.com/orders', period: { kind: 'interval', minutes: 1440 } } }),
    ).toBe(true);
  });

  it('sp:saveSchedule rejects malformed periods per kind and non-string ids/urls', () => {
    const base = { type: 'sp:saveSchedule' };
    const entryUrl = 'https://s.example.com/orders';
    expect(isExtensionMessage({ ...base, schedule: { flowId: 'r1', entryUrl, period: { kind: 'daily', time: '9:00' } } })).toBe(false);
    expect(isExtensionMessage({ ...base, schedule: { flowId: 'r1', entryUrl, period: { kind: 'daily', time: '09:60' } } })).toBe(false);
    expect(isExtensionMessage({ ...base, schedule: { flowId: 'r1', entryUrl, period: { kind: 'weekly', weekday: 7, time: '09:00' } } })).toBe(false);
    expect(isExtensionMessage({ ...base, schedule: { flowId: 'r1', entryUrl, period: { kind: 'weekly', weekday: '1', time: '09:00' } } })).toBe(false);
    expect(isExtensionMessage({ ...base, schedule: { flowId: 'r1', entryUrl, period: { kind: 'interval', minutes: 0 } } })).toBe(false);
    expect(isExtensionMessage({ ...base, schedule: { flowId: 'r1', entryUrl, period: { kind: 'interval', minutes: 1441 } } })).toBe(false);
    expect(isExtensionMessage({ ...base, schedule: { flowId: 'r1', entryUrl, period: { kind: 'interval', minutes: 30.5 } } })).toBe(false);
    expect(isExtensionMessage({ ...base, schedule: { flowId: 'r1', entryUrl, period: { kind: 'cron' } } })).toBe(false);
    expect(isExtensionMessage({ ...base, schedule: { entryUrl, period: { kind: 'daily', time: '09:00' } } })).toBe(false);
    expect(isExtensionMessage({ ...base, schedule: { flowId: 7, entryUrl, period: { kind: 'daily', time: '09:00' } } })).toBe(false);
    expect(isExtensionMessage({ ...base, schedule: { id: 7, flowId: 'r1', entryUrl, period: { kind: 'daily', time: '09:00' } } })).toBe(false);
    expect(isExtensionMessage({ ...base, schedule: { flowId: 'r1', period: { kind: 'daily', time: '09:00' } } })).toBe(false);
  });

  it('ct:takeTimedStart needs a non-empty triggerId', () => {
    expect(isExtensionMessage({ type: 'ct:takeTimedStart', triggerId: 'sched-1@1770000000000' })).toBe(true);
    expect(isExtensionMessage({ type: 'ct:takeTimedStart' })).toBe(false);
    expect(isExtensionMessage({ type: 'ct:takeTimedStart', triggerId: '' })).toBe(false);
    expect(isExtensionMessage({ type: 'ct:takeTimedStart', triggerId: 7 })).toBe(false);
  });
});

// support-http: the upload request guard is the first of three fences in front of the only
// flow-declared fetch the extension makes (shape here → binding/pinning → credential in the
// handler). A hole here would let a forged content message reach the handler; an over-strict
// guard would silently drop the real runtime's requests as bad-payload.
describe('ct:performUpload payload guard', () => {
  const base = {
    type: 'ct:performUpload',
    flowId: 'r1',
    flowDraftHash: 'h',
    url: 'https://collect.example.com/api/orders',
    method: 'POST',
    payload: { orderNo: 'A-1', urgent: true, lines: [{ sku: 'S', qty: '2' }] },
    timeoutMs: 15_000,
  };

  it('accepts the automatic-run and dry-run shapes with optional credentialName / captureMaxBytes', () => {
    expect(isExtensionMessage(base)).toBe(true);
    expect(isExtensionMessage({ ...base, dryRun: true, credentialName: '我的上报服务器', captureMaxBytes: 65_536 })).toBe(true);
    expect(isExtensionMessage({ ...base, method: 'GET', payload: { orderNo: 'A-1', urgent: 'true' } })).toBe(true);
    expect(isExtensionMessage({ ...base, payload: {} })).toBe(true);
  });

  it('rejects a plain-http / query / userinfo destination, a method outside GET/POST and a non-boolean dryRun', () => {
    expect(isExtensionMessage({ ...base, url: 'http://collect.example.com/api/orders' })).toBe(false);
    expect(isExtensionMessage({ ...base, url: 'https://collect.example.com/api/orders?x=1' })).toBe(false);
    expect(isExtensionMessage({ ...base, url: 'https://u:p@collect.example.com/api/orders' })).toBe(false);
    expect(isExtensionMessage({ ...base, method: 'PUT' })).toBe(false);
    expect(isExtensionMessage({ ...base, dryRun: 'yes' })).toBe(false);
  });

  it('rejects GET payloads with non-string values and POST payloads with non-JSON values or too many keys', () => {
    expect(isExtensionMessage({ ...base, method: 'GET', payload: { urgent: true } })).toBe(false);
    expect(isExtensionMessage({ ...base, payload: { f: () => 1 } })).toBe(false);
    expect(isExtensionMessage({ ...base, payload: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])) })).toBe(false);
    expect(isExtensionMessage({ ...base, payload: 'x' })).toBe(false);
  });

  it('rejects a malformed credential name, a deadline outside the wait budget and a capture cap above the engine cap', () => {
    expect(isExtensionMessage({ ...base, credentialName: ' padded ' })).toBe(false);
    expect(isExtensionMessage({ ...base, credentialName: '' })).toBe(false);
    expect(isExtensionMessage({ ...base, timeoutMs: 0 })).toBe(false);
    expect(isExtensionMessage({ ...base, timeoutMs: 60_001 })).toBe(false);
    expect(isExtensionMessage({ ...base, captureMaxBytes: 65_537 })).toBe(false);
    expect(isExtensionMessage({ ...base, captureMaxBytes: 0 })).toBe(false);
    expect(isExtensionMessage({ ...base, flowId: 7 })).toBe(false);
  });
});

describe('upload credential message guards (sp:*)', () => {
  it('sp:getUploadCredentials takes no payload; save needs three strings; delete needs a name string', () => {
    expect(isExtensionMessage({ type: 'sp:getUploadCredentials' })).toBe(true);
    expect(isExtensionMessage({ type: 'sp:saveUploadCredential', name: 'c', headerName: 'Authorization', value: 'Bearer t' })).toBe(true);
    expect(isExtensionMessage({ type: 'sp:saveUploadCredential', name: 'c', headerName: 'Authorization' })).toBe(false);
    expect(isExtensionMessage({ type: 'sp:saveUploadCredential', name: 'c', headerName: 7, value: 'v' })).toBe(false);
    expect(isExtensionMessage({ type: 'sp:deleteUploadCredential', name: 'c' })).toBe(true);
    expect(isExtensionMessage({ type: 'sp:deleteUploadCredential' })).toBe(false);
  });
});
