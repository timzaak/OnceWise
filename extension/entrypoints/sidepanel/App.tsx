import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  sendRuntimeMessage,
  type ContentStateView,
} from '@/lib/messaging';
import { describeFlow, flowDraftHash, shortFlowId, type Flow } from '@/lib/flow-schema';
import { redactText } from '@/lib/redact';
import { t } from '@/lib/i18n';
import { formatTime, statusLabel } from '@/lib/ui-labels';
import { onboardingItem, flowFailuresItem, flowStoreItem, type FlowFailureNotice } from '@/lib/storage';
import { baseCss } from '@/lib/ui-css';
import OnboardingView from './OnboardingView';
import FlowEditor from './FlowEditor';
import SettingsPanel from './SettingsPanel';
import SyncPanel from './SyncPanel';

type View =
  | { kind: 'flows' }
  | { kind: 'edit'; flow: Flow }
  | { kind: 'sync' }
  | { kind: 'settings' }
  | { kind: 'onboarding' };

// Shared tokens (reset / typography / badges / buttons / callouts) come from lib/ui-css; only the
// sidepanel-specific layout flows live here.
const CSS = `${baseCss('sp', { btnMinHeight: '36px', btnPaddingX: '12px', cardPadding: '16px', cardGap: '8px' })}
.sp-shell { background: var(--ow-surface); border-bottom: 1px solid var(--ow-line); position: sticky; top: 0; z-index: 10; }
.sp-brand { display: flex; align-items: center; gap: 9px; padding: 14px 16px 8px; font-size: 15px; font-weight: 750; letter-spacing: -.02em; }
.sp-brand-mark { display: inline-grid; place-items: center; width: 27px; height: 27px; border-radius: 5px; background: var(--ow-ink); color: #fff; font-size: 19px; line-height: 1; }
.sp-nav { display: flex; gap: 4px; padding: 0 8px 8px; }
.sp-tab { flex: 1; min-height: 38px; border: none; background: transparent; border-radius: 5px; font-size: 13px; font-weight: 600; color: var(--ow-muted); cursor: pointer; padding: 0 4px; }
.sp-tab::before { content: ''; display: inline-block; width: 5px; height: 5px; margin-right: 6px; border-radius: 50%; background: transparent; vertical-align: middle; }
.sp-tab:hover { background: #f2f2f0; color: var(--ow-ink); }
.sp-tab:focus-visible { outline: 2px solid var(--ow-accent); outline-offset: 1px; }
.sp-tab.active { color: var(--ow-ink); }
.sp-tab.active::before { background: var(--ow-accent); }
.sp-main { flex: 1; padding: 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.sp-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; }
.sp-section-head h1 { font-size: 20px; line-height: 1.3; margin: 0; }
.sp-section-head span { font-size: 11px; color: var(--ow-muted); overflow-wrap: anywhere; text-align: right; }
.sp-flow-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.sp-flow-head .sp-title { min-width: 0; }
.sp-flow-head .sp-badge { flex: none; }
.sp-flow-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding-top: 10px; margin-top: 2px; border-top: 1px solid var(--ow-line); }
.sp-flow-id { display: inline-flex; align-items: stretch; border: 1px solid var(--ow-line); border-radius: 5px; background: var(--ow-canvas); cursor: pointer; padding: 0; overflow: hidden; }
.sp-flow-id:hover { border-color: #aaa9a5; background: #f2f2f0; }
.sp-flow-id:focus-visible { outline: 2px solid var(--ow-accent); outline-offset: 2px; }
.sp-flow-id-label { display: inline-flex; align-items: center; padding: 0 7px; font-size: 10px; font-weight: 700; letter-spacing: .05em; color: var(--ow-muted); border-right: 1px solid var(--ow-line); }
.sp-flow-id-value { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; font-weight: 600; letter-spacing: .05em; color: var(--ow-ink); padding: 3px 8px; }
.sp-flow-id-check { color: var(--ow-success); margin-left: 5px; }
.sp-badge.fail { border-color: #e2b8b8; color: var(--ow-danger); background: #fff1f0; }
.sp-input, .sp-textarea, .sp-select { width: 100%; min-height: 38px; padding: 6px 10px; font-size: 13px; font-family: inherit; border: 1px solid #cececa; border-radius: 5px; background: var(--ow-surface); color: var(--ow-ink); }
.sp-textarea { min-height: 76px; resize: vertical; }
.sp-input:focus-visible, .sp-textarea:focus-visible, .sp-select:focus-visible { outline: 2px solid var(--ow-accent); outline-offset: 1px; }
.sp-label { font-size: 13px; font-weight: 600; margin: 0 0 4px; display: block; }
.sp-field { display: flex; flex-direction: column; gap: 4px; }
.sp-empty { text-align: center; padding: 32px 16px; display: flex; flex-direction: column; gap: 12px; align-items: center; border: 1px dashed #c9c9c5; border-radius: 6px; background: var(--ow-surface); }
.sp-loading { display: flex; justify-content: center; padding: 24px; color: var(--ow-muted); font-size: 13px; }
.sp-group { border: 1px solid var(--ow-line); border-radius: 5px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.sp-option { display: flex; align-items: center; gap: 6px; font-size: 12px; min-height: 28px; }
.sp-back { align-self: flex-start; }
.sp-progress { font-size: 12px; color: var(--ow-success); margin: 0; }
.sp-progress.fail { color: var(--ow-danger); }
`;

