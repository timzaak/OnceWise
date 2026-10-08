// Shared protocol definitions for the OnceWise Flow native messaging channel. Both host.mjs and
// client.mjs import this file; the extension side re-implements the same guards in
// extension/lib/native-messaging.ts (double validation — host and background each enforce the op
// whitelist and payload shapes).
//
// Wire format:
// - Chrome <-> host: Native Messaging frames (4-byte little-endian length + UTF-8 JSON), stdio only.
// - host <-> client: local IPC (Windows named pipe / Unix domain socket), one JSON object per line.
// - Application request cap: 512 KiB (the serialized JSON envelope), enforced on both hops.
// - Response cap: 1 MiB — responses (host stdin) carry whole flows (flow.read), and a flow saved at
//   the request cap plus its envelope can exceed 512 KiB.
//
// Requires Node.js 22+ (skill-documented runtime; assertNode22 enforces it).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const HOST_NAME = 'ai.oncewise.native';
export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;

// Production extension ID assigned by the Chrome Web Store (item dmmhmcdbkbbgbcidafhlhepdchjboenc;
// the store rejects uploads whose manifest carries a key, so the store build cannot keep the pinned
// dev ID). The host manifest's allowed_origins must list exactly this origin unless an override is
// given explicitly (install.mjs --extension-id, e.g. fkkfdckchahnjkcbimnbhonbgcefnafi for the
// fixed-key unpacked build from extension/wxt.config.ts).
export const EXTENSION_ID = 'dmmhmcdbkbbgbcidafhlhepdchjboenc';

// Closed op whitelist. Enable / delete / rollback / list / browser / script are not part of the
// channel — destructive and user-reserved actions stay off the AI channel, and widening this list
// is a product decision, never a casual code change.
export const OPS = Object.freeze(['ping', 'flow.read', 'flow.validate', 'flow.save', 'flow.verify']);

export const ERROR_CODES = Object.freeze([
  'bad-payload',
  'payload-too-large',
  'not-json',
  'validation-failed',
  'read-not-authorized',
  'flow-not-found',
  'flow-enabled',
  'revision-stale',
  'ref-expired',
  'clock-regressed',
  'bad-ref-time',
  'storage-error',
  'extension-not-connected',
  'result-unknown',
  'unsupported-op',
]);

// Client-observable transport outcomes (not protocol responses; reported by client.mjs only).
export const TRANSPORT_CODES = Object.freeze(['not-delivered', 'extension-not-connected', 'result-unknown']);

export function assertNode22() {
  const [major] = process.versions.node.split('.').map(Number);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`OnceWise native host requires Node.js 22+ (found ${process.versions.node})`);
  }
}

export function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// Stateful chunked frame parser: push a stdin chunk, get back every complete JSON object. maxBytes
// bounds one frame — the host's stdin carries responses (use MAX_RESPONSE_BYTES there); a reader of
// request frames keeps the default request cap.
export class FrameReader {
  constructor(maxBytes = MAX_REQUEST_BYTES) {
    this.buffer = Buffer.alloc(0);
    this.maxBytes = maxBytes;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxBytes) {
        // A corrupt frame desynchronizes the stream — the only safe recovery is dropping it
        throw new Error(`native messaging frame exceeds ${this.maxBytes} bytes`);
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(4 + length);
      try {
        messages.push(JSON.parse(body));
      } catch {
        // One unreadable frame: skip it (its response id is unknown, nothing to route)
      }
    }
    return messages;
  }
}

// Stateful chunked line splitter for the newline-delimited JSON IPC: push a data chunk, get back
// every complete line (without its newline). Endpoint policies — buffer caps, per-line handling —
// stay with the endpoints.
export class LineReader {
  constructor() {
    this.buffer = '';
  }

  get pendingLength() {
    return this.buffer.length;
  }

  push(chunk) {
    this.buffer += chunk;
    const lines = [];
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      lines.push(this.buffer.slice(0, index));
      this.buffer = this.buffer.slice(index + 1);
    }
    return lines;
  }
}

export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function requestSizeOk(request) {
  return Buffer.byteLength(JSON.stringify(request ?? null), 'utf8') <= MAX_REQUEST_BYTES;
}

