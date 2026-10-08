#!/usr/bin/env node
// AI-side CLI for the OnceWise Flow native channel. Sends ONE request to the host over local IPC and
// prints exactly ONE JSON result on stdout; diagnostics go to stderr.
//
// Result semantics (results must be real):
// - a protocol response arrives        -> that response verbatim (ok:true data | ok:false error)
// - the IPC endpoint cannot be reached -> ok:false error extension-not-connected (nothing was sent)
// - the write failed before flushing   -> ok:false error not-delivered (definitely not written)
// - connection lost / timeout after the request was flushed -> ok:false error result-unknown
//   (the save may or may not have happened: run `flow.verify` and check the extension state before
//   deciding anything; never retry blindly, and only save again with a fresh user confirmation)
//
// Usage:
//   node client.mjs ping
//   node client.mjs flow.read --flow-id <id>
//   node client.mjs flow.validate --file flow.json | --text '<json>'
//   node client.mjs flow.save --file flow.json [--flow-id <id> --expected-updated-at <ms>] [--ref <ref>]
//   node client.mjs flow.verify --ref <ref>
//   [--timeout <ms>] (default 10000)
//
// flow.save mints a fresh clientRef per invocation unless --ref is given; the minted ref is printed
// inside the request echo on stderr so a result-unknown outcome can still be verified afterwards.
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  assertNode22,
  checkResponse,
  ipcEndpoint,
  LineReader,
  makeError,
  newClientRef,
  parseClientRef,
} from './protocol.mjs';

function usage(message) {
  if (message !== undefined) process.stderr.write(`[oncewise-client] ${message}\n`);
  process.stderr.write(
    'usage: node client.mjs <ping|flow.read|flow.validate|flow.save|flow.verify> [options]\n' +
      '  --flow-id <id>            flow.read / flow.save replacement target\n' +
      '  --expected-updated-at <ms> required with --flow-id (CAS token from flow.read)\n' +
      '  --file <path> | --text <json>  flow.validate / flow.save payload\n' +
      '  --ref <clientRef>         use an explicit clientRef (flow.save / flow.verify)\n' +
      '  --timeout <ms>            response timeout (default 10000)\n',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const [op, ...rest] = argv;
  if (op === undefined) usage('missing op');
  const options = { op };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) usage(`missing value for ${flag}`);
    if (flag === '--flow-id') options.flowId = value;
    else if (flag === '--expected-updated-at') options.expectedUpdatedAt = value;
    else if (flag === '--file') options.file = value;
    else if (flag === '--text') options.text = value;
    else if (flag === '--ref') options.ref = value;
    else if (flag === '--timeout') options.timeout = value;
    else usage(`unknown option ${flag}`);
  }
  return options;
}

// Returns { payload, usedRef }: the wire payload plus, for flow.save only, the clientRef echoed to
// stderr — the echo never travels on the wire.
function buildPayload(options) {
  switch (options.op) {
    case 'ping':
      return { payload: {} };
    case 'flow.read':
      if (options.flowId === undefined) usage('flow.read needs --flow-id');
      return { payload: { flowId: options.flowId } };
    case 'flow.verify': {
      if (options.ref === undefined) usage('flow.verify needs --ref');
      if (parseClientRef(options.ref) === null) usage('--ref must be "<issuedAt-ms>.<32 hex chars>"');
      return { payload: { clientRef: options.ref } };
    }
    case 'flow.validate':
    case 'flow.save': {
      let text = options.text;
      if (text === undefined) {
        if (options.file === undefined) usage(`${options.op} needs --file or --text`);
        text = readFileSync(options.file, 'utf8');
      }
      JSON.parse(text); // refuse locally on obvious non-JSON; the extension re-checks authoritatively
      const payload = { text };
      let usedRef;
      if (options.op === 'flow.save') {
        let ref = options.ref;
        if (ref === undefined) ref = newClientRef();
        if (parseClientRef(ref) === null) usage('--ref must be "<issuedAt-ms>.<32 hex chars>"');
        payload.clientRef = ref;
        usedRef = ref;
        if (options.flowId !== undefined) {
          payload.flowId = options.flowId;
          const stamp = Number(options.expectedUpdatedAt);
          if (!Number.isSafeInteger(stamp)) usage('replacements need --expected-updated-at <ms> (from flow.read)');
          payload.expectedUpdatedAt = stamp;
        }
      }
      return { payload, usedRef };
    }
    default:
      usage(`unknown op "${options.op}"`);
  }
}

function emit(result, exitCode) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(exitCode);
}

function fail(code, message, exitCode) {
  emit({ ...makeError(null, code, message), transport: true }, exitCode);
}

async function main() {
  assertNode22();
  const options = parseArgs(process.argv.slice(2));
  let payload;
  let usedRef;
  try {
    ({ payload, usedRef } = buildPayload(options));
  } catch (error) {
    // A local error (unreadable --file, non-JSON text) is a usage failure, not a transport outcome —
    // it must never wear a transport code that points at the host or Chrome
    process.stderr.write(`[oncewise-client] ${error.message}\n`);
    process.exit(2);
  }
  if (usedRef !== undefined) {
    process.stderr.write(`[oncewise-client] save clientRef: ${usedRef}\n`);
  }
  const request = {
    v: 1,
    id: `c${Date.now().toString(36)}`,
    op: options.op,
    payload,
  };
  const timeoutMs = options.timeout !== undefined ? Number(options.timeout) : 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) usage('--timeout must be a positive integer (ms)');
  const endpoint = ipcEndpoint();

  let socket;
  try {
    socket = connect(endpoint.path);
  } catch (error) {
    fail('extension-not-connected', `cannot open the native channel (${error.message}); is the host installed and Chrome running with the extension?`, 1);
  }

  let flushed = false;
  const timer = setTimeout(() => {
    if (flushed) fail('result-unknown', `no response within ${timeoutMs}ms — the request was sent; verify before retrying`, 1);
    else fail('not-delivered', 'the request could not be delivered', 1);
  }, timeoutMs);

  socket.on('connect', () => {
    socket.write(`${JSON.stringify(request)}\n`, () => {
      flushed = true;
    });
  });

  const lines = new LineReader();
  socket.on('data', (chunk) => {
    for (const line of lines.push(chunk)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        clearTimeout(timer);
        fail('result-unknown', 'unreadable host response', 1);
        return;
      }
      const checked = checkResponse(message);
      clearTimeout(timer);
      if (!checked.ok) {
        fail('result-unknown', 'malformed host response', 1);
        return;
      }
      // A definitive protocol answer — including rejections like validation-failed (exit 0:
      // the transport delivered a real result; transport failures exit 1)
      emit(checked.response, 0);
    }
  });

  socket.on('error', (error) => {
    clearTimeout(timer);
    const neverConnected = ['ENOENT', 'ECONNREFUSED', 'EACCES'].includes(error.code);
    if (neverConnected) {
      fail(
        'extension-not-connected',
        `the native host is not reachable (${error.code}) — install it (oncewise-setup) and make sure this Chrome is running with the extension`,
        1,
      );
    } else if (flushed) {
      fail('result-unknown', `connection lost after the request was sent (${error.code}) — verify before retrying`, 1);
    } else {
      fail('not-delivered', `the request could not be delivered (${error.code})`, 1);
    }
  });

  socket.on('close', () => {
    clearTimeout(timer);
    if (flushed) fail('result-unknown', 'connection closed after the request was sent — verify before retrying', 1);
    else fail('not-delivered', 'connection closed before the request was sent', 1);
  });
}

main().catch((error) => {
  fail('extension-not-connected', error.message, 1);
});
