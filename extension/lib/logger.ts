// Levelled console logging over loglevel. The scope prefix identifies a line's module — the
// background service worker, the sidepanel/import page and content scripts log into separate
// DevTools consoles, so an unprefixed line cannot be traced back to its source. Everything stays
// on the console: nothing is persisted or sent anywhere (the extension's everything-stays-local
// posture covers logs too).
//
// Default levels: debug under `wxt dev`, warn in production builds (info/debug noise would bury
// the lines that matter in a user's console) and warn under Vitest so suite output stays quiet
// unless something is actually wrong.
import log from 'loglevel';

export type Logger = log.Logger;

const DEFAULT_LEVEL: log.LogLevelDesc =
  import.meta.env.PROD || import.meta.env.MODE === 'test' ? 'warn' : 'debug';

export function createLogger(scope: string): Logger {
  const scoped = log.getLogger(scope);
  scoped.methodFactory = (methodName, level, loggerName) => {
    const original = log.methodFactory(methodName, level, loggerName);
    return (...args: unknown[]) => original(`[ow:${String(loggerName)}]`, ...args);
  };
  // persist=false: levels are never written to localStorage (a MV3 service worker has none)
  scoped.setLevel(DEFAULT_LEVEL, false);
  return scoped;
}