// Returns { ok: true, request } or { ok: false, id, code, message } — id is echoed when readable so
// the client can correlate the refusal.
export function checkRequest(v) {
  if (!isPlainObject(v)) return { ok: false, id: null, code: 'bad-payload', message: 'request must be an object' };
  const id = typeof v.id === 'string' || typeof v.id === 'number' ? v.id : null;
  if (v.v !== PROTOCOL_VERSION) {
    return { ok: false, id, code: 'bad-payload', message: `v must be ${PROTOCOL_VERSION}` };
  }
  if (id === null) return { ok: false, id: null, code: 'bad-payload', message: 'id must be a string or number' };
  if (typeof v.op !== 'string' || !OPS.includes(v.op)) {
    return { ok: false, id, code: 'unsupported-op', message: `op must be one of ${OPS.join('|')}` };
  }
  if (v.payload !== undefined && !isPlainObject(v.payload)) {
    return { ok: false, id, code: 'bad-payload', message: 'payload must be an object' };
  }
  if (!requestSizeOk(v)) {
    return { ok: false, id, code: 'payload-too-large', message: `request exceeds ${MAX_REQUEST_BYTES} bytes` };
  }
  return { ok: true, request: v };
}

export function checkResponse(v) {
  if (!isPlainObject(v) || v.v !== PROTOCOL_VERSION) return { ok: false };
  if (typeof v.id !== 'string' && typeof v.id !== 'number') return { ok: false };
  if (v.ok === true) return isPlainObject(v.data) || v.data === undefined ? { ok: true, response: v } : { ok: false };
  if (v.ok !== false) return { ok: false };
  const error = v.error;
  if (!isPlainObject(error) || typeof error.code !== 'string' || typeof error.message !== 'string') return { ok: false };
  return { ok: true, response: v };
}

export function makeOk(id, data) {
  return { v: PROTOCOL_VERSION, id, ok: true, ...(data !== undefined ? { data } : {}) };
}

export function makeError(id, code, message, errors) {
  return { v: PROTOCOL_VERSION, id, ok: false, error: { code, message, ...(errors !== undefined ? { errors } : {}) } };
}

export function newClientRef(now = Date.now()) {
  return `${now}.${randomBytes(16).toString('hex')}`;
}

export function parseClientRef(ref) {
  if (typeof ref !== 'string') return null;
  const match = /^(\d{1,15})\.([0-9a-f]{32})$/.exec(ref);
  if (match === null) return null;
  return { issuedAt: Number(match[1]), random: match[2] };
}

export function installDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'OnceWiseAI', 'native-host');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'OnceWiseAI', 'native-host');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'oncewise-ai', 'native-host');
}

// Local IPC endpoint between the AI client and the Chrome-launched host. User scope only:
// - Windows: a named pipe named after the current user (see host.mjs for the isolation note).
// - macOS/Linux: a Unix socket in a 0700 directory, socket itself 0600; the host refuses to serve
//   when it cannot enforce those modes.
export function ipcEndpoint() {
  if (process.platform === 'win32') {
    const user = os.userInfo().username.replace(/[^a-zA-Z0-9_-]/g, '_');
    return { kind: 'pipe', path: `\\\\.\\pipe\\${HOST_NAME}-${user}` };
  }
  const dir =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'OnceWiseAI', 'ipc')
      : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), '.local', 'run', 'oncewise-ai');
  return { kind: 'unix', dir, path: path.join(dir, `${HOST_NAME}.sock`) };
}

// Chrome user-level native messaging host registration location. Windows registers the manifest
// path under an HKCU registry key; macOS/Linux drop the manifest JSON into the browser's
// NativeMessagingHosts directory. `browser` selects the Chrome flavor (chrome | chromium).
export function chromeHostRegistration(browser = 'chrome', { registryRoot, manifestDir } = {}) {
  if (registryRoot !== undefined && registryRoot !== null) {
    return { kind: 'registry', key: registryRoot, manifestPath: path.join(installDir(), `${HOST_NAME}.json`) };
  }
  if (manifestDir !== undefined && manifestDir !== null) {
    return { kind: 'file', manifestPath: path.join(manifestDir, `${HOST_NAME}.json`) };
  }
  if (process.platform === 'win32') {
    const key =
      browser === 'chromium'
        ? `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`
        : `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
    return { kind: 'registry', key, manifestPath: path.join(installDir(), `${HOST_NAME}.json`) };
  }
  const browserDir =
    browser === 'chromium'
      ? process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Chromium')
        : path.join(os.homedir(), '.config', 'chromium')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
        : path.join(os.homedir(), '.config', 'google-chrome');
  return { kind: 'file', manifestPath: path.join(browserDir, 'NativeMessagingHosts', `${HOST_NAME}.json`) };
}

export function hostManifest(launcherPath, extensionId = EXTENSION_ID) {
  return {
    name: HOST_NAME,
    description: 'OnceWise Flow flow handover host (relays validated flow requests to the extension)',
    type: 'stdio',
    path: launcherPath,
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}
