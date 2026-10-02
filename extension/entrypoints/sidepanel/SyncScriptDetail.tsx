// Sync tab S3: script detail — info & rename (no version created), version list, summary preview
// (validation failure disables pull), pull / switch / rollback (impact made explicit before switching),
// publish new version (same-content warning) and unlink.
import { useCallback, useEffect, useState } from 'react';
import { sendRuntimeMessage, type ScriptRowView, type VersionPreviewView } from '@/lib/messaging';
import type { VersionMetaDto } from '@/lib/sync-api';
import { redactText } from '@/lib/redact';
import { t } from '@/lib/i18n';
import type { Flow } from '@/lib/flow-schema';
import type { SyncCall } from '@/lib/use-sync';

interface Props {
  spaceId: string;
  scriptId: string;
  serverUrl: string;
  call: SyncCall;
  onBack: () => void;
}

interface PreviewState {
  versionNumber: number;
  preview?: VersionPreviewView;
  errors?: string[];
}

function errorText(res: { ok: false; reason: string; detail?: string } | undefined, fallback: string): string {
  if (res === undefined) return fallback;
  if (res.reason === 'unreachable') return t('sync.error.unreachable');
  if (res.reason === 'bad-space-key') return t('sync.error.badKey');
  if (res.reason === 'space-not-found' || res.reason === 'script-not-found') return t('sync.error.notFound');
  if (res.reason === 'invalid-input') return res.detail ?? t('sync.error.invalidInput');
  return res.detail ?? fallback;
}

