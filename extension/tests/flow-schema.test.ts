import { describe, expect, it } from 'vitest';
import {
  buildImportedFlow,
  describePage,
  describeFlow,
  describeTrigger,
  isSubmitForbiddenText,
  isSubmitLikeText,
  parseOrigin,
  flowDraftHash,
  shortFlowId,
  validateFlow,
  type Flow,
} from '@/lib/flow-schema';
import { isSubmitClassActionSpec } from '@/lib/step-schema';

// Flows are data, not code: the version gate plus the envelope (name/site/page/trigger/budget/
// businessKey) validated here around the step tree (step-schema.test.ts covers the tree).
// There is exactly one flow format — anything else is refused with a version error, no migration.

// Minimal steps body for fixtures (DEC-019): read → conditional action → submit click
function stepsTree(): Record<string, unknown> {
  return {
    id: 'root',
    kind: 'sequence',
    steps: [
      {
        id: 'read-state',
        kind: 'read',
        read: { kind: 'boolean', target: { clues: { id: 'editState' }, componentType: 'checkbox', displayLabel: '编辑态' } },
        into: 'edited',
      },
      {
        id: 'branch',
        kind: 'if',
        when: { kind: 'boolean', ref: 'vars.edited', equals: false },
        then: [{ id: 'click-edit', kind: 'action', action: { type: 'clickButton', target: { clues: { id: 'editBtn' }, componentType: 'button', displayLabel: '编 辑' } } }],
      },
      { id: 'save', kind: 'action', action: { type: 'clickButton', target: { clues: { id: 'saveBtn' }, componentType: 'button', displayLabel: '保 存' } } },
    ],
  };
}

function fieldRef(overrides: Record<string, unknown> = {}) {
  return {
    clues: { id: 'form_item_tran_warehouse_id' },
    componentType: 'antdSelect',
    displayLabel: '发货仓库',
    ...overrides,
  };
}

function baseFlow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: 'r_test_1',
    name: '发货仓库→联系电话',
    site: 'https://saas.example.com',
    page: { urlIncludes: '#/shipment/send-to-amazon/' },
    trigger: { kind: 'fieldChange', field: fieldRef(), condition: { kind: 'anyChange' } },
    steps: stepsTree(),
    status: 'draft',
    provenance: {
      source: 'import',
      importedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    ...overrides,
  };
}

describe('version gate (one flow format, no migration)', () => {
  it('missing, unknown and future schemaVersions are refused with the expected number stated', () => {
    const missing = { ...baseFlow() };
    delete missing.schemaVersion;
    expect(validateFlow(missing, 'full').ok).toBe(false);
    expect(validateFlow(baseFlow({ schemaVersion: 3 }), 'full').ok).toBe(false);
    expect(validateFlow(baseFlow({ schemaVersion: 99 }), 'import').ok).toBe(false);
    const res = validateFlow(baseFlow({ schemaVersion: 3 }), 'import');
    expect(res.errors.join('\n')).toContain('must be 1');
  });

  it('the current schemaVersion validates in both modes', () => {
    expect(validateFlow(baseFlow(), 'full').ok).toBe(true);
    expect(validateFlow(baseFlow(), 'import').ok).toBe(true);
  });
});

describe('submit term families (DEC-010: allowed vs forbidden split)', () => {
  it('isSubmitLikeText matches the allowed family after whitespace normalization', () => {
    expect(isSubmitLikeText('保 存')).toBe(true);
    expect(isSubmitLikeText('确\n定')).toBe(true);
    expect(isSubmitLikeText('展开更多')).toBe(false);
    expect(isSubmitLikeText('重置筛选')).toBe(false);
    // forbidden terms are not submit-like for classification purposes
    expect(isSubmitLikeText('删除商品')).toBe(false);
  });

  it('isSubmitForbiddenText catches the forbidden family only', () => {
    expect(isSubmitForbiddenText('删除商品')).toBe(true);
    expect(isSubmitForbiddenText('保存')).toBe(false);
  });

  it('submit classification: explicit submitLike overrides the label both ways', () => {
    expect(isSubmitClassActionSpec({ submitLike: true, target: { displayLabel: '入库' } })).toBe(true);
    expect(isSubmitClassActionSpec({ submitLike: false, target: { displayLabel: '保存筛选' } })).toBe(false);
    expect(isSubmitClassActionSpec({ target: { displayLabel: '保存' } })).toBe(true);
  });
});

