// Upload step (support-http): the vocabulary, the background executor's transport policy, the
// device-local credential store, the ct:performUpload adjudication chain, the compiler's payload
// resolution / capture slot and the content-side decorator. Every assertion here pins a product
// promise from the PRD / decision log (DEC-support-http-001..006) — the https-only destination,
// zero egress before a credential resolves, no retry, no truncation, the single credential header,
// the unmasked destination in the summary — so a behavioural drift turns this file red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { jsonResponse, recordingFetch, type Recorded } from './fetch-recorder';
import {
  describeSteps,
  flowDraftHash,
  isHttpsUploadUrl,
  isUploadRequestShape,
  isValidUploadCredentialName,
  stepsHaveUploadStep,
  uploadDeclarationsOf,
  validateFlow,
  MAX_UPLOAD_CAPTURE_BYTES,
  MAX_UPLOAD_PAYLOAD_BYTES,
  type Flow,
} from '@/lib/flow-schema';
import type { StepNode } from '@/lib/step-schema';
import {
  deleteUploadCredential,
  handlePerformUpload,
  isValidUploadCredentialValue,
  isValidUploadHeaderName,
  listUploadCredentials,
  performUpload,
  resolveUploadCredential,
  saveUploadCredential,
  withUpload,
  UPLOAD_CREDENTIAL_VALUE_MAX,
  UPLOAD_FAILURE_REASONS,
  UPLOAD_TIMEOUT_MARGIN_MS,
  type PerformUploadMessage,
  type UploadDriverRequest,
  type UploadOutcome,
} from '@/lib/flow-upload';
import { DriverFailure, runFlow, type FlowDriver, type HandoverRequest, type StepNodeEvent } from '@/lib/flow-compiler';
import { needsBusinessClaim } from '@/lib/page-enter';
import { buildFlowStore, flowStoreItem } from '@/lib/storage';

const SITE = 'https://www.example.com';
const DEST = 'https://collect.example.com/api/orders';
const CRED = '我的上报服务器';

const field = (id: string, displayLabel = id, componentType: 'input' | 'checkbox' | 'button' | 'other' = 'input') => ({
  clues: { id },
  componentType,
  displayLabel,
});

const readScalar = (id: string, into: string): StepNode => ({ id: `read-${into}`, kind: 'read', read: { kind: 'scalar', target: field(id) }, into });
const readBoolean = (id: string, into: string): StepNode => ({ id: `read-${into}`, kind: 'read', read: { kind: 'boolean', target: field(id, id, 'checkbox') }, into });
const readRows = (id: string, into: string): StepNode => ({ id: `read-${into}`, kind: 'read', read: { kind: 'rows', table: field(id, id, 'other'), columns: ['sku', 'qty'] }, into });

type UploadNode = Extract<StepNode, { kind: 'upload' }>;
const uploadNode = (over: Partial<UploadNode> = {}): UploadNode => ({ id: 'u1', kind: 'upload', url: DEST, method: 'POST', timeoutMs: 5000, ...over });
const seq = (...steps: StepNode[]): StepNode => ({ id: 'root', kind: 'sequence', steps });

function makeFlow(steps: StepNode, overrides: Partial<Flow> = {}): Flow {
  return {
    schemaVersion: 1,
    id: 'r_up',
    name: '上报流程',
    site: SITE,
    page: { urlIncludes: '/orders' },
    trigger: { kind: 'pageEnter' },
    steps,
    status: 'enabled',
    provenance: { source: 'import', createdAt: 0, updatedAt: 0 },
    ...overrides,
  };
}

const submitSteps = (): StepNode =>
  seq({ id: 'save', kind: 'action', action: { type: 'clickButton', submitLike: true, target: field('saveBtn', '保存', 'button') } });

// A driver whose reads come from a map and whose upload (when present) is the caller's spy
function fakeDriver(opts: { reads?: Record<string, unknown>; upload?: FlowDriver['upload']; handover?: FlowDriver['handover'] } = {}): FlowDriver {
  return {
    read: async (spec) => {
      const id = spec.kind === 'rows' ? spec.table.clues.id! : spec.target.clues.id!;
      return { ok: true, value: opts.reads?.[id] };
    },
    act: async () => 'ok',
    waitUntil: async () => ({ outcome: 'satisfied' }),
    ...(opts.upload !== undefined ? { upload: opts.upload } : {}),
    ...(opts.handover !== undefined ? { handover: opts.handover } : {}),
  };
}

