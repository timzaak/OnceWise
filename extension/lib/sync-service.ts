// Background sync orchestration (data-sync): every sp:sync* handler, space bookkeeping (create with a
// locally generated id — key-less org-bound creation on workspace-permissions servers, otherwise the
// original key path — join-by-code with local space-code/invite typing, forget/delete, server-switch
// reset), the pull/switch data flow (validate → flow write → link update → registration sync + reload
// push, zero writes on validation failure), the script-list join with the local pinning links, and the
// org-bound invite/member surface. background.ts stays a thin router; only this module talks to
// lib/sync-api.ts. Every business API call goes through authedOperation (lib/sync-auth.ts): bearer +
// lazy renewal on Herald-gated servers, the original credential-free wire shape on none/unknown ones;
// the sign-in lifecycle handlers live in lib/sync-auth.ts.
import { importFlowContent } from './import-pipeline';
import { afterFlowsWrite } from './site-scripts';
import {
  describePage,
  describePages,
  describeTrigger,
  describeSteps,
  flowDraftHash,
  validateFlow,
} from './flow-schema';
import { stepsHaveSubmitAction } from './step-schema';
import { redactText } from './redact';
import { loadFlows, saveFlowRecord } from './storage';
import * as api from './sync-api';
import type { SpaceRole } from './sync-api';
import { authedOperation, authReady, getAuthState, NONE_OP_BUDGET_MS, probeAuthMode, signIn, signOut } from './sync-auth';
import {
  clearSyncSpaceRole,
  findLinkByFlow,
  findLinkByScript,
  forgetSpace,
  findSpace,
  loadSyncConfig,
  loadSyncLinks,
  loadSyncUi,
  removeSyncLink,
  resetSyncForServer,
  setSyncCurrentSpace,
  spaceCategory,
  updateSyncSpaceRole,
  upsertSyncLink,
  upsertSyncSpace,
  type SyncSpaceEntry,
} from './sync-storage';
import type {
  ExtensionMessage,
  ExtensionResponse,
  ScriptRowView,
  SpaceMemberView,
  SyncSpaceView,
} from './messaging';

export type SyncMessage = Extract<ExtensionMessage, { type: `sp:sync${string}` }>;

// A space-scoped operation needs a configured server plus a locally known space; unknown/badly
// shaped space ids fail as not-configured so the UI routes back to the spaces view. `key` is the
// entry key normalized to null for org-bound spaces — the form the api layer accepts.
type SpaceContext = { serverUrl: string; space: SyncSpaceEntry; key: string | null };

async function requireServer(): Promise<string | { resp: ExtensionResponse }> {
  const config = await loadSyncConfig();
  if (config.serverUrl === '') return { resp: { ok: false, reason: 'not-configured' } };
  return config.serverUrl;
}

async function requireSpace(spaceId: string): Promise<SpaceContext | { resp: ExtensionResponse }> {
  const config = await loadSyncConfig();
  if (config.serverUrl === '') return { resp: { ok: false, reason: 'not-configured' } };
  const space = findSpace(config, spaceId);
  if (space === undefined) return { resp: { ok: false, reason: 'space-not-known' } };
  return { serverUrl: config.serverUrl, space, key: space.key ?? null };
}

function spaceView(space: SyncSpaceEntry): SyncSpaceView {
  return {
    id: space.id,
    name: space.name,
    createdAt: space.createdAt,
    // Org-bound entries have no key — no share code row exists for them
    code: space.key === undefined ? null : api.spaceCodeOf(space.id, space.key),
    ...(space.myRole === undefined ? {} : { myRole: space.myRole }),
    ...(space.myUserId === undefined ? {} : { myUserId: space.myUserId }),
  };
}

// The invite/member surface is org-bound only; a key-space entry is refused before any traffic
// (spaceCategory is the fixed read-side rule; its 'invalid' torn shapes deliberately pass as
// org-bound here — the server re-decides membership). The view layer localizes the reason.
function orgBoundOnly(space: SyncSpaceEntry): ExtensionResponse | null {
  return spaceCategory(space) === 'key' ? { ok: false, reason: 'space-key-unsupported' } : null;
}

