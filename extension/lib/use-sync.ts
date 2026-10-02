// Shared state + actions for the sidepanel "Sync" tab. One generic call() wraps every sp:sync*
// message with SYNC_TIMEOUT_MS; transient transport failures surface as 'timeout'.
import { useCallback, useEffect, useState } from 'react';
import {
  sendRuntimeMessage,
  SYNC_TIMEOUT_MS,
  type ExtensionResponse,
  type SyncStateView,
} from '@/lib/messaging';
import { t } from '@/lib/i18n';
import type { SyncMessage } from '@/lib/sync-service';

export type SyncHealth = 'unknown' | 'ok' | 'unreachable';

export type SyncCall = (msg: SyncMessage) => Promise<ExtensionResponse | undefined>;

export function useSync(): {
  status: SyncStateView | null;
  health: SyncHealth;
  notice: string | null;
  setNotice: (notice: string | null) => void;
  load: () => Promise<void>;
  call: SyncCall;
  probeHealth: () => Promise<SyncHealth>;
} {
  const [status, setStatus] = useState<SyncStateView | null>(null);
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

  useEffect(() => {
    void load();
  }, [load]);

  const call = useCallback<SyncCall>(
    async (msg) => {
      try {
        return await sendRuntimeMessage(msg, SYNC_TIMEOUT_MS);
      } catch {
        return { ok: false, reason: 'timeout', detail: t('sync.error.timeout') };
      }
    },
    [],
  );

  const probeHealth = useCallback(async (): Promise<SyncHealth> => {
    const res = await call({ type: 'sp:syncProbeHealth' });
    const next: SyncHealth = res?.ok && res.health === 'ok' ? 'ok' : 'unreachable';
    setHealth(next);
    return next;
  }, [call]);

  return { status, health, notice, setNotice, load, call, probeHealth };
}
