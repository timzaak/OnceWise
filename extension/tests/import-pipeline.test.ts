// Import chain (DEC-015 single channel): parse JSON, reject invalid flows without touching existing
// flows, and produce a disabled draft. The data-sync pull channel shares the same validation and
// envelope semantics (DEC-019).
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { buildImportedFlow, validateFlow } from '@/lib/flow-schema';
import { importFlowContent, importFlowText } from '@/lib/import-pipeline';
import { isFromContentScript, isFromExtensionPage, type MessageSender } from '@/lib/messaging';
import { buildFlowStore, loadFlows, flowStoreItem } from '@/lib/storage';

const phoneTarget = { clues: { id: 'contactPhone' }, componentType: 'input', displayLabel: '联系电话' };

function importFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: '发货仓库→联系电话',
    site: 'https://www.example.com',
    page: { urlIncludes: '/form-page.html' },
    trigger: { kind: 'pageEnter' },
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'fill-phone',
          kind: 'action',
          action: { type: 'setInputValue', target: phoneTarget, value: '13800001234' },
        },
      ],
    },
    ...overrides,
  };
}

// The native channel's flow.validate/flow.save ops (lib/native-messaging.ts) forward to
// importFlowText (lib/import-pipeline.ts): parse → envelope detection → validateFlow('import') →
// buildImportedFlow, without persisting (flow.save persists via nativeSaveRecord). These tests
// drive that same lib pipeline.
function runImport(text: string): { ok: boolean; errors?: string[]; draft?: ReturnType<typeof buildImportedFlow> } {
  const res = importFlowText(text);
  return res.ok ? { ok: true, draft: res.draft } : { ok: false, errors: res.errors };
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe('import validation chain', () => {
  it('non-JSON text is rejected with a parse reason and nothing saved', () => {
    const res = runImport('{ this is not json');
    expect(res.ok).toBe(false);
    expect(res.errors![0]).toContain('Not valid JSON');
  });

  it('structural errors reject the whole file (empty steps)', () => {
    const res = runImport(JSON.stringify(importFile({ steps: { id: 'root', kind: 'sequence', steps: [] } })));
    expect(res.ok).toBe(false);
    expect(res.errors!.join('\n')).toContain('steps must be a non-empty array');
  });

  it('forbidden submit family rejects the file at import time (step actions)', () => {
    const res = runImport(
      JSON.stringify(
        importFile({
          steps: {
            id: 'root',
            kind: 'sequence',
            steps: [
              {
                id: 'click-delete',
                kind: 'action',
                action: { type: 'clickButton', target: { clues: { id: 'x' }, componentType: 'button', displayLabel: '删除记录' } },
              },
            ],
          },
        }),
      ),
    );
    expect(res.ok).toBe(false);
    expect(res.errors!.join('\n')).toContain('forbidden irreversible-action terms');
  });

  it('a file with an unknown schemaVersion is refused with the expected number stated', () => {
    const res = runImport(JSON.stringify(importFile({ schemaVersion: 3 })));
    expect(res.ok).toBe(false);
    expect(res.errors!.join('\n')).toContain('schemaVersion');
    expect(res.errors!.join('\n')).toContain('must be 1');
  });

  it('action-list shaped files without a step tree are refused (one format, no migration)', () => {
    const actionList = {
      schemaVersion: 1,
      name: '动作组格式',
      site: 'https://www.example.com',
      page: { urlIncludes: '/form-page.html' },
      trigger: { kind: 'pageEnter' },
      actions: [{ kind: 'setInputValue', target: phoneTarget, value: { kind: 'constant', value: '138' } }],
    };
    const res = runImport(JSON.stringify(actionList));
    expect(res.ok).toBe(false);
    expect(res.errors!.join('\n')).toContain('steps');
    // The pull channel applies the same gate (DEC-data-sync-011: unsupported formats, zero writes)
    expect(importFlowContent(actionList).ok).toBe(false);
  });

  it('success path: normalized draft, status draft, envelope rewritten, existing flows untouched', async () => {
    const existing = buildImportedFlow(validateFlow(importFile({ name: '已有流程' }), 'import').draft!);
    await flowStoreItem.setValue(buildFlowStore([existing]));

    const file = importFile({ status: 'enabled', id: 'attacker-id', provenance: { source: 'legacy', createdAt: 0, updatedAt: 0 } });
    const res = runImport(JSON.stringify(file));
    expect(res.ok).toBe(true);
    expect(res.draft!.status).toBe('draft');
    expect(res.draft!.id).not.toBe('attacker-id');
    expect(res.draft!.provenance.source).toBe('import');
    expect(res.draft!.steps.kind).toBe('sequence');

    // importFlowText does not persist; the channel's flow.save persists via nativeSaveRecord
    const flows = await loadFlows();
    expect(flows).toHaveLength(1);
    expect(flows[0]!.name).toBe('已有流程');
  });
});

describe('importFlowContent (workspace pull channel: same validation)', () => {
  it('a valid cloud flow object lands as a fresh draft', () => {
    const res = importFlowContent(importFile());
    expect(res.ok, (res.ok ? [] : res.errors).join('；')).toBe(true);
    if (res.ok) {
      expect(res.draft.status).toBe('draft');
      expect(res.draft.name).toBe('发货仓库→联系电话');
    }
  });

  it('envelope fields (id/status/provenance) are detected, ignored and rewritten', () => {
    const file = importFile({ id: 'cloud-id', status: 'enabled', provenance: { source: 'legacy', createdAt: 0, updatedAt: 0 } });
    const res = importFlowContent(file);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.hadEnvelope).toBe(true);
      expect(res.draft.id).not.toBe('cloud-id');
      expect(res.draft.status).toBe('draft');
      expect(res.draft.provenance.source).toBe('import');
    }
  });

  it('structural and schema errors pass through verbatim', () => {
    const wrongVersion = importFlowContent(importFile({ schemaVersion: 3 }));
    expect(wrongVersion.ok).toBe(false);
    if (!wrongVersion.ok) expect(wrongVersion.errors.join('\n')).toContain('schemaVersion');

    const broken = importFlowContent(importFile({ steps: { id: 'root', kind: 'sequence', steps: [] } }));
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.errors.join('\n')).toContain('steps must be a non-empty array');

    expect(importFlowContent('not-an-object').ok).toBe(false);
  });

  it('preserves business strings that resemble template interpolation in both import channels', () => {
    const file = importFile();
    (file.steps as { steps: { action: { value: string } }[] }).steps[0]!.action.value = '备注 ${9999} 结束';
    const textResult = importFlowText(JSON.stringify(file));
    const contentResult = importFlowContent(file);
    expect(textResult.ok).toBe(true);
    expect(contentResult.ok).toBe(true);
    if (textResult.ok && contentResult.ok) {
      const textAction = (textResult.draft.steps as { steps: { action: { value: string } }[] }).steps[0]!.action;
      const contentAction = (contentResult.draft.steps as { steps: { action: { value: string } }[] }).steps[0]!.action;
      expect(textAction.value).toBe('备注 ${9999} 结束');
      expect(contentAction.value).toBe(textAction.value);
    }
  });

});

