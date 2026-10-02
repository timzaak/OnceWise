// Enforcement anchor: every case in the flow corpus (tests/fixtures/oncewise-flow/cases.json) must agree
// with the normative implementation (validateFlow('import') over the step schema); coverage
// gaps in the corpus turn this red. The format document is maintained alongside the corpus
// and validator; prose changes are not checked by this test.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildImportedFlow,
  validateFlow,
  isSubmitForbiddenText,
  isSubmitLikeText,
  SCHEMA_VERSION,
  SUBMIT_ALLOWED_TERMS,
  SUBMIT_FORBIDDEN_TERMS,
} from '@/lib/flow-schema';
import {
  MAX_STEP_DEPTH,
  MAX_STEP_NODES,
  STEP_BUDGET_CAPS,
  STEP_NODE_KINDS,
} from '@/lib/step-schema';
import { importFlowText } from '@/lib/import-pipeline';

interface CorpusCase {
  name: string;
  expect: 'valid' | 'invalid';
  expectErrorIncludes?: string;
  flow: unknown;
}

const corpusPath = fileURLToPath(
  new URL('./fixtures/oncewise-flow/cases.json', import.meta.url),
);
const corpus = JSON.parse(readFileSync(corpusPath, 'utf-8')) as { cases: CorpusCase[] };

describe('corpus agreement with validateFlow("import")', () => {
  it('corpus loads and is non-empty', () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(50);
  });

  for (const testCase of corpus.cases) {
    it(`case ${testCase.name} → ${testCase.expect}`, () => {
      const res = validateFlow(testCase.flow, 'import');
      if (testCase.expect === 'valid') {
        expect(res.errors.join('；')).toBe('');
        expect(res.ok).toBe(true);
        expect(res.draft).toBeDefined();
        // Drafts never carry envelope fields: an enabled state cannot ride in through a file
        const draft = res.draft as Record<string, unknown>;
        expect(draft.id).toBeUndefined();
        expect(draft.status).toBeUndefined();
        expect(draft.provenance).toBeUndefined();
      } else {
        expect(res.ok).toBe(false);
        expect(res.errors.length).toBeGreaterThan(0);
        if (testCase.expectErrorIncludes) {
          expect(res.errors.join('\n')).toContain(testCase.expectErrorIncludes);
        }
      }
    });
  }
});

describe('corpus coverage (missing coverage turns red)', () => {
  const names = corpus.cases.map((c) => c.name);

  it('covers every step node kind', () => {
    for (const kind of STEP_NODE_KINDS) {
      expect(names.some((n) => n.includes(kind)), `missing node kind coverage: ${kind}`).toBe(true);
    }
  });

  it('covers every read kind and action type', () => {
    for (const key of ['scalar', 'boolean', 'collection', 'rows']) {
      expect(names.some((n) => n.includes(`read-${key}`) || (key === 'rows' && n.includes('readMatches-rows'))), `missing read coverage: ${key}`).toBe(true);
    }
    for (const type of ['setInputValue', 'selectOption', 'setCheckbox', 'clickButton']) {
      expect(names.some((n) => n.includes(type)), `missing action type coverage: ${type}`).toBe(true);
    }
  });

  it('covers every predicate kind', () => {
    for (const key of ['exists', 'equals', 'numberCompare', 'nonEmpty', 'every', 'some', 'and-or-not']) {
      expect(names.some((n) => n.includes(`predicate-${key}`) || (key === 'every' && n.includes('assert-every'))), `missing predicate coverage: ${key}`).toBe(true);
    }
    // The boolean predicate rides along the read-boolean case (its assert compares the boolean state)
    expect(names.some((n) => n.includes('boolean'))).toBe(true);
  });

  it('covers both trigger kinds', () => {
    expect(names.some((n) => n.includes('pageEnter'))).toBe(true);
    expect(names.some((n) => n.includes('fieldChange'))).toBe(true);
  });

  it('covers page fingerprint forms', () => {
    expect(names.some((n) => n.includes('url-includes'))).toBe(true);
    expect(names.some((n) => n.includes('content-includes'))).toBe(true);
    expect(names.some((n) => n.includes('empty-url-includes'))).toBe(true);
  });

  it('covers submit semantics', () => {
    expect(names.some((n) => n.includes('submitLike'))).toBe(true);
    expect(names.some((n) => n.includes('forbidden'))).toBe(true);
    expect(names.some((n) => n.includes('allowed-labeled'))).toBe(true);
  });

  // Cross-page pages/navigate corpus coverage — the corpus mirrors the flow-format doc and the
  // validators, the same sources it must stay in sync with
  it('covers cross-page vocabulary: navigate, pages declarations and the bidirectional reference check', () => {
    expect(names.some((n) => n.includes('navigate'))).toBe(true);
    expect(names.some((n) => n.includes('pages'))).toBe(true);
    // both directions of the to↔pages cross-check
    expect(names.some((n) => n.includes('to-undeclared'))).toBe(true);
    expect(names.some((n) => n.includes('dead-declared'))).toBe(true);
    // the page-readiness deadline is bounded by the wait budget
    expect(names.some((n) => n.includes('timeout-over-budget'))).toBe(true);
    // data carries across the jump
    expect(names.some((n) => n.includes('slot-carryover'))).toBe(true);
    // pages shape rules
    expect(names.some((n) => n.includes('duplicate-id'))).toBe(true);
    expect(names.some((n) => n.includes('fingerprint'))).toBe(true);
  });

  it('covers loop scoping, business identity and budgets', () => {
    expect(names.some((n) => n.includes('within'))).toBe(true);
    expect(names.some((n) => n.includes('businessKey'))).toBe(true);
    expect(names.some((n) => n.includes('budget'))).toBe(true);
    expect(names.some((n) => n.includes('maxiterations'))).toBe(true);
  });

  it('covers structural limits and envelope handling', () => {
    expect(names.some((n) => n.includes('duplicate-id'))).toBe(true);
    expect(names.some((n) => n.includes('envelope'))).toBe(true);
    expect(names.some((n) => n.includes('schema-version'))).toBe(true);
    expect(names.some((n) => n.includes('branch-only'))).toBe(true);
  });

  it('validator constants stay non-trivial (anchor against accidental emptying)', () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(STEP_BUDGET_CAPS).toEqual({ loopItems: 100, waitMs: 60_000, runMs: 900_000 });
    expect(MAX_STEP_NODES).toBe(200);
    expect(MAX_STEP_DEPTH).toBe(8);
    // English-first term families with Chinese terms kept for flows authored on Chinese sites
    expect([...SUBMIT_ALLOWED_TERMS]).toEqual(['save', 'submit', 'confirm', '保存', '提交', '确认', '确定']);
    expect([...SUBMIT_FORBIDDEN_TERMS]).toEqual([
      'delete', 'remove', 'pay', 'payment', 'purchase', 'checkout', 'publish',
      '删除', '移除', '支付', '下单', '发布',
    ]);
  });

  it('submit classification is case-insensitive for English terms and unchanged for Chinese', () => {
    expect(isSubmitLikeText('Save')).toBe(true);
    expect(isSubmitLikeText('保存草稿')).toBe(true);
    expect(isSubmitLikeText('Reset form')).toBe(false);
    expect(isSubmitForbiddenText('Delete User')).toBe(true);
    expect(isSubmitForbiddenText('删除用户')).toBe(true);
    expect(isSubmitForbiddenText('Save and keep')).toBe(false);
  });
});

