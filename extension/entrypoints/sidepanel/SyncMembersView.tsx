// Sync tab members view (space-permissions spaces): the live member list (fetched on open,
// kept in component state only — never in storage), one-time invite issuing with the single
// plaintext display + copy, and the explicit-confirm member operations (promote / demote /
// remove / transfer ownership). Leaving is not done here — the spaces row's Leave button owns
// self-exit so the semantics stay in one place.
import { useCallback, useEffect, useState } from 'react';
import type { ExtensionResponse, InviteView, SpaceMemberView } from '@/lib/messaging';
import type { SpaceRole } from '@/lib/sync-api';
import { t } from '@/lib/i18n';
import { commonSyncErrorText } from '@/lib/sync-errors';
import type { SyncCall } from '@/lib/use-sync';

interface Props {
  spaceId: string;
  spaceName: string;
  myRole: SpaceRole;
  myUserId?: string;
  call: SyncCall;
  onBack: () => void;
  // Refreshes the panel status after a successful op — e.g. a transfer demotes this caller, and
  // the myRole prop must follow before the owner-gated buttons render again
  onChanged: () => void;
}

function memberErrorText(res: ExtensionResponse | undefined, fallback: string): string {
  if (res === undefined || res.ok) return fallback;
  if (res.reason === 'space-role-required') return t('sync.members.manageDenied');
  if (res.reason === 'space-owner-protected') return t('sync.error.spaceOwnerProtected');
  if (res.reason === 'space-last-admin-protected') return t('sync.error.spaceLastAdminProtected');
  if (res.reason === 'member-not-found') return t('sync.error.memberNotFound');
  // The space can vanish under an open members view (deleted elsewhere); same text as the
  // scripts/detail views
  if (res.reason === 'space-not-found') return t('sync.scripts.spaceGone');
  if (res.reason === 'invite-invalid') return t('sync.error.inviteInvalid');
  if (res.reason === 'invite-expired') return t('sync.error.inviteExpired');
  if (res.reason === 'invite-already-used') return t('sync.error.inviteAlreadyUsed');
  const common = commonSyncErrorText(res);
  if (common !== null) return common;
  return res.detail ?? fallback;
}

function roleBadgeClass(role: SpaceRole): string {
  if (role === 'owner') return 'sp-badge enabled';
  if (role === 'member') return 'sp-badge paused';
  return 'sp-badge';
}

