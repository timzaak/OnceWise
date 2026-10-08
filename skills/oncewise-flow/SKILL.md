---
name: oncewise-flow
description: Create or revise OnceWise Flow JSON automation flows, including pre-run input forms and sequential pages on the same site. Use Chrome DevTools MCP for target pages and the Native Messaging client for validation, saving, and verification. Obtain explicit confirmation of the validated flow before saving; the user enables it in the extension. If either channel is unavailable, use oncewise-setup first.
---

# Create OnceWise Flow flows

Produce a pure JSON flow. The extension validates, stores, and executes it; flows cannot contain executable code.

This skill and its [flow format](references/flow-format.md) describe how to author the JSON; reading the extension source is not a prerequisite. A working delivery still requires the installed extension, Chrome DevTools MCP, and the sibling `oncewise-message` client. Without those channels, an offline JSON draft is not a verified or delivered flow.

At the start, tell the user the division of work: you inspect and test the target page, write and validate the flow, request explicit approval of the validated content before saving, and verify the saved state. The user clicks `用 AI 优化` (Improve with AI) in the side panel when revising a flow, opens the import page if needed (Settings → Open import page), and personally enables a saved flow from its confirmation card or side-panel switch. The side panel is not a tab accessible through MCP. Do not operate extension controls or bypass them through storage or guessed URLs.

## Required channels

- **Target pages:** use only tools provided by `chrome-devtools-mcp` for page discovery, DOM inspection, and interaction. Check tool provenance; similarly named tools, terminal HTTP requests, and other browser-control tools do not qualify. A read-only `evaluate_script` may inspect the current DOM but must not make network requests or change the page.
- **Flow handoff (required companion `oncewise-message`):** use only its client `skills/oncewise-message/client.mjs` for `ping`, `flow.read`, `flow.validate`, `flow.save`, and `flow.verify`. If the skill was installed without the `oncewise-message` directory next to it, repair the installation through `oncewise-setup` before any handoff. The client prints one JSON result to stdout and echoes a save's clientRef to stderr. The channel cannot operate pages or enable, delete, or roll back flows.

```bash
node <repository>/skills/oncewise-message/client.mjs ping
node <repository>/skills/oncewise-message/client.mjs flow.read --flow-id <id>
node <repository>/skills/oncewise-message/client.mjs flow.validate --file flow.json
node <repository>/skills/oncewise-message/client.mjs flow.save --file flow.json
node <repository>/skills/oncewise-message/client.mjs flow.verify --ref <ref>
```

Before creating or revising a flow, confirm the MCP provider, read the target page with `list_pages` and `take_snapshot`, and run `client.mjs ping`. If a check fails, report the blocker and direct the user to run `oncewise-setup`. Stop flow creation and import until both channels work. For `--autoConnect` to the user's regular Chrome, the user must approve each browser connection.

## Create or revise

1. Find every target page with MCP `list_pages` and inspect it with `take_snapshot`. When needed, use read-only DOM inspection to collect real id, name, label, placeholder, and aria-label clues. Never invent selectors.
2. Verify locators, values, and reversible actions on test data or records the user authorized, using the same MCP's `fill`/`click` and a snapshot after each action. Before a save, submit, confirm, or other business-state change, ensure the actual target and consequence are authorized. If execution is unsafe, stop before that action and identify the unverified steps.
3. Write one schemaVersion 1 JSON flow following [the flow format](references/flow-format.md). Use a narrow, stable page fingerprint; only documented step nodes, actions, and typed predicates; `foreach` with `within` for grouped forms; bounded waits; and a reliable `businessKey` for submit-like actions. Do not include delete, remove, payment, purchase, or publish actions. Set budgets for the observed page.
   For values the user should fill before execution, declare `inputs` (key, label, type, required, and options where needed) and consume them through references such as `{ "ref": "inputs.phone" }`. Keep user-entered values out of the shared JSON. Guard optional references before consuming them in actions or loops. The extension renders the form from these declarations; saving its values affects the next triggered run and does not start a run.
4. For a business that spans several pages of the same site (wizard-style form → confirm → result), write one cross-page flow instead of several disconnected ones: declare each continuation page in `pages` (fingerprints taken from that page's real DOM, same rules as the entry page), and put a `navigate` node immediately after the click that causes the jump. Verify each page's step segment on its own page with MCP within the authorization in step 2; report any unverified segment. The input snapshot, vars, and loop progress carry across the jump automatically. The extension rechecks the declared `businessKey` on arrival when its field is present; add `read` + `assert` checks for page-specific business invariants. The extension never navigates by itself — if the click does not leave the page, the flow fails at the `navigate` deadline and does not retry. Only sequential full-page jumps within one origin are supported, including a next page opened in a new tab; this does not provide cross-site, parallel-tab, or interrupted-run recovery.
5. Run `flow.validate --file <file>`. Fix every error and revalidate. Show the user the validated JSON file or its contents, the extension's summary, what you tested, and any submit-like action that will run automatically after enablement. **Wait for explicit approval of this exact content before saving.** A request to create or improve a flow, the Improve with AI click, or approval to enable does not approve saving. After any revision, revalidate, show it again, and obtain fresh approval.
6. After approval, run `flow.save --file <file>`. An `ok:true` response means the flow is saved but disabled. Run `flow.verify --ref <ref from stderr>` and report the read-back state. If inputs are declared, tell the user to fill and save them in the flow details. The user personally enables the flow, then enters the matching entry page or changes the configured page field to trigger it; saving input values is not an immediate-run command. Do not click extension controls.

For a revision, first ask the user to open the flow in the side panel and click `用 AI 优化` (Improve with AI). The extension pauses it and grants 15 minutes to read it. Use `flow.read --flow-id <id>` to get the full flow and `updatedAt`; do not infer it from a summary. Change only the requested parts, recheck affected page operations, and describe the replacement and differences before approval. Save with `--flow-id <id> --expected-updated-at <updatedAt>`. On `read-not-authorized`, ask the user to click again. On `revision-stale`, `flow-enabled`, or `flow-not-found`, stop and ask the user to restart the revision in the side panel. A successful replacement is disabled. If the revision is abandoned, leave the paused flow for the user to resume or manage.

## Failure and reporting flows

- `extension-not-connected` means the request did not reach the host; repair the channel through `oncewise-setup`. `result-unknown` means it may have been sent: check `flow.verify` and extension state before acting, never assume success or failure or blindly retry. A fresh save after a rejected or uncertain result requires a new user confirmation and clientRef.
- Do not claim a flow was saved until the extension's read-back confirms it. Report which page actions were tested and which were skipped. If no live run was performed, say that execution remains unverified.
- Open a flow's target page for a demo only when the user requested one and the data or record is authorized; a `pageEnter` flow may execute immediately. The user handles enablement, history, rollback, and deletion in the extension.
- Do not create flows for platforms the extension's usage instructions exclude, including Taobao and Amazon.
- When the user asks for a capability the flow format or the extension does not support (for example cross-site orchestration, parallel tabs, or an excluded action such as payment or deletion), state the limit plainly, offer the nearest achievable alternative, and direct the user to request it at https://github.com/timzaak/OnceWise/issues. Tell the user not to paste flow JSON, input values, or business data into the request.

Use [the flow format](references/flow-format.md) for the schema and the `oncewise-message` client at `../oncewise-message/` for handoff. Host installation and troubleshooting are in the `oncewise-setup` reference `../oncewise-setup/references/native-host-setup.md`.