// A Response whose body is a stream that records whether anything ever pulled from it — the
// "error body is never read" and "no capture → body never read" promises are observable only here.
// highWaterMark 0: the default strategy pre-pulls one chunk at construction regardless of readers,
// which would make the flag meaningless.
function streamResponse(chunks: string[], status = 200, headers: Record<string, string> = {}): { resp: Response; pulled: () => boolean } {
  let pulled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        const next = chunks.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(encoder.encode(next));
      },
    },
    { highWaterMark: 0 },
  );
  return { resp: new Response(stream, { status, headers }), pulled: () => pulled };
}

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('upload vocabulary helpers', () => {
  it('isHttpsUploadUrl: https only, no userinfo / query / fragment (DEC-support-http-001/003)', () => {
    expect(isHttpsUploadUrl(DEST)).toBe(true);
    expect(isHttpsUploadUrl('https://10.20.30.40:8443/api/v1/collect')).toBe(true);
    expect(isHttpsUploadUrl('http://collect.example.com/api')).toBe(false);
    expect(isHttpsUploadUrl('https://user:pw@collect.example.com/api')).toBe(false);
    expect(isHttpsUploadUrl(`${DEST}?token=1`)).toBe(false);
    expect(isHttpsUploadUrl(`${DEST}#frag`)).toBe(false);
    // A bare trailing delimiter parses to search/hash '' (WHATWG drops the empty section) but the
    // runtime GET appends `?query` to the RAW string: `…#?q` would lose the payload whole, `…??q`
    // would mangle the first key — both must be refused here, not at request time
    expect(isHttpsUploadUrl(`${DEST}?`)).toBe(false);
    expect(isHttpsUploadUrl(`${DEST}#`)).toBe(false);
    expect(isHttpsUploadUrl('not a url')).toBe(false);
    expect(isHttpsUploadUrl('')).toBe(false);
    expect(isHttpsUploadUrl(42)).toBe(false);
  });

  it('isValidUploadCredentialName: trimmed, bounded, CJK allowed, control chars refused', () => {
    expect(isValidUploadCredentialName(CRED)).toBe(true);
    expect(isValidUploadCredentialName('prod-api')).toBe(true);
    expect(isValidUploadCredentialName('a'.repeat(64))).toBe(true);
    expect(isValidUploadCredentialName(' padded ')).toBe(false);
    expect(isValidUploadCredentialName('')).toBe(false);
    expect(isValidUploadCredentialName('a'.repeat(65))).toBe(false);
    expect(isValidUploadCredentialName('tab\there')).toBe(false);
    // __proto__ would pass every other rule but the store writer assigns by plain bracket
    // assignment — the record would hit the prototype setter and silently never persist
    expect(isValidUploadCredentialName('__proto__')).toBe(false);
    expect(isValidUploadCredentialName(null)).toBe(false);
  });

  it('a __proto__ payload key is refused — the runtime copies keys by plain assignment and would silently drop it from the request', () => {
    const res = validateFlow(makeFlow(seq(uploadNode({ payload: { ['__proto__']: { ref: 'vars.orderNo' } } }))), 'import');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.some((e) => e.includes('__proto__'))).toBe(true);
  });

  it('stepsHaveUploadStep sees nested uploads; uploadDeclarationsOf collects every (url, method, credential) triple', () => {
    const nested = seq(
      readRows('lines', 'lines'),
      { id: 'f', kind: 'foreach', over: 'vars.lines', itemVar: 'line', do: [uploadNode({ id: 'u-in', method: 'GET', payload: { sku: { ref: 'line.sku' } } })] },
      { id: 'i', kind: 'if', when: { kind: 'nonEmpty', ref: 'vars.lines' }, then: [uploadNode({ id: 'u-then', credential: CRED })] },
    );
    expect(stepsHaveUploadStep(nested)).toBe(true);
    expect(stepsHaveUploadStep(submitSteps())).toBe(false);
    const declared = uploadDeclarationsOf(nested);
    expect(declared).toHaveLength(2);
    expect(declared).toContainEqual({ url: DEST, method: 'GET' });
    expect(declared).toContainEqual({ url: DEST, method: 'POST', credential: CRED });
    expect(uploadDeclarationsOf(submitSteps())).toEqual([]);
  });

  it('the six failure reasons are the closed set the i18n branches cover; the hop margin is 5s', () => {
    expect([...UPLOAD_FAILURE_REASONS]).toEqual([
      'credential-missing', 'upload-network', 'upload-status', 'upload-timeout', 'upload-response-too-large', 'upload-payload-too-large',
    ]);
    expect(UPLOAD_TIMEOUT_MARGIN_MS).toBe(5_000);
    expect(UPLOAD_CREDENTIAL_VALUE_MAX).toBe(4096);
  });
});

describe('describeSteps egress rows', () => {
  it('an upload row carries egress + the verbatim destination, and its text names payload refs, credential and capture — never the URL', () => {
    const rows = describeSteps(seq(
      readScalar('orderNo', 'orderNo'),
      uploadNode({ credential: CRED, payload: { orderNo: { ref: 'vars.orderNo' }, note: 'hello' }, capture: { into: 'receipt' } }),
    ));
    expect(rows[0]).toEqual({ text: 'read orderNo → orderNo', submit: false });
    expect('egress' in rows[0]!).toBe(false);
    expect(rows[1]).toEqual({
      text: `upload POST · payload {orderNo←vars.orderNo, note=hello} · credential ${CRED} · capture → vars.receipt`,
      submit: false,
      egress: true,
      egressUrl: DEST,
    });
    expect(rows[1]!.text).not.toContain('collect.example.com');
  });

  it('a digit-heavy destination survives untouched in egressUrl while staying out of the redactable text', () => {
    const url = 'https://10.20.30.40:8443/api/v1/collect';
    const [row] = describeSteps(seq(uploadNode({ url, method: 'GET' })));
    expect(row).toEqual({ text: 'upload GET', submit: false, egress: true, egressUrl: url });
    expect(row!.text).not.toContain('10.20.30.40');
  });
});

