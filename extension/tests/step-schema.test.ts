// Steps vocabulary validation (DEC-019). These tests pin WHY validation exists: a flow that
// reaches the compiler must be statically safe — unknown nodes, dangling references, branch-only
// slots, wrong collection types and out-of-budget values must be refused BEFORE any execution, so
// the runtime never guesses mid-run (PRD §4.3: 非法引用、未知节点、越界预算在执行前被拒绝).
import { describe, expect, it } from 'vitest';
import {
  countStepNodes,
  describeSteps,
  resolveStepBudget,
  validateSteps,
  stepsHaveSubmitAction,
  type FieldRef,
  type InputDefinition,
  type StepNode,
} from '@/lib/step-schema';

const field = (id: string, label = id): FieldRef => ({ clues: { id }, componentType: 'input', displayLabel: label });
const button = (id: string, label: string): FieldRef => ({ clues: { id }, componentType: 'button', displayLabel: label });

const readGroups: StepNode = {
  id: 'read-groups',
  kind: 'read',
  read: { kind: 'collection', target: button('tabs', '包装组') },
  into: 'groups',
};

const readRows: StepNode = {
  id: 'read-rows',
  kind: 'read',
  read: { kind: 'rows', table: field('packingTable', '装箱表'), columns: ['weight', 'length', 'width', 'height'] },
  into: 'rows',
};

function validPacking(): StepNode {
  return {
    id: 'root',
    kind: 'sequence',
    steps: [
      readGroups,
      readRows,
      {
        id: 'assert-rows',
        kind: 'assert',
        check: {
          kind: 'and',
          parts: [
            { kind: 'nonEmpty', ref: 'vars.rows' },
            {
              kind: 'every',
              ref: 'vars.rows',
              item: {
                kind: 'and',
                parts: [
                  { kind: 'numberCompare', ref: 'item.weight', op: '>', value: 0 },
                  { kind: 'numberCompare', ref: 'item.length', op: '>', value: 0 },
                ],
              },
            },
          ],
        },
      },
      { id: 'save', kind: 'action', action: { type: 'clickButton', target: button('saveBtn', '保 存') } },
    ],
  };
}

describe('validateSteps: valid trees', () => {
  it('accepts the packing-shaped sequence (read → assert → action)', () => {
    const res = validateSteps(validPacking());
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('accepts trigger.value references and wait readMatches over its own slot', () => {
    const tree: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'w', kind: 'wait', timeoutMs: 5000, until: { kind: 'readMatches', read: { kind: 'scalar', target: field('phone') }, into: 'phone', when: { kind: 'nonEmpty', ref: 'vars.phone' } } },
        { id: 'fill', kind: 'action', action: { type: 'setInputValue', target: field('other'), value: { ref: 'trigger.value' } } },
      ],
    };
    expect(validateSteps(tree).ok).toBe(true);
  });

  it('accepts within-scoped targets inside the loop that binds the item variable (当前组作用域)', () => {
    const tree: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        {
          id: 'loop',
          kind: 'foreach',
          over: 'vars.groups',
          itemVar: 'group',
          do: [
            { id: 'tab', kind: 'action', action: { type: 'clickButton', target: { ...button('tabBtn', '包装组页签'), within: 'group' } } },
            { id: 'rows', kind: 'read', read: { kind: 'rows', table: { ...field('table'), within: 'group' }, columns: ['weight'] }, into: 'rows' },
            { id: 'w', kind: 'wait', timeoutMs: 1000, until: { kind: 'elementPresent', target: { ...field('banner'), within: 'group' } } },
            { id: 'b', kind: 'read', read: { kind: 'boolean', target: { ...field('active'), within: 'group' } }, into: 'active' },
          ],
        },
      ],
    };
    expect(validateSteps(tree).errors).toEqual([]);
  });

  it('rejects within-scoped targets naming anything but an in-scope loop item variable', () => {
    const outside: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'a', kind: 'action', action: { type: 'clickButton', target: { ...button('tabBtn', '包装组页签'), within: 'group' } } },
      ],
    };
    expect(validateSteps(outside).errors.join('\n')).toContain('within: "group" is not a loop item variable in scope');

    const wrongName: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        {
          id: 'loop',
          kind: 'foreach',
          over: 'vars.groups',
          itemVar: 'group',
          do: [
            { id: 'a', kind: 'action', action: { type: 'clickButton', target: { ...button('tabBtn', '包装组页签'), within: 'row' } } },
          ],
        },
      ],
    };
    expect(validateSteps(wrongName).errors.join('\n')).toContain('within: "row" is not a loop item variable in scope');
  });
});

