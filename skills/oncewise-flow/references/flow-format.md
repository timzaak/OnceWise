# Flow format (schemaVersion 1)

The authoritative validators are `extension/lib/flow-schema.ts` (`validateFlow(input, 'import')`) and `extension/lib/step-schema.ts`. Flows are pure JSON data; the extension validates and executes only its closed step vocabulary. It never executes code, expressions, or scripts carried by a flow. Any schema version other than numeric `1` is rejected.

## Top-level object

Required fields are `schemaVersion`, `name`, `site`, `page`, `trigger`, and `steps`. Optional fields are `inputs`, `budget`, `businessKey`, and `pages`.

| Field | Requirement |
| --- | --- |
| `schemaVersion` | Numeric `1` only. |
| `name` | Nonempty string after trimming. |
| `site` | Parseable HTTP(S) origin, including an optional port, with no path (for example `https://www.example.com`). |
| `page` | Page fingerprint below. The entry page — the only trigger binding surface. |
| `pages` | Optional declared continuation pages for a cross-page flow (see "Cross-page flows"). |
| `trigger` | One of the triggers below. |
| `steps` | Nonempty step tree. |
| `inputs` | Optional pre-run input definitions. |
| `budget` | Optional limits that can only lower the engine caps. |
| `businessKey` | Scalar read of a stable business-instance identifier. Required for a submit-like flow to auto-start. |

Internal envelope fields such as `id`, `status`, and `provenance` are ignored and rewritten on import. Imported flows are disabled.

## Page and trigger

`page.urlIncludes` is a nonempty substring of the page URL's path and hash, excluding its query. Choose a narrow, stable path fragment. Optional `page.contentIncludes` is a **nonempty** FieldRef array; every reference must match exactly one visible element or the flow does not match. Omit it when the URL is sufficient.

```json
{ "kind": "fieldChange", "field": { "...": "FieldRef" }, "condition": { "kind": "anyChange" } }
{ "kind": "fieldChange", "field": { "...": "FieldRef" }, "condition": { "kind": "codeEquals", "code": "SZ" } }
{ "kind": "pageEnter" }
```

`fieldChange` starts on a field change. `codeEquals` compares the selected code: text inside `[xxx]` in an Ant Design option, or the whole option text when brackets are absent. The current field value is `trigger.value`. `pageEnter` starts when the entry fingerprint becomes matched (including content that appears after loading), or when its declared business key changes while matched. Each flow starts at most once per document and business instance; submit-like flows also have the browser-session claim described below.

## Pre-run inputs

Users fill and save declared inputs in the extension's flow details. Definitions travel with the flow; values remain on each user's device and are excluded from flow sync and logs. Reference them as `inputs.<key>`, for example `"value": { "ref": "inputs.phone" }` in a `setInputValue` action; a bare `"inputs.phone"` would be literal text. Saving inputs does not start execution: the enabled flow still needs its `pageEnter` or `fieldChange` trigger. If a page-enter attempt was skipped for missing inputs, save the inputs and re-enter or reload the entry page to trigger again.

```json
"inputs": [
  { "key": "phone", "label": "Contact phone", "type": "text", "required": true },
  { "key": "warehouse", "label": "Shipping warehouse", "type": "single", "required": false,
    "options": [{ "value": "SZ", "label": "Shenzhen" }] },
  { "key": "insured", "label": "Insured", "type": "checkbox", "required": false }
]
```

- Each input has a unique identifier `key`, nonempty `label`, `required` boolean, and one `type`: `text`, `number`, `single`, `checkbox`, `date`, `time`, or `multi`. Definitions contain no user values, defaults, or UI state; unknown definition fields are rejected.
- `single` and `multi` require a nonempty `options` array with unique, nonempty `value` strings and nonempty `label` strings; labels need not be unique. Other types must not have `options`.
- Text, number, single, date, and time values are strings; numbers are finite decimal values, dates use `YYYY-MM-DD`, and times use `HH:mm`. Checkbox values are booleans (`false` is filled). Multi values are arrays of distinct option values. Empty values are unfilled.
- A missing required value, an invalid stored value, a stored value whose definition changed, or an unreadable input store skips automatic execution before any page action. Invalid or stale stored values block startup even for optional items; the user must save them again under the current definitions. A missing optional value does not block startup. Input references must name declared keys and match their declared types; otherwise validation rejects the flow.
- Only `inputs.<key>` is valid, not `inputs` or deeper paths. String-like inputs work with `exists`/`nonEmpty`/`equals` and as `setInputValue`/`selectOption` values; only `number` works with `numberCompare`. Checkbox works with `boolean`/`equals` and `setCheckbox.checked`. Multi works with `exists`/`nonEmpty`/`every`/`some` and bounded `foreach.over`.
- An unfilled optional input makes its direct comparison, presence, or collection predicate false; compound predicates still follow `and`/`or`/`not` logic. Using it directly in `foreach.over` or an action requiring a value fails with `input-missing` before that node's page actions; earlier actions are not undone. Guard optional uses with `exists` or `nonEmpty`. Each run uses an input snapshot taken at start, carried across declared page jumps; saving new values during a run affects only subsequent runs.

