// Background sync orchestration (data-sync): every sp:sync* handler, space bookkeeping (create with a
// locally generated id+key, join-by-code verification, forget/delete, server-switch reset), the
// pull/switch data flow (validate → flow write → link update → registration sync + reload push, zero
// writes on validation failure) and the script-list join with the local pinning links. background.ts
// stays a thin router; only this module talks to lib/sync-api.ts. Every business API call goes
// through authedOperation (lib/sync-auth.ts): bearer + lazy renewal on Herald-gated servers, the
// original credential-free wire shape on none/unknown ones; the sign-in lifecycle handlers live in
// lib/sync-auth.ts.
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
import { authedOperation, authReady, getAuthState, signIn, signOut } from './sync-auth';
import {
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
  upsertSyncLink,
  upsertSyncSpace,
  type SyncSpaceEntry,
} from './sync-storage';
import type { ExtensionMessage, ExtensionResponse, ScriptRowView, SyncSpaceView } from './messaging';

export type SyncMessage = Extract<ExtensionMessage, { type: `sp:sync${string}` }>;

// A space-scoped operation needs a configured server plus a locally known space; unknown/badly
// shaped space ids fail as not-configured so the UI routes back to the spaces view
type SpaceContext = { serverUrl: string; space: SyncSpaceEntry };

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
  return { serverUrl: config.serverUrl, space };
}

function spaceView(space: SyncSpaceEntry): SyncSpaceView {
  return {
    id: space.id,
    name: space.name,
    createdAt: space.createdAt,
    code: api.spaceCodeOf(space.id, space.key),
  };
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

    // Create generates the id and the key locally (the server never assigns identity); the entry is
    // stored only after the server accepted the registration
    case 'sp:syncCreateSpace': {
      const serverUrl = await requireServer();
      if (typeof serverUrl !== 'string') return serverUrl.resp;
      const id = api.generateSpaceId();
      const key = api.generateSpaceKey();
      const outcome = await authedOperation(
        serverUrl,
        (bearer, deadlineAt) => api.createSpace(serverUrl, { id, key, name: msg.name }, { bearer, deadlineAt }),
        true,
      );
      if (!outcome.ok) return outcome.resp;
      await upsertSyncSpace({ id, key, name: outcome.data.name, createdAt: outcome.data.createdAt });
      await setSyncCurrentSpace(id);
      return { ok: true, space: { id, name: outcome.data.name } };
    }

    // Join parses the share code locally, then verifies it against the server before storing —
    // a mistyped code never lands in local state
    case 'sp:syncJoinSpace': {
      const serverUrl = await requireServer();
      if (typeof serverUrl !== 'string') return serverUrl.resp;
      const parsed = api.parseSpaceCode(msg.code.trim());
      if (parsed === null) return { ok: false, reason: 'bad-space-code' };
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
        (bearer, deadlineAt) => api.deleteSpace(ctx.serverUrl, ctx.space.id, ctx.space.key, { bearer, deadlineAt }),
        true,
      );
      if (!outcome.ok) return outcome.resp;
      await forgetSpace(msg.spaceId);
      return { ok: true };
    }

    case 'sp:syncListScripts': {
      const ctx = await requireSpace(msg.spaceId);
      if ('resp' in ctx) return ctx.resp;
      const outcome = await authedOperation(
        ctx.serverUrl,
        (bearer, deadlineAt) => api.listScripts(ctx.serverUrl, ctx.space.key, msg.spaceId, { bearer, deadlineAt }),
        false,
      );
      if (!outcome.ok) return outcome.resp;
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
      return { ok: true, scriptRows };
    }

    case 'sp:syncListVersions': {
      const ctx = await requireSpace(msg.spaceId);
      if ('resp' in ctx) return ctx.resp;
      const outcome = await authedOperation(
        ctx.serverUrl,
        (bearer, deadlineAt) =>
          api.listScriptVersions(ctx.serverUrl, ctx.space.key, msg.spaceId, msg.scriptId, { bearer, deadlineAt }),
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
          api.getScriptVersion(ctx.serverUrl, ctx.space.key, msg.spaceId, msg.scriptId, msg.versionNumber, {
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
          api.getScriptVersion(ctx.serverUrl, ctx.space.key, msg.spaceId, msg.scriptId, msg.versionNumber, {
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
            ctx.space.key,
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
            ctx.space.key,
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
            ctx.space.key,
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

    default:
      return { ok: false, reason: 'bad-payload' };
  }
}
