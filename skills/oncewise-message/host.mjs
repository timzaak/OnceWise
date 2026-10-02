#!/usr/bin/env node
// OnceWise AI native messaging host. Chrome launches this process when the extension calls
// connectNative('ai.oncewise.native'); it then bridges two channels:
//
//   AI client <--local IPC (newline-delimited JSON)--> this host <--Native Messaging frames--> extension
//
// Flows of the road:
// - stdout carries ONLY Chrome Native Messaging frames (4-byte LE length + JSON); diagnostics go to
//   stderr. Never console.log to stdout.
// - The host is a relay with its own validation: every client line passes the shared envelope guard
//   (v/id/op whitelist/payload/size) before it is forwarded; unknown ops answer unsupported-op with
//   zero side effects. The extension re-validates everything independently.
// - Lifetime: bound to the Chrome port. When Chrome closes stdin the host shuts down; the IPC socket
//   is removed on the way out.
// - Scope: user-level only. On macOS/Linux the socket directory is forced to 0700 and the socket to
//   0600 — the host refuses to serve when it cannot enforce those modes. On Windows the named pipe is
//   scoped by the current username (see the note at serveIpc); hard cross-user ACL enforcement is a
//   platform-validation item recorded in skills/oncewise-setup/references/native-host-setup.md.
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import {
  FrameReader,
  LineReader,
  MAX_RESPONSE_BYTES,
  checkRequest,
  checkResponse,
  encodeFrame,
  ipcEndpoint,
  makeError,
  assertNode22,
} from './protocol.mjs';

assertNode22();

const endpoint = ipcEndpoint();
const pending = new Map(); // host-side correlation id -> { socket, clientId }
let nextCorrelationId = 0;
let shuttingDown = false;

function stderr(...args) {
  process.stderr.write(`[oncewise-native-host] ${args.join(' ')}\n`);
}

function writeClientLine(socket, message) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

// stdin carries the extension's RESPONSES (flow.read returns whole flows), so this stream is bounded
// by the response cap, not the request cap
const frameReader = new FrameReader(MAX_RESPONSE_BYTES);

process.stdin.on('data', (chunk) => {
  let messages;
  try {
    messages = frameReader.push(chunk);
  } catch (error) {
    stderr('frame stream desynchronized:', error.message);
    shutdown(1);
    return;
  }
  for (const message of messages) {
    const checked = checkResponse(message);
    if (!checked.ok) {
      stderr('dropping unreadable Chrome message');
      continue;
    }
    const { response } = checked;
    const waiter = pending.get(String(response.id));
    if (waiter === undefined) {
      stderr(`response without a waiting request (id ${response.id})`);
      continue;
    }
    pending.delete(String(response.id));
    writeClientLine(waiter.socket, { ...response, id: waiter.clientId });
  }
});

process.stdin.on('end', () => shutdown(0, 'Chrome closed the native port'));
process.stdin.on('error', () => shutdown(0, 'stdin error'));
process.stdout.on('error', () => shutdown(0, 'stdout error'));

function handleClientLine(socket, line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    writeClientLine(socket, makeError(null, 'not-json', 'the request line is not valid JSON'));
    return;
  }
  const checked = checkRequest(parsed);
  if (!checked.ok) {
    writeClientLine(socket, makeError(checked.id, checked.code, checked.message));
    return;
  }
  const request = checked.request;
  const correlationId = String(++nextCorrelationId);
  pending.set(correlationId, { socket, clientId: request.id });
  process.stdout.write(encodeFrame({ v: request.v, id: correlationId, op: request.op, payload: request.payload }));
}

function serveIpc() {
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    const lines = new LineReader();
    socket.on('data', (chunk) => {
      for (const line of lines.push(chunk)) handleClientLine(socket, line);
      // A client that never sends a newline would grow the buffer unboundedly
      if (lines.pendingLength > 1_048_576) socket.destroy();
    });
    const drop = () => {
      for (const [correlationId, waiter] of pending) {
        if (waiter.socket === socket) {
          pending.delete(correlationId);
          // The request already left for Chrome; its response (if any) is dropped — the client
          // observes a closed connection and must treat the outcome as unknown, never as success.
        }
      }
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  // Windows named pipes live in a global namespace; Node cannot attach an explicit DACL from pure JS,
  // so user scoping relies on the username-derived pipe name plus the default pipe security (write
  // access restricted to the creating user/administrators). Real-machine verification of that
  // boundary is tracked as a platform-validation item.
  if (endpoint.kind === 'unix') {
    mkdirSync(endpoint.dir, { recursive: true, mode: 0o700 });
    chmodSync(endpoint.dir, 0o700);
    try {
      unlinkSync(endpoint.path);
    } catch {
      // no stale socket — fine
    }
  }

  server.listen(endpoint.path, () => {
    if (endpoint.kind === 'unix') {
      // bind() creates the socket with 0777 & ~umask (typically 0755) — tighten it to 0600
      // explicitly, then verify; filesystems that cannot represent the mode still refuse.
      chmodSync(endpoint.path, 0o600);
      const enforced =
        (statSync(endpoint.dir).mode & 0o777) === 0o700 && (statSync(endpoint.path).mode & 0o777) === 0o600;
      if (!enforced) {
        stderr(`refusing to serve: ${endpoint.dir} must be 0700 and the socket 0600`);
        shutdown(1);
        return;
      }
    }
    stderr(`listening on ${endpoint.path}`);
  });

  server.on('error', (error) => {
    stderr(`IPC server error: ${error.message}`);
    shutdown(1);
  });

  return server;
}

let ipcServer;

function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason !== undefined) stderr('shutting down:', reason);
  // Requests already forwarded to Chrome can no longer be answered — their clients see the close and
  // must treat those outcomes as unknown.
  for (const { socket } of pending.values()) socket.end();
  ipcServer?.close(() => undefined);
  if (endpoint.kind === 'unix') {
    try {
      unlinkSync(endpoint.path);
    } catch {
      // already gone
    }
  }
  process.exitCode = code;
  process.stdin.destroy();
  setImmediate(() => process.exit(code));
}

process.on('SIGINT', () => shutdown(0, 'SIGINT'));
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));

ipcServer = serveIpc();
