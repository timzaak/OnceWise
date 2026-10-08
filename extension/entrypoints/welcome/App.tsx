import { baseCss } from '@/lib/ui-css';
import { t, type MessageKey } from '@/lib/i18n';
import { openImportPage } from '@/lib/import-page';
import { useCopied } from '@/lib/use-copy';

// Welcome + tutorial landing opened once by the background on install (the import page it used to
// open assumes flows already exist and teaches nothing). The steps mirror the store listing's
// GETTING STARTED: install the skills with the one-line installer, let oncewise-setup install the
// native host, ask the AI for a flow, enable it yourself. Shared tokens (reset / typography /
// cards / buttons) come from lib/ui-css; only the welcome-specific layout flows live here.
// Store-assigned listing (ID-only canonical form; the dev build shares this listing). The store
// rejects manifest `key` fields, so the store build's ID differs from the pinned dev ID.
const STORE_URL = 'https://chromewebstore.google.com/detail/dmmhmcdbkbbgbcidafhlhepdchjboenc';
const SKILLS_INSTALL_CMD =
  'npx skills add timzaak/OnceWise --skill oncewise-setup --skill oncewise-flow --skill oncewise-message';

const STEPS: ReadonlyArray<{ title: MessageKey; body: MessageKey }> = [
  { title: 'welcome.step1.title', body: 'welcome.step1.body' },
  { title: 'welcome.step2.title', body: 'welcome.step2.body' },
  { title: 'welcome.step3.title', body: 'welcome.step3.body' },
  { title: 'welcome.step4.title', body: 'welcome.step4.body' },
];

const CSS = `${baseCss('wl', { btnMinHeight: '38px', btnPaddingX: '14px', cardPadding: '16px', cardGap: '10px' })}
.wl-header { background: var(--ow-surface); border-bottom: 1px solid var(--ow-line); padding: 18px 24px; }
.wl-header-inner { max-width: 812px; margin: 0 auto; }
.wl-brand { display: flex; align-items: center; gap: 7px; margin-bottom: 14px; font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.wl-brand-mark { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 4px; background: var(--ow-ink); color: #fff; font-size: 14px; line-height: 1; }
.wl-header h1 { font-size: 20px; line-height: 1.3; font-weight: 700; margin: 0 0 12px; }
.wl-intro { font-size: 13px; color: #3d3d3d; margin: 0; line-height: 1.6; }
.wl-main { flex: 1; width: 100%; max-width: 860px; margin: 0 auto; padding: 24px 24px 48px; display: flex; flex-direction: column; gap: 16px; }
.wl-steps { list-style: none; margin: 0; padding: 0; }
.wl-step { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--ow-line); }
.wl-step:last-child { border-bottom: none; padding-bottom: 2px; }
.wl-step-no { flex-shrink: 0; display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--ow-ink); color: #fff; font-size: 13px; font-weight: 700; margin-top: 2px; }
.wl-step-title { font-size: 13px; font-weight: 650; margin: 0; }
.wl-step-body { font-size: 13px; color: #3d3d3d; line-height: 1.6; margin: 4px 0 0; overflow-wrap: anywhere; }
.wl-code { display: block; min-width: 0; flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: #f5f5f3; border: 1px solid var(--ow-line); border-radius: 5px; padding: 6px 10px; margin: 0; overflow-wrap: anywhere; }
.wl-cmd-row { display: flex; gap: 8px; align-items: stretch; margin-top: 8px; flex-wrap: wrap; }
.wl-cmd-row .wl-btn { min-height: 32px; font-size: 12px; padding: 4px 10px; flex-shrink: 0; }
.wl-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
a.wl-btn { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; }
.wl-star-card { background: var(--ow-accent-soft); border-color: #b6dcd5; }
.wl-star { color: #e8a400; font-size: 15px; }
@media (max-width: 600px) { .wl-header { padding: 16px; } .wl-main { padding: 16px 16px 40px; } }
`;

function App() {
  const { copied, copy } = useCopied();

  return (
    <>
      <style>{CSS}</style>
      <header className="wl-header">
        <div className="wl-header-inner">
          <div className="wl-brand"><span className="wl-brand-mark" aria-hidden="true">✓</span>OnceWise Flow</div>
          <h1>{t('welcome.title')}</h1>
          <p className="wl-intro">{t('welcome.intro')}</p>
        </div>
      </header>
      <main className="wl-main">
        <section className="wl-card" aria-label={t('welcome.steps.title')}>
          <h2 className="wl-title">{t('welcome.steps.title')}</h2>
          <ol className="wl-steps">
            {STEPS.map((step, i) => (
              <li className="wl-step" key={step.title}>
                <span className="wl-step-no" aria-hidden="true">{i + 1}</span>
                <div>
                  <p className="wl-step-title">{t(step.title)}</p>
                  <p className="wl-step-body">{t(step.body)}</p>
                  {i === 0 && (
                    <div className="wl-cmd-row">
                      <code className="wl-code">{SKILLS_INSTALL_CMD}</code>
                      <button type="button" className="wl-btn" onClick={() => copy(SKILLS_INSTALL_CMD)}>
                        {copied ? t('welcome.step1.copied') : t('welcome.step1.copy')}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
        <section className="wl-card" aria-label={t('welcome.explore.title')}>
          <h2 className="wl-title">{t('welcome.explore.title')}</h2>
          <p className="wl-desc">{t('welcome.explore.sidepanel')}</p>
          <p className="wl-desc">{t('welcome.explore.localFirst')}</p>
        </section>
        <section className="wl-card wl-star-card" aria-label={t('welcome.star.title')}>
          <h2 className="wl-title">{t('welcome.star.title')}</h2>
          <p className="wl-desc">{t('welcome.star.body')}</p>
          <div className="wl-actions">
            <a className="wl-btn primary" href={STORE_URL} target="_blank" rel="noreferrer">
              <span className="wl-star" aria-hidden="true">★</span>&nbsp;{t('welcome.star.button')}
            </a>
            <button type="button" className="wl-btn" onClick={() => void openImportPage().catch(() => undefined)}>
              {t('welcome.openFlows')}
            </button>
          </div>
        </section>
      </main>
    </>
  );
}

export default App;