describe('envelope validation', () => {
  it('site must be an http(s) origin (hostname or path forms rejected)', () => {
    expect(validateFlow(baseFlow({ site: 'saas.example.com' })).ok).toBe(false);
    expect(validateFlow(baseFlow({ site: 'https://saas.example.com/path' })).ok).toBe(false);
    expect(validateFlow(baseFlow({ site: 'ftp://saas.example.com' })).ok).toBe(false);
    expect(parseOrigin('https://saas.example.com')).toBe('https://saas.example.com');
  });

  it('name is required', () => {
    expect(validateFlow(baseFlow({ name: '  ' })).ok).toBe(false);
  });

  it('page fingerprint: empty urlIncludes and empty contentIncludes arrays are rejected', () => {
    expect(validateFlow(baseFlow({ page: { urlIncludes: '' } })).ok).toBe(false);
    expect(validateFlow(baseFlow({ page: { urlIncludes: '/x', contentIncludes: [] } })).ok).toBe(false);
    expect(validateFlow(baseFlow({ page: {} })).ok).toBe(false);
  });

  it('trigger must be fieldChange{field,condition} or pageEnter', () => {
    expect(
      validateFlow(baseFlow({ trigger: { field: fieldRef(), condition: { kind: 'anyChange' } } })).ok,
    ).toBe(false);
    expect(validateFlow(baseFlow({ trigger: { kind: 'fieldChange', field: fieldRef() } })).ok).toBe(false);
    expect(validateFlow(baseFlow({ trigger: { kind: 'pageEnter' } })).ok).toBe(true);
    expect(validateFlow(baseFlow({ trigger: { kind: 'fieldChange', field: fieldRef(), condition: { kind: 'codeEquals', code: 'NZCK' } } })).ok).toBe(true);
  });

  it('budget may only lower the engine caps', () => {
    expect(validateFlow(baseFlow({ budget: { loopItems: 50, waitMs: 3000, runMs: 60000 } })).ok).toBe(true);
    const over = validateFlow(baseFlow({ budget: { runMs: 16 * 60 * 1000 } }));
    expect(over.ok).toBe(false);
    expect(over.errors.join('\n')).toContain('exceeds the engine cap');
    expect(validateFlow(baseFlow({ budget: { waitMs: 0 } })).ok).toBe(false);
    expect(validateFlow(baseFlow({ budget: 'fast' })).ok).toBe(false);
  });

  it('businessKey must be a scalar read', () => {
    const scalar = {
      kind: 'scalar',
      target: { clues: { id: 'orderNo' }, componentType: 'other', displayLabel: '单据编号' },
    };
    expect(
      validateFlow(baseFlow({ businessKey: { read: scalar } })).ok,
    ).toBe(true);
    const rows = {
      kind: 'rows',
      target: { clues: { id: 'rows' }, componentType: 'other', displayLabel: '行集合' },
      into: 'rows',
    };
    const res = validateFlow(baseFlow({ businessKey: { read: rows } }));
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('scalar');
    expect(validateFlow(baseFlow({ businessKey: 'orderNo' })).ok).toBe(false);
  });

  it('a missing or malformed steps body is rejected', () => {
    const noSteps = { ...baseFlow() };
    delete noSteps.steps;
    expect(validateFlow(noSteps, 'import').ok).toBe(false);
    expect(validateFlow(baseFlow({ steps: { id: 'root', kind: 'mystery' } })).ok).toBe(false);
  });

  it('full mode requires the envelope (id/status/provenance); import mode ignores it', () => {
    const core = baseFlow();
    delete core.id;
    delete core.status;
    delete core.provenance;
    expect(validateFlow(core, 'full').ok).toBe(false);
    const imported = validateFlow(core, 'import');
    expect(imported.ok, imported.errors.join('；')).toBe(true);
    expect(imported.draft).toBeDefined();
    expect(imported.draft!.name).toBe('发货仓库→联系电话');
  });

  it('non-object input is rejected outright (sp:saveFlow validation failure path)', () => {
    expect(validateFlow(null).ok).toBe(false);
    expect(validateFlow('flow').ok).toBe(false);
    expect(validateFlow(42).ok).toBe(false);
  });
});

