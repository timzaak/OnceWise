// The import pipeline (DEC-015 single channel) as one reusable composition: parse JSON → envelope detection →
// validateFlow('import') → buildImportedFlow. The native channel's flow.validate / flow.save dispatch
// (lib/native-messaging.ts) and the tests both forward here, so the pipeline has a single definition
// instead of per-caller reassembly.
// Entry points validate against the current schemaVersion only (DEC-019): any other version is
// rejected with the version error; drafts carry the step tree.
import { buildImportedFlow, isPlainObject, validateFlow, type Flow } from '@/lib/flow-schema';
import { t } from '@/lib/i18n';

export type ImportTextResult =
  | { ok: true; draft: Flow; hadEnvelope: boolean }
  | { ok: false; reason: 'not-json' | 'invalid-flow'; errors: string[] };

// Envelope declaration for the import page's "ignored fields" notice — detected here so the envelope
// key list lives next to the validation logic instead of being re-derived by the UI.
export function importFlowText(text: string): ImportTextResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: 'not-json', errors: [t('err.notJson', { message: (error as Error).message })] };
  }
  const hadEnvelope =
    isPlainObject(parsed) &&
    ('id' in parsed || 'status' in parsed || 'provenance' in parsed);
  const validated = validateFlow(parsed, 'import');
  if (!validated.ok || !validated.draft) {
    return { ok: false, reason: 'invalid-flow', errors: validated.errors };
  }
  return { ok: true, draft: buildImportedFlow(validated.draft), hadEnvelope };
}

export type ImportContentResult =
  | { ok: true; draft: Flow; hadEnvelope: boolean }
  | { ok: false; reason: 'invalid-flow'; errors: string[] };

// Workspace pull/switch channel (data-sync): the server's flowContent is already a parsed JSON
// object. Validation and envelope-rewrite semantics are identical to importFlowText.
export function importFlowContent(content: unknown): ImportContentResult {
  const hadEnvelope =
    isPlainObject(content) && ('id' in content || 'status' in content || 'provenance' in content);
  const validated = validateFlow(content, 'import');
  if (!validated.ok || !validated.draft) {
    return { ok: false, reason: 'invalid-flow', errors: validated.errors };
  }
  return { ok: true, draft: buildImportedFlow(validated.draft), hadEnvelope };
}
