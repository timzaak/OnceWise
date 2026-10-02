// Sync tab root: view routing (spaces / scripts / script detail) and the top status line (server
// health + current space). Local-first: with no server configured the tab still renders the spaces
// view — nothing here gates any local feature.
import { useState } from 'react';
import { useSync } from '@/lib/use-sync';
import { t } from '@/lib/i18n';
import SyncSpacesView from './SyncSpacesView';
import SyncScriptsView from './SyncScriptsView';
import SyncScriptDetail from './SyncScriptDetail';

type SyncView =
  | { kind: 'spaces' }
  | { kind: 'scripts' }
  | { kind: 'script-detail'; scriptId: string };

// Only the sync-tab-specific styles; layout and shared components reuse the sp-* tokens
// injected by App
const SYNC_CSS = `
.sp-badge.sync-new { border-color: #b6dcd5; color: var(--ow-success); background: var(--ow-accent-soft); }
.sp-badge.submit { border-color: #e9d39b; color: var(--ow-warning); background: #fff5d6; }
.sync-intro { cursor: help; width: fit-content; }
`;

export default function SyncPanel() {
  const { status, health, load, call, probeHealth } = useSync();
  const [view, setView] = useState<SyncView>({ kind: 'spaces' });

  if (status === null) {
    return <div className="sp-loading">{t('sync.loading')}</div>;
  }

  const currentSpace =
    status.currentSpaceId === null ? null : status.spaces.find((s) => s.id === status.currentSpaceId) ?? null;

  return (
    <>
      <style>{SYNC_CSS}</style>
      {status.serverUrl !== '' && view.kind !== 'spaces' && (
        <section className="sp-card" aria-label={t('sync.server.title')}>
          <div className="sp-row" style={{ justifyContent: 'space-between' }}>
            <span className="sp-desc">
              {currentSpace?.name ?? status.serverUrl}
            </span>
            <div className="sp-row">
              <span className={`sp-badge ${health === 'ok' ? 'enabled' : health === 'unreachable' ? 'fail' : ''}`}>
                {health === 'ok'
                  ? t('sync.state.ok')
                  : health === 'unreachable'
                    ? t('sync.state.unreachable')
                    : t('sync.state.unknown')}
              </span>
              <button type="button" className="sp-btn" onClick={() => void probeHealth()}>
                {t('sync.server.probe')}
              </button>
            </div>
          </div>
        </section>
      )}

      {view.kind === 'spaces' && (
        <SyncSpacesView
          status={status}
          health={health}
          call={call}
          probeHealth={probeHealth}
          onChanged={() => void load()}
          onOpenScripts={() => setView({ kind: 'scripts' })}
        />
      )}

      {view.kind === 'scripts' &&
        (status.currentSpaceId === null || currentSpace === null ? (
          <section className="sp-card">
            <p className="sp-hint">{t('sync.spaces.empty')}</p>
            <button type="button" className="sp-btn" onClick={() => setView({ kind: 'spaces' })}>
              {t('sync.scripts.back')}
            </button>
          </section>
        ) : (
          <SyncScriptsView
            spaceId={currentSpace.id}
            spaceName={currentSpace.name}
            serverUrl={status.serverUrl}
            call={call}
            onOpenDetail={(scriptId) => setView({ kind: 'script-detail', scriptId })}
            onBack={() => setView({ kind: 'spaces' })}
          />
        ))}

      {view.kind === 'script-detail' && status.currentSpaceId !== null && currentSpace !== null && (
        <SyncScriptDetail
          spaceId={currentSpace.id}
          scriptId={view.scriptId}
          serverUrl={status.serverUrl}
          call={call}
          onBack={() => setView({ kind: 'scripts' })}
        />
      )}
    </>
  );
}
