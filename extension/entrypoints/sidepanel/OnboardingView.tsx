// First-use notice with excluded-platform declaration (DEC-011): purely informational, re-viewable, bound
// to the sidepanel's first open (the welcome page auto-opened at install never triggers it).
import { onboardingItem } from '@/lib/storage';
import { t } from '@/lib/i18n';

interface Props {
  onClose: () => void;
}

export default function OnboardingView({ onClose }: Props) {
  const confirm = async () => {
    // Declared write exception: the sidepanel writes this pure UI flag directly (background never reads it)
    await onboardingItem.setValue({ seen: true }).catch(() => undefined);
    onClose();
  };

  return (
    <section className="sp-card" aria-label={t('onboarding.title')}>
      <h2 className="sp-title">{t('onboarding.title')}</h2>

      <div className="sp-field">
        <span className="sp-label">{t('onboarding.what.title')}</span>
        <p className="sp-desc">{t('onboarding.what.body')}</p>
      </div>

      <div className="sp-field">
        <span className="sp-label">{t('onboarding.excluded.title')}</span>
        <p className="sp-desc">{t('onboarding.excluded.body')}</p>
      </div>

      <div className="sp-field">
        <span className="sp-label">{t('onboarding.auto.title')}</span>
        <p className="sp-desc">{t('onboarding.auto.body')}</p>
      </div>

      <div className="sp-field">
        <span className="sp-label">{t('onboarding.data.title')}</span>
        <p className="sp-desc">{t('onboarding.data.body')}</p>
      </div>

      <button type="button" className="sp-btn primary" onClick={() => void confirm()}>
        {t('onboarding.ack')}
      </button>
    </section>
  );
}