describe('needsBusinessClaim truth table (PRD: claim when the flow declares a businessKey)', () => {
  const businessKey = { read: { kind: 'scalar' as const, target: field('orderNo', '单据号') } };
  it('submit → claim; upload + businessKey → claim; pure upload without a key → no claim; neither → no claim', () => {
    expect(needsBusinessClaim(makeFlow(submitSteps()))).toBe(true);
    expect(needsBusinessClaim(makeFlow(submitSteps(), { businessKey }))).toBe(true);
    expect(needsBusinessClaim(makeFlow(seq(uploadNode()), { businessKey }))).toBe(true);
    expect(needsBusinessClaim(makeFlow(seq(uploadNode())))).toBe(false);
    expect(needsBusinessClaim(makeFlow(seq(readScalar('a', 'a')), { businessKey }))).toBe(false);
  });
});

describe('performUpload', () => {
  const credential = { headerName: 'Authorization', value: 'Bearer tok' };
  let calls: Recorded[];
  let lastInit: RequestInit | undefined;

  const install = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
    calls = [];
    lastInit = undefined;
    vi.stubGlobal('fetch', recordingFetch(calls, (url, init) => {
      lastInit = init;
      return handler(url, init);
    }));
  };

  const req = (over: Partial<UploadDriverRequest> = {}): UploadDriverRequest => ({ url: DEST, method: 'POST', payload: { orderNo: 'A-1' }, timeoutMs: 5000, ...over });

  it('POST with capture: JSON body, exactly one credential header + Content-Type, hard transport options, body captured', async () => {
    install(() => new Response('RCPT-1', { status: 200 }));
    const out = await performUpload(req({ payload: { orderNo: 'A-1', urgent: true, lines: [{ sku: 'S', qty: '2' }] }, captureMaxBytes: MAX_UPLOAD_CAPTURE_BYTES }), credential);
    expect(out).toEqual({ ok: true, status: 200, body: 'RCPT-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(DEST);
    expect(calls[0]!.method).toBe('POST');
    // Runtime types survive the fixed JSON mapping: string, boolean, array of row objects
    expect(JSON.parse(calls[0]!.body!)).toEqual({ orderNo: 'A-1', urgent: true, lines: [{ sku: 'S', qty: '2' }] });
    expect(calls[0]!.headers).toEqual({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
    expect(lastInit?.redirect).toBe('error');
    expect(lastInit?.credentials).toBe('omit');
    expect(lastInit?.cache).toBe('no-store');
    expect(lastInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it('GET: payload becomes the query string, no body, no Content-Type; without a credential the header set is empty', async () => {
    install(() => new Response(null, { status: 204 }));
    const out = await performUpload(req({ method: 'GET', payload: { orderNo: 'A-1', urgent: 'true', note: 'a b&c' } }), null);
    expect(out).toEqual({ ok: true, status: 204 });
    expect(calls[0]!.url).toBe(`${DEST}?orderNo=A-1&urgent=true&note=a+b%26c`);
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers).toEqual({});
  });

  it('omitted payload: GET sends no query at all, POST sends "{}" with Content-Type', async () => {
    install(() => new Response(null, { status: 200 }));
    await performUpload(req({ method: 'GET', payload: {} }), credential);
    expect(calls[0]!.url).toBe(DEST);
    expect(calls[0]!.headers).toEqual({ Authorization: 'Bearer tok' });
    await performUpload(req({ payload: {} }), null);
    expect(calls[1]!.body).toBe('{}');
    expect(calls[1]!.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('without capture the response body is never read; the outcome carries no body', async () => {
    const { resp, pulled } = streamResponse(['should-not-be-read']);
    install(() => resp);
    const out = await performUpload(req(), credential);
    expect(out).toEqual({ ok: true, status: 200 });
    expect(pulled()).toBe(false);
  });

  it('non-2xx → upload-status with the code as detail; the error body is never read or parsed (PRD §4.2)', async () => {
    const { resp, pulled } = streamResponse(['{"error":"nope"}'], 500);
    install(() => resp);
    const out = await performUpload(req({ captureMaxBytes: MAX_UPLOAD_CAPTURE_BYTES }), credential);
    expect(out).toEqual({ ok: false, reason: 'upload-status', detail: '500' });
    expect(pulled()).toBe(false);
    install(() => jsonResponse(302, {}));
    expect(await performUpload(req(), credential)).toEqual({ ok: false, reason: 'upload-status', detail: '302' });
  });

  it('a timeout is upload-timeout (possibly sent — still not retried); any other throw is upload-network; exactly one attempt each', async () => {
    install(() => { throw new DOMException('deadline', 'TimeoutError'); });
    expect(await performUpload(req(), credential)).toEqual({ ok: false, reason: 'upload-timeout', detail: DEST });
    expect(calls).toHaveLength(1);
    install(() => { throw new DOMException('aborted', 'AbortError'); });
    expect(await performUpload(req(), credential)).toEqual({ ok: false, reason: 'upload-timeout', detail: DEST });
    // redirect: 'error' surfaces as a TypeError from fetch → network class, no credential replay
    install(() => { throw new TypeError('Failed to fetch'); });
    expect(await performUpload(req(), credential)).toEqual({ ok: false, reason: 'upload-network', detail: DEST });
    expect(calls).toHaveLength(1);
  });

  it('a request over the payload cap fails BEFORE fetch (zero egress) for both methods', async () => {
    install(() => new Response(null, { status: 200 }));
    const big = 'x'.repeat(MAX_UPLOAD_PAYLOAD_BYTES + 1);
    expect(await performUpload(req({ payload: { big } }), credential)).toEqual({ ok: false, reason: 'upload-payload-too-large', detail: DEST });
    expect(await performUpload(req({ method: 'GET', payload: { big } }), credential)).toEqual({ ok: false, reason: 'upload-payload-too-large', detail: DEST });
    expect(calls).toHaveLength(0);
  });

  it('a response over the capture cap fails without truncation — by Content-Length shortcut and by streamed size alike', async () => {
    install(() => new Response('x', { status: 200, headers: { 'content-length': String(MAX_UPLOAD_CAPTURE_BYTES + 1) } }));
    expect(await performUpload(req({ captureMaxBytes: MAX_UPLOAD_CAPTURE_BYTES }), credential)).toEqual({ ok: false, reason: 'upload-response-too-large', detail: DEST });
    const half = 'y'.repeat(40_000);
    const { resp } = streamResponse([half, half]);
    install(() => resp);
    const out = await performUpload(req({ captureMaxBytes: MAX_UPLOAD_CAPTURE_BYTES }), credential);
    expect(out).toEqual({ ok: false, reason: 'upload-response-too-large', detail: DEST });
    expect('body' in out).toBe(false);
  });

  it('a streamed response within the cap is captured whole; a bodiless 2xx captures the empty string', async () => {
    const { resp } = streamResponse(['ab', 'cd']);
    install(() => resp);
    expect(await performUpload(req({ captureMaxBytes: MAX_UPLOAD_CAPTURE_BYTES }), credential)).toEqual({ ok: true, status: 200, body: 'abcd' });
    install(() => new Response(null, { status: 204 }));
    expect(await performUpload(req({ captureMaxBytes: MAX_UPLOAD_CAPTURE_BYTES }), credential)).toEqual({ ok: true, status: 204, body: '' });
  });

  it('a body that breaks or crosses the deadline MID-READ is classified like the fetch phase, never an escaping exception', async () => {
    // 2xx headers arrived, then the stream dies: the request itself may already have been
    // delivered — a network-class failure, not a crash and not "unreachable" as raw rejection
    // would surface via the content-side catch
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('ab'));
        controller.error(new TypeError('network gone'));
      },
    });
    install(() => new Response(broken, { status: 200 }));
    expect(await performUpload(req({ captureMaxBytes: MAX_UPLOAD_CAPTURE_BYTES }), credential)).toEqual({ ok: false, reason: 'upload-network', detail: DEST });
    // The node timeout signal spans the whole fetch, body included: a slow body crossing the
    // deadline aborts the stream mid-read → upload-timeout (possibly sent), the same wording the
    // fetch-phase abort gets
    const deadlineHit = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new DOMException('deadline', 'TimeoutError'));
      },
    });
    install(() => new Response(deadlineHit, { status: 200 }));
    expect(await performUpload(req({ captureMaxBytes: MAX_UPLOAD_CAPTURE_BYTES }), credential)).toEqual({ ok: false, reason: 'upload-timeout', detail: DEST });
  });
});

