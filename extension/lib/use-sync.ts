// Shared state + actions for the sidepanel "Sync" tab. One generic call() wraps every sp:sync*
// message with a mode-appropriate timeout (auth-gated servers may legitimately spend up to 115s in
// the background; none-mode keeps the original 30s); transient transport failures surface as
// 'timeout'. Sign-in has its own long budget — it spans a real authorization window and must not
// ride the generic wrapper.
import { useCallback, useEffect, useState } from 'react';
import {
  sendRuntimeMessage,
  SYNC_AUTH_OP_TIMEOUT_MS,
  SYNC_SIGN_IN_TIMEOUT_MS,
  SYNC_TIMEOUT_MS,
  type ExtensionResponse,
  type SyncAuthView,
  type SyncStateView,
} from '@/lib/messaging';
import { t } from '@/lib/i18n';
import type { SyncMessage } from '@/lib/sync-service';

export type SyncHealth = 'unknown' | 'ok' | 'unreachable';

export type SyncCall = (msg: SyncMessage) => Promise<ExtensionResponse | undefined>;

export function useSync(): {
  status: SyncStateView | null;
  auth: SyncAuthView | null;
  health: SyncHealth;
  notice: string | null;
  setNotice: (notice: string | null) => void;
  load: () => Promise<void>;
  call: SyncCall;
  probeHealth: () => Promise<SyncHealth>;
  refreshAuth: () => Promise<void>;
  signIn: () => Promise<ExtensionResponse | undefined>;
  signOut: () => Promise<void>;
} {
  const [status, setStatus] = useState<SyncStateView | null>(null);
  // Re-read from the background on every mount (GetAuthState) — never trusted from UI cache
  const [auth, setAuth] = useState<SyncAuthView | null>(null);
  const [health, setHealth] = useState<SyncHealth>('unknown');
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await sendRuntimeMessage({ type: 'sp:syncGetStatus' });
      if (res?.ok && res.syncState) setStatus(res.syncState);
    } catch {
      // Keep the previous status when the background is momentarily unreachable
    }
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      const res = await sendRuntimeMessage({ type: 'sp:syncGetAuthState' }, SYNC_TIMEOUT_MS);
      if (res?.ok && res.authState) setAuth(res.authState);
      else setAuth({ mode: 'unknown', signedIn: false });
    } catch {
      setAuth((prev) => prev ?? { mode: 'unknown', signedIn: false });
    }
  }, []);

  useEffect(() => {
    void load();
    void refreshAuth();
  }, [load, refreshAuth]);

  // Auth-gated business messages may run up to the background's 115s budget (probe + renewal +
  // requests); none-mode keeps the original 30s hop. The mode is the panel's cached probe — at
  // worst a stale cache picks the wrong hop timeout, never a wrong wire shape.
  const call = useCallback<SyncCall>(
    async (msg) => {
      const hopMs = auth?.mode === 'herald' ? SYNC_AUTH_OP_TIMEOUT_MS : SYNC_TIMEOUT_MS;
      try {
        return await sendRuntimeMessage(msg, hopMs);
      } catch {
        return { ok: false, reason: 'timeout', detail: t('sync.error.timeout') };
      }
    },
    [auth?.mode],
  );

  const probeHealth = useCallback(async (): Promise<SyncHealth> => {
    const res = await call({ type: 'sp:syncProbeHealth' });
    const next: SyncHealth = res?.ok && res.health === 'ok' ? 'ok' : 'unreachable';
    setHealth(next);
    return next;
  }, [call]);

  const signIn = useCallback(async (): Promise<ExtensionResponse | undefined> => {
    try {
      const res = await sendRuntimeMessage({ type: 'sp:syncSignIn' }, SYNC_SIGN_IN_TIMEOUT_MS);
      await refreshAuth();
      return res;
    } catch {
      await refreshAuth();
      return { ok: false, reason: 'login-timeout', detail: t('sync.auth.loginTimeout') };
    }
  }, [refreshAuth]);

  const signOut = useCallback(async () => {
    try {
      await sendRuntimeMessage({ type: 'sp:syncSignOut' }, SYNC_TIMEOUT_MS);
    } catch {
      // The local clear may still have landed; the state refresh below is the source of truth
    }
    await refreshAuth();
  }, [refreshAuth]);

  return { status, auth, health, notice, setNotice, load, call, probeHealth, refreshAuth, signIn, signOut };
}
