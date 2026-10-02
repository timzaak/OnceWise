// Settings: the import page entry (AI import channel anchor) + a re-viewable usage notice (DEC-011).
import { openImportPage } from '@/lib/import-page';
import { t } from '@/lib/i18n';

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
    </>
  );
}