describe('foreign data shapes are rejected outright (unreleased, no compatibility path)', () => {
  it('legacy-shaped fields fail even at the current schemaVersion', () => {
    const legacyShaped = {
      schemaVersion: 1,
      id: 'r_old',
      name: '旧流程',
      site: 'saas.eccang.com',
      pageClue: { hashIncludes: '#/x/' },
      trigger: { field: fieldRef(), condition: { kind: 'anyChange' } },
      actions: [{ kind: 'setInputValue', target: fieldRef(), value: { kind: 'constant', value: 'x' } }],
      status: 'enabled',
      provenance: { source: 'ai-draft', aiRetries: 2, createElapsedMs: 5000, createdAt: 1, updatedAt: 2 },
    };
    expect(validateFlow(legacyShaped, 'full').ok).toBe(false);
    expect(validateFlow(legacyShaped, 'import').ok).toBe(false);
  });
});

describe('readable rendering (summary source)', () => {
  it('the flow renders in business language', () => {
    const flow = baseFlow() as unknown as Flow;
    const text = describeFlow(flow);
    expect(text).toContain('When [发货仓库] changes');
    expect(text).toContain('保 存');
  });

  it('pageEnter flows render page-entry semantics; page fingerprint renders its content features', () => {
    const flow = baseFlow({ trigger: { kind: 'pageEnter' } }) as unknown as Flow;
    expect(describeTrigger(flow)).toBe('When entering this page');
    expect(describePage(flow)).toBe('URL contains "#/shipment/send-to-amazon/"');
    const withContent = baseFlow({
      page: { urlIncludes: '/form-page.html', contentIncludes: [fieldRef({ componentType: 'other', displayLabel: '成功横幅' })] },
    }) as unknown as Flow;
    expect(describePage(withContent)).toContain('1 page content feature');
  });
});

describe('flowDraftHash (stable-content hashing)', () => {
  it('envelope changes (updatedAt/status) do not affect the hash', () => {
    const a = baseFlow() as unknown as Flow;
    const b = baseFlow() as unknown as Flow;
    b.provenance.updatedAt += 5000;
    b.status = 'enabled';
    expect(flowDraftHash(a)).toBe(flowDraftHash(b));
  });

  it('stable content changes (step node label) change the hash', () => {
    const a = baseFlow() as unknown as Flow;
    const b = baseFlow() as unknown as Flow;
    b.steps = {
      ...stepsTree(),
      steps: [...(stepsTree().steps as unknown[]), { id: 'extra', kind: 'action', action: { type: 'clickButton', target: { clues: { id: 'x' }, componentType: 'button', displayLabel: '保 存' } } }],
    } as unknown as Flow['steps'];
    expect(flowDraftHash(a)).not.toBe(flowDraftHash(b));
  });
});

describe('buildImportedFlow (import always lands as draft, DEC-015)', () => {
  it('rewrites the envelope with source import and importedAt', () => {
    const validated = validateFlow(baseFlow(), 'import');
    expect(validated.ok, validated.errors.join('；')).toBe(true);
    const imported = buildImportedFlow(validated.draft!, 5_000);
    expect(imported.status).toBe('draft');
    expect(imported.provenance.source).toBe('import');
    expect(imported.provenance.importedAt).toBe(5_000);
    expect(imported.id).toMatch(/^r_/);
    expect(imported.schemaVersion).toBe(1);
  });
});

