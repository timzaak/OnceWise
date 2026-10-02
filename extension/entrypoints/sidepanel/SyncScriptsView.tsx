// Sync tab S2: the space's script list (pinned / new-version / local-edits badges, masked display) and
// saving a local flow as a script (with the explicit data-leaves-your-device confirmation).
import { useCallback, useEffect, useState } from 'react';
import { sendRuntimeMessage } from '@/lib/messaging';
import type { ScriptRowView } from '@/lib/messaging';
import type { Flow } from '@/lib/flow-schema';
import { redactText } from '@/lib/redact';
import { t } from '@/lib/i18n';
import type { SyncCall } from '@/lib/use-sync';

interface Props {
  spaceId: string;
  spaceName: string;
  serverUrl: string;
  call: SyncCall;
  onOpenDetail: (scriptId: string) => void;
  onBack: () => void;
}

function errorText(res: { ok: false; reason: string; detail?: string } | undefined, fallback: string): string {
  if (res === undefined) return fallback;
  if (res.reason === 'unreachable') return t('sync.error.unreachable');
  if (res.reason === 'bad-space-key') return t('sync.error.badKey');
  if (res.reason === 'space-not-found') return t('sync.scripts.spaceGone');
  if (res.reason === 'invalid-input') return res.detail ?? t('sync.error.invalidInput');
  return res.detail ?? fallback;
}