describe('validateSteps: refusal semantics (before any execution)', () => {
  it('rejects unknown node kinds', () => {
    const res = validateSteps({ id: 'x', kind: 'goto', target: 'y' });
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('unknown node kind');
  });

  it('rejects duplicate node ids anywhere in the tree', () => {
    const tree = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        { id: 'read-groups', kind: 'read', read: { kind: 'scalar', target: field('a') }, into: 'a' },
      ],
    };
    const res = validateSteps(tree);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('duplicate node id');
  });

  it('rejects "__completed" as a node id — the cross-page resume sentinel must stay unambiguous', () => {
    // resumePathAfter returns raw node ids as the resume path and uses '__completed' for
    // end-of-tree; a node with that id after a navigate would be read as the sentinel and silently
    // skip every remaining step
    const tree = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        { id: '__completed', kind: 'read', read: { kind: 'scalar', target: field('a') }, into: 'a' },
      ],
    };
    const res = validateSteps(tree);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('"__completed" is reserved');
  });

  it('rejects references to slots that are never assigned', () => {
    const tree: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'a', kind: 'assert', check: { kind: 'nonEmpty', ref: 'vars.neverRead' } },
      ],
    };
    const res = validateSteps(tree);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('not assigned on every path');
  });

  it('rejects reads of a slot that only one branch assigns (definite-assignment analysis)', () => {
    const tree: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        {
          id: 'branch',
          kind: 'if',
          when: { kind: 'nonEmpty', ref: 'vars.groups' },
          then: [{ id: 'r-only-then', kind: 'read', read: { kind: 'scalar', target: field('x') }, into: 'onlyThen' }],
          else: [{ id: 'r-else-noop', kind: 'assert', check: { kind: 'nonEmpty', ref: 'vars.groups' } }],
        },
        // onlyThen is definite on neither path after the if — reading it here must be refused
        { id: 'use-only-then', kind: 'assert', check: { kind: 'exists', ref: 'vars.onlyThen' } },
      ],
    };
    const res = validateSteps(tree);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('onlyThen');
  });

  it('rejects reads of loop-body slots after the loop (the body may run zero times)', () => {
    const tree: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        {
          id: 'loop',
          kind: 'foreach',
          over: 'vars.groups',
          itemVar: 'group',
          do: [{ id: 'body-read', kind: 'read', read: { kind: 'scalar', target: field('y') }, into: 'bodySlot' }],
        },
        { id: 'after', kind: 'assert', check: { kind: 'exists', ref: 'vars.bodySlot' } },
      ],
    };
    const res = validateSteps(tree);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('bodySlot');
  });

  it('rejects foreach over a non-collection slot', () => {
    const tree: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'r', kind: 'read', read: { kind: 'scalar', target: field('a') }, into: 'scalarSlot' },
        { id: 'loop', kind: 'foreach', over: 'vars.scalarSlot', itemVar: 'x', do: [{ id: 'noop', kind: 'assert', check: { kind: 'exists', ref: 'x' } }] },
      ],
    };
    const res = validateSteps(tree);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('requires a collection or rows slot');
  });

  it('rejects a wait without a deadline and one beyond the budget', () => {
    const noDeadline = validateSteps({ id: 'w', kind: 'wait', until: { kind: 'elementPresent', target: button('b', '按钮') } });
    expect(noDeadline.ok).toBe(false);
    expect(noDeadline.errors.join('\n')).toContain('deadline is required');

    const tooLong = validateSteps({ id: 'w', kind: 'wait', timeoutMs: 61_000, until: { kind: 'elementPresent', target: button('b', '按钮') } });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.errors.join('\n')).toContain('exceeds the wait budget');

    // A lowered flow budget tightens the allowed deadline further (flows can only shrink budgets)
    const lowered = validateSteps(
      { id: 'w', kind: 'wait', timeoutMs: 5_000, until: { kind: 'elementPresent', target: button('b', '按钮') } },
      { loopItems: 100, waitMs: 3_000, runMs: 900_000 },
    );
    expect(lowered.ok).toBe(false);
    expect(lowered.errors.join('\n')).toContain('exceeds the wait budget');
  });

  it('rejects foreach maxIterations beyond the loop budget', () => {
    const tree: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        { id: 'loop', kind: 'foreach', over: 'vars.groups', itemVar: 'g', maxIterations: 101, do: [{ id: 'noop', kind: 'assert', check: { kind: 'exists', ref: 'g' } }] },
      ],
    };
    const res = validateSteps(tree);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('exceeds the loop budget');
  });

  it('rejects shadowed loop item variables', () => {
    const tree: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        {
          id: 'outer',
          kind: 'foreach',
          over: 'vars.groups',
          itemVar: 'g',
          do: [
            {
              id: 'inner',
              kind: 'foreach',
              over: 'vars.groups',
              itemVar: 'g',
              do: [{ id: 'noop', kind: 'assert', check: { kind: 'exists', ref: 'g' } }],
            },
          ],
        },
      ],
    };
    const res = validateSteps(tree);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('shadows');
  });

  it('rejects nesting deeper than the structural budget', () => {
    let node: StepNode = { id: 'leaf', kind: 'assert', check: { kind: 'exists', ref: 'vars.groups' } };
    for (let i = 0; i < 12; i++) {
      node = { id: `seq-${i}`, kind: 'sequence', steps: [readGroups, node] };
    }
    const res = validateSteps(node);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('nesting deeper than');
  });

  it('rejects unknown predicate kinds and malformed predicates', () => {
    const res = validateSteps({
      id: 'a',
      kind: 'assert',
      check: { kind: 'regexMatch', ref: 'vars.groups', pattern: 'x' },
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('unknown predicate kind');
  });

  it('rejects unknown action types and forbidden irreversible buttons', () => {
    const badType = validateSteps({ id: 'a', kind: 'action', action: { type: 'runScript', target: field('x') } });
    expect(badType.ok).toBe(false);
    expect(badType.errors.join('\n')).toContain('unknown action type');

    const forbidden = validateSteps({
      id: 'a',
      kind: 'action',
      action: { type: 'clickButton', target: button('del', '删除记录') },
    });
    expect(forbidden.ok).toBe(false);
    expect(forbidden.errors.join('\n')).toContain('forbidden irreversible-action terms');
  });
});