## Step nodes

Every node has an ID unique in the tree, 1–64 characters from letters, digits, underscore, and hyphen; `__completed` is reserved and rejected. Identifiers used for input keys, declared page IDs, read slots, loop variables, and row columns must match `[A-Za-z_][A-Za-z0-9_]*` (no hyphens).

| `kind` | Fields | Behavior |
| --- | --- | --- |
| `sequence` | Nonempty `steps` array | Run in order; stop on failure. |
| `read` | `read`: ReadSpec; `into`: slot | Store page data in `vars.<into>`. |
| `action` | `action`: ActionSpec | Perform an allowed action. |
| `if` | `when`: predicate; `then` and optional `else`: node arrays | Choose a branch; continue when false with no else. |
| `foreach` | `over`: collection ref; `itemVar`; `do`: node array; optional `maxIterations` | Iterate sequentially within the loop budget. |
| `wait` | Positive `timeoutMs` ≤ `budget.waitMs`; `until`: WaitCondition | Read-only polling with a deadline. |
| `assert` | `check`: predicate | Fail if the invariant is false. |
| `navigate` | `to`: declared page id; positive `timeoutMs` ≤ `budget.waitMs` | Declare the expected jump to a continuation page; see "Cross-page flows". |

The tree may contain at most 200 nodes and 8 levels of nesting. A loop processes at most 100 items; one wait lasts at most 60 seconds; a run lasts at most 15 minutes and executes at most 2,000 nodes.

### ReadSpec

| `kind` | Fields | Result |
| --- | --- | --- |
| `scalar` | `target`: FieldRef | Control value, selected-option text, or element text. |
| `boolean` | `target`: FieldRef | Checked/selected state; a missing element reads as `false`. |
| `collection` | `target`: FieldRef matching each member | Frozen member IDs, relocated by ID during iteration. |
| `rows` | `table`: FieldRef; `columns`: identifiers | Row objects keyed by column; each row must have the expected number of readable controls. |

### ActionSpec

| `type` | Required fields | Behavior |
| --- | --- | --- |
| `setInputValue` | `target`, `value` | Set text and verify the write. |
| `selectOption` | `target`, `value` | Select an Ant Design or native option and verify the write. |
| `setCheckbox` | `target`, `checked` | Set checked state and verify the write. |
| `clickButton` | `target` | Click a button. |

`value` is a constant string or a structured reference such as `{ "ref": "vars.code" }`. `setCheckbox.checked` is a boolean or a checkbox-input reference. No other action types are accepted.

### WaitCondition

| `kind` | Fields | Completion |
| --- | --- | --- |
| `elementPresent` | `target` | One visible match appears; initial absence keeps waiting, ambiguity fails. |
| `elementAbsent` | `target` | Target disappears. |
| `readMatches` | `read`: ReadSpec; `into`: slot; `when`: predicate | Read until nonempty, stable across consecutive samples, and predicate true; then store the final value in `vars.<into>`. |

### Predicates

| `kind` | Fields | Meaning |
| --- | --- | --- |
| `exists` | `ref` | Reference has a value. |
| `boolean` | `ref`, boolean `equals` | Boolean comparison. |
| `equals` | `ref`, `value` | String, number, or boolean equality; numbers compare numerically. |
| `numberCompare` | `ref`, `op` (`>`, `>=`, `<`, `<=`), finite `value` | False for missing, empty, or nonnumeric values. |
| `nonEmpty` | `ref` | Nonempty string or array. |
| `every` / `some` | `ref`, `item` predicate | Test collection items using `item` or `item.<field>`; `every` is false for an empty collection. |
| `and` / `or` | Nonempty `parts` array | Combine predicates. |
| `not` | `of` predicate | Negate. |

## Cross-page flows

A flow may run across the pages of one wizard-like business (form → confirm → result) instead of a single document. Declare each continuation page in `pages` and mark the jump with a `navigate` node:

```json
"pages": [
  { "id": "confirm", "page": { "urlIncludes": "/order/confirm" } },
  { "id": "result", "page": { "urlIncludes": "/order/result" } }
]
```

