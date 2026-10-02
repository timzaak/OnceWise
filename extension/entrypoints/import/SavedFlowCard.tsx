// Saved-summary card (DEC-016): after a native-channel save this card reads the REAL flow
// from the store (by flowId — the session pointer only says which flow to show) and renders its
// summary plus the one-click enable. The enable click belongs to the user only: the AI never operates
// this page.
import { useCallback, useEffect, useState } from 'react';
import { sendRuntimeMessage } from '@/lib/messaging';
import { describePages, describeTrigger, describeSteps, type Flow } from '@/lib/flow-schema';
import { redactText } from '@/lib/redact';
import { t } from '@/lib/i18n';
import { statusLabel } from '@/lib/ui-labels';
import { lastNativeSaveItem } from '@/lib/storage';

type OneStopPhase =
  | { kind: 'idle' }
  | { kind: 'enabling' }
  | { kind: 'done' }
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; message: string };

export default function SavedFlowCard() {
  const [pointer, setPointer] = useState<Awaited<ReturnType<typeof lastNativeSaveItem.getValue>> | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [loading, setLoading] = useState(false);
  const [oneStop, setOneStop] = useState<OneStopPhase>({ kind: 'idle' });

  const load = useCallback(async (flowId: string) => {
    setLoading(true);
    try {
      const res = await sendRuntimeMessage({ type: 'sp:getFlows' });
      const found = res?.ok ? res.flows?.find((r) => r.id === flowId) : undefined;
      setFlow(found ?? null);
    } catch {
      setFlow(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void lastNativeSaveItem.getValue().then(setPointer);
    const unwatch = lastNativeSaveItem.watch((next) => {
      setPointer(next);
      setOneStop({ kind: 'idle' });
    });
    return () => unwatch();
  }, []);

  useEffect(() => {
    if (pointer !== null) void load(pointer.flowId);
    else setFlow(null);
  }, [pointer, load]);

  if (pointer === null) return null;

  if (flow === null) {
    return (
      <section className="im-card" aria-label={t('saved.title')}>
        <h2 className="im-title">{t('saved.title')}</h2>
        <p className="im-desc">{loading ? t('common.loading') : t('saved.flowGone')}</p>
      </section>
    );
  }

  return (
    <section className="im-card" aria-label={t('saved.title')}>
      <div className="im-row" style={{ justifyContent: 'space-between' }}>
        <h2 className="im-title">{t('saved.title')}</h2>
        <span className={`im-badge ${flow.status}`}>{statusLabel(flow.status)}</span>
      </div>
      <p className="im-hint">
        {pointer.replayed ? t('saved.replayedHint') : t('saved.hint')}
      </p>
      <div className="im-result ok">
        <div className="im-row" style={{ justifyContent: 'space-between' }}>
          <strong className="im-desc">{flow.name}</strong>
        </div>
        <div className="im-info-row"><span className="k">{t('import.info.site')}</span><span>{flow.site}</span></div>
        <div className="im-info-row"><span className="k">{t('import.info.page')}</span><span>{describePages(flow)}</span></div>
        <div className="im-info-row"><span className="k">{t('import.info.trigger')}</span><span>{describeTrigger(flow)}</span></div>
        <ol className="im-actions">
          {describeSteps(flow.steps).map((step, i) => (
            <li key={i} className="im-action-item">
              {step.submit && <span className="im-badge submit">{t('import.submitBadge')}</span>}
              <span>{redactText(step.text)}</span>
            </li>
          ))}
        </ol>
        <OneStopEnable flow={flow} oneStop={oneStop} onEnable={() => void enable(flow)} />
      </div>
    </section>
  );

  function enable(target: Flow) {
    setOneStop({ kind: 'enabling' });
    void (async () => {
      const enabled = await sendRuntimeMessage({
        type: 'sp:setFlowStatus',
        id: target.id,
        status: 'enabled',
      }).catch(() => undefined);
      if (!enabled?.ok) {
        if (enabled?.reason === 'flow-not-found') {
          // The flow was deleted concurrently (e.g. from the sidepanel) — the card is dead, no retry
          setOneStop({ kind: 'invalid', message: t('import.oneshot.flowGone') });
          return;
        }
        setOneStop({
          kind: 'error',
          message: t('import.oneshot.enableFail', { reason: enabled?.reason ?? t('common.timeoutWord') }),
        });
        return;
      }
      setOneStop({ kind: 'done' });
      void load(target.id);
    })();
  }
}

function OneStopEnable({
  flow,
  oneStop,
  onEnable,
}: {
  flow: Flow;
  oneStop: OneStopPhase;
  onEnable: () => void;
}) {
  const busy = oneStop.kind === 'enabling';
  const done = oneStop.kind === 'done' || flow.status === 'enabled';
  return (
    <div className="im-next-step" aria-label={t('import.oneshot.title')}>
      <h3 className="im-title">{t('import.oneshot.title')}</h3>
      <p className="im-hint">{t('import.oneshot.hint', { site: flow.site })}</p>
      {busy && <p className="im-steps">{t('import.oneshot.enabling')}</p>}
      {done && (
        <p className="im-row">
          <span className="im-badge enabled">{t('import.oneshot.enabled')}</span>
          <span className="im-hint">{t('import.oneshot.doneHint')}</span>
        </p>
      )}
      {oneStop.kind === 'error' && <p className="im-warn">{oneStop.message}</p>}
      {oneStop.kind === 'invalid' && <p className="im-warn">{oneStop.message}</p>}
      {!done && oneStop.kind !== 'invalid' && (
        <div className="im-row">
          <button type="button" className="im-btn primary" onClick={onEnable} disabled={busy}>
            {busy ? t('common.busy') : t('common.enable')}
          </button>
          {oneStop.kind === 'error' && (
            <span className="im-hint">{t('import.oneshot.laterHint')}</span>
          )}
        </div>
      )}
    </div>
  );
}