describe('isFromExtensionPage (sp:*/bg:* caller guard, DEC-015)', () => {
  const id = browser.runtime.id;

  function senderOf(url?: string): MessageSender {
    return { id, url } as MessageSender;
  }

  it('accepts the sidepanel and import page extension URLs', () => {
    expect(isFromExtensionPage(senderOf(browser.runtime.getURL('/sidepanel.html')))).toBe(true);
    expect(isFromExtensionPage(senderOf(browser.runtime.getURL('/import.html')))).toBe(true);
  });

  it('rejects external origins, foreign extension ids and missing urls', () => {
    expect(isFromExtensionPage(senderOf('https://example.com/page'))).toBe(false);
    expect(isFromExtensionPage({ id: 'someone-else', url: browser.runtime.getURL('/import.html') } as MessageSender)).toBe(false);
    expect(isFromExtensionPage(senderOf(undefined))).toBe(false);
  });
});

describe('isFromContentScript (ct:* sender guard, DEC-007)', () => {
  it('accepts a content sender on any http(s) page (content scripts only exist on flow sites)', () => {
    const sender = { id: browser.runtime.id, url: 'https://www.example.com/form-page.html' } as MessageSender;
    expect(isFromContentScript(sender)).toBe(true);
  });

  it('rejects foreign ids, missing urls and non-http(s) urls', () => {
    expect(isFromContentScript({ id: browser.runtime.id, url: 'chrome-extension://x/sidepanel.html' } as MessageSender)).toBe(false);
    expect(isFromContentScript({ id: 'other', url: 'https://www.example.com/x' } as MessageSender)).toBe(false);
    expect(isFromContentScript({ id: browser.runtime.id } as MessageSender)).toBe(false);
  });
});