async function requireOrgBound(spaceId: string): Promise<SpaceContext | { resp: ExtensionResponse }> {
  const ctx = await requireSpace(spaceId);
  if ('resp' in ctx) return ctx;
  const refused = orgBoundOnly(ctx.space);
  return refused !== null ? { resp: refused } : ctx;
}

// Takes the full ExtensionMessage union so the background router needs no cast; non-sync messages
// fall through to bad-payload (the switch labels do the narrowing)
export async function handleSyncMessage(msg: ExtensionMessage): Promise<ExtensionResponse> {
  switch (msg.type) {
    case 'sp:syncGetStatus': {
      const [config, ui] = await Promise.all([loadSyncConfig(), loadSyncUi()]);
      return {
        ok: true,
        syncState: {
          serverUrl: config.serverUrl,
          spaces: config.spaces.map(spaceView),
          currentSpaceId: ui.currentSpaceId,
        },
      };
    }

    case 'sp:syncProbeHealth': {
      const serverUrl = await requireServer();
      if (typeof serverUrl !== 'string') return serverUrl.resp;
      const res = await api.getHealth(serverUrl);
      return { ok: true, health: res.ok ? 'ok' : 'unreachable' };
    }

    // Sign-in lifecycle (Herald-gated servers): mode probe + non-secret auth state, the
    // authorization-window sign-in and the local sign-out — all orchestrated in lib/sync-auth.ts
    case 'sp:syncGetAuthState':
      return getAuthState();
    case 'sp:syncSignIn':
      return signIn();
    case 'sp:syncSignOut':
      return signOut();

    // The UI has already requested the origin's host permission inside its user gesture; changing
    // the address resets the local spaces/links/selection (confirmed upstream by the UI) and, in
    // the same serialized write, the old server's sign-in state. The auth-write path gates on the
    // storage trusted-contexts restriction — without it nothing is cleared and no probe is sent.
    case 'sp:syncSetServer': {
      const origin = api.normalizeServerUrl(msg.serverUrl);
      if (!origin) return { ok: false, reason: 'invalid-origin' };
      if (!(await authReady())) return { ok: false, reason: 'auth-unavailable' };
      const config = await loadSyncConfig();
      if (config.serverUrl !== origin) await resetSyncForServer(origin);
      const res = await api.getHealth(origin);
      if (!res.ok) return { ok: false, reason: 'unreachable' };
      return { ok: true, health: 'ok' };
    }

    // Create generates the id locally (the server never assigns identity); the entry is stored
    // only after the server accepted the registration. On workspace-permissions servers the
    // creation goes key-less (org-bound, creator = owner); none and older servers keep the
    // original key path byte-for-byte. An unknown probe refuses outright (fail-closed): no
    // request, no local entry — a probe failure is never treated as none.
    case 'sp:syncCreateSpace': {
      const serverUrl = await requireServer();
      if (typeof serverUrl !== 'string') return serverUrl.resp;
      // The probe start anchors the whole message budget (probe + request must answer within one
      // UI hop); authedOperation re-uses it instead of re-anchoring after the probe
      const probeStartedAt = Date.now();
      const probe = await probeAuthMode(serverUrl, probeStartedAt + NONE_OP_BUDGET_MS);
      if (probe.mode === 'unknown') return { ok: false, reason: 'auth-unavailable' };
      if (probe.mode === 'herald' && probe.workspacePermissions) {
        const id = api.generateSpaceId();
        const outcome = await authedOperation(
          serverUrl,
          (bearer, deadlineAt) => api.createSpace(serverUrl, { id, name: msg.name }, { bearer, deadlineAt }),
          true,
          probe,
          probeStartedAt,
        );
        if (!outcome.ok) return outcome.resp;
        await upsertSyncSpace({
          id,
          name: outcome.data.name,
          createdAt: outcome.data.createdAt,
          myRole: outcome.data.myRole ?? 'owner',
          ...(outcome.data.myUserId === undefined ? {} : { myUserId: outcome.data.myUserId }),
        });
        await setSyncCurrentSpace(id);
        return { ok: true, space: { id, name: outcome.data.name } };
      }
      const id = api.generateSpaceId();
      const key = api.generateSpaceKey();
      const outcome = await authedOperation(
        serverUrl,
        (bearer, deadlineAt) => api.createSpace(serverUrl, { id, key, name: msg.name }, { bearer, deadlineAt }),
        true,
        probe,
        probeStartedAt,
      );
      if (!outcome.ok) return outcome.resp;
      await upsertSyncSpace({ id, key, name: outcome.data.name, createdAt: outcome.data.createdAt });
      await setSyncCurrentSpace(id);
      return { ok: true, space: { id, name: outcome.data.name } };
    }

    // Join parses the pasted code locally first, then verifies against the server before storing
    // — a mistyped code never lands in local state. Space codes take the original key path;
    // invite codes ("…#iv-…") redeem into read-only membership on workspace-permissions servers
    // (none/older servers are refused locally with zero traffic; an unknown probe fail-closes).
    case 'sp:syncJoinSpace': {
      const serverUrl = await requireServer();
      if (typeof serverUrl !== 'string') return serverUrl.resp;
      const raw = msg.code.trim();
      const parsed = api.parseEntryCode(raw);
      if (parsed === null) return { ok: false, reason: 'bad-space-code' };
      if (parsed.kind === 'space') {
        const outcome = await authedOperation(
          serverUrl,
          (bearer, deadlineAt) => api.getSpace(serverUrl, parsed.id, parsed.key, { bearer, deadlineAt }),
          false,
        );
        if (!outcome.ok) return outcome.resp;
        await upsertSyncSpace({
          id: outcome.data.id,
          key: parsed.key,
          name: outcome.data.name,
          createdAt: outcome.data.createdAt,
        });
        return { ok: true, space: { id: outcome.data.id, name: outcome.data.name } };
      }
      const probeStartedAt = Date.now();
      const probe = await probeAuthMode(serverUrl, probeStartedAt + NONE_OP_BUDGET_MS);
      if (probe.mode === 'unknown') return { ok: false, reason: 'auth-unavailable' };
      if (probe.mode !== 'herald' || !probe.workspacePermissions) {
        return { ok: false, reason: 'invite-unsupported' };
      }
      // The wire form is the pasted string itself; a sent-timeout surfaces as
      // operation-uncertain, and retrying is safe (redemption is idempotent per caller)
      const outcome = await authedOperation(
        serverUrl,
        (bearer, deadlineAt) => api.redeemInvite(serverUrl, raw, { bearer, deadlineAt }),
        true,
        probe,
        probeStartedAt,
      );
      if (!outcome.ok) return outcome.resp;
      await upsertSyncSpace({
        id: outcome.data.id,
        name: outcome.data.name,
        createdAt: outcome.data.createdAt,
        // A replayed code returns the caller's actual role — never a demotion
        myRole: outcome.data.myRole ?? 'member',
        ...(outcome.data.myUserId === undefined ? {} : { myUserId: outcome.data.myUserId }),
      });
      return { ok: true, space: { id: outcome.data.id, name: outcome.data.name } };
    }

    case 'sp:syncSelectSpace': {
      await setSyncCurrentSpace(msg.spaceId);
      return { ok: true };
    }

    // Local-only forget: server state untouched (the space stays for other holders of the code)
    case 'sp:syncForgetSpace': {
      await forgetSpace(msg.spaceId);
      return { ok: true };
    }

    case 'sp:syncDeleteSpace': {
      const ctx = await requireSpace(msg.spaceId);
      if ('resp' in ctx) return ctx.resp;
      const outcome = await authedOperation(
        ctx.serverUrl,
        (bearer, deadlineAt) =>
          api.deleteSpace(ctx.serverUrl, ctx.space.id, ctx.key, { bearer, deadlineAt }),
        true,
      );
      if (!outcome.ok) return outcome.resp;
      await forgetSpace(msg.spaceId);
      return { ok: true };
    }

    case 'sp:syncListScripts': {
      const ctx = await requireSpace(msg.spaceId);
      if ('resp' in ctx) return ctx.resp;
      // Org-bound entries refresh the role first, inside one authedOperation run (single probe,
      // single deadline): getSpace decides membership/role, then listScripts runs as the same
      // member. A failed getSpace short-circuits (removed → space-access-denied, gone →
      // space-not-found, outage → 503 — all passed through verbatim). Key spaces keep the exact
      // original single request.
      let freshRole: SpaceRole | undefined;
      let freshUserId: string | undefined;
      const outcome = await authedOperation(
        ctx.serverUrl,
        async (bearer, deadlineAt) => {
          if (ctx.space.key !== undefined) {
            return api.listScripts(ctx.serverUrl, ctx.space.key, msg.spaceId, { bearer, deadlineAt });
          }
          const spaceRes = await api.getSpace(ctx.serverUrl, msg.spaceId, null, { bearer, deadlineAt });
          if (!spaceRes.ok) return spaceRes;
          if (spaceRes.data.myRole !== undefined) {
            freshRole = spaceRes.data.myRole;
            freshUserId = spaceRes.data.myUserId;
          }
          return api.listScripts(ctx.serverUrl, null, msg.spaceId, { bearer, deadlineAt });
        },
        false,
      );
      if (!outcome.ok) return outcome.resp;
      if (freshRole !== undefined && (ctx.space.myRole !== freshRole || ctx.space.myUserId !== freshUserId)) {
        await updateSyncSpaceRole(msg.spaceId, freshRole, freshUserId);
      }
      const [links, flows] = await Promise.all([loadSyncLinks(), loadFlows()]);
      const scriptRows: ScriptRowView[] = outcome.data.map((script) => {
        const link = findLinkByScript(links, msg.spaceId, script.id);
        if (link === undefined) return { ...script };
        const flow = flows.find((r) => r.id === link.flowId);
        return {
          ...script,
          local: {
            flowId: link.flowId,
            pinnedVersionNumber: link.pinnedVersionNumber,
            localFlowExists: flow !== undefined,
            hasLocalEdits: flow !== undefined && flowDraftHash(flow) !== link.pinnedContentHash,
            newVersionAvailable: script.latestVersionNumber > link.pinnedVersionNumber,
          },
        };
      });
      return { ok: true, scriptRows, ...(freshRole !== undefined ? { myRole: freshRole } : {}) };
    }

    case 'sp:syncListVersions': {
      const ctx = await requireSpace(msg.spaceId);
      if ('resp' in ctx) return ctx.resp;
      const outcome = await authedOperation(
        ctx.serverUrl,
        (bearer, deadlineAt) =>
          api.listScriptVersions(ctx.serverUrl, ctx.key, msg.spaceId, msg.scriptId, { bearer, deadlineAt }),
        false,
      );
      if (!outcome.ok) return outcome.resp;
      return { ok: true, versionMetas: outcome.data };
    }

    case 'sp:syncPreviewVersion': {
      const ctx = await requireSpace(msg.spaceId);
      if ('resp' in ctx) return ctx.resp;
      const outcome = await authedOperation(
        ctx.serverUrl,
        (bearer, deadlineAt) =>
          api.getScriptVersion(ctx.serverUrl, ctx.key, msg.spaceId, msg.scriptId, msg.versionNumber, {
            bearer,
            deadlineAt,
          }),
        false,
      );
      if (!outcome.ok) return outcome.resp;
      const validated = importFlowContent(outcome.data.flowContent);
      if (!validated.ok) return { ok: false, reason: 'invalid-content', errors: validated.errors };
      const draft = validated.draft;
      return {
        ok: true,
        versionPreview: {
          name: draft.name,
          site: draft.site,
          pageDesc: describePages(draft),
          triggerDesc: describeTrigger(draft),
          // The step list covers branches and loops; submit flags come from the recursive step
          // scan, not a top-level filter (DEC-data-sync-011)
          actions: describeSteps(draft.steps).map((s) => ({
            text: redactText(s.text),
            submit: s.submit,
          })),
          hasSubmit: stepsHaveSubmitAction(draft.steps),
        },
      };
    }

    // Pull (no local link) and switch/pin (link exists) share one entry point; the version is
    // re-validated on every call (versions are immutable, no state is cached)
    case 'sp:syncPullVersion': {
      const ctx = await requireSpace(msg.spaceId);
      if ('resp' in ctx) return ctx.resp;
      const outcome = await authedOperation(
        ctx.serverUrl,
        (bearer, deadlineAt) =>
          api.getScriptVersion(ctx.serverUrl, ctx.key, msg.spaceId, msg.scriptId, msg.versionNumber, {
            bearer,
            deadlineAt,
          }),
        false,
      );
      if (!outcome.ok) return outcome.resp;
      const validated = importFlowContent(outcome.data.flowContent);
      if (!validated.ok) return { ok: false, reason: 'invalid-content', errors: validated.errors };
      const draft = validated.draft;
      const links = await loadSyncLinks();
      const link = findLinkByScript(links, msg.spaceId, msg.scriptId);
      const linkedFlow = link === undefined ? undefined : (await loadFlows()).find((r) => r.id === link.flowId);
      // Switch/pin keeps the flowId; the draft envelope resets status to 'draft' — a switched flow
      // must be re-enabled by the local user
      const candidate = link === undefined || linkedFlow === undefined ? draft : { ...draft, id: link.flowId };
      // 'full' validation before persisting (same two-step shape as sp:saveFlow) — also keeps the
      // validation-failure-zero-writes guarantee: local flows and links stay untouched
      const fullCheck = validateFlow(candidate, 'full');
      if (!fullCheck.ok || !fullCheck.flow) {
        return { ok: false, reason: 'invalid-content', errors: fullCheck.errors };
      }
      const created = link === undefined || linkedFlow === undefined;
      await saveFlowRecord(fullCheck.flow);
      // Write order: flow first, link second — a SW death between the two only leaves the badge
      // stale until the next pull/publish self-heals it
      await upsertSyncLink({
        flowId: fullCheck.flow.id,
        spaceId: msg.spaceId,
        scriptId: msg.scriptId,
        scriptName: link?.scriptName ?? '',
        pinnedVersionNumber: msg.versionNumber,
        pinnedContentHash: flowDraftHash(draft),
      });
      await afterFlowsWrite();
      return { ok: true, flowId: fullCheck.flow.id, created };
    }

    // Upload targets the currently selected space (the scripts view is only reachable with one)
    case 'sp:syncUploadScript': {
      const ui = await loadSyncUi();
      if (ui.currentSpaceId === null) return { ok: false, reason: 'not-configured' };
      const ctx = await requireSpace(ui.currentSpaceId);
      if ('resp' in ctx) return ctx.resp;
      // A flow linked to any script publishes through that script's "publish new version" instead —
      // uploading again would silently rebind the 1:1 mapping to a different script
      if (findLinkByFlow(await loadSyncLinks(), msg.flowId) !== undefined) {
        return { ok: false, reason: 'invalid-input', detail: 'The flow is already linked to a script; publish a new version from that script instead.' };
      }
      const flow = (await loadFlows()).find((r) => r.id === msg.flowId);
      if (flow === undefined) return { ok: false, reason: 'flow-not-found' };
      // Uploads serialize the validated whitelist object, never the stored record as-is: input values
      // live outside the Flow in local storage, and the rebuild drops any foreign field a future
      // caller might have attached to it.
      const checked = validateFlow(flow, 'full');
      if (!checked.ok || !checked.flow) return { ok: false, reason: 'flow-not-found' };
      const uploadable = checked.flow;
      const outcome = await authedOperation(
        ctx.serverUrl,
        (bearer, deadlineAt) =>
          api.createScript(
            ctx.serverUrl,
            ctx.key,
            ctx.space.id,
            {
              id: api.generateScriptId(),
              name: msg.name,
              note: msg.note,
              versionNote: msg.versionNote,
              flowContent: uploadable,
            },
            { bearer, deadlineAt },
          ),
        true,
      );
      if (!outcome.ok) return outcome.resp;
      await upsertSyncLink({
        flowId: flow.id,
        spaceId: ctx.space.id,
        scriptId: outcome.data.id,
        scriptName: msg.name,
        pinnedVersionNumber: 1,
        pinnedContentHash: flowDraftHash(flow),
      });
      return { ok: true, scriptId: outcome.data.id };
    }

    case 'sp:syncPublishVersion': {
      const link = findLinkByFlow(await loadSyncLinks(), msg.flowId);
      if (link === undefined) return { ok: false, reason: 'not-linked' };
      const ctx = await requireSpace(link.spaceId);
      if ('resp' in ctx) return ctx.resp;
      const flow = (await loadFlows()).find((r) => r.id === msg.flowId);
      if (flow === undefined) return { ok: false, reason: 'flow-not-found' };
      // Same whitelist serialization as upload: the published version carries definitions only
      const checked = validateFlow(flow, 'full');
      if (!checked.ok || !checked.flow) return { ok: false, reason: 'flow-not-found' };
      const publishable = checked.flow;
      const outcome = await authedOperation(
        ctx.serverUrl,
        (bearer, deadlineAt) =>
          api.createScriptVersion(
            ctx.serverUrl,
            ctx.key,
            link.spaceId,
            link.scriptId,
            { versionNote: msg.versionNote, flowContent: publishable },
            { bearer, deadlineAt },
          ),
        true,
      );
      if (!outcome.ok) return outcome.resp;
      await upsertSyncLink({
        ...link,
        pinnedVersionNumber: outcome.data.versionNumber,
        pinnedContentHash: flowDraftHash(flow),
      });
      return { ok: true, versionNumber: outcome.data.versionNumber };
    }

    case 'sp:syncUpdateScript': {
      const link = findLinkByFlow(await loadSyncLinks(), msg.flowId);
      if (link === undefined) return { ok: false, reason: 'not-linked' };
      const ctx = await requireSpace(link.spaceId);
      if ('resp' in ctx) return ctx.resp;
      const outcome = await authedOperation(
        ctx.serverUrl,
        (bearer, deadlineAt) =>
          api.updateScript(
            ctx.serverUrl,
            ctx.key,
            link.spaceId,
            link.scriptId,
            { name: msg.name, note: msg.note },
            { bearer, deadlineAt },
          ),
        true,
      );
      if (!outcome.ok) return outcome.resp;
      if (msg.name !== undefined) await upsertSyncLink({ ...link, scriptName: msg.name });
      return { ok: true };
    }

    case 'sp:syncUnlink': {
      await removeSyncLink(msg.flowId);
      return { ok: true };
    }

    // --- workspace permissions: invites and member management (org-bound spaces only) ---

    // The plaintext code exists exactly once, in this response — never stored, never logged
    case 'sp:syncIssueInvite': {
      const ctx = await requireOrgBound(msg.spaceId);
      if ('resp' in ctx) return ctx.resp;
      const outcome = await authedOperation(
        ctx.serverUrl,
        (bearer, deadlineAt) => api.issueSpaceInvite(ctx.serverUrl, msg.spaceId, { bearer, deadlineAt }),
        true,
      );
      if (!outcome.ok) return outcome.resp;
      return { ok: true, invite: { code: outcome.data.code, expiresAt: outcome.data.expiresAt } };
    }

    // Live list, one full page of 100; nothing member-shaped is ever persisted locally. The
    // caller's own facts are re-decided first, inside one authedOperation run (same shape as
    // sp:syncListScripts): the stored myUserId/myRole can belong to a previous account on this
    // device, and the view's "You" marking and owner gating must follow the identity the
    // server actually sees.
    case 'sp:syncListMembers': {
      const ctx = await requireOrgBound(msg.spaceId);
      if ('resp' in ctx) return ctx.resp;
      let freshRole: SpaceRole | undefined;
      let freshUserId: string | undefined;
      const outcome = await authedOperation(
        ctx.serverUrl,
        async (bearer, deadlineAt) => {
          const spaceRes = await api.getSpace(ctx.serverUrl, msg.spaceId, null, { bearer, deadlineAt });
          if (!spaceRes.ok) return spaceRes;
          if (spaceRes.data.myRole !== undefined) {
            freshRole = spaceRes.data.myRole;
            freshUserId = spaceRes.data.myUserId;
          }
          return api.listSpaceMembers(ctx.serverUrl, msg.spaceId, 1, 100, { bearer, deadlineAt });
        },
        false,
      );
      if (!outcome.ok) return outcome.resp;
      if (freshRole !== undefined && (ctx.space.myRole !== freshRole || ctx.space.myUserId !== freshUserId)) {
        await updateSyncSpaceRole(msg.spaceId, freshRole, freshUserId);
      }
      const members: SpaceMemberView[] = outcome.data.items.map((m) => ({
        userId: m.userId,
        email: m.email ?? null,
        nickname: m.nickname ?? null,
        role: m.role,
        isOwner: m.isOwner,
        joinedAt: m.joinedAt ?? null,
      }));
      return {
        ok: true,
        members,
        membersTruncated: outcome.data.total > members.length,
        ...(freshRole === undefined ? {} : { myRole: freshRole, myUserId: freshUserId }),
      };
    }

    case 'sp:syncUpdateMemberRole': {
      const ctx = await requireOrgBound(msg.spaceId);
      if ('resp' in ctx) return ctx.resp;
      const outcome = await authedOperation(
        ctx.serverUrl,
        (bearer, deadlineAt) =>
          api.updateSpaceMemberRole(ctx.serverUrl, msg.spaceId, msg.userId, msg.role, { bearer, deadlineAt }),
        true,
      );
      if (!outcome.ok) return outcome.resp;
      return { ok: true };
    }

    // userId '' = leave this space (self-exit): the target always re-resolves from a fresh
    // getSpace inside the same authedOperation run — a stored myUserId can belong to a previous
    // account on this device and is never trusted to pick the removal target. Success never
    // removes the local entry (local-first: pulled content stays, forgetting is separate), but
    // it drops the stale role facts so the list stops rendering manager-gated buttons.
    case 'sp:syncRemoveMember': {
      const ctx = await requireOrgBound(msg.spaceId);
      if ('resp' in ctx) return ctx.resp;
      let target = msg.userId;
      const outcome = await authedOperation(
        ctx.serverUrl,
        async (bearer, deadlineAt) => {
          if (target === '') {
            const spaceRes = await api.getSpace(ctx.serverUrl, msg.spaceId, null, { bearer, deadlineAt });
            if (!spaceRes.ok) return spaceRes;
            // An org-bound member answer without myUserId is out of contract — fail closed
            if (spaceRes.data.myUserId === undefined || spaceRes.data.myUserId === '') {
              return {
                ok: false as const,
                error: {
                  kind: 'http' as const,
                  status: 503,
                  code: 'AUTH_UNAVAILABLE',
                  message: 'The server did not report a member id for this caller',
                },
              };
            }
            target = spaceRes.data.myUserId;
          }
          return api.removeSpaceMember(ctx.serverUrl, msg.spaceId, target, { bearer, deadlineAt });
        },
        true,
      );
      if (!outcome.ok) return outcome.resp;
      if (msg.userId === '') await clearSyncSpaceRole(msg.spaceId);
      return { ok: true };
    }

    case 'sp:syncTransferOwnership': {
      const ctx = await requireOrgBound(msg.spaceId);
      if ('resp' in ctx) return ctx.resp;
      const outcome = await authedOperation(
        ctx.serverUrl,
        (bearer, deadlineAt) => api.transferSpaceOwnership(ctx.serverUrl, msg.spaceId, msg.userId, { bearer, deadlineAt }),
        true,
      );
      if (!outcome.ok) return outcome.resp;
      // A successful transfer demotes the caller to admin — write it back so the panel status
      // stops rendering owner-gated UI before the next scripts-view role refresh
      await updateSyncSpaceRole(msg.spaceId, 'admin');
      return { ok: true };
    }

    default:
      return { ok: false, reason: 'bad-payload' };
  }
}
