// Sync tab root: view routing (spaces / scripts / script detail / members) and the top status
// line (server health + current space). Local-first: with no server configured the tab still
// renders the spaces view — nothing here gates any local feature.
import { useState } from 'react';
import { useSync } from '@/lib/use-sync';
import { t } from '@/lib/i18n';
import { DEFAULT_SYNC_SERVER_URL } from '@/lib/sync-storage';
import SyncAuthCard from './SyncAuthCard';
import SyncSpacesView from './SyncSpacesView';
import SyncScriptsView from './SyncScriptsView';
import SyncScriptDetail from './SyncScriptDetail';
import SyncMembersView from './SyncMembersView';

type SyncView =
  | { kind: 'spaces' }
  | { kind: 'scripts' }
  | { kind: 'script-detail'; scriptId: string }
  | { kind: 'members' };

// Only the sync-tab-specific styles; layout and shared components reuse the sp-* tokens
// injected by App
const SYNC_CSS = `
.sp-badge.sync-new { border-color: #b6dcd5; color: var(--ow-success); background: var(--ow-accent-soft); }
.sp-badge.submit { border-color: #e9d39b; color: var(--ow-warning); background: #fff5d6; }
.sync-intro { cursor: help; width: fit-content; }
`;

export default function SyncPanel() {
  const { status, auth, health, load, call, probeHealth, refreshAuth, signIn, signOut } = useSync();
  const [view, setView] = useState<SyncView>({ kind: 'spaces' });

  // Space/server mutations also refresh the auth state — e.g. a server switch must immediately
  // re-probe the mode and drop the old server's signed-in card. The status reload is awaited so
  // callers that switch views right after (select → scripts/members) mount against the fresh
  // currentSpace, not the previous one.
  const onChanged = async () => {
    await load();
    void refreshAuth();
  };

  if (status === null) {
    return <div className="sp-loading">{t('sync.loading')}</div>;
  }

  const currentSpace =
    status.currentSpaceId === null ? null : status.spaces.find((s) => s.id === status.currentSpaceId) ?? null;

  return (
    <>
      <style>{SYNC_CSS}</style>
      {status.serverUrl !== '' && auth?.mode === 'herald' && (
        <SyncAuthCard auth={auth} signIn={signIn} signOut={signOut} />
      )}

      {status.serverUrl !== '' && view.kind !== 'spaces' && (
        <section className="sp-card" aria-label={t('sync.server.title')}>
          <div className="sp-row" style={{ justifyContent: 'space-between' }}>
            <span className="sp-desc">
              {currentSpace?.name ??
                (status.serverUrl === DEFAULT_SYNC_SERVER_URL ? t('sync.server.official') : status.serverUrl)}
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
          onChanged={onChanged}
          onOpenScripts={() => setView({ kind: 'scripts' })}
          onOpenMembers={() => setView({ kind: 'members' })}
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
            spaceCode={currentSpace.code}
            initialRole={currentSpace.myRole}
            serverUrl={status.serverUrl}
            call={call}
            onOpenDetail={(scriptId) => setView({ kind: 'script-detail', scriptId })}
            onBack={() => setView({ kind: 'spaces' })}
          />
        ))}

      {view.kind === 'members' &&
        (status.currentSpaceId === null || currentSpace === null ? (
          <section className="sp-card">
            <p className="sp-hint">{t('sync.spaces.empty')}</p>
            <button type="button" className="sp-btn" onClick={() => setView({ kind: 'spaces' })}>
              {t('sync.scripts.back')}
            </button>
          </section>
        ) : (
          <SyncMembersView
            key={currentSpace.id}
            spaceId={currentSpace.id}
            spaceName={currentSpace.name}
            myRole={currentSpace.myRole ?? 'member'}
            myUserId={currentSpace.myUserId}
            call={call}
            onBack={() => setView({ kind: 'spaces' })}
            onChanged={() => void onChanged()}
          />
        ))}

      {view.kind === 'script-detail' && status.currentSpaceId !== null && currentSpace !== null && (
        <SyncScriptDetail
          spaceId={currentSpace.id}
          scriptId={view.scriptId}
          spaceCode={currentSpace.code}
          serverUrl={status.serverUrl}
          call={call}
          onBack={() => setView({ kind: 'scripts' })}
        />
      )}
    </>
  );
}