describe('validateSteps: reference type guards (values feed real form fields)', () => {
  it('rejects a whole rows/collection/boolean slot as an action value; scalar and row fields pass', () => {
    const valueOver = (ref: string): StepNode => ({
      id: 'root',
      kind: 'sequence',
      steps: [
        readRows,
        { id: 'fill', kind: 'action', action: { type: 'setInputValue', target: field('out'), value: { ref } } },
      ],
    });
    // rows.<field> is a string — fine
    expect(validateSteps(valueOver('vars.rows.weight')).ok).toBe(true);
    // the whole rows array would be written as "[object Object]" and pass the driver read-back check
    expect(validateSteps(valueOver('vars.rows')).ok).toBe(false);
    expect(validateSteps(valueOver('vars.rows')).errors.join('\n')).toContain('value position requires a string');
  });

  it('rejects a boolean slot as an action value ("true" is not the data the page asked for)', () => {
    const tree: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'rb', kind: 'read', read: { kind: 'boolean', target: field('editState') }, into: 'edited' },
        { id: 'fill', kind: 'action', action: { type: 'setInputValue', target: field('out'), value: { ref: 'vars.edited' } } },
      ],
    };
    const res = validateSteps(tree);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('value position requires a string');
  });

  it('rejects a whole loop item as an action value (a member field is required)', () => {
    const tree: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        {
          id: 'loop',
          kind: 'foreach',
          over: 'vars.groups',
          itemVar: 'g',
          do: [{ id: 'fill', kind: 'action', action: { type: 'setInputValue', target: field('out'), value: { ref: 'g' } } }],
        },
      ],
    };
    const res = validateSteps(tree);
    expect(res.ok).toBe(false);
    expect(res.errors.join('\n')).toContain('whole loop item');
  });

  it('rejects every/some over scalar/boolean slots and member fields; collection/rows slots pass', () => {
    const everyOver = (ref: string): StepNode => ({
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        { id: 'chk', kind: 'assert', check: { kind: 'every', ref, item: { kind: 'nonEmpty', ref: 'item' } } },
      ],
    });
    expect(validateSteps(everyOver('vars.groups')).ok).toBe(true);
    // a scalar slot reaching every would pass vacuously at runtime — the inversion of the
    // empty-collection flow — so it never validates
    const scalarTree: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'rs', kind: 'read', read: { kind: 'scalar', target: field('phone') }, into: 'phone' },
        { id: 'chk', kind: 'assert', check: { kind: 'every', ref: 'vars.phone', item: { kind: 'nonEmpty', ref: 'item' } } },
      ],
    };
    expect(validateSteps(scalarTree).ok).toBe(false);
    expect(validateSteps(scalarTree).errors.join('\n')).toContain('every/some need a collection or rows slot');
  });
});

