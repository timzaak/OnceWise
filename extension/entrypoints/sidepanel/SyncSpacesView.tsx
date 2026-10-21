// Sync tab S0/S1: server configuration (official vs self-hosted choice, plain-HTTP warning) and
// the locally-known spaces list —
// create (id generated on this device; key-less org-bound creation on space-permissions
// servers, otherwise the original key path), join by a pasted space code or invite code, select,
// copy the share code, forget (local), delete (server) or leave (org-bound self-exit).
// Progressive disclosure: status content (server row, spaces list) is always shown; every form
// (server address, create, join) starts collapsed behind a button and expands on demand —
// the join form must stay reachable while signed out (the gate refusal keeps the pasted code
// in the form, pinned by us-wp-002 T4).
import { useState } from 'react';
import { parseOrigin } from '@/lib/flow-schema';
import type { SyncCall, SyncHealth } from '@/lib/use-sync';
import type { ExtensionResponse, SyncStateView } from '@/lib/messaging';
import { t } from '@/lib/i18n';
import { DEFAULT_SYNC_SERVER_URL } from '@/lib/sync-storage';
import { commonSyncErrorText } from '@/lib/sync-errors';

// Self-host pointer shown as the ⓘ tooltip beside the server title — the repo behind the
// server-side image users may deploy themselves (same URL as the store listing)
const SELF_HOST_REPO_URL = 'https://github.com/timzaak/OnceWise';

interface Props {
  status: SyncStateView;
  health: SyncHealth;
  call: SyncCall;
  probeHealth: () => Promise<SyncHealth>;
  onChanged: () => void | Promise<void>;
  onOpenScripts: () => void;
  onOpenMembers: () => void;
}

function spaceErrorText(res: ExtensionResponse | undefined, fallback: string): string {
  if (res === undefined || res.ok) return fallback;
  if (res.reason === 'bad-space-key') return t('sync.error.badKey');
  if (res.reason === 'bad-space-code') return t('sync.spaces.badCode');
  if (res.reason === 'space-key-mismatch') return t('sync.spaces.keyMismatch');
  if (res.reason === 'space-not-found') return t('sync.spaces.notFound');
  // Space-permission refusals reach this view through leave (org-bound self-exit) and
  // delete — the same keys the members view maps
  if (res.reason === 'space-role-required') return t('sync.error.spaceRoleRequired');
  if (res.reason === 'space-owner-protected') return t('sync.error.spaceOwnerProtected');
  if (res.reason === 'space-last-admin-protected') return t('sync.error.spaceLastAdminProtected');
  if (res.reason === 'member-not-found') return t('sync.error.memberNotFound');
  if (res.reason === 'invite-invalid') return t('sync.error.inviteInvalid');
  if (res.reason === 'invite-expired') return t('sync.error.inviteExpired');
  if (res.reason === 'invite-already-used') return t('sync.error.inviteAlreadyUsed');
  if (res.reason === 'invite-unsupported') return t('sync.error.inviteUnsupported');
  const common = commonSyncErrorText(res);
  if (common !== null) return common;
  return res.detail ?? fallback;
}

function roleLabel(role: 'owner' | 'admin' | 'member'): string {
  if (role === 'owner') return t('sync.roles.owner');
  if (role === 'admin') return t('sync.roles.admin');
  return t('sync.roles.readOnly');
}