export default function SyncScriptDetail({ spaceId, scriptId, serverUrl, call, onBack }: Props) {
  const [row, setRow] = useState<ScriptRowView | null>(null);
  const [versions, setVersions] = useState<VersionMetaDto[] | null>(null);
  const [localFlow, setLocalFlow] = useState<Flow | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeIsHint, setNoticeIsHint] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState('');
  const [renameNote, setRenameNote] = useState('');
  const [versionNote, setVersionNote] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [listRes, versionRes, flowsRes] = await Promise.all([
        call({ type: 'sp:syncListScripts', spaceId }),
        call({ type: 'sp:syncListVersions', spaceId, scriptId }),
        sendRuntimeMessage({ type: 'sp:getFlows' }),
      ]);
      if (listRes?.ok && listRes.scriptRows) {
        const next = listRes.scriptRows.find((s) => s.id === scriptId) ?? null;
        setRow(next);
        setLocalFlow(
          next?.local ? (flowsRes?.ok && flowsRes.flows ? flowsRes.flows.find((r) => r.id === next.local!.flowId) ?? null : undefined)
          : null,
        );
      }
      if (versionRes?.ok && versionRes.versionMetas) setVersions(versionRes.versionMetas);
      if (!listRes?.ok || !versionRes?.ok) {
        setNoticeIsHint(false);
        setNotice(errorText(listRes?.ok ? undefined : listRes, t('sync.detail.loadFail')));
      } else {
        setNotice(null);
      }
    } finally {
      setBusy(false);
    }
  }, [call, spaceId, scriptId]);

  useEffect(() => {
    void load();
  }, [load]);

  const linked = row?.local !== undefined;
  const flowExists = row?.local?.localFlowExists === true;

  const showPreview = async (versionNumber: number) => {
    setBusy(true);
    try {
      const res = await call({ type: 'sp:syncPreviewVersion', spaceId, scriptId, versionNumber });
      if (res?.ok && res.versionPreview) {
        setPreview({ versionNumber, preview: res.versionPreview });
      } else if (res !== undefined && res.ok === false && res.reason === 'invalid-content') {
        setPreview({ versionNumber, errors: res.errors ?? [t('sync.detail.preview.invalid')] });
      } else {
        setNoticeIsHint(false);
        setNotice(t('sync.error.previewFail'));
      }
    } finally {
      setBusy(false);
    }
  };

  const pull = async (versionNumber: number) => {
    const scriptName = row?.name ?? '';
    if (!linked || !flowExists) {
      if (!window.confirm(t('sync.detail.pull.confirmNew', { name: scriptName, n: versionNumber }))) {
        return;
      }
    } else if (
      !window.confirm(
        t('sync.detail.pull.confirmSwitch', {
          name: localFlow?.name ?? scriptName,
          from: row!.local!.pinnedVersionNumber,
          to: versionNumber,
        }),
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await call({ type: 'sp:syncPullVersion', spaceId, scriptId, versionNumber });
      if (!res?.ok) {
        if (res?.reason === 'invalid-content') {
          setPreview({ versionNumber, errors: res.errors ?? [t('sync.detail.preview.invalid')] });
          setNoticeIsHint(false);
          setNotice(t('sync.detail.pull.invalid'));
        } else {
          setNoticeIsHint(false);
          setNotice(errorText(res, t('sync.error.pullFail')));
        }
        return;
      }
      setNoticeIsHint(true);
      setNotice(
        res.created
          ? t('sync.detail.pull.created')
          : t('sync.detail.pull.switched', { n: versionNumber }),
      );
      setPreview(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!linked) return;
    // Same content = the local flow's stable-content hash matches the pinned version (the server is
    // not idempotent; this is the client-side guard against accidental re-publish)
    const sameContent = localFlow !== null && localFlow !== undefined && !row!.local!.hasLocalEdits;
    const cloudNote = t('sync.detail.publish.cloudNote', { server: serverUrl });
    const warning = sameContent
      ? t('sync.detail.publish.sameWarn', { n: row!.local!.pinnedVersionNumber })
      : t('sync.detail.publish.confirm');
    if (!window.confirm(cloudNote + warning)) return;
    setBusy(true);
    try {
      const res = await call({ type: 'sp:syncPublishVersion', flowId: row!.local!.flowId, versionNote });
      if (!res?.ok) {
        setNoticeIsHint(false);
        setNotice(
          res !== undefined && res.ok === false && res.reason === 'flow-not-found'
            ? t('sync.detail.publish.flowGone')
            : errorText(res as { ok: false; reason: string; detail?: string }, t('sync.error.publishFail')),
        );
        return;
      }
      setNoticeIsHint(true);
      setNotice(t('sync.detail.publish.ok', { n: res.versionNumber ?? 0 }));
      setVersionNote('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!linked) return;
    const trimmed = renameName.trim();
    if (renameName !== '' && (trimmed.length < 1 || trimmed.length > 100)) {
      setNoticeIsHint(false);
      setNotice(t('sync.detail.rename.nameNeeded'));
      return;
    }
    if (renameName === '' && renameNote === '') {
      setNoticeIsHint(false);
      setNotice(t('sync.detail.rename.needOne'));
      return;
    }
    setBusy(true);
    try {
      const res = await call({
        type: 'sp:syncUpdateScript',
        flowId: row!.local!.flowId,
        ...(renameName === '' ? {} : { name: trimmed }),
        ...(renameNote === '' ? {} : { note: renameNote }),
      });
      if (!res?.ok) {
        setNoticeIsHint(false);
        setNotice(errorText(res, t('sync.error.renameFail')));
        return;
      }
      setNoticeIsHint(true);
      setNotice(t('sync.detail.rename.ok'));
      setRenameOpen(false);
      setRenameName('');
      setRenameNote('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    if (!linked) return;
    if (!window.confirm(t('sync.detail.unlink.confirm'))) return;
    setBusy(true);
    try {
      const res = await call({ type: 'sp:syncUnlink', flowId: row!.local!.flowId });
      if (!res?.ok) {
        setNoticeIsHint(false);
        setNotice(t('sync.detail.unlink.fail'));
        return;
      }
      setNoticeIsHint(true);
      setNotice(t('sync.detail.unlink.ok'));
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (row === null) {
    return (
      <section className="sp-card">
        <button type="button" className="sp-btn" onClick={onBack}>
          {t('sync.detail.back')}
        </button>
        {notice && <p className="sp-error">{notice}</p>}
        <div className="sp-loading">{busy ? t('common.loading') : t('sync.detail.missing')}</div>
      </section>
    );
  }

  return (
    <>
      <section className="sp-card">
        <div className="sp-row" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="sp-btn" onClick={onBack}>
            {t('sync.detail.back')}
          </button>
          <button type="button" className="sp-btn" disabled={busy} onClick={() => void load()}>
            {t('common.refresh')}
          </button>
        </div>
        {notice && <p className={noticeIsHint ? 'sp-hint' : 'sp-error'}>{notice}</p>}
      </section>

      <section className="sp-card" aria-label={row.name}>
        <div className="sp-row" style={{ justifyContent: 'space-between' }}>
          <h2 className="sp-title">{row.name}</h2>
          <span className="sp-badge">{t('sync.scripts.latest', { n: row.latestVersionNumber })}</span>
        </div>
        {row.note !== '' && <p className="sp-sub">{t('sync.scripts.note', { note: redactText(row.note) })}</p>}
        <p className="sp-sub">{t('sync.scripts.latestNote', { note: redactText(row.latestVersionNote) || '—', time: row.updatedAt })}</p>
        {linked && (
          <div className="sp-row">
            <span className="sp-badge">{t('sync.scripts.pinned', { n: row.local!.pinnedVersionNumber })}</span>
            {row.local!.newVersionAvailable && (
              <span className="sp-badge sync-new">{t('sync.scripts.newVersion', { n: row.latestVersionNumber })}</span>
            )}
            {row.local!.hasLocalEdits && <span className="sp-badge paused">{t('sync.scripts.localEdits')}</span>}
            {!flowExists && (
              <>
                <span className="sp-badge fail">{t('sync.scripts.flowDeleted')}</span>
                <p className="sp-hint">{t('sync.detail.flowDeletedHint')}</p>
              </>
            )}
          </div>
        )}
        {linked ? (
          !renameOpen ? (
            <div className="sp-row">
              <button type="button" className="sp-btn" onClick={() => { setRenameOpen(true); setRenameName(row.name); setRenameNote(''); }}>
                {t('sync.detail.rename')}
              </button>
              <button type="button" className="sp-btn danger" onClick={() => void unlink()}>
                {t('sync.detail.unlink')}
              </button>
            </div>
          ) : (
            <div className="sp-group">
              <p className="sp-hint">{t('sync.detail.renameHint')}</p>
              <div className="sp-field">
                <label className="sp-label" htmlFor="sync-rename-name">{t('sync.detail.rename.nameLabel')}</label>
                <input id="sync-rename-name" className="sp-input" value={renameName} onChange={(e) => setRenameName(e.target.value)} />
              </div>
              <div className="sp-field">
                <label className="sp-label" htmlFor="sync-rename-note">{t('sync.detail.rename.noteLabel')}</label>
                <input id="sync-rename-note" className="sp-input" value={renameNote} onChange={(e) => setRenameNote(e.target.value)} />
              </div>
              <div className="sp-row">
                <button type="button" className="sp-btn primary" disabled={busy} onClick={() => void rename()}>
                  {t('sync.detail.rename.save')}
                </button>
                <button type="button" className="sp-btn" onClick={() => setRenameOpen(false)}>
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )
        ) : (
          <p className="sp-hint">{t('sync.detail.notLinked')}</p>
        )}
      </section>

      {linked && flowExists && (
        <section className="sp-card" aria-label={t('sync.detail.publish.title')}>
          <h2 className="sp-title" style={{ fontSize: 14 }}>{t('sync.detail.publish.title')}</h2>
          <p className="sp-sub">{t('sync.detail.publish.hint', { name: localFlow?.name ?? '' })}</p>
          <div className="sp-field">
            <label className="sp-label" htmlFor="sync-publish-note">{t('sync.detail.publish.noteLabel')}</label>
            <input id="sync-publish-note" className="sp-input" value={versionNote} onChange={(e) => setVersionNote(e.target.value)} />
          </div>
          <button type="button" className="sp-btn primary" disabled={busy} onClick={() => void publish()}>
            {t('sync.detail.publish.submit')}
          </button>
        </section>
      )}

      <section className="sp-card" aria-label={t('sync.detail.versions.title')}>
        <h2 className="sp-title" style={{ fontSize: 14 }}>{t('sync.detail.versions.title')}</h2>
        {versions === null ? (
          <div className="sp-loading">{t('common.loading')}</div>
        ) : (
          versions.map((v) => {
            const isPinned = linked && v.versionNumber === row.local!.pinnedVersionNumber;
            const isLatest = v.versionNumber === row.latestVersionNumber;
            const previewFailed = preview?.versionNumber === v.versionNumber && preview.errors !== undefined;
            return (
              <div key={v.versionNumber} className="sp-group" aria-label={`v${v.versionNumber}`}>
                <div className="sp-row" style={{ justifyContent: 'space-between' }}>
                  <h3 className="sp-title" style={{ fontSize: 13 }}>v{v.versionNumber} {redactText(v.note) !== '' ? `· ${redactText(v.note)}` : ''}</h3>
                  <div className="sp-row">
                    {isPinned && <span className="sp-badge enabled">{t('sync.detail.versions.pinned')}</span>}
                    {isLatest && <span className="sp-badge">{t('sync.detail.versions.latest')}</span>}
                  </div>
                </div>
                <p className="sp-sub">{v.createdAt}</p>
                <div className="sp-row">
                  <button type="button" className="sp-btn" disabled={busy} onClick={() => void showPreview(v.versionNumber)}>
                    {t('sync.detail.versions.preview')}
                  </button>
                  {isPinned ? (
                    <span className="sp-hint">{t('sync.detail.versions.pinnedNow')}</span>
                  ) : (
                    <button
                      type="button"
                      className="sp-btn primary"
                      disabled={busy || previewFailed}
                      onClick={() => void pull(v.versionNumber)}
                    >
                      {linked && flowExists ? t('sync.detail.versions.switch') : t('sync.detail.versions.pull')}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </section>

      {preview?.preview && (
        <section className="sp-card" aria-label={t('sync.detail.preview.title', { n: preview.versionNumber })}>
          <h2 className="sp-title" style={{ fontSize: 14 }}>{t('sync.detail.preview.title', { n: preview.versionNumber })}</h2>
          <p className="sp-desc">{preview.preview.name} · {preview.preview.site}</p>
          <p className="sp-sub">{t('sync.detail.preview.page', { text: preview.preview.pageDesc })}</p>
          <p className="sp-sub">{t('sync.detail.preview.trigger', { text: preview.preview.triggerDesc })}</p>
          <div className="sp-group">
            {preview.preview.actions.map((a, i) => (
              <div key={i} className="sp-option" style={{ justifyContent: 'space-between' }}>
                <span className="sp-desc">{a.text}</span>
                {a.submit && <span className="sp-badge submit">{t('sync.detail.preview.submit')}</span>}
              </div>
            ))}
          </div>
          {preview.preview.hasSubmit && (
            <p className="sp-warn">{t('sync.detail.preview.submitWarn')}</p>
          )}
        </section>
      )}
      {preview?.errors && (
        <section className="sp-card" aria-label={t('sync.detail.preview.failTitle', { n: preview.versionNumber })}>
          <h2 className="sp-title" style={{ fontSize: 14 }}>{t('sync.detail.preview.failTitle', { n: preview.versionNumber })}</h2>
          {preview.errors.map((e, i) => (
            <p key={i} className="sp-error">{e}</p>
          ))}
          <p className="sp-hint">{t('sync.detail.preview.failHint')}</p>
        </section>
      )}
    </>
  );
}