describe('derived helpers', () => {
  it('stepsHaveSubmitAction finds submit-class clicks nested in branches and loops', () => {
    const tree: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        {
          id: 'loop',
          kind: 'foreach',
          over: 'vars.groups',
          itemVar: 'g',
          do: [
            {
              id: 'branch',
              kind: 'if',
              when: { kind: 'nonEmpty', ref: 'vars.groups' },
              then: [{ id: 'save', kind: 'action', action: { type: 'clickButton', target: button('saveBtn', '保 存') } }],
            },
          ],
        },
      ],
    };
    expect(stepsHaveSubmitAction(tree)).toBe(true);
    expect(stepsHaveSubmitAction(validPacking())).toBe(true);

    const noSubmit: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [readGroups, { id: 'fill', kind: 'action', action: { type: 'setInputValue', target: field('phone'), value: '138' } }],
    };
    expect(stepsHaveSubmitAction(noSubmit)).toBe(false);
  });

  it('describeSteps renders indented branches/loops and flags submit-class actions', () => {
    const steps = describeSteps(validPacking());
    const texts = steps.map((s) => s.text);
    expect(texts[0]).toContain('read collection');
    expect(texts[1]).toContain('read rows');
    expect(texts[2]).toContain('assert');
    expect(texts[3]).toContain('clickButton 保 存');
    expect(steps[3]!.submit).toBe(true);
    expect(steps[0]!.submit).toBe(false);

    const looped = describeSteps({
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        {
          id: 'loop',
          kind: 'foreach',
          over: 'vars.groups',
          itemVar: 'g',
          do: [{ id: 'fill', kind: 'action', action: { type: 'setInputValue', target: field('phone'), value: '138' } }],
        },
      ],
    });
    const loopLine = looped.find((s) => s.text.includes('foreach'))!;
    expect(loopLine.text).toContain('foreach vars.groups as g');
    const bodyLine = looped.find((s) => s.text.includes('setInputValue'))!;
    expect(bodyLine.text.startsWith('  ')).toBe(true);
  });

  it('countStepNodes counts every node in branches and loops', () => {
    expect(countStepNodes(validPacking())).toBe(5);
  });
});