describe('upload credential store', () => {
  it('save → list never returns the value; resolve returns it; upsert overwrites but keeps createdAt', async () => {
    expect(await saveUploadCredential({ name: CRED, headerName: 'Authorization', value: 'Bearer one' })).toEqual({ ok: true });
    const [first] = await listUploadCredentials();
    expect(first).toEqual({ name: CRED, headerName: 'Authorization', createdAt: expect.any(Number) });
    expect('value' in first!).toBe(false);
    expect(await resolveUploadCredential(CRED)).toEqual({ headerName: 'Authorization', value: 'Bearer one' });
    expect(await saveUploadCredential({ name: CRED, headerName: 'X-API-Key', value: 'two' })).toEqual({ ok: true });
    const list = await listUploadCredentials();
    expect(list).toHaveLength(1);
    expect(list[0]!.createdAt).toBe(first!.createdAt);
    expect(await resolveUploadCredential(CRED)).toEqual({ headerName: 'X-API-Key', value: 'two' });
  });

  it('list is sorted by name; delete is immediate and a second delete reports not-found', async () => {
    await saveUploadCredential({ name: 'zeta', headerName: 'X-API-Key', value: 'z' });
    await saveUploadCredential({ name: 'alpha', headerName: 'X-API-Key', value: 'a' });
    expect((await listUploadCredentials()).map((c) => c.name)).toEqual(['alpha', 'zeta']);
    expect(await deleteUploadCredential('zeta')).toEqual({ ok: true });
    expect(await deleteUploadCredential('zeta')).toEqual({ ok: false, reason: 'not-found' });
    expect(await resolveUploadCredential('zeta')).toBeNull();
    expect((await listUploadCredentials()).map((c) => c.name)).toEqual(['alpha']);
  });

  it('refuses invalid names, non-token / protocol header names and values with line breaks — with zero writes', async () => {
    expect(await saveUploadCredential({ name: ' x ', headerName: 'Authorization', value: 'v' })).toEqual({ ok: false, reason: 'invalid-name' });
    expect(await saveUploadCredential({ name: 'a'.repeat(65), headerName: 'Authorization', value: 'v' })).toEqual({ ok: false, reason: 'invalid-name' });
    // __proto__ as a name would silently never persist (prototype setter) while reporting ok
    expect(await saveUploadCredential({ name: '__proto__', headerName: 'Authorization', value: 'v' })).toEqual({ ok: false, reason: 'invalid-name' });
    for (const headerName of ['Host', 'cookie', 'Content-Length', 'Content-Type', 'content-type', '__proto__', 'Proxy-Authorization', 'Sec-Fetch-Mode', 'Content Length', '']) {
      expect(await saveUploadCredential({ name: 'c', headerName, value: 'v' }), headerName).toEqual({ ok: false, reason: 'invalid-header' });
    }
    expect(await saveUploadCredential({ name: 'c', headerName: 'Authorization', value: 'a\r\nb' })).toEqual({ ok: false, reason: 'invalid-value' });
    expect(await saveUploadCredential({ name: 'c', headerName: 'Authorization', value: '' })).toEqual({ ok: false, reason: 'invalid-value' });
    expect(await saveUploadCredential({ name: 'c', headerName: 'Authorization', value: 'a'.repeat(UPLOAD_CREDENTIAL_VALUE_MAX + 1) })).toEqual({ ok: false, reason: 'invalid-value' });
    expect(await saveUploadCredential({ name: 'c', headerName: 'Authorization', value: '令牌abc' })).toEqual({ ok: false, reason: 'invalid-value' });
    expect(await listUploadCredentials()).toEqual([]);
  });

  it('header-name rule: RFC 7230 token minus the fetch-forbidden set and proxy-/sec- prefixes', () => {
    for (const ok of ['Authorization', 'X-API-Key', 'x-custom_token', 'Api.Key']) expect(isValidUploadHeaderName(ok), ok).toBe(true);
    for (const bad of ['Host', 'HOST', 'Cookie', 'Cookie2', 'Origin', 'Referer', 'Via', 'Transfer-Encoding', 'proxy-x', 'Sec-CH-UA', 'has space', 'ü', 'a:b']) {
      expect(isValidUploadHeaderName(bad), bad).toBe(false);
    }
    // Content-Type collides with the fixed POST Content-Type (overwritten / merged), __proto__
    // hits the plain-object assignment trap and would never attach — neither is fetch-forbidden
    for (const bad of ['Content-Type', 'CONTENT-TYPE', 'content-type', '__proto__']) {
      expect(isValidUploadHeaderName(bad), bad).toBe(false);
    }
    expect(isValidUploadCredentialValue('Bearer abc.def')).toBe(true);
    expect(isValidUploadCredentialValue('tab\there')).toBe(false);
    // Header values are ByteStrings: a codepoint above 0xFF makes Headers construction throw
    // (a TypeError, not a DOMException) — saved here, it would fail at request time as a
    // misreported network error, so it must be refused at save time. ÿ (0xFF) stays legal
    expect(isValidUploadCredentialValue('ÿ')).toBe(true);
    expect(isValidUploadCredentialValue('Ā')).toBe(false);
    expect(isValidUploadCredentialValue('令牌abc')).toBe(false);
    expect(isValidUploadCredentialValue('token😀')).toBe(false);
  });
});

