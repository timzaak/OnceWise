// The sync tab's sign-in card, rendered only when the connected server is Herald-gated. States:
// signed-out guidance + Sign in, busy while the authorization window is open, signed-in badge +
// Sign out behind an explicit confirm (signing out only clears the local sign-in state). The card
// itself never sees tokens — just the non-secret mode/signedIn facts from the background.
import { useState } from 'react';
import { t } from '@/lib/i18n';
import type { ExtensionResponse, SyncAuthView } from '@/lib/messaging';

interface Props {
  auth: SyncAuthView;
  signIn: () => Promise<ExtensionResponse | undefined>;
  signOut: () => Promise<void>;
}

function authErrorText(res: ExtensionResponse | undefined): string {
  if (res === undefined || res.ok) return t('sync.auth.loginFailed');
  if (res.reason === 'login-cancelled') return t('sync.auth.loginCancelled');
  if (res.reason === 'login-timeout') return t('sync.auth.loginTimeout');
  if (res.reason === 'auth-unavailable') return t('sync.auth.unavailable');
  if (res.reason === 'auth-changed') return t('sync.auth.relogin');
  return res.detail ?? t('sync.auth.loginFailed');
}

export default function SyncAuthCard({ auth, signIn, signOut }: Props) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const doSignIn = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await signIn();
      if (!res?.ok) setNotice(authErrorText(res));
    } finally {
      setBusy(false);
    }
  };

  const doSignOut = async () => {
    if (!window.confirm(t('sync.auth.signOutConfirm'))) return;
    setBusy(true);
    setNotice(null);
    try {
      await signOut();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sp-card" aria-label={t('sync.auth.title')}>
      <div className="sp-row" style={{ justifyContent: 'space-between' }}>
        <h2 className="sp-title">{t('sync.auth.title')}</h2>
        {auth.signedIn && <span className="sp-badge enabled">{t('sync.auth.signedIn')}</span>}
      </div>
      {!auth.signedIn && <p className="sp-hint">{t('sync.auth.required')}</p>}
      {notice && <p className="sp-error">{notice}</p>}
      <div className="sp-row">
        {auth.signedIn ? (
          <button type="button" className="sp-btn" disabled={busy} onClick={() => void doSignOut()}>
            {t('sync.auth.signOut')}
          </button>
        ) : (
          <button type="button" className="sp-btn primary" disabled={busy} onClick={() => void doSignIn()}>
            {busy ? t('sync.auth.signingIn') : t('sync.auth.signIn')}
          </button>
        )}
      </div>
    </section>
  );
}