describe('shortFlowId (sidepanel display token)', () => {
  // The tail must be a faithful suffix of the full id: the user quotes this token in an AI prompt
  // and the agent suffix-matches it against the full granted id from ping — a hash or a reformatted
  // token would silently break that handshake.
  it('is the exact tail of a deriveFlowId id and at most 6 chars', () => {
    const id = buildImportedFlow(validateFlow(baseFlow(), 'import').draft!).id;
    const short = shortFlowId(id);
    expect(id.endsWith(short)).toBe(true);
    expect(short.length).toBeLessThanOrEqual(6);
  });

  it('is total on foreign ids (never longer than the input)', () => {
    expect(shortFlowId('abc')).toBe('abc');
    expect(shortFlowId('foreign-identifier-9')).toBe('fier-9');
  });
});

// Pre-run input declarations (form-support): the flow carries DEFINITIONS only — a definition that
// smuggles a value (or any unknown field) is rejected whole so personal data can never ride inside
// the shared flow object. Declared keys also scope `inputs.<key>` step references.
describe('input declarations', () => {
  const inputDefs = [
    { key: 'phone', label: '联系电话', type: 'text', required: true },
    { key: 'count', label: '数量', type: 'number', required: true },
    {
      key: 'warehouse', label: '发货仓库', type: 'single', required: false,
      options: [{ value: 'SZ', label: '深圳仓' }, { value: 'GZ', label: '广州仓' }],
    },
    { key: 'insured', label: '保价', type: 'checkbox', required: false },
    { key: 'shipDate', label: '发货日期', type: 'date', required: false },
    { key: 'pickupAt', label: '揽收时间', type: 'time', required: false },
    {
      key: 'channels', label: '报关渠道', type: 'multi', required: false,
      options: [{ value: 'A', label: '渠道A' }, { value: 'B', label: '渠道B' }],
    },
  ];

  it('accepts all seven declared types and carries them into both validation outputs', () => {
    const full = validateFlow(baseFlow({ inputs: inputDefs }), 'full');
    expect(full.ok, full.errors.join('；')).toBe(true);
    expect(full.flow?.inputs).toEqual(inputDefs);
    const imported = validateFlow(baseFlow({ inputs: inputDefs }), 'import');
    expect(imported.ok, imported.errors.join('；')).toBe(true);
    expect(imported.draft?.inputs).toEqual(inputDefs);
  });

  it('rejects unknown types, duplicate keys, wrong requiredness and malformed options', () => {
    const cases: unknown[] = [
      [{ key: 'a', label: 'A', type: 'email', required: true }],
      [
        { key: 'a', label: 'A', type: 'text', required: false },
        { key: 'a', label: 'B', type: 'text', required: false },
      ],
      [{ key: 'a', label: 'A', type: 'text' }],
      [{ key: 'a', label: 'A', type: 'single', required: false, options: [] }],
      [
        {
          key: 'a', label: 'A', type: 'multi', required: false,
          options: [{ value: 'X', label: 'X' }, { value: 'X', label: 'X2' }],
        },
      ],
      [{ key: 'a', label: 'A', type: 'text', required: false, options: [{ value: 'X', label: 'X' }] }],
      [{ key: '1bad', label: 'A', type: 'text', required: false }],
      [{ key: 'a', label: '  ', type: 'text', required: false }],
      'not-an-array',
    ];
    for (const inputs of cases) {
      const res = validateFlow(baseFlow({ inputs }), 'import');
      expect(res.ok, `expected rejection for ${JSON.stringify(inputs)}`).toBe(false);
    }
  });

  it('a definition carrying any foreign field (e.g. a filled value) is rejected whole', () => {
    const smuggled = [...inputDefs, { key: 'extra', label: 'E', type: 'text', required: false, value: '13800001234' }];
    const res = validateFlow(baseFlow({ inputs: smuggled }), 'import');
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('unknown field "value"');
  });

  it('declared keys scope inputs.<key> references; undeclared keys fail the whole flow', () => {
    const stepsUsingInputs = {
      id: 'root',
      kind: 'sequence',
      steps: [
        {
          id: 'fill',
          kind: 'action',
          action: {
            type: 'setInputValue',
            target: fieldRef({ componentType: 'input', displayLabel: '联系电话' }),
            value: { ref: 'inputs.phone' },
          },
        },
      ],
    };
    const ok = validateFlow(baseFlow({ inputs: inputDefs, steps: stepsUsingInputs }), 'import');
    expect(ok.ok, ok.errors.join('；')).toBe(true);
    const bad = validateFlow(baseFlow({ inputs: inputDefs, steps: {
      ...stepsUsingInputs,
      steps: [{ ...stepsUsingInputs.steps[0], action: { ...(stepsUsingInputs.steps[0] as { action: Record<string, unknown> }).action, value: { ref: 'inputs.mystery' } } }],
    } }), 'import');
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('\n')).toContain('inputs.mystery');
  });

  it('flows without inputs keep validating unchanged and inputs.<key> stays unknown to them', () => {
    const legacy = validateFlow(baseFlow(), 'import');
    expect(legacy.ok, legacy.errors.join('；')).toBe(true);
    expect(legacy.draft?.inputs).toBeUndefined();
    const strayRef = validateFlow(baseFlow({
      steps: {
        id: 'root', kind: 'sequence',
        steps: [{ id: 'fill', kind: 'action', action: { type: 'setInputValue', target: fieldRef(), value: { ref: 'inputs.phone' } } }],
      },
    }), 'import');
    expect(strayRef.ok).toBe(false);
  });

  it('flowDraftHash covers the input declarations (a definition change is a content change)', () => {
    const a = baseFlow() as unknown as Flow;
    const b = baseFlow({ inputs: inputDefs }) as unknown as Flow;
    expect(flowDraftHash(a)).not.toBe(flowDraftHash(b));
    const c = baseFlow({ inputs: JSON.parse(JSON.stringify(inputDefs)) }) as unknown as Flow;
    (c.inputs![0] as { required: boolean }).required = false;
    expect(flowDraftHash(b)).not.toBe(flowDraftHash(c));
  });
});
// Cross-page declared pages envelope (DEC-cross-page-flow-001, schemaVersion stays 1).
import { describePages, flowContentFields } from '@/lib/flow-schema';