export default function SyncScriptsView({ spaceId, spaceName, serverUrl, call, onOpenDetail, onBack }: Props) {
  const [rows, setRows] = useState<ScriptRowView[] | null>(null);
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeWarn, setNoticeWarn] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [flowId, setFlowId] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [versionNote, setVersionNote] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [listRes, flowsRes] = await Promise.all([
        call({ type: 'sp:syncListScripts', spaceId }),
        sendRuntimeMessage({ type: 'sp:getFlows' }),
      ]);
      if (listRes?.ok && listRes.scriptRows) {
        setRows(listRes.scriptRows);
        setNotice(null);
      } else if (listRes !== undefined && listRes.ok === false) {
        setNoticeWarn(listRes.reason === 'space-not-found' || listRes.reason === 'bad-space-key');
        setNotice(errorText(listRes, t('sync.scripts.loadFail')));
      }
      if (flowsRes?.ok && flowsRes.flows) setFlows(flowsRes.flows);
    } finally {
      setBusy(false);
    }
  }, [call, spaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const linkedFlowIds = new Set((rows ?? []).map((r) => r.local?.flowId).filter((id): id is string => id !== undefined));
  const unlinkedFlows = (flows ?? []).filter((r) => !linkedFlowIds.has(r.id));

  const pickFlow = (id: string) => {
    setFlowId(id);
    const flow = unlinkedFlows.find((r) => r.id === id);
    setName(flow?.name ?? '');
  };

  const upload = async () => {
    const trimmed = name.trim();
    if (flowId === '') {
      setNoticeWarn(false);
      setNotice(t('sync.scripts.save.pickFlow'));
      return;
    }
    if (trimmed.length < 1 || trimmed.length > 100) {
      setNoticeWarn(false);
      setNotice(t('sync.scripts.save.nameNeeded'));
      return;
    }
    if (!window.confirm(t('sync.scripts.save.cloudConfirm', { server: serverUrl }))) {
      return;
    }
    setBusy(true);
    try {
      const res = await call({ type: 'sp:syncUploadScript', flowId, name: trimmed, note, versionNote });
      if (!res?.ok) {
        setNoticeWarn(false);
        setNotice(
          res !== undefined && res.ok === false && res.reason === 'flow-not-found'
            ? t('sync.scripts.save.flowGone')
            : errorText(res as { ok: false; reason: string; detail?: string }, t('sync.error.generic')),
        );
        return;
      }
      setNoticeWarn(false);
      setNotice(t('sync.scripts.save.ok'));
      setUploadOpen(false);
      setFlowId('');
      setName('');
      setNote('');
      setVersionNote('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="sp-card">
        <div className="sp-row" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="sp-btn" onClick={onBack}>
            {t('sync.scripts.back')}
          </button>
          <button type="button" className="sp-btn" disabled={busy} onClick={() => void load()}>
            {t('common.refresh')}
          </button>
        </div>
        <p className="sp-sub">{spaceName}</p>
        {notice && <p className={noticeWarn ? 'sp-warn' : 'sp-error'}>{notice}</p>}
      </section>

      {(rows ?? []).map((row) => (
        <section key={row.id} className="sp-card" aria-label={row.name}>
          <div className="sp-row" style={{ justifyContent: 'space-between' }}>
            <h2 className="sp-title" style={{ fontSize: 14 }}>{row.name}</h2>
            <span className="sp-badge">{t('sync.scripts.latest', { n: row.latestVersionNumber })}</span>
          </div>
          {row.note !== '' && <p className="sp-sub">{t('sync.scripts.note', { note: redactText(row.note) })}</p>}
          <p className="sp-sub">{t('sync.scripts.latestNote', { note: redactText(row.latestVersionNote) || '—', time: row.updatedAt })}</p>
          {row.local && (
            <div className="sp-row">
              <span className="sp-badge">{t('sync.scripts.pinned', { n: row.local.pinnedVersionNumber })}</span>
              {row.local.newVersionAvailable && (
                <span className="sp-badge sync-new">{t('sync.scripts.newVersion', { n: row.latestVersionNumber })}</span>
              )}
              {row.local.hasLocalEdits && <span className="sp-badge paused">{t('sync.scripts.localEdits')}</span>}
              {!row.local.localFlowExists && <span className="sp-badge fail">{t('sync.scripts.flowDeleted')}</span>}
            </div>
          )}
          <button type="button" className="sp-btn primary" onClick={() => onOpenDetail(row.id)}>
            {t('sync.scripts.detail')}
          </button>
        </section>
      ))}

      {rows !== null && rows.length === 0 && (
        <div className="sp-empty">
          <p className="sp-desc">{t('sync.scripts.empty')}</p>
        </div>
      )}

      <section className="sp-card" aria-label={t('sync.scripts.save.title')}>
        {!uploadOpen ? (
          <button type="button" className="sp-btn primary" disabled={(flows ?? []).length === 0} onClick={() => setUploadOpen(true)}>
            {t('sync.scripts.save.title')}
          </button>
        ) : (
          <>
            <h2 className="sp-title" style={{ fontSize: 14 }}>{t('sync.scripts.save.title')}</h2>
            <div className="sp-field">
              <label className="sp-label" htmlFor="sync-upload-flow">{t('sync.scripts.save.flowLabel')}</label>
              <select id="sync-upload-flow" className="sp-select" value={flowId} onChange={(e) => pickFlow(e.target.value)}>
                <option value="" disabled>
                  {t('sync.scripts.save.pick')}
                </option>
                {unlinkedFlows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {r.site}
                  </option>
                ))}
              </select>
              {unlinkedFlows.length === 0 && <p className="sp-hint">{t('sync.scripts.save.allLinked')}</p>}
            </div>
            <div className="sp-field">
              <label className="sp-label" htmlFor="sync-upload-name">{t('sync.scripts.save.nameLabel')}</label>
              <input id="sync-upload-name" className="sp-input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="sp-field">
              <label className="sp-label" htmlFor="sync-upload-note">{t('sync.scripts.save.noteLabel')}</label>
              <input id="sync-upload-note" className="sp-input" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="sp-field">
              <label className="sp-label" htmlFor="sync-upload-vnote">{t('sync.scripts.save.versionNoteLabel')}</label>
              <input id="sync-upload-vnote" className="sp-input" value={versionNote} onChange={(e) => setVersionNote(e.target.value)} />
            </div>
            <div className="sp-row">
              <button type="button" className="sp-btn primary" disabled={busy} onClick={() => void upload()}>
                {t('sync.scripts.save.submit')}
              </button>
              <button type="button" className="sp-btn" onClick={() => setUploadOpen(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </>
        )}
      </section>
    </>
  );
}
