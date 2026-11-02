// Settings: the import page entry (AI import channel anchor), a re-viewable usage notice (DEC-011)
// and the device-local upload credential card (support-http FR3).
import { useCallback, useEffect, useState } from 'react';
import { openImportPage } from '@/lib/import-page';
import { t } from '@/lib/i18n';
import { sendRuntimeMessage, type UploadCredentialView } from '@/lib/messaging';

interface Props {
  onShowOnboarding: () => void;
}

export default function SettingsPanel({ onShowOnboarding }: Props) {
  return (
    <>
      <section className="sp-card">
        <h2 className="sp-title">{t('settings.usage.title')}</h2>
        <p className="sp-hint">{t('settings.usage.hint')}</p>
        <button type="button" className="sp-btn" onClick={onShowOnboarding}>
          {t('settings.usage.button')}
        </button>
      </section>

      <section className="sp-card" aria-label={t('settings.import.button')}>
        <h2 className="sp-title">{t('settings.import.button')}</h2>
        <p className="sp-hint">{t('settings.import.hint')}</p>
        <button type="button" className="sp-btn" onClick={() => void openImportPage().catch(() => undefined)}>
          {t('settings.import.button')}
        </button>
      </section>

      <UploadCredentialsCard />
    </>
  );
}

// Device-local credential records (DEC-support-http-002/005): list shows name + header only — the
// value is write-only from this UI (entered once, never read back). Validation reasons come from
// the background single writer; the form keeps its typed values on a refusal so the user can fix
// the one field that failed. Component-local state only; the store is the truth, re-read after
// every write.
function UploadCredentialsCard() {
  const [credentials, setCredentials] = useState<UploadCredentialView[] | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [headerName, setHeaderName] = useState('Authorization');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await sendRuntimeMessage({ type: 'sp:getUploadCredentials' });
      if (res?.ok && res.credentials) setCredentials(res.credentials);
      else setCredentials((prev) => prev ?? []);
    } catch {
      setCredentials((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The fallback line names the operation — a delete must not report itself as a failed save
  const reasonText = (reason: string, failKey: 'settings.credentials.opFail' | 'settings.credentials.deleteFail'): string => {
    switch (reason) {
      case 'invalid-name':
        return t('settings.credentials.invalidName');
      case 'invalid-header':
        return t('settings.credentials.invalidHeader');
      case 'invalid-value':
        return t('settings.credentials.invalidValue');
      case 'not-found':
        return t('settings.credentials.notFound');
      default:
        return t(failKey, { reason });
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await sendRuntimeMessage({ type: 'sp:saveUploadCredential', name, headerName, value });
      if (!res?.ok) {
        setError(reasonText(res?.ok === false ? res.reason : t('common.unknownReason'), 'settings.credentials.opFail'));
        return;
      }
      setFormOpen(false);
      setName('');
      setHeaderName('Authorization');
      setValue('');
      await load();
    } catch {
      setError(t('settings.credentials.opFail', { reason: t('common.timeoutWord') }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    if (!window.confirm(t('settings.credentials.confirm', { name: target }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await sendRuntimeMessage({ type: 'sp:deleteUploadCredential', name: target });
      if (!res?.ok) setError(reasonText(res?.ok === false ? res.reason : t('common.unknownReason'), 'settings.credentials.deleteFail'));
      await load();
    } catch {
      setError(t('settings.credentials.deleteFail', { reason: t('common.timeoutWord') }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sp-card" aria-label={t('settings.credentials.title')}>
      <h2 className="sp-title">{t('settings.credentials.title')}</h2>
      <p className="sp-hint">{t('settings.credentials.hint')}</p>
      {credentials === null ? (
        <p className="sp-sub">{t('common.loading')}</p>
      ) : (
        <>
          {credentials.length === 0 && <p className="sp-sub">{t('settings.credentials.empty')}</p>}
          {credentials.map((credential) => (
            <div key={credential.name} className="sp-option" style={{ justifyContent: 'space-between' }}>
              <span className="sp-desc" style={{ overflowWrap: 'anywhere' }}>
                {credential.name} · {credential.headerName}
              </span>
              <button
                type="button"
                className="sp-btn danger"
                onClick={() => void remove(credential.name)}
                disabled={busy}
                aria-label={`${t('settings.credentials.delete')} ${credential.name}`}
              >
                {t('settings.credentials.delete')}
              </button>
            </div>
          ))}
        </>
      )}
      {error !== null && <p className="sp-error" role="alert">{error}</p>}
      {formOpen ? (
        <>
          <div className="sp-field">
            <label className="sp-label" htmlFor="credential-name">{t('settings.credentials.nameLabel')}</label>
            <input
              id="credential-name"
              className="sp-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="sp-field">
            <label className="sp-label" htmlFor="credential-header">{t('settings.credentials.headerLabel')}</label>
            <input
              id="credential-header"
              className="sp-input"
              type="text"
              value={headerName}
              onChange={(e) => setHeaderName(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="sp-field">
            <label className="sp-label" htmlFor="credential-value">{t('settings.credentials.valueLabel')}</label>
            <input
              id="credential-value"
              className="sp-input"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="off"
            />
            <p className="sp-sub">{t('settings.credentials.valueHint')}</p>
          </div>
          <div className="sp-row">
            <button type="button" className="sp-btn primary" onClick={() => void save()} disabled={busy}>
              {busy ? t('common.saving') : t('settings.credentials.save')}
            </button>
            <button type="button" className="sp-btn" onClick={() => setFormOpen(false)} disabled={busy}>
              {t('common.cancel')}
            </button>
          </div>
        </>
      ) : (
        <div className="sp-row">
          <button type="button" className="sp-btn" onClick={() => setFormOpen(true)} disabled={busy}>
            {t('settings.credentials.add')}
          </button>
        </div>
      )}
    </section>
  );
}