export default function SyncSpacesView({
  status,
  health,
  call,
  probeHealth,
  onChanged,
  onOpenScripts,
  onOpenMembers,
}: Props) {
  const configured = status.serverUrl !== '';
  // Official mode connects to the built-in default and never shows or asks for an address; only
  // a self-hosted origin is ever displayed or typed. The mode re-derives from the configured URL
  // each time the form opens.
  const officialDefault = status.serverUrl === '' || status.serverUrl === DEFAULT_SYNC_SERVER_URL;
  const [serverMode, setServerMode] = useState<'official' | 'custom'>(officialDefault ? 'official' : 'custom');
  const [serverInput, setServerInput] = useState(officialDefault ? '' : status.serverUrl);
  const [serverBusy, setServerBusy] = useState(false);
  const [serverMsg, setServerMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  // The address form only mounts while editing: configured servers show the compact status row
  // (address + health), matching the row the other sync views render
  const [editingServer, setEditingServer] = useState(!configured);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const rawInput = serverInput.trim();
  const parsedOrigin = rawInput === '' ? null : parseOrigin(rawInput.includes('://') ? rawInput : `https://${rawInput}`);

  const connectServer = () => {
    setNotice(null);
    const target = serverMode === 'official' ? DEFAULT_SYNC_SERVER_URL : parsedOrigin;
    if (!target) {
      setServerMsg({ kind: 'error', text: t('sync.server.invalid') });
      return;
    }
    if (
      status.serverUrl !== '' &&
      status.serverUrl !== target &&
      !window.confirm(t('sync.server.confirmChange'))
    ) {
      return;
    }
    setServerBusy(true);
    setServerMsg(null);
    void (async () => {
      try {
        const res = await call({ type: 'sp:syncSetServer', serverUrl: target });
        if (!res?.ok) {
          // auth-unavailable refuses before anything is saved — the "address was saved" retry hint
          // would be wrong
          setServerMsg({
            kind: 'error',
            text: res?.reason === 'auth-unavailable' ? t('sync.server.authUnavailable') : t('sync.server.unreachableSave'),
          });
          return;
        }
        setEditingServer(false);
        const next = await probeHealth();
        // The parent's status snapshot decides whether the spaces forms are enabled — refresh it
        onChanged();
        setServerMsg(next === 'ok' ? { kind: 'ok', text: t('sync.server.reachable') } : { kind: 'error', text: t('sync.server.unreachable') });
      } finally {
        setServerBusy(false);
      }
    })();
  };

  const select = async (spaceId: string) => {
    await call({ type: 'sp:syncSelectSpace', spaceId });
    // Awaited: the view switch chained after select (.then(onOpenScripts/onOpenMembers)) must
    // mount against the reloaded status, not the pre-selection one
    await onChanged();
  };

  const create = async () => {
    const name = createName.trim();
    if (name.length < 1 || name.length > 50) {
      setNotice(t('sync.spaces.nameNeeded'));
      return;
    }
    setBusy(true);
    try {
      const res = await call({ type: 'sp:syncCreateSpace', name });
      if (!res?.ok) {
        setNotice(spaceErrorText(res, t('sync.error.createFail')));
        return;
      }
      setCreateName('');
      setCreating(false);
      setNotice(t('sync.spaces.createdOk', { name: res.space!.name }));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    const code = joinCode.trim();
    if (code === '') {
      setNotice(t('sync.spaces.badCode'));
      return;
    }
    setBusy(true);
    try {
      const res = await call({ type: 'sp:syncJoinSpace', code });
      if (!res?.ok) {
        setNotice(spaceErrorText(res, t('sync.error.joinFail')));
        return;
      }
      setJoinCode('');
      setJoining(false);
      setNotice(t('sync.spaces.joinedOk', { name: res.space!.name }));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const forget = async (spaceId: string, name: string) => {
    if (!window.confirm(t('sync.spaces.confirmForget', { name }))) return;
    setBusy(true);
    try {
      const res = await call({ type: 'sp:syncForgetSpace', spaceId });
      if (!res?.ok) {
        setNotice(spaceErrorText(res, t('sync.error.forgetFail')));
        return;
      }
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  // Org-bound delete cascades the organization and outstanding invites — a different
  // confirmation than the key-space one
  const remove = async (spaceId: string, name: string, orgBound: boolean) => {
    const confirmText = orgBound
      ? t('sync.spaces.confirmDeleteProtected', { name })
      : t('sync.spaces.confirmDelete', { name });
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    try {
      const res = await call({ type: 'sp:syncDeleteSpace', spaceId });
      if (!res?.ok) {
        setNotice(spaceErrorText(res, t('sync.error.deleteFail')));
        return;
      }
      setNotice(t('sync.spaces.deleted', { name }));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  // Leave (org-bound self-exit): the server removes the membership; the local entry and
  // already-pulled content stay (forgetting them is a separate, explicit step)
  const leave = async (spaceId: string, name: string) => {
    if (!window.confirm(t('sync.spaces.confirmLeave', { name }))) return;
    setBusy(true);
    try {
      const res = await call({ type: 'sp:syncRemoveMember', spaceId, userId: '' });
      if (!res?.ok) {
        setNotice(spaceErrorText(res, t('sync.error.generic')));
        return;
      }
      setNotice(t('sync.spaces.leaveOk'));
      // The background dropped the entry's role facts on success — re-read so the row (and its
      // manager-gated buttons) disappears instead of lingering with a stale badge
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async (spaceId: string, code: string) => {
    const ok = await navigator.clipboard?.writeText(code).then(() => true).catch(() => false);
    if (ok) {
      setCopiedId(spaceId);
      window.setTimeout(() => setCopiedId(null), 2000);
    }
  };

  return (
    <>
      <section className="sp-card" aria-label={t('sync.server.title')}>
        <h2 className="sp-title">
          {t('sync.server.title')}{' '}
          <a
            className="sync-intro"
            style={{ color: 'inherit', textDecoration: 'none' }}
            href={SELF_HOST_REPO_URL}
            target="_blank"
            rel="noreferrer"
            title={t('sync.server.selfHost')}
          >
            ⓘ
          </a>
        </h2>
        {configured && !editingServer ? (
          <div className="sp-row" style={{ justifyContent: 'space-between' }}>
            <span className="sp-desc">
              {status.serverUrl === DEFAULT_SYNC_SERVER_URL ? t('sync.server.official') : status.serverUrl}
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
              <button
                type="button"
                className="sp-btn"
                onClick={() => {
                  setServerMode(officialDefault ? 'official' : 'custom');
                  setServerInput(officialDefault ? '' : status.serverUrl);
                  setServerMsg(null);
                  setEditingServer(true);
                }}
              >
                {t('sync.server.change')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="sp-field">
              <label className="sp-label" htmlFor="sync-server-mode">{t('sync.server.modeLabel')}</label>
              <select
                id="sync-server-mode"
                className="sp-select"
                value={serverMode}
                onChange={(e) => setServerMode(e.target.value as 'official' | 'custom')}
              >
                <option value="official">{t('sync.server.official')}</option>
                <option value="custom">{t('sync.server.custom')}</option>
              </select>
            </div>
            {serverMode === 'official' ? (
              <p className="sp-hint">{t('sync.server.officialHint')}</p>
            ) : (
              <>
                <div className="sp-field">
                  <label className="sp-label" htmlFor="sync-server">{t('sync.server.label')}</label>
                  <input
                    id="sync-server"
                    className="sp-input"
                    placeholder={t('sync.server.placeholder')}
                    value={serverInput}
                    onChange={(e) => setServerInput(e.target.value)}
                  />
                </div>
                {parsedOrigin?.startsWith('http://') && (
                  <p className="sp-warn">{t('sync.server.httpWarn')}</p>
                )}
              </>
            )}
            <div className="sp-row">
              <button type="button" className="sp-btn primary" disabled={serverBusy} onClick={connectServer}>
                {serverBusy ? t('sync.server.connecting') : t('sync.server.connect')}
              </button>
            </div>
          </>
        )}
        {serverMsg && <p className={serverMsg.kind === 'ok' ? 'sp-hint' : 'sp-error'}>{serverMsg.text}</p>}
      </section>

      <section className="sp-card" aria-label={t('sync.spaces.title')}>
        <h2 className="sp-title">{t('sync.spaces.title')}</h2>
        <p className="sp-hint">{t('sync.spaces.localHint')}</p>
        {notice && <p className="sp-error">{notice}</p>}
        {status.spaces.length === 0 ? (
          <p className="sp-hint">{t('sync.spaces.empty')}</p>
        ) : (
          status.spaces.map((space) => {
            const orgBound = space.code === null;
            // Rows are never hidden — a hidden row would strand its Forget button, and after a
            // leave the entry must stay forgettable (the leave notice says so). An org-bound
            // entry without a valid role is a former member (or a torn/foreign shape): no
            // badge, no role-gated buttons; Scripts stays (the server re-decides membership),
            // Forget stays (the only cleanup entry)
            const member =
              orgBound && (space.myRole === 'owner' || space.myRole === 'admin' || space.myRole === 'member');
            const manager = space.myRole === 'owner' || space.myRole === 'admin';
            return (
              <div key={space.id} className="sp-group" aria-label={space.name}>
                <div className="sp-row" style={{ justifyContent: 'space-between' }}>
                  <h3 className="sp-title" style={{ fontSize: 14 }}>{space.name}</h3>
                  <div className="sp-row">
                    {orgBound && member && (
                      <span className="sp-badge">{roleLabel(space.myRole!)}</span>
                    )}
                    {status.currentSpaceId === space.id && <span className="sp-badge enabled">{t('sync.spaces.current')}</span>}
                  </div>
                </div>
                {space.code !== null && (
                  <div className="sp-field">
                    <span className="sp-label">{t('sync.spaces.shareLabel')}</span>
                    <div className="sp-row">
                      <input className="sp-input" style={{ flex: 1 }} readOnly value={space.code} aria-label={t('sync.spaces.shareLabel')} />
                      <button type="button" className="sp-btn" onClick={() => void copyCode(space.id, space.code!)}>
                        {copiedId === space.id ? t('sync.spaces.copied') : t('sync.spaces.copy')}
                      </button>
                    </div>
                  </div>
                )}
                <div className="sp-row">
                  <button
                    type="button"
                    className="sp-btn primary"
                    disabled={busy}
                    onClick={() => void select(space.id).then(onOpenScripts)}
                  >
                    {t('sync.spaces.scripts')}
                  </button>
                  {orgBound && manager && (
                    <button
                      type="button"
                      className="sp-btn"
                      disabled={busy}
                      onClick={() => void select(space.id).then(onOpenMembers)}
                    >
                      {t('sync.spaces.members')}
                    </button>
                  )}
                  {(!orgBound || manager) && (
                    <button type="button" className="sp-btn danger" disabled={busy} onClick={() => void remove(space.id, space.name, orgBound)}>
                      {t('sync.spaces.delete')}
                    </button>
                  )}
                  <button type="button" className="sp-btn" disabled={busy} onClick={() => void forget(space.id, space.name)}>
                    {t('sync.spaces.forget')}
                  </button>
                  {/* Leave is a member action — a former member's leftover row offers no way
                      back in except a fresh invite */}
                  {orgBound && member && (
                    <button type="button" className="sp-btn" disabled={busy} onClick={() => void leave(space.id, space.name)}>
                      {t('sync.spaces.leave')}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </section>

      {configured && (
        <>
          <section className="sp-card" aria-label={t('sync.spaces.create')}>
            {creating ? (
              <>
                <div className="sp-field">
                  <label className="sp-label" htmlFor="sync-space-name">{t('sync.spaces.newName')}</label>
                  <input
                    id="sync-space-name"
                    className="sp-input"
                    placeholder={t('sync.spaces.namePlaceholder')}
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                  />
                </div>
                <div className="sp-row">
                  <button type="button" className="sp-btn primary" disabled={busy} onClick={() => void create()}>
                    {t('sync.spaces.create')}
                  </button>
                  {/* Cancel only collapses — the typed name stays for a re-open */}
                  <button type="button" className="sp-btn" disabled={busy} onClick={() => setCreating(false)}>
                    {t('common.cancel')}
                  </button>
                </div>
              </>
            ) : (
              <div className="sp-row">
                <button type="button" className="sp-btn" onClick={() => setCreating(true)}>
                  {t('sync.spaces.create')}
                </button>
              </div>
            )}
          </section>

          <section className="sp-card" aria-label={t('sync.spaces.join')}>
            {joining ? (
              <>
                <div className="sp-field">
                  <label className="sp-label" htmlFor="sync-join-code">{t('sync.spaces.joinLabel')}</label>
                  <input
                    id="sync-join-code"
                    className="sp-input"
                    placeholder={t('sync.spaces.joinPlaceholder')}
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value)}
                  />
                </div>
                <div className="sp-row">
                  <button type="button" className="sp-btn primary" disabled={busy} onClick={() => void join()}>
                    {t('sync.spaces.join')}
                  </button>
                  {/* Same retention rule as a gate refusal: cancel collapses but keeps the pasted code */}
                  <button type="button" className="sp-btn" disabled={busy} onClick={() => setJoining(false)}>
                    {t('common.cancel')}
                  </button>
                </div>
              </>
            ) : (
              <div className="sp-row">
                <button type="button" className="sp-btn" onClick={() => setJoining(true)}>
                  {t('sync.spaces.join')}
                </button>
              </div>
            )}
          </section>
        </>
      )}

      <p className="sp-hint sync-intro" title={t('sync.intro.body')}>
        ⓘ {t('sync.intro.title')}
      </p>
    </>
  );
}
