// Local version history with user-only rollback (DEC-008/009): at most the last 10
// successful saves per flow, listed as metadata (version, readable time, current marker). Rolling
// back asks for a keyboard-accessible confirmation stating the flow lands NOT enabled; failures
// change neither the flow nor its history. Load/empty/failure states carry text, never color alone.
import { useCallback, useEffect, useState } from 'react';
import { sendRuntimeMessage } from '@/lib/messaging';
import type { FlowHistoryMeta } from '@/lib/storage';
import { formatTime } from '@/lib/ui-labels';
import { t } from '@/lib/i18n';

interface Props {
  flowId: string;
  flowName: string;
  onRolledBack: () => void;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; versions: FlowHistoryMeta[] }
  | { kind: 'error'; message: string };

export default function FlowHistorySection({ flowId, flowName, onRolledBack }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await sendRuntimeMessage({ type: 'sp:getFlowHistory', flowId });
      if (res?.ok) {
        setPhase({ kind: 'ready', versions: res.versions ?? [] });
      } else {
        setPhase({ kind: 'error', message: t('history.loadFail', { reason: res?.reason ?? t('common.unknownReason') }) });
      }
    } catch {
      setPhase({ kind: 'error', message: t('history.loadTimeout') });
    }
  }, [flowId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rollback = (version: FlowHistoryMeta) => {
    // Second confirmation: state plainly that the result is not enabled
    if (!window.confirm(t('history.rollbackConfirm', { name: flowName, version: version.versionId }))) return;
    setBusyId(version.versionId);
    setRollbackError(null);
    void (async () => {
      try {
        const res = await sendRuntimeMessage({ type: 'sp:rollbackFlow', flowId, versionId: version.versionId });
        if (!res?.ok) {
          setRollbackError(t('history.rollbackFail', { reason: res?.reason ?? t('common.unknownReason') }));
          return;
        }
        await load();
        onRolledBack();
      } catch {
        setRollbackError(t('history.rollbackFail', { reason: t('common.timeoutWord') }));
      } finally {
        setBusyId(null);
      }
    })();
  };

  return (
    <section className="sp-card" aria-label={t('history.title')}>
      <h2 className="sp-title">{t('history.title')}</h2>
      <p className="sp-sub">{t('history.hint')}</p>
      {phase.kind === 'loading' && <p className="sp-sub">{t('common.loading')}</p>}
      {phase.kind === 'error' && (
        <>
          <p className="sp-error" role="alert">{phase.message}</p>
          <div className="sp-row">
            <button type="button" className="sp-btn" onClick={() => { setPhase({ kind: 'loading' }); void load(); }}>
              {t('common.retry')}
            </button>
          </div>
        </>
      )}
      {phase.kind === 'ready' && phase.versions.length === 0 && (
        <p className="sp-sub">{t('history.empty')}</p>
      )}
      {phase.kind === 'ready' && phase.versions.length > 0 && (
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          {[...phase.versions].reverse().map((version) => (
            <li key={version.versionId} className="sp-desc">
              {t('history.versionLine', { version: version.versionId, time: formatTime(version.savedAt) })}
              {version.current ? ` · ${t('history.current')}` : ''}
              {!version.current && (
                <>
                  {' '}
                  <button
                    type="button"
                    className="sp-btn"
                    onClick={() => rollback(version)}
                    disabled={busyId !== null}
                  >
                    {busyId === version.versionId ? t('common.busy') : t('history.rollbackTo')}
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {rollbackError && <p className="sp-error" role="alert">{rollbackError}</p>}
    </section>
  );
}
