// Sync tab S0/S1: server configuration (plain-HTTP warning) and the locally-known spaces list —
// create (id+key generated on this device), join by shared code, select, copy the share code, forget
// (local) or delete (server).
import { useState } from 'react';
import { parseOrigin } from '@/lib/flow-schema';
import type { SyncCall, SyncHealth } from '@/lib/use-sync';
import type { ExtensionResponse, SyncStateView } from '@/lib/messaging';
import { t } from '@/lib/i18n';

interface Props {
  status: SyncStateView;
  health: SyncHealth;
  call: SyncCall;
  probeHealth: () => Promise<SyncHealth>;
  onChanged: () => void;
  onOpenScripts: () => void;
}

function spaceErrorText(res: ExtensionResponse | undefined, fallback: string): string {
  if (res === undefined || res.ok) return fallback;
  if (res.reason === 'unreachable') return t('sync.error.unreachable');
  if (res.reason === 'bad-space-key') return t('sync.error.badKey');
  if (res.reason === 'bad-space-code') return t('sync.spaces.badCode');
  if (res.reason === 'space-key-mismatch') return t('sync.spaces.keyMismatch');
  if (res.reason === 'space-not-found') return t('sync.spaces.notFound');
  if (res.reason === 'invalid-input') return res.detail ?? t('sync.error.invalidInput');
  // Auth-gate outcomes: sign-in guidance (never a permission/role notice — any valid sign-in is
  // enough), a retryable dependency failure, an unknown-outcome write, and a session replaced
  // mid-operation
  if (res.reason === 'sign-in-required') return t('sync.auth.required');
  if (res.reason === 'auth-unavailable') return t('sync.auth.unavailable');
  if (res.reason === 'operation-uncertain') return t('sync.auth.operationUncertain');
  if (res.reason === 'auth-changed') return t('sync.auth.relogin');
  return res.detail ?? fallback;
}

export default function SyncSpacesView({ status, health, call, probeHealth, onChanged, onOpenScripts }: Props) {
  const [serverInput, setServerInput] = useState(status.serverUrl);
  const [serverBusy, setServerBusy] = useState(false);
  const [serverMsg, setServerMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const rawInput = serverInput.trim();
  const parsedOrigin = rawInput === '' ? null : parseOrigin(rawInput.includes('://') ? rawInput : `https://${rawInput}`);
  const configured = status.serverUrl !== '';

  const connectServer = () => {
    setNotice(null);
    if (!parsedOrigin) {
      setServerMsg({ kind: 'error', text: t('sync.server.invalid') });
      return;
    }
    if (
      status.serverUrl !== '' &&
      status.serverUrl !== parsedOrigin &&
      !window.confirm(t('sync.server.confirmChange'))
    ) {
      return;
    }
    setServerBusy(true);
    setServerMsg(null);
    void (async () => {
      try {
        const res = await call({ type: 'sp:syncSetServer', serverUrl: parsedOrigin });
        if (!res?.ok) {
          // auth-unavailable refuses before anything is saved — the "address was saved" retry hint
          // would be wrong
          setServerMsg({
            kind: 'error',
            text: res?.reason === 'auth-unavailable' ? t('sync.server.authUnavailable') : t('sync.server.unreachableSave'),
          });
          return;
        }
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
    onChanged();
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

  const remove = async (spaceId: string, name: string) => {
    if (!window.confirm(t('sync.spaces.confirmDelete', { name }))) return;
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
        <h2 className="sp-title">{t('sync.server.title')}</h2>
        {configured && (
          <p className="sp-sub">
            {t('sync.server.current', {
              url: status.serverUrl,
              state:
                health === 'ok'
                  ? t('sync.server.state.ok')
                  : health === 'unreachable'
                    ? t('sync.server.state.unreachable')
                    : t('sync.server.state.unknown'),
            })}
          </p>
        )}
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
        {serverMsg && <p className={serverMsg.kind === 'ok' ? 'sp-hint' : 'sp-error'}>{serverMsg.text}</p>}
        <div className="sp-row">
          <button type="button" className="sp-btn primary" disabled={serverBusy} onClick={connectServer}>
            {serverBusy ? t('sync.server.connecting') : t('sync.server.connect')}
          </button>
        </div>
      </section>

      <section className="sp-card" aria-label={t('sync.spaces.title')}>
        <h2 className="sp-title">{t('sync.spaces.title')}</h2>
        <p className="sp-hint">{t('sync.spaces.localHint')}</p>
        {notice && <p className="sp-error">{notice}</p>}
        {status.spaces.length === 0 ? (
          <p className="sp-hint">{t('sync.spaces.empty')}</p>
        ) : (
          status.spaces.map((space) => (
            <div key={space.id} className="sp-group" aria-label={space.name}>
              <div className="sp-row" style={{ justifyContent: 'space-between' }}>
                <h3 className="sp-title" style={{ fontSize: 14 }}>{space.name}</h3>
                {status.currentSpaceId === space.id && <span className="sp-badge enabled">{t('sync.spaces.current')}</span>}
              </div>
              <div className="sp-field">
                <span className="sp-label">{t('sync.spaces.shareLabel')}</span>
                <div className="sp-row">
                  <input className="sp-input" style={{ flex: 1 }} readOnly value={space.code} aria-label={t('sync.spaces.shareLabel')} />
                  <button type="button" className="sp-btn" onClick={() => void copyCode(space.id, space.code)}>
                    {copiedId === space.id ? t('sync.spaces.copied') : t('sync.spaces.copy')}
                  </button>
                </div>
              </div>
              <div className="sp-row">
                <button
                  type="button"
                  className="sp-btn primary"
                  disabled={busy}
                  onClick={() => void select(space.id).then(onOpenScripts)}
                >
                  {t('sync.spaces.scripts')}
                </button>
                <button type="button" className="sp-btn danger" disabled={busy} onClick={() => void remove(space.id, space.name)}>
                  {t('sync.spaces.delete')}
                </button>
                <button type="button" className="sp-btn" disabled={busy} onClick={() => void forget(space.id, space.name)}>
                  {t('sync.spaces.forget')}
                </button>
              </div>
            </div>
          ))
        )}
      </section>

      {configured && (
        <>
          <section className="sp-card" aria-label={t('sync.spaces.create')}>
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
            <button type="button" className="sp-btn primary" disabled={busy} onClick={() => void create()}>
              {t('sync.spaces.create')}
            </button>
          </section>

          <section className="sp-card" aria-label={t('sync.spaces.join')}>
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
            <button type="button" className="sp-btn primary" disabled={busy} onClick={() => void join()}>
              {t('sync.spaces.join')}
            </button>
          </section>
        </>
      )}

      <p className="sp-hint sync-intro" title={t('sync.intro.body')}>
        ⓘ {t('sync.intro.title')}
      </p>
    </>
  );
}
