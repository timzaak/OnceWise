// Shared recording fetch mock for the sync test suites: every stubbed fetch is captured as a
// Recorded entry and routed to the caller's handler. The handler arrives as a value — a suite that
// swaps handlers after install (sync-auth's stubFetch) passes a closure reading its own binding.
import { vi } from 'vitest';

export interface Recorded {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Install a recording fetch mock; the handler resolves per-request responses
export function recordingFetch(
  calls: Recorded[],
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // sync-api only ever passes a plain header record
    const headers: Record<string, string> =
      init?.headers === undefined ? {} : { ...(init.headers as Record<string, string>) };
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : String(init.body),
      headers,
    });
    return handler(url, init);
  });
}