describe('envelope rewrite (import never carries an enabled state)', () => {
  it('the envelope case imports clean: envelope fields are dropped, status lands as draft', () => {
    const envelopeCase = corpus.cases.find((c) => c.name.startsWith('envelope'));
    expect(envelopeCase).toBeDefined();
    const flow = buildImportedFlow(
      validateFlow(envelopeCase!.flow, 'import').draft!,
      1234,
    );
    expect(flow.status).toBe('draft');
    expect(flow.id).not.toBe('cloud-id');
    expect(flow.provenance.source).toBe('import');
    expect(flow.provenance.importedAt).toBe(1234);
  });
});

describe('known-answer example (warehouse-phone.example.json)', () => {
  const phone = {
    clues: { id: 'contactPhone', labelText: '联系电话' },
    componentType: 'input',
    displayLabel: '联系电话',
  };

  it('imports the documented plain JSON flow', () => {
    const examplePath = fileURLToPath(
      new URL('./fixtures/oncewise-flow/warehouse-phone.example.json', import.meta.url),
    );
    const text = readFileSync(examplePath, 'utf-8');
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      schemaVersion: 1,
      name: '发货仓库切换自动填联系电话',
      site: 'http://localhost:8123',
      page: { urlIncludes: '/form-page.html' },
      trigger: {
        kind: 'fieldChange',
        field: {
          clues: { id: 'warehouse', labelText: '发货仓库' },
          componentType: 'antdSelect',
          displayLabel: '发货仓库',
        },
        condition: { kind: 'anyChange' },
      },
      steps: {
        id: 'root',
        kind: 'sequence',
        steps: [
          {
            id: 'fill-SZ',
            kind: 'if',
            when: { kind: 'equals', ref: 'trigger.value', value: 'SZ' },
            then: [{ id: 'set-SZ', kind: 'action', action: { type: 'setInputValue', target: phone, value: '13800001234' } }],
          },
          {
            id: 'fill-DG',
            kind: 'if',
            when: { kind: 'equals', ref: 'trigger.value', value: 'DG' },
            then: [{ id: 'set-DG', kind: 'action', action: { type: 'setInputValue', target: phone, value: '13900005678' } }],
          },
          {
            id: 'fill-GH',
            kind: 'if',
            when: { kind: 'equals', ref: 'trigger.value', value: 'GH' },
            then: [{ id: 'set-GH', kind: 'action', action: { type: 'setInputValue', target: phone, value: '13700009876' } }],
          },
        ],
      },
    });
    // The known answer also clears the import gate as a draft
    const imported = importFlowText(text);
    expect(imported.ok).toBe(true);
    expect(imported.ok ? imported.draft?.steps : null).toEqual(parsed.steps);
  });
});