// `inputs.<key>` static scoping (form-support): every reference position is type-checked against the
// DECLARED input so a flow can never reach the driver with a value of the wrong shape (a multi in
// a text field, a scalar in a checkbox slot). These rejections happen at import — before any
// execution — keeping the conservative-stop principle for old and new flows alike.
describe('inputs.<key> reference scoping and type flows', () => {
  const defs = (types: Partial<Record<string, string>>): InputDefinition[] =>
    Object.entries(types).map(([key, type]) => ({
      key,
      label: key,
      type: type as InputDefinition['type'],
      required: false,
      ...(type === 'single' || type === 'multi' ? { options: [{ value: 'V1', label: 'V1' }, { value: 'V2', label: 'V2' }] } : {}),
    }));

  const check = (tree: StepNode, inputs: InputDefinition[]): string[] =>
    validateSteps(tree, undefined, inputs).errors;

  const setValue = (ref: string): StepNode => ({
    id: 'root', kind: 'sequence',
    steps: [{ id: 'a', kind: 'action', action: { type: 'setInputValue', target: field('out'), value: { ref } } }],
  });

  it('string inputs (text/number/single/date/time) are valid value-position references', () => {
    const inputs = defs({ phone: 'text', count: 'number', warehouse: 'single', shipDate: 'date', pickupAt: 'time' });
    for (const key of ['phone', 'count', 'warehouse', 'shipDate', 'pickupAt']) {
      expect(check(setValue(`inputs.${key}`), inputs)).toEqual([]);
    }
  });

  it('array and boolean inputs in a string value position are rejected', () => {
    const inputs = defs({ channels: 'multi', insured: 'checkbox' });
    expect(check(setValue('inputs.channels'), inputs).join('\n')).toContain('value position requires a string input');
    expect(check(setValue('inputs.insured'), inputs).join('\n')).toContain('value position requires a string input');
  });

  it('setCheckbox.checked accepts a checkbox input ref or a literal boolean — nothing else', () => {
    const inputs = defs({ insured: 'checkbox', phone: 'text' });
    const checkboxAction = (checked: unknown): StepNode => ({
      id: 'root', kind: 'sequence',
      steps: [{ id: 'a', kind: 'action', action: { type: 'setCheckbox', target: field('box'), checked: checked as never } }],
    });
    expect(check(checkboxAction({ ref: 'inputs.insured' }), inputs)).toEqual([]);
    expect(check(checkboxAction(true), inputs)).toEqual([]);
    expect(check(checkboxAction({ ref: 'inputs.phone' }), inputs).join('\n')).toContain('setCheckbox needs a checkbox input');
    // Slot refs are not a checked source: only run-start input values are
    expect(check(checkboxAction({ ref: 'vars.flag' }), inputs).join('\n')).toContain('must be inputs.<key>');
  });

  it('numberCompare only accepts number inputs; boolean predicates only checkbox inputs', () => {
    const inputs = defs({ count: 'number', phone: 'text', insured: 'checkbox' });
    const numberTree: StepNode = {
      id: 'root', kind: 'sequence',
      steps: [{ id: 'a', kind: 'assert', check: { kind: 'numberCompare', ref: 'inputs.count', op: '>', value: 0 } }],
    };
    expect(check(numberTree, inputs)).toEqual([]);
    const textNumberTree: StepNode = {
      id: 'root', kind: 'sequence',
      steps: [{ id: 'a', kind: 'assert', check: { kind: 'numberCompare', ref: 'inputs.phone', op: '>', value: 0 } }],
    };
    expect(check(textNumberTree, inputs).join('\n')).toContain('numberCompare needs a number input');
    const boolTree: StepNode = {
      id: 'root', kind: 'sequence',
      steps: [{ id: 'a', kind: 'assert', check: { kind: 'boolean', ref: 'inputs.insured', equals: true } }],
    };
    expect(check(boolTree, inputs)).toEqual([]);
    const textBoolTree: StepNode = {
      id: 'root', kind: 'sequence',
      steps: [{ id: 'a', kind: 'assert', check: { kind: 'boolean', ref: 'inputs.phone', equals: true } }],
    };
    expect(check(textBoolTree, inputs).join('\n')).toContain('boolean predicates need a checkbox input');
  });

  it('every/some and foreach.over accept only multi inputs; the loop item is a string member', () => {
    const inputs = defs({ channels: 'multi', phone: 'text' });
    const someTree: StepNode = {
      id: 'root', kind: 'sequence',
      steps: [{ id: 'a', kind: 'assert', check: { kind: 'some', ref: 'inputs.channels', item: { kind: 'equals', ref: 'item', value: 'V1' } } }],
    };
    expect(check(someTree, inputs)).toEqual([]);
    const someTextTree: StepNode = {
      id: 'root', kind: 'sequence',
      steps: [{ id: 'a', kind: 'assert', check: { kind: 'some', ref: 'inputs.phone', item: { kind: 'nonEmpty', ref: 'item' } } }],
    };
    expect(check(someTextTree, inputs).join('\n')).toContain('every/some need a multi input');
    const loopTree: StepNode = {
      id: 'root', kind: 'sequence',
      steps: [{
        id: 'loop', kind: 'foreach', over: 'inputs.channels', itemVar: 'channel',
        do: [{ id: 'fill', kind: 'action', action: { type: 'setInputValue', target: field('out'), value: { ref: 'channel' } } }],
      }],
    };
    expect(check(loopTree, inputs)).toEqual([]);
    const loopTextTree: StepNode = {
      id: 'root', kind: 'sequence',
      steps: [{
        id: 'loop', kind: 'foreach', over: 'inputs.phone', itemVar: 'channel',
        do: [{ id: 'fill', kind: 'action', action: { type: 'setInputValue', target: field('out'), value: 'x' } }],
      }],
    };
    expect(check(loopTextTree, inputs).join('\n')).toContain('foreach over an input requires a multi input');
  });

  it('malformed references are rejected: bare inputs, three segments, undeclared keys', () => {
    const inputs = defs({ phone: 'text' });
    for (const ref of ['inputs', 'inputs.phone.length', 'inputs.mystery']) {
      const errors = check(setValue(ref), inputs);
      expect(errors.length, `expected rejection for ${ref}`).toBeGreaterThan(0);
    }
    expect(check(setValue('inputs.mystery'), inputs).join('\n')).toContain('does not declare');
    // no declarations at all → every inputs ref is unknown (old flows never validate new references)
    expect(check(setValue('inputs.phone'), []).join('\n')).toContain('does not declare');
  });

  it('an itemVar named "inputs" is reserved to keep the reference domain unambiguous', () => {
    const inputs = defs({ channels: 'multi' });
    const tree: StepNode = {
      id: 'root', kind: 'sequence',
      steps: [{
        id: 'loop', kind: 'foreach', over: 'inputs.channels', itemVar: 'inputs',
        do: [{ id: 'fill', kind: 'action', action: { type: 'setInputValue', target: field('out'), value: 'x' } }],
      }],
    };
    expect(check(tree, inputs).join('\n')).toContain('reserved');
  });

  it('exists/nonEmpty accept every input type (the optional-consumption guard pattern)', () => {
    const inputs = defs({ phone: 'text', insured: 'checkbox', channels: 'multi' });
    for (const key of ['phone', 'insured', 'channels']) {
      const tree: StepNode = {
        id: 'root', kind: 'sequence',
        steps: [{ id: 'a', kind: 'assert', check: { kind: 'exists', ref: `inputs.${key}` } }],
      };
      expect(check(tree, inputs)).toEqual([]);
    }
  });
});