- `pages` is an optional declaration list; each `id` is a unique identifier and each `page` is a fingerprint with the same rules as the entry `page`. When `pages` is present it must be nonempty. The executed step tree and its `navigate.to` references determine the page sequence, not the order of this list.
- Every declared page **must** be referenced by at least one `navigate.to`, and every `navigate.to` must reference a declared `pages[].id`. Both directions are validated; dead declarations reject the whole flow.
- All pages must belong to the flow's single `site` (origin). Cross-site chains are not part of the format.
- A `navigate` node goes right after the whitelisted click that causes the jump (a submit button or a pagination link, including one that opens the next page in a new tab). The extension has **no active navigation primitive**: it never assigns `location` — the jump is caused only by that click, and `navigate` merely declares "the run will leave this page for the declared page `to` and continues there". If the full-page navigation never happens (the site intercepts the submit, validation keeps the page), the `navigate` deadline expires and the run fails like a wait timeout — the click is never replayed.
- `timeoutMs` (≤ `budget.waitMs`, so at most 60 s) bounds the wait for the declared page to arrive.
- Data carries across: the run-start input snapshot, every slot, loop binding, and loop progress readable before the jump is readable on the declared page — the continuation is the same run. Execution counts and the original run deadline accumulate across pages. Take each page's step segment from that page's real DOM; FieldRefs are only as good as the page they run on. Cross-site chains and simultaneous or alternating tab orchestration are unsupported. Same-document view changes use ordinary actions and waits rather than `navigate`.
- Business identity across pages: the run resumes on the declared page only after re-checking `businessKey` when it is declared and was read before the jump — an equal value passes, a **different** value cancels (the page belongs to another business instance), an unreadable/ambiguous value cancels, and a missing field on the continuation page skips the recheck (express in-flow identity there with your own `read` + `assert`). Express in-page identity continuation yourself with `read` + `assert` on the shared order number.
- Unloading or refreshing a page stops its local run. Closing the source tab cancels its pending handover; restarting the browser or pausing/deleting/replacing the flow also prevents continuation. Completed actions are never rolled back, and there is no automatic recovery from an interrupted run. An already pending declared jump has the arrival exception below.
- Boundary statement for authors: continuation is decided declaratively (declared page fingerprint + tab relationship + deadline + single claim). A manual navigation or refresh onto the declared page while a jump is pending can satisfy the same conditions and continue the run; the extension does not distinguish the navigation's cause. The preceding click has already executed, any submit-like business instance remains claimed, and a declared business key is rechecked when its field is available.

## Data references and FieldRef

References are JSON strings, never executable expressions: `trigger.value`, `inputs.<key>`, `vars.<slot>` (including dotted fields), and a loop's `<itemVar>`/`<itemVar>.<field>`. `itemVar` cannot be `inputs`. In an action value, use `{ "ref": "vars.code" }`; a bare string is a constant. A slot assigned only in one branch cannot be used after that branch unless every branch assigns it. A slot assigned inside a loop cannot be used after the loop. Validation rejects unassigned paths.

All targets, `trigger.field`, `page.contentIncludes[]`, and collection-member locators use FieldRef:

```json
{
  "clues": { "id": "contactPhone", "labelText": "Contact phone" },
  "componentType": "input",
  "displayLabel": "Contact phone",
  "within": "group"
}
```

- `clues` may include `id`, `name`, `labelText`, `placeholder`, `ariaLabel`, and `cssPath`. The resolver tries from strongest to weakest: id, name, label with component type, placeholder, aria label, then CSS path. The first clue with exactly one visible match in scope wins; a missing or ambiguous clue can fall through to the next. Resolution fails when no clue produces a unique visible match. Collect clues from the real DOM.
- Collection clues should match every member. Member IDs use `data-key`, then `id`, `name`, `aria-label`, then normalized text; IDs must be unique.
- `componentType` is `input`, `antdSelect`, `checkbox`, `button`, or `other`. `displayLabel` is a nonempty human-readable name.
- Optional `within` scopes a locator to the current loop item and its Ant Design tab panel. It can reference only an in-scope `itemVar`. Use it for each group's controls in grouped forms.

## Submit actions and business instances

Allowed submit-like labels contain `save`, `submit`, `confirm`, `保存`, `提交`, `确认`, or `确定` (case-insensitive). A `clickButton` may use `"submitLike": true` to mark one explicitly, or `false` to correct a false positive. Such actions run automatically after the user enables the flow.

Labels containing `delete`, `remove`, `pay`, `payment`, `purchase`, `checkout`, `publish`, `删除`, `移除`, `支付`, `下单`, or `发布` are always rejected.

A submit-like flow needs `businessKey.read` as a scalar read of a stable identifier such as an order number; without it, automatic startup is blocked. The extension claims `site + flowId + businessKey` across tabs, allowing at most one execution per business instance per browser session, including failed runs. Do not use random values or page-template fingerprints. When the record could change during the flow, read its ID at the start, read it again before final confirmation, and assert equality. Failure stops later actions but does not undo completed submissions or replay timed-out clicks.

## Budget and validation

`budget` may lower, never raise, the engine caps: `loopItems` ≤ 100, `waitMs` ≤ 60000, `runMs` ≤ 900000. `foreach.maxIterations` must not exceed `loopItems`; `wait.timeoutMs` and `navigate.timeoutMs` must not exceed `waitMs`. Set tight limits for the observed page.

The extension parses JSON and validates the entire flow before saving. Any error rejects the whole flow; fix the reported path and validate again. After validation, show the summary and exact content to the user and obtain explicit approval before `flow.save`. Saved flows are disabled until the user enables them in the extension. The user also handles rollback from locally retained version history.
