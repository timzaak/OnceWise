// The shared tail of every sync view's reason→text mapper. Each view maps its view-specific
// reasons first, then delegates here, then falls back to res.detail ?? its own fallback — so a
// reason newly common to several views gets one entry instead of one per view.
import { t } from './i18n';

export function commonSyncErrorText(res: { reason: string; detail?: string }): string | null {
  if (res.reason === 'unreachable') return t('sync.error.unreachable');
  // Removed from an org-bound space: local data stays, forgetting is the user's own call
  if (res.reason === 'space-access-denied') return t('sync.error.spaceAccessDenied');
  // Key spaces have no invite/member surface — the background refuses before any traffic
  if (res.reason === 'space-key-unsupported') return t('sync.error.spaceKeyUnsupported');
  if (res.reason === 'invalid-input') return res.detail ?? t('sync.error.invalidInput');
  // Auth-gate outcomes: sign-in guidance (never a permission/role notice — any valid sign-in is
  // enough), a retryable dependency failure, an unknown-outcome write, and a session replaced
  // mid-operation
  if (res.reason === 'sign-in-required') return t('sync.auth.required');
  if (res.reason === 'auth-unavailable') return t('sync.auth.unavailable');
  if (res.reason === 'operation-uncertain') return t('sync.auth.operationUncertain');
  if (res.reason === 'auth-changed') return t('sync.auth.relogin');
  return null;
}
