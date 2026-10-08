import { useEffect, useState } from 'react';
import SavedFlowCard from './SavedFlowCard';
import FlowListSection from './FlowListSection';
import { baseCss } from '@/lib/ui-css';
import { t } from '@/lib/i18n';
import { sendRuntimeMessage } from '@/lib/messaging';

// Import page shell: the AI no longer operates this page — flow handover
// travels the native channel. The page shows the saved-summary card with the user-only enable entry
// plus the flow list with independent enable/pause toggles (DEC-016), and a native-channel connection
// hint. Shared tokens (reset / typography / badges / buttons / callouts) come from lib/ui-css; only
// the import-page-specific layout flows live here.
const CSS = `${baseCss('im', { btnMinHeight: '38px', btnPaddingX: '14px', cardPadding: '16px', cardGap: '10px' })}
.im-header { background: var(--ow-surface); border-bottom: 1px solid var(--ow-line); padding: 18px 24px; }
.im-header-inner { max-width: 812px; margin: 0 auto; }
.im-brand { display: flex; align-items: center; gap: 7px; margin-bottom: 14px; font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.im-brand-mark { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 4px; background: var(--ow-ink); color: #fff; font-size: 14px; line-height: 1; }
.im-header h1 { font-size: 20px; line-height: 1.3; font-weight: 700; margin: 0 0 12px; }
.im-boundary { font-size: 13px; color: #07645d; background: var(--ow-accent-soft); border-radius: 5px; padding: 10px 12px; margin: 0; }
.im-main { flex: 1; width: 100%; max-width: 860px; margin: 0 auto; padding: 24px 24px 48px; display: flex; flex-direction: column; gap: 16px; }
.im-badge.draft { border-color: #cececa; color: #555; background: #f5f5f3; }
.im-badge.submit { border-color: #e9d39b; color: var(--ow-warning); background: #fff5d6; }
.im-badge.skip { border-color: #cececa; color: #626262; background: #f5f5f3; }
.im-result { border-radius: 5px; padding: 12px; display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.im-result.error { background: #fff1f0; border: 1px solid #e2b8b8; }
.im-result.summary { background: var(--ow-accent-soft); border: 1px solid #b6dcd5; }
.im-result.ok { background: var(--ow-accent-soft); border: 1px solid #b6dcd5; }
.im-info-row { display: flex; gap: 8px; font-size: 13px; }
.im-info-row .k { color: var(--ow-muted); flex-shrink: 0; }
.im-actions { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; }
.im-action-item { display: flex; gap: 8px; align-items: baseline; font-size: 13px; line-height: 1.6; }
.im-list-item { border-bottom: 1px solid var(--ow-line); padding: 12px 0; display: flex; flex-direction: column; gap: 6px; }
.im-list-item:last-child { border-bottom: none; }
.im-kv { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; }
.im-empty { text-align: center; padding: 24px 12px; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.im-steps { font-size: 12px; color: var(--ow-success); margin: 0; }
.im-steps.fail { color: var(--ow-danger); }
.im-next-step { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid #b6dcd5; }
@media (max-width: 600px) { .im-header { padding: 16px; } .im-main { padding: 16px 16px 40px; } }
`;

function App() {
  return (
    <>
      <style>{CSS}</style>
      <header className="im-header">
        <div className="im-header-inner">
          <div className="im-brand"><span className="im-brand-mark" aria-hidden="true">✓</span>OnceWise Flow</div>
          <h1>{t('import.docTitle')}</h1>
          <p className="im-boundary" role="note">{t('import.boundary')}</p>
        </div>
      </header>
      <main className="im-main">
        <ChannelHint />
        <SavedFlowCard />
        <FlowListSection />
      </main>
    </>
  );
}

// Connection hint: reflects the in-memory port state (display only). When the host is not reachable
// the page still works — saved flows live in the store, and the summary card appears on the next
// successful native save.
function ChannelHint() {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const res = await sendRuntimeMessage({ type: 'sp:getNativeChannelState' });
        if (!cancelled) setConnected(res?.ok === true && res.connected === true);
      } catch {
        if (!cancelled) setConnected(false);
      }
    };
    void probe();
    const timer = setInterval(() => void probe(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  if (connected === null) return null;
  return (
    <p className="im-hint" role="status">
      {connected ? t('native.channel.connected') : t('native.channel.disconnected')}
    </p>
  );
}

export default App;
