// Compact flow list with independent enable/pause toggles (DEC-016). Deep management (edit / dry-run /
// delete / history / rollback) stays in the sidepanel workbench — this list only carries the toggle.
import { useCallback, useEffect, useState } from 'react';
import { sendRuntimeMessage } from '@/lib/messaging';
import type { Flow } from '@/lib/flow-schema';
import { formatTime, statusLabel } from '@/lib/ui-labels';
import { t } from '@/lib/i18n';
import { flowStoreItem } from '@/lib/storage';

export default function FlowListSection() {
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await sendRuntimeMessage({ type: 'sp:getFlows' });
      if (res?.ok && res.flows) setFlows(res.flows);
    } catch {
      setFlows((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
    // v2 single-key truth: the watch fires on any flows/history/receipts commit
    const unwatch = flowStoreItem.watch(() => void load());
    return () => unwatch();
  }, [load]);

  const toggle = async (flow: Flow) => {
    setBusyId(flow.id);
    setNotice(null);
    try {
      const next = flow.status === 'enabled' ? 'paused' : 'enabled';
      const res = await sendRuntimeMessage({ type: 'sp:setFlowStatus', id: flow.id, status: next });
      if (!res?.ok) {
        setNotice(t('import.list.opFail', { reason: res?.reason ?? t('common.unknownReason') }));
      }
      await load();
    } catch {
      setNotice(t('import.list.opTimeout'));
    } finally {
      setBusyId(null);
    }
  };

  const sorted = flows === null ? null : [...flows].sort((a, b) => b.provenance.updatedAt - a.provenance.updatedAt);

  return (
    <section className="im-card" aria-label={t('import.list.title')}>
      <h2 className="im-title">{t('import.list.title')}</h2>
      {notice && <p className="im-warn">{notice}</p>}
      {sorted === null ? (
        <p className="im-hint">{t('import.list.loading')}</p>
      ) : sorted.length === 0 ? (
        <div className="im-empty">
          <p className="im-desc">{t('import.list.empty')}</p>
        </div>
      ) : (
        sorted.map((flow) => (
          <div key={flow.id} className="im-list-item">
            <div className="im-row" style={{ justifyContent: 'space-between' }}>
              <strong className="im-desc">{flow.name}</strong>
              <span className={`im-badge ${flow.status}`}>{statusLabel(flow.status)}</span>
            </div>
            <div className="im-kv">
              <span className="im-sub">{flow.site} · {t('import.list.updated', { time: formatTime(flow.provenance.updatedAt, { withSeconds: false }) })}</span>
              <button
                type="button"
                className="im-btn"
                onClick={() => void toggle(flow)}
                disabled={busyId === flow.id}
              >
                {busyId === flow.id ? t('common.busy') : flow.status === 'enabled' ? t('common.pause') : t('common.enable')}
              </button>
            </div>
          </div>
        ))
      )}
      <p className="im-hint">{t('import.list.sidepanelHint')}</p>
    </section>
  );
}