describe('handlePerformUpload', () => {
  let calls: Recorded[];
  const flow = makeFlow(seq(readScalar('orderNo', 'orderNo'), uploadNode({ credential: CRED, payload: { orderNo: { ref: 'vars.orderNo' } } })));
  const msg = (over: Partial<PerformUploadMessage> = {}): PerformUploadMessage => ({
    type: 'ct:performUpload',
    flowId: flow.id,
    flowDraftHash: flowDraftHash(flow),
    url: DEST,
    method: 'POST',
    payload: { orderNo: 'A-1' },
    credentialName: CRED,
    timeoutMs: 5000,
    ...over,
  });

  beforeEach(async () => {
    calls = [];
    vi.stubGlobal('fetch', recordingFetch(calls, () => new Response('RCPT', { status: 201 })));
    await flowStoreItem.setValue(buildFlowStore([flow]));
  });

  it('automatic run: enabled flow at its current hash, declared triple, saved credential → one fetch with that single header', async () => {
    await saveUploadCredential({ name: CRED, headerName: 'Authorization', value: 'Bearer tok' });
    const res = await handlePerformUpload(msg({ captureMaxBytes: MAX_UPLOAD_CAPTURE_BYTES }), SITE);
    expect(res).toEqual({ ok: true, upload: { status: 201, body: 'RCPT' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers).toEqual({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' });
  });

  it('a missing credential fails with its name BEFORE any network activity (US-HTP-003 scene 2)', async () => {
    expect(await handlePerformUpload(msg(), SITE)).toEqual({ ok: false, reason: 'credential-missing', detail: CRED });
    expect(calls).toHaveLength(0);
  });

  it('flow binding: unknown flow, foreign site, not enabled, stale hash → flow-mismatch, zero egress', async () => {
    await saveUploadCredential({ name: CRED, headerName: 'Authorization', value: 'Bearer tok' });
    expect(await handlePerformUpload(msg({ flowId: 'r_other' }), SITE)).toEqual({ ok: false, reason: 'flow-mismatch' });
    expect(await handlePerformUpload(msg(), 'https://evil.example.net')).toEqual({ ok: false, reason: 'flow-mismatch' });
    expect(await handlePerformUpload(msg({ flowDraftHash: 'h_stale' }), SITE)).toEqual({ ok: false, reason: 'flow-mismatch' });
    await flowStoreItem.setValue(buildFlowStore([{ ...flow, status: 'paused' }]));
    expect(await handlePerformUpload(msg(), SITE)).toEqual({ ok: false, reason: 'flow-mismatch' });
    expect(calls).toHaveLength(0);
  });

  it('destination pinning: a (url, method, credentialName) triple the flow does not declare is refused — a credential never travels to a forged destination', async () => {
    await saveUploadCredential({ name: CRED, headerName: 'Authorization', value: 'Bearer tok' });
    expect(await handlePerformUpload(msg({ url: 'https://attacker.example.net/steal' }), SITE)).toEqual({ ok: false, reason: 'flow-mismatch' });
    expect(await handlePerformUpload(msg({ method: 'GET' }), SITE)).toEqual({ ok: false, reason: 'flow-mismatch' });
    expect(await handlePerformUpload(msg({ credentialName: undefined }), SITE)).toEqual({ ok: false, reason: 'flow-mismatch' });
    expect(calls).toHaveLength(0);
  });

  it('a dry run passes on sender trust alone (the editor flow may be unsaved) and still resolves the credential first', async () => {
    expect(await handlePerformUpload(msg({ flowId: 'draft-not-in-store', dryRun: true }), SITE)).toEqual({ ok: false, reason: 'credential-missing', detail: CRED });
    expect(calls).toHaveLength(0);
    await saveUploadCredential({ name: CRED, headerName: 'X-API-Key', value: 'k' });
    expect(await handlePerformUpload(msg({ flowId: 'draft-not-in-store', dryRun: true }), SITE)).toEqual({ ok: true, upload: { status: 201 } });
    expect(calls[0]!.headers).toEqual({ 'X-API-Key': 'k', 'Content-Type': 'application/json' });
  });

  it('a payload that fails the shared shape rule is bad-request even if it somehow bypassed the message guard', async () => {
    expect(await handlePerformUpload(msg({ url: 'http://collect.example.com/api/orders' }), SITE)).toEqual({ ok: false, reason: 'bad-request' });
    expect(await handlePerformUpload(msg({ method: 'GET', payload: { n: 1 } as unknown as Record<string, unknown> }), SITE)).toEqual({ ok: false, reason: 'bad-request' });
    expect(calls).toHaveLength(0);
  });

  it('no credentialName declared → no authentication header at all', async () => {
    const open = makeFlow(seq(uploadNode({ id: 'u2' })), { id: 'r_open' });
    await flowStoreItem.setValue(buildFlowStore([open]));
    const res = await handlePerformUpload(
      { type: 'ct:performUpload', flowId: open.id, flowDraftHash: flowDraftHash(open), url: DEST, method: 'POST', payload: {}, timeoutMs: 1000 },
      SITE,
    );
    expect(res).toEqual({ ok: true, upload: { status: 201 } });
    expect(calls[0]!.headers).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('isUploadRequestShape', () => {
  const base = { url: DEST, method: 'POST', payload: { a: 'x' }, timeoutMs: 1000 };
  it('accepts the resolved GET/POST shapes within every cap', () => {
    expect(isUploadRequestShape(base)).toBe(true);
    expect(isUploadRequestShape({ ...base, method: 'GET', payload: { a: 'x', b: 'true' }, credentialName: CRED, captureMaxBytes: MAX_UPLOAD_CAPTURE_BYTES })).toBe(true);
    expect(isUploadRequestShape({ ...base, payload: { rows: [{ sku: 'S' }], flag: true, n: 3, none: null, multi: ['a', 'b'] } })).toBe(true);
    expect(isUploadRequestShape({ ...base, timeoutMs: 60_000 })).toBe(true);
  });

  it('refuses every out-of-bound field: destination, method, GET non-string values, deep/odd POST values, key count, credential name, deadline, capture cap', () => {
    expect(isUploadRequestShape({ ...base, url: 'http://collect.example.com/x' })).toBe(false);
    expect(isUploadRequestShape({ ...base, method: 'DELETE' })).toBe(false);
    expect(isUploadRequestShape({ ...base, method: 'GET', payload: { a: 1 } })).toBe(false);
    expect(isUploadRequestShape({ ...base, payload: { f: () => 1 } })).toBe(false);
    expect(isUploadRequestShape({ ...base, payload: { u: undefined } })).toBe(false);
    // A payload value may nest four container levels (rows → row object is two); a fifth is refused
    expect(isUploadRequestShape({ ...base, payload: { l1: { l2: { l3: { l4: { leaf: 'ok' } } } } } })).toBe(true);
    expect(isUploadRequestShape({ ...base, payload: { l1: { l2: { l3: { l4: { l5: { leaf: 'too-deep' } } } } } } })).toBe(false);
    expect(isUploadRequestShape({ ...base, payload: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])) })).toBe(false);
    expect(isUploadRequestShape({ ...base, payload: 'not-an-object' })).toBe(false);
    expect(isUploadRequestShape({ ...base, credentialName: ' padded ' })).toBe(false);
    expect(isUploadRequestShape({ ...base, timeoutMs: 0 })).toBe(false);
    expect(isUploadRequestShape({ ...base, timeoutMs: 60_001 })).toBe(false);
    expect(isUploadRequestShape({ ...base, captureMaxBytes: MAX_UPLOAD_CAPTURE_BYTES + 1 })).toBe(false);
    expect(isUploadRequestShape({ ...base, captureMaxBytes: 0 })).toBe(false);
    expect(isUploadRequestShape({ ...base, captureMaxBytes: 1.5 })).toBe(false);
  });
});

describe('upload node in the compiled machine', () => {
  const reads = { orderNo: 'A-1', urgent: true, lines: [{ sku: 'S', qty: '2' }] };

  it('GET payload values are String()-normalized (boolean → "true"), POST keeps runtime types; the engine cap rides along only with capture', async () => {
    const seen: UploadDriverRequest[] = [];
    const driver = fakeDriver({ reads, upload: async (req) => { seen.push(req); return { ok: true, status: 200, body: 'RCPT' }; } });
    const steps = seq(
      readScalar('orderNo', 'orderNo'), readBoolean('urgent', 'urgent'), readRows('lines', 'lines'),
      uploadNode({ id: 'g', method: 'GET', payload: { orderNo: { ref: 'vars.orderNo' }, urgent: { ref: 'vars.urgent' }, note: 'n', seed: { ref: 'trigger.value' } } }),
      uploadNode({ id: 'p', payload: { urgent: { ref: 'vars.urgent' }, lines: { ref: 'vars.lines' }, phone: { ref: 'inputs.phone' } }, credential: CRED, capture: { into: 'receipt' } }),
      { id: 'a', kind: 'assert', check: { kind: 'equals', ref: 'vars.receipt', value: 'RCPT' } },
    );
    expect(validateFlow({ ...makeFlow(steps), inputs: [{ key: 'phone', label: '电话', type: 'text', required: true }] }, 'full').ok).toBe(true);
    const result = await runFlow({ steps, trigger: 'T', inputs: { phone: '138' } }, driver).result;
    expect(result.outcome).toBe('completed');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ url: DEST, method: 'GET', payload: { orderNo: 'A-1', urgent: 'true', note: 'n', seed: 'T' }, timeoutMs: 5000 });
    expect(seen[1]).toEqual({
      url: DEST, method: 'POST', payload: { urgent: true, lines: [{ sku: 'S', qty: '2' }], phone: '138' },
      credentialName: CRED, timeoutMs: 5000, captureMaxBytes: MAX_UPLOAD_CAPTURE_BYTES,
    });
    expect(result.vars.receipt).toBe('RCPT');
    expect(result.executed).toBe(5);
  });

  it('an absent optional input in the payload fails the node with input-missing and zero driver calls (DEC-form-support-007)', async () => {
    const upload = vi.fn(async (): Promise<UploadOutcome> => ({ ok: true, status: 200 }));
    const steps = seq(uploadNode({ payload: { phone: { ref: 'inputs.phone' } } }));
    const result = await runFlow({ steps, inputs: {} }, fakeDriver({ upload })).result;
    expect(result.outcome).toBe('failed');
    expect(result.failure).toMatchObject({ nodeId: 'u1', stage: 'upload', reason: 'input-missing', detail: 'inputs.phone' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('a driver refusal lands as the failure with stage upload, reason and detail; a driver without the capability fails as unsupported', async () => {
    const steps = seq(uploadNode({ credential: CRED }));
    const refused = await runFlow({ steps }, fakeDriver({ upload: async () => ({ ok: false, reason: 'credential-missing', detail: CRED }) })).result;
    expect(refused.failure).toMatchObject({ nodeId: 'u1', stage: 'upload', reason: 'credential-missing', detail: CRED, iterationPath: '' });
    const legacy = await runFlow({ steps }, fakeDriver()).result;
    expect(legacy.outcome).toBe('failed');
    expect(legacy.failure).toMatchObject({ stage: 'upload', reason: 'unsupported', detail: DEST });
  });

  it('progress hooks report the node as kind "upload" (start → ok) and an unresolved non-input ref lands as ""', async () => {
    const events: StepNodeEvent[] = [];
    const seen: UploadDriverRequest[] = [];
    const steps = seq(
      readRows('lines', 'lines'),
      { id: 'f', kind: 'foreach', over: 'vars.lines', itemVar: 'line', do: [uploadNode({ id: 'u-in', payload: { sku: { ref: 'line.sku' }, missing: { ref: 'line.nope' } } })] },
    );
    const driver = fakeDriver({ reads: { lines: [{ sku: 'S1' }] }, upload: async (req) => { seen.push(req); return { ok: true, status: 200 }; } });
    const result = await runFlow({ steps, hooks: { onNode: (e) => events.push(e) } }, driver).result;
    expect(result.outcome).toBe('completed');
    expect(seen[0]!.payload).toEqual({ sku: 'S1', missing: '' });
    expect(events.filter((e) => e.nodeId === 'u-in').map((e) => [e.phase, e.kind, e.iterationPath])).toEqual([['start', 'upload', '[0]'], ['ok', 'upload', '[0]']]);
  });
});

describe('withUpload decorator', () => {
  let sent: unknown[];
  let reply: unknown;
  let throwOnSend: Error | null;

  beforeEach(() => {
    sent = [];
    reply = { ok: true, upload: { status: 200, body: 'RCPT' } };
    throwOnSend = null;
    const runtime = fakeBrowser.runtime as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    runtime.sendMessage = async (msg: unknown) => {
      sent.push(msg);
      if (throwOnSend !== null) throw throwOnSend;
      return reply;
    };
  });

  const meta = { flowId: 'r_up', flowDraftHash: 'h1', dryRun: false };
  const req: UploadDriverRequest = { url: DEST, method: 'POST', payload: { a: 'x' }, credentialName: CRED, timeoutMs: 5000, captureMaxBytes: MAX_UPLOAD_CAPTURE_BYTES };

  it('sends ct:performUpload with the run identity and the request — no header fields — and maps the success response', async () => {
    const driver = withUpload(fakeDriver(), () => meta);
    expect(await driver.upload!(req, new AbortController().signal)).toEqual({ ok: true, status: 200, body: 'RCPT' });
    expect(sent).toEqual([{ type: 'ct:performUpload', flowId: 'r_up', flowDraftHash: 'h1', ...req }]);
    expect(Object.keys(sent[0] as object)).not.toContain('headers');
  });

  it('marks dry runs explicitly and omits optional fields that are absent', async () => {
    const driver = withUpload(fakeDriver(), () => ({ ...meta, dryRun: true }));
    reply = { ok: true, upload: { status: 204 } };
    const slim: UploadDriverRequest = { url: DEST, method: 'GET', payload: {}, timeoutMs: 100 };
    expect(await driver.upload!(slim, new AbortController().signal)).toEqual({ ok: true, status: 204 });
    expect(sent[0]).toEqual({ type: 'ct:performUpload', flowId: 'r_up', flowDraftHash: 'h1', dryRun: true, url: DEST, method: 'GET', payload: {}, timeoutMs: 100 });
  });

  it('maps refusals verbatim; a lost hop (no receiver / throw / malformed) is upload-network — never a retry', async () => {
    const driver = withUpload(fakeDriver(), () => meta);
    reply = { ok: false, reason: 'upload-status', detail: '500' };
    expect(await driver.upload!(req, new AbortController().signal)).toEqual({ ok: false, reason: 'upload-status', detail: '500' });
    reply = { ok: false, reason: 'flow-mismatch' };
    expect(await driver.upload!(req, new AbortController().signal)).toEqual({ ok: false, reason: 'flow-mismatch' });
    reply = undefined;
    expect(await driver.upload!(req, new AbortController().signal)).toEqual({ ok: false, reason: 'upload-network', detail: DEST });
    reply = { ok: true };
    expect(await driver.upload!(req, new AbortController().signal)).toEqual({ ok: false, reason: 'upload-network', detail: DEST });
    throwOnSend = new Error('Message ct:performUpload timed out');
    expect(await driver.upload!(req, new AbortController().signal)).toEqual({ ok: false, reason: 'upload-network', detail: DEST });
    expect(sent).toHaveLength(5);
  });

  it('an aborted signal never lets a queued upload out — zero messages, DriverFailure aborted (same guard as the DOM act)', async () => {
    const driver = withUpload(fakeDriver(), () => meta);
    await expect(driver.upload!(req, AbortSignal.abort())).rejects.toMatchObject({ stage: 'upload', reason: 'aborted' });
    expect(sent).toEqual([]);
  });

  it('without a live run it throws unsupported; it forwards read/act/waitUntil and an inner handover capability', async () => {
    const driver = withUpload(fakeDriver(), () => null);
    await expect(driver.upload!(req, new AbortController().signal)).rejects.toBeInstanceOf(DriverFailure);
    const handover = vi.fn(async (_req: HandoverRequest) => undefined);
    const wrapped = withUpload(fakeDriver({ reads: { x: 'v' }, handover }), () => meta);
    expect(await wrapped.read({ kind: 'scalar', target: field('x') }, { trigger: '', items: {} }, new AbortController().signal)).toEqual({ ok: true, value: 'v' });
    expect(wrapped.handover).toBeDefined();
    await wrapped.handover!({ to: 'p', resumeAfter: 'n', timeoutMs: 1, context: {} as HandoverRequest['context'] }, new AbortController().signal);
    expect(handover).toHaveBeenCalledTimes(1);
    expect(withUpload(fakeDriver(), () => meta).handover).toBeUndefined();
  });
});
