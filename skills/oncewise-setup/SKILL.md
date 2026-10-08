---
name: oncewise-setup
description: Connect the current agent to the user's regular Chrome through Chrome DevTools MCP, install the OnceWise Flow Native Messaging host, and verify both channels. Use on first setup or when either channel fails.
---

# Set up the OnceWise Flow browser and local channel

Complete setup only when the current agent reads the user's tab and the extension page through Chrome DevTools MCP, and `client.mjs ping` returns `ok:true`. Use `oncewise-flow` to create flows.

**Required companion — `oncewise-message`:** the local-channel programs in `skills/oncewise-message/`. This skill and `oncewise-flow` both need them. If the installer placed the skills elsewhere and `oncewise-message` is not next to them, copy or link `skills/oncewise-message/` into that installation before continuing.

## 1. Make MCP available to the current agent

1. Identify the current agent host and version. Check its MCP registrations and available tools. Tool names alone, another client's list, and `npm list` are not evidence.
2. If Chrome DevTools MCP is unavailable, install it using the current host's official documentation or built-in help and the [MCP setup reference](references/mcp-setup.md). If needed, search for official instructions using the host name and version. Perform steps the agent can do; give the user only steps the agent cannot perform. Ask for the product/version if still unclear. Report unsupported hosts without guessing paths or switching browser tools.
3. Reload as required. Ask the user to enable remote debugging and approve the connection in their regular Chrome. The current agent must call **this MCP's** `list_pages` and `take_snapshot` on the specified ordinary tab. Continue only when the calls succeed and the page matches.

## 2. Verify the extension

1. Use `list_extensions` over the same MCP connection when available. Check OnceWise Flow is enabled and its ID is `fkkfdckchahnjkcbimnbhonbgcefnafi`. If the ID differs, reinstall the fixed-key build; flows under another ID are not available here.
2. If absent, use MCP `install_extension` with this project's unpacked build when available; otherwise ask the user to load it following `README.md`. Verify again through MCP.
3. Find `chrome-extension://<id>/import.html` with this MCP's `list_pages` and inspect it with `take_snapshot`. If absent, open it through MCP using the verified ID, or ask the user to open it from the side panel (Settings → Open import page). Verify the flow list and channel status. Do not fill in or save flows on this page.

## 3. Install and verify the Native Messaging host (flow handoff channel)

Follow the [Native Messaging host reference](references/native-host-setup.md):

1. Check Node.js 22+ and the `oncewise-message` programs at `skills/oncewise-message/`.
2. From that directory, run `node install.mjs` during setup. Add `--browser chromium` for Chromium. The default binds the Chrome Web Store build (ID `dmmhmcdbkbbgbcidafhlhepdchjboenc`); for this repository's fixed-key unpacked build pass `--extension-id fkkfdckchahnjkcbimnbhonbgcefnafi` (the ID verified in step 2). Fix and rerun if the JSON result says `installed:false`. `client.mjs` stays in the skill directory; it needs no separate installation.
3. Ask the user to start or restart that Chrome, then run `node client.mjs ping`. Require one JSON result with `ok:true` and `schemaVersion`; troubleshoot failures using the reference. Installation alone does not prove connectivity.

## Report the result

Report the agent host, MCP tool source, browser/tab and extension-page evidence, extension ID, Native Messaging installation directory, and `ping` result. If either channel fails, state which one and how to repair it. If extension tools and its page are both unavailable, say its installation status is unverified. Test connectivity only with `ping`; do not inspect or write flows.