export default function SyncMembersView({ spaceId, spaceName, myRole, myUserId, call, onBack, onChanged }: Props) {
  const [members, setMembers] = useState<SpaceMemberView[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [invite, setInvite] = useState<InviteView | null>(null);
  const [copied, setCopied] = useState(false);
  // Seeded from the stored entry, then re-decided by every list response: the stored
  // myUserId/myRole can belong to a previous account on this device, and the "You" marking
  // and owner gating must follow the caller the server actually sees
  const [selfRole, setSelfRole] = useState<SpaceRole>(myRole);
  const [selfUserId, setSelfUserId] = useState<string | undefined>(myUserId);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await call({ type: 'sp:syncListMembers', spaceId });
      if (res?.ok && res.members) {
        setMembers(res.members);
        setTruncated(res.membersTruncated === true);
        if (res.myRole !== undefined) {
          setSelfRole(res.myRole);
          setSelfUserId(res.myUserId);
        }
        setNotice(null);
      } else if (res !== undefined && !res.ok) {
        setNotice(memberErrorText(res, t('sync.error.generic')));
      }
    } finally {
      setBusy(false);
    }
  }, [call, spaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Every member operation re-pulls the list afterwards: the list is both the verification
  // path for an uncertain outcome and the immediate reflection of the change
  const runOp = async (
    action: () => Promise<ExtensionResponse | undefined>,
    fallback: string,
    confirmText?: string,
  ) => {
    if (confirmText !== undefined && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      const res = await action();
      if (!res?.ok) {
        const text = res !== undefined && !res.ok ? memberErrorText(res, fallback) : fallback;
        // An uncertain outcome (hop timeout / sent timeout) may still have committed — the list
        // is the verification path, so re-pull it; the notice lands AFTER the reload so a
        // successful re-pull cannot wipe the failure feedback with its setNotice(null)
        if (res !== undefined && (res.reason === 'timeout' || res.reason === 'operation-uncertain')) {
          await load();
        }
        setNotice(text);
        return;
      }
      setNotice(null);
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const issueInvite = async () => {
    setBusy(true);
    try {
      const res = await call({ type: 'sp:syncIssueInvite', spaceId });
      if (!res?.ok) {
        setNotice(res !== undefined && !res.ok ? memberErrorText(res, t('sync.error.generic')) : t('sync.error.generic'));
        return;
      }
      setInvite(res.invite ?? null);
      setCopied(false);
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const copyInvite = async () => {
    if (invite === null) return;
    const ok = await navigator.clipboard?.writeText(invite.code).then(() => true).catch(() => false);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  const identityOf = (m: SpaceMemberView): string =>
    m.nickname ?? m.email ?? t('sync.members.identityFallback', { id: m.userId.slice(0, 8) });

  return (
    <>
      <section className="sp-card">
        <div className="sp-row" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="sp-btn" onClick={onBack}>
            {t('sync.scripts.back')}
          </button>
          <button type="button" className="sp-btn" disabled={busy} onClick={() => void load()}>
            {t('sync.members.refresh')}
          </button>
        </div>
        <p className="sp-sub">
          {t('sync.members.title')} · {spaceName}
        </p>
        {notice && <p className="sp-error">{notice}</p>}
      </section>

      {/* Same failure shape as the scripts view: while the first load is pending the list is
          simply empty; a failed load shows the notice above and never a stuck Loading row */}
      {(members ?? []).map((m) => {
          const self = selfUserId !== undefined && m.userId === selfUserId;
          return (
            <section key={m.userId} className="sp-card" aria-label={identityOf(m)}>
              <div className="sp-row" style={{ justifyContent: 'space-between' }}>
                <h2 className="sp-title" style={{ fontSize: 14 }}>{identityOf(m)}</h2>
                <div className="sp-row">
                  <span className={roleBadgeClass(m.role)}>
                    {m.isOwner
                      ? t('sync.roles.owner')
                      : m.role === 'admin'
                        ? t('sync.roles.admin')
                        : t('sync.roles.readOnly')}
                  </span>
                  {self && <span className="sp-badge sync-new">{t('sync.members.you')}</span>}
                </div>
              </div>
              <p className="sp-sub">{m.userId}</p>
              {m.joinedAt !== null && <p className="sp-sub">{t('sync.members.joinedAt', { time: m.joinedAt })}</p>}
              {/* The own row carries no inline management (leaving owns self-exit); the owner
                  row is protected server-side and shows no remove/demote at all */}
              {!self && !m.isOwner && (
                <div className="sp-row">
                  {m.role === 'member' && (
                    <button
                      type="button"
                      className="sp-btn"
                      disabled={busy}
                      onClick={() =>
                        void runOp(
                          () => call({ type: 'sp:syncUpdateMemberRole', spaceId, userId: m.userId, role: 'admin' }),
                          t('sync.error.generic'),
                        )
                      }
                    >
                      {t('sync.members.promote')}
                    </button>
                  )}
                  {m.role === 'admin' && (
                    <button
                      type="button"
                      className="sp-btn"
                      disabled={busy}
                      onClick={() =>
                        void runOp(
                          () => call({ type: 'sp:syncUpdateMemberRole', spaceId, userId: m.userId, role: 'member' }),
                          t('sync.error.generic'),
                          t('sync.members.confirmDemote', { name: identityOf(m) }),
                        )
                      }
                    >
                      {t('sync.members.demote')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="sp-btn danger"
                    disabled={busy}
                    onClick={() =>
                      void runOp(
                        () => call({ type: 'sp:syncRemoveMember', spaceId, userId: m.userId }),
                        t('sync.error.generic'),
                        t('sync.members.confirmRemove', { name: identityOf(m) }),
                      )
                    }
                  >
                    {t('sync.members.remove')}
                  </button>
                  {selfRole === 'owner' && m.role === 'admin' && (
                    <button
                      type="button"
                      className="sp-btn"
                      disabled={busy}
                      onClick={() =>
                        void runOp(
                          () => call({ type: 'sp:syncTransferOwnership', spaceId, userId: m.userId }),
                          t('sync.error.generic'),
                          t('sync.members.confirmTransfer', { name: identityOf(m) }),
                        )
                      }
                    >
                      {t('sync.members.transfer')}
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })}

      {members !== null && members.length === 0 && (
        <div className="sp-empty">
          <p className="sp-desc">{t('sync.members.empty')}</p>
        </div>
      )}

      {truncated && <p className="sp-hint">{t('sync.members.truncated')}</p>}

      <section className="sp-card" aria-label={t('sync.members.inviteIssue')}>
        <h2 className="sp-title" style={{ fontSize: 14 }}>{t('sync.members.inviteIssue')}</h2>
        <p className="sp-hint">{t('sync.members.inviteRules')}</p>
        {invite !== null && (
          <>
            <div className="sp-field">
              <span className="sp-label">{t('sync.members.inviteLabel')}</span>
              <div className="sp-row">
                <input
                  className="sp-input"
                  style={{ flex: 1 }}
                  readOnly
                  value={invite.code}
                  aria-label={t('sync.members.inviteLabel')}
                />
                <button type="button" className="sp-btn" onClick={() => void copyInvite()}>
                  {copied ? t('sync.members.inviteCopied') : t('sync.members.inviteCopy')}
                </button>
              </div>
            </div>
            <p className="sp-hint">{t('sync.members.inviteExpiresAt', { time: invite.expiresAt })}</p>
            <p className="sp-hint">{t('sync.members.inviteLostHint')}</p>
          </>
        )}
        <button type="button" className="sp-btn primary" disabled={busy} onClick={() => void issueInvite()}>
          {t('sync.members.inviteIssue')}
        </button>
      </section>
    </>
  );
}
