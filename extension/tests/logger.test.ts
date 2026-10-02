// The wrapper's two jobs: tag every line with its scope (the background service worker, the
// sidepanel/import page and content scripts log into separate DevTools consoles — an untagged
// line cannot be traced back to its module) and gate by level (a production build must not spray
// info/debug into a user's console). loglevel maps the debug level onto console.log, so the
// spies target the console method loglevel actually calls.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/lib/logger';

describe('createLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefixes lines with the scope so a line can be traced back to its module', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = createLogger('trace-me');
    logger.setLevel('debug');
    logger.debug('hello');
    expect(spy).toHaveBeenCalledWith('[ow:trace-me]', 'hello');
  });

  it('suppresses levels below the threshold', () => {
    const debugSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = createLogger('gated');
    logger.setLevel('warn');
    logger.debug('hidden');
    logger.warn('shown');
    expect(debugSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[ow:gated]', 'shown');
  });
});