function App() {
  const [view, setView] = useState<View>({ kind: 'flows' });
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [flowFailures, setFlowFailures] = useState<Record<string, FlowFailureNotice>>({});
  const [contentState, setContentState] = useState<ContentStateView | null>(null);
  const [onboardingSeen, setOnboardingSeen] = useState<boolean | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadFlows = useCallback(async () => {
    try {
      const res = await sendRuntimeMessage({ type: 'sp:getFlows' });
      if (res?.ok && res.flows) setFlows(res.flows);
    } catch {
      setFlows((prev) => prev ?? []);
    }
  }, []);

  const probeContent = useCallback(async () => {
    try {
      const res = await sendRuntimeMessage({ type: 'bg:getContentState' }, 4000);
      setContentState(res?.ok && res.state ? res.state : null);
    } catch {
      setContentState(null);
    }
  }, []);

  useEffect(() => {
    void onboardingItem.getValue().then((state) => setOnboardingSeen(state.seen));
    void loadFlows();
    void flowFailuresItem.getValue().then(setFlowFailures);
    void probeContent();
    // v2 single-key truth: any flows/history/receipts commit refreshes the list
    const unwatchFlows = flowStoreItem.watch(() => void loadFlows());
    const unwatchFailures = flowFailuresItem.watch((notices) => setFlowFailures(notices));
    return () => {
      unwatchFlows();
      unwatchFailures();
    };
  }, [loadFlows, probeContent]);

  const siteFlows = useMemo(() => {
    if (!flows) return null;
    const origin = contentState?.origin;
    const sorted = [...flows].sort((a, b) => b.provenance.updatedAt - a.provenance.updatedAt);
    if (!origin) return sorted;
    return [...sorted.filter((r) => r.site === origin), ...sorted.filter((r) => r.site !== origin)];
  }, [flows, contentState]);

  const setStatus = async (flow: Flow, status: Flow['status']) => {
    await sendRuntimeMessage({ type: 'sp:setFlowStatus', id: flow.id, status });
    void loadFlows();
  };

  const remove = (flow: Flow) => {
    if (!window.confirm(t('flows.confirmDelete', { name: flow.name }))) return;
    void sendRuntimeMessage({ type: 'sp:deleteFlow', id: flow.id }).then(() => loadFlows());
  };

  // The short id exists to be quoted to the AI — the chip copies it in one click; a failed copy
  // just leaves the chip unchanged rather than surfacing an error for a convenience action.
  const copyId = (flow: Flow) => {
    void navigator.clipboard.writeText(shortFlowId(flow.id)).then(
      () => setCopiedId(flow.id),
      () => undefined,
    );
  };

  useEffect(() => {
    if (copiedId === null) return;
    const timer = window.setTimeout(() => setCopiedId(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedId]);

  // First open: the full notice view replaces the workbench until acknowledged (DEC-011)
  const showOnboardingOverlay = onboardingSeen === false;

  return (
    <>
      <style>{CSS}</style>
      <div className="sp-shell">
        <div className="sp-brand"><span className="sp-brand-mark" aria-hidden="true">✓</span>OnceWise AI</div>
        {!showOnboardingOverlay && (
          <nav className="sp-nav" aria-label={t('nav.views')}>
            <button type="button" className={`sp-tab${view.kind === 'flows' || view.kind === 'edit' ? ' active' : ''}`} aria-current={view.kind === 'flows' || view.kind === 'edit' ? 'page' : undefined} onClick={() => { setView({ kind: 'flows' }); void probeContent(); }}>
              {t('nav.flows')}
            </button>
            <button type="button" className={`sp-tab${view.kind === 'sync' ? ' active' : ''}`} aria-current={view.kind === 'sync' ? 'page' : undefined} onClick={() => setView({ kind: 'sync' })}>
              {t('nav.sync')}
            </button>
            <button type="button" className={`sp-tab${view.kind === 'settings' || view.kind === 'onboarding' ? ' active' : ''}`} aria-current={view.kind === 'settings' || view.kind === 'onboarding' ? 'page' : undefined} onClick={() => setView({ kind: 'settings' })}>
              {t('nav.settings')}
            </button>
          </nav>
        )}
      </div>
      {showOnboardingOverlay ? (
        <main className="sp-main">
          <OnboardingView onClose={() => setOnboardingSeen(true)} />
        </main>
      ) : (
        <>
          <main className="sp-main">
            {view.kind === 'flows' && (
              siteFlows === null ? (
                <div className="sp-loading">{t('flows.loading')}</div>
              ) : siteFlows.length === 0 ? (
                <>
                  <div className="sp-section-head"><h1>{t('nav.flows')}</h1></div>
                  <div className="sp-empty"><p className="sp-desc">{t('flows.emptyHint')}</p></div>
                </>
              ) : (
                <>
                  <div className="sp-section-head">
                    <h1>{t('nav.flows')}</h1>
                    {contentState?.origin && <span>{contentState.origin}</span>}
                  </div>
                  {siteFlows.map((flow) => {
                    return (
                      <section key={flow.id} className="sp-card sp-flow-card" aria-label={t('flows.cardAria', { name: flow.name })}>
                        <div className="sp-flow-head">
                          <h2 className="sp-title">{flow.name}</h2>
                          <span className={`sp-badge ${flow.status}`}>{statusLabel(flow.status)}</span>
                        </div>
                        <p className="sp-sub">
                          {flow.site} · {t('flows.updatedAt', { time: formatTime(flow.provenance.updatedAt) })}
                        </p>
                        <p className="sp-desc">{redactText(describeFlow(flow))}</p>
                        {flowFailures[flow.id]?.flowDraftHash === flowDraftHash(flow) && (
                          <details className="sp-progress fail">
                            <summary>{t('flows.lastFailure')}</summary>
                            <p>{formatFlowFailure(flowFailures[flow.id])}</p>
                          </details>
                        )}
                        <div className="sp-flow-footer">
                          <button
                            type="button"
                            className="sp-flow-id"
                            title={t('flows.idTooltip')}
                            aria-label={t('flows.idCopy', { id: shortFlowId(flow.id) })}
                            onClick={() => copyId(flow)}
                          >
                            <span className="sp-flow-id-label" aria-hidden="true">{t('flows.idLabel')}</span>
                            <span className="sp-flow-id-value">
                              {shortFlowId(flow.id)}
                              {copiedId === flow.id && <span className="sp-flow-id-check" aria-hidden="true">✓</span>}
                            </span>
                          </button>
                          <div className="sp-row">
                            <button type="button" className="sp-btn primary" onClick={() => setView({ kind: 'edit', flow })}>
                              {t('flows.viewEdit')}
                            </button>
                            {flow.status === 'enabled' ? (
                              <button type="button" className="sp-btn" onClick={() => void setStatus(flow, 'paused')}>
                                {t('common.pause')}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="sp-btn"
                                onClick={() => void setStatus(flow, 'enabled')}
                              >
                                {flow.status === 'paused' ? t('common.resume') : t('common.enable')}
                              </button>
                            )}
                            <button type="button" className="sp-btn danger" onClick={() => remove(flow)}>
                              {t('common.delete')}
                            </button>
                          </div>
                        </div>
                      </section>
                    );
                  })}
                </>
              )
            )}

            {view.kind === 'edit' && (
              <FlowEditor
                key={view.flow.id}
                flow={view.flow}
                contentState={contentState}
                failureText={flowFailures[view.flow.id]?.flowDraftHash === flowDraftHash(view.flow)
                  ? formatFlowFailure(flowFailures[view.flow.id]) : null}
                onBack={() => setView({ kind: 'flows' })}
                onSaved={() => setView({ kind: 'flows' })}
              />
            )}

            {view.kind === 'sync' && <SyncPanel />}
            {view.kind === 'settings' && <SettingsPanel onShowOnboarding={() => setView({ kind: 'onboarding' })} />}
            {view.kind === 'onboarding' && (
              <>
                <button type="button" className="sp-btn sp-back" onClick={() => setView({ kind: 'settings' })}>
                  ← {t('nav.settings')}
                </button>
                <OnboardingView onClose={() => setView({ kind: 'settings' })} />
              </>
            )}
          </main>
        </>
      )}
    </>
  );
}

export default App;

function formatFlowFailure(notice: FlowFailureNotice | undefined): string {
  if (!notice) return '';
  const { failure } = notice;
  // Input-gate skips name the items to fix, not a step node — render them as plain guidance
  if (failure.reason === 'input-invalid') {
    return redactText(t('flows.inputInvalid', { detail: failure.detail ?? '' }));
  }
  if (failure.reason === 'input-unavailable') {
    return t('flows.inputUnavailable');
  }
  const pagePrefix = failure.pageId !== undefined ? t('flows.failurePage', { page: failure.pageId }) : '';
  return redactText(`${pagePrefix}${failure.nodeId}${failure.iterationPath} · ${failure.stage}: ${failure.reason}${failure.detail ? ` (${failure.detail})` : ''}`);
}