// Cross-page navigate node vocabulary (DEC-cross-page-flow-001).
describe('navigate node validation', () => {
  const navAfter = (...extra: StepNode[]): StepNode => ({
    id: 'root',
    kind: 'sequence',
    steps: [
      readGroups,
      { id: 'save', kind: 'action', action: { type: 'clickButton', target: button('saveBtn', '保 存') } },
      { id: 'nav1', kind: 'navigate', to: 'confirm', timeoutMs: 8000 },
      ...extra,
    ],
  });

  it('a navigate after the triggering click is valid, inside if and foreach too', () => {
    expect(validateSteps(navAfter()).errors).toEqual([]);
    const inIf: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        {
          id: 'branch',
          kind: 'if',
          when: { kind: 'nonEmpty', ref: 'vars.groups' },
          then: [{ id: 'nav1', kind: 'navigate', to: 'confirm', timeoutMs: 1000 }],
        },
      ],
    };
    expect(validateSteps(inIf).errors).toEqual([]);
    const inLoop: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        {
          id: 'loop',
          kind: 'foreach',
          over: 'vars.groups',
          itemVar: 'g',
          do: [{ id: 'nav1', kind: 'navigate', to: 'confirm', timeoutMs: 1000 }],
        },
      ],
    };
    expect(validateSteps(inLoop).errors).toEqual([]);
  });

  it('slots and loop bindings pass through the jump — data read before stays usable after', () => {
    const steps: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        { id: 'read-note', kind: 'read', read: { kind: 'scalar', target: field('note') }, into: 'note' },
        { id: 'save', kind: 'action', action: { type: 'clickButton', target: button('saveBtn', '保 存') } },
        { id: 'nav1', kind: 'navigate', to: 'confirm', timeoutMs: 8000 },
        { id: 'use-slot', kind: 'action', action: { type: 'setInputValue', target: field('out'), value: { ref: 'vars.note' } } },
      ],
    };
    expect(validateSteps(steps).errors).toEqual([]);
    const scoped = navAfter({ id: 'use-item', kind: 'read', read: { kind: 'scalar', target: { ...field('x'), within: 'g' } }, into: 'x' });
    // `within: g` is NOT in scope here (no enclosing loop around the navigate) — the walk still
    // rejects it exactly as without the navigate in between
    expect(validateSteps(scoped).ok).toBe(false);
    const scopedOk: StepNode = {
      id: 'root',
      kind: 'sequence',
      steps: [
        readGroups,
        {
          id: 'loop',
          kind: 'foreach',
          over: 'vars.groups',
          itemVar: 'g',
          do: [
            { id: 'nav1', kind: 'navigate', to: 'confirm', timeoutMs: 1000 },
            { id: 'use-item', kind: 'action', action: { type: 'setCheckbox', checked: { ref: 'inputs.insured' }, target: { ...field('x'), within: 'g' } } },
          ],
        },
      ],
    };
    expect(
      validateSteps(scopedOk, undefined, [{ key: 'insured', label: 'Insured', type: 'checkbox', required: false }]).errors,
    ).toEqual([]);
  });

  it('to must be a non-empty string', () => {
    const bad1 = { id: 'root', kind: 'sequence', steps: [{ id: 'nav1', kind: 'navigate', to: '', timeoutMs: 1000 }] };
    expect(validateSteps(bad1 as unknown as StepNode).errors.join('\n')).toContain('steps[nav1].to: must be a non-empty');
    const bad2 = { id: 'root', kind: 'sequence', steps: [{ id: 'nav1', kind: 'navigate', timeoutMs: 1000 }] };
    expect(validateSteps(bad2 as unknown as StepNode).ok).toBe(false);
  });

  it('timeoutMs is a positive deadline bounded by the wait budget', () => {
    const mk = (timeoutMs: number): StepNode =>
      ({ id: 'root', kind: 'sequence', steps: [{ id: 'nav1', kind: 'navigate', to: 'confirm', timeoutMs }] }) as StepNode;
    expect(validateSteps(mk(0)).ok).toBe(false);
    expect(validateSteps(mk(-5)).ok).toBe(false);
    expect(validateSteps(mk(60_001)).errors.join('\n')).toContain('exceeds the wait budget');
    // The flow may only lower the engine cap — a navigate may not out-wait its own budget
    expect(validateSteps(mk(5000), resolveStepBudget({ waitMs: 3000 })).errors.join('\n')).toContain('exceeds the wait budget 3000');
    expect(validateSteps(mk(3000), resolveStepBudget({ waitMs: 5000 })).errors).toEqual([]);
  });

  it('navigate renders one summary line naming the declared page and deadline', () => {
    const lines = describeSteps(navAfter());
    const navLine = lines.find((l) => l.text.includes('navigate'));
    expect(navLine?.text).toContain('navigate to page confirm');
    expect(navLine?.text).toContain('8000ms');
  });

  it('navigate is a leaf for the shared container walks (counting and submit scanning unchanged)', () => {
    expect(countStepNodes(navAfter())).toBe(4);
    expect(stepsHaveSubmitAction(navAfter())).toBe(true);
  });
});