const declaredPages = [
  { id: 'confirm', page: { urlIncludes: '/order/confirm' } },
  { id: 'result', page: { urlIncludes: '/order/result' } },
];

function multiPageFlow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseFlow({
    pages: declaredPages,
    steps: {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'save', kind: 'action', action: { type: 'clickButton', target: { clues: { id: 'saveBtn' }, componentType: 'button', displayLabel: '保 存' } } },
        { id: 'nav1', kind: 'navigate', to: 'confirm', timeoutMs: 8000 },
        { id: 'nav2', kind: 'navigate', to: 'result', timeoutMs: 5000 },
      ],
    },
    ...overrides,
  });
}

describe('declared pages envelope (multi-page flows)', () => {
  it('a valid multi-page envelope passes import validation and the draft carries pages', () => {
    const res = validateFlow(multiPageFlow(), 'import');
    expect(res.errors.join('；')).toBe('');
    expect(res.ok).toBe(true);
    expect(res.draft?.pages).toEqual(declaredPages);
  });

  it('single-page flows stay exactly as legal as before (absent pages, absent navigate)', () => {
    const res = validateFlow(baseFlow(), 'import');
    expect(res.ok).toBe(true);
    expect(res.draft?.pages).toBeUndefined();
  });

  it('schemaVersion stays 1 — the multi-page vocabulary is an optional increment, not a version bump', () => {
    expect(validateFlow(multiPageFlow({ schemaVersion: 2 }), 'import').errors[0]).toContain('schemaVersion');
  });

  it('a navigate targeting an undeclared page is rejected (no silent single-page run)', () => {
    const res = validateFlow(
      multiPageFlow({ pages: [{ id: 'confirm', page: { urlIncludes: '/order/confirm' } }] }),
      'import',
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('navigate.to "result" is not a declared pages[].id');
  });

  it('a navigate without any pages declaration is rejected', () => {
    const flow = multiPageFlow();
    delete (flow as Record<string, unknown>)['pages'];
    const res = validateFlow(flow, 'import');
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('is not a declared pages[].id');
  });

  it('a declared page referenced by no navigate is a dead declaration and rejected', () => {
    const res = validateFlow(
      multiPageFlow({
        pages: [...declaredPages, { id: 'orphan', page: { urlIncludes: '/order/orphan' } }],
      }),
      'import',
    );
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('declared page "orphan" is not referenced by any navigate step');
  });

  it('pages shape rules: non-array, empty array, duplicate ids, non-identifier ids, bad fingerprints', () => {
    expect(validateFlow(multiPageFlow({ pages: 'confirm' }), 'import').ok).toBe(false);
    expect(validateFlow(multiPageFlow({ pages: [] }), 'import').ok).toBe(false);
    const dup = validateFlow(
      multiPageFlow({ pages: [{ id: 'confirm', page: { urlIncludes: '/a' } }, { id: 'confirm', page: { urlIncludes: '/b' } }] }),
      'import',
    );
    expect(dup.errors.join('\n')).toContain('"confirm" is declared more than once');
    const badId = validateFlow(
      multiPageFlow({ pages: [{ id: '2nd', page: { urlIncludes: '/a' } }, { id: 'result', page: { urlIncludes: '/b' } }] }),
      'import',
    );
    expect(badId.errors.join('\n')).toContain('pages[0].id: must be an identifier');
    const badPrint = validateFlow(
      multiPageFlow({ pages: [{ id: 'confirm', page: { urlIncludes: '' } }, { id: 'result', page: { urlIncludes: '/b' } }] }),
      'import',
    );
    expect(badPrint.errors.join('\n')).toContain('pages[0]');
  });
});

describe('flowContentFields / flowDraftHash with pages', () => {
  it('pages join the stable content projection — a pages change changes the draft hash', () => {
    const a = multiPageFlow() as unknown as Flow;
    const b = multiPageFlow({ pages: [{ id: 'confirm', page: { urlIncludes: '/order/confirm-v2' } }, declaredPages[1]!] }) as unknown as Flow;
    expect(flowDraftHash(a)).not.toBe(flowDraftHash(b));
  });

  it('flows without pages keep the legacy projection — the pages key is absent, hashes unchanged', () => {
    const flow = baseFlow() as unknown as Flow;
    expect(Object.prototype.hasOwnProperty.call(flowContentFields(flow), 'pages')).toBe(false);
  });
});

describe('describePages (multi-page summary, one rendering for every consumer)', () => {
  it('single-page flows render exactly the entry fingerprint', () => {
    const flow = baseFlow() as unknown as Flow;
    expect(describePages(flow)).toBe('URL contains "#/shipment/send-to-amazon/"');
  });

  it('multi-page flows render the entry plus the declared list', () => {
    const flow = multiPageFlow() as unknown as Flow;
    const text = describePages(flow);
    expect(text).toContain('URL contains "#/shipment/send-to-amazon/"');
    expect(text).toContain('2');
    expect(text).toContain('confirm');
    expect(text).toContain('/order/confirm');
    expect(text).toContain('result');
  });
});
