---
name: oncewise-message
description: Local flow-handoff channel programs for OnceWise Flow — install and verify the native-messaging host, or run client.mjs for ping, flow.read, flow.validate, flow.save, and flow.verify. Required companion of oncewise-setup and oncewise-flow; load this when either reports the channel missing.
---

# OnceWise Flow native-messaging programs

`skills/oncewise-message/` holds the host and CLI that hand flows between an AI agent and the OnceWise Flow Chrome extension: `install.mjs`, `uninstall.mjs`, `host.mjs`, `client.mjs`, `protocol.mjs`. Nothing here operates pages or enables, deletes, or rolls back flows; the extension stays the only validator and store.

- Install (user-level, once): `node install.mjs` — add `--browser chromium` or `--extension-id <id>` when the target differs. Requires Node 22+.
- Verify: `node client.mjs ping` must return one JSON result with `ok:true`.
- Handoff operations: `client.mjs flow.read --flow-id <id>`, `flow.validate --file <file>`, `flow.save --file <file>`, `flow.verify --ref <ref>`.

Install location, the fixed extension ID, troubleshooting, and uninstall live in [the oncewise-setup reference](../oncewise-setup/references/native-host-setup.md). `oncewise-setup` drives this directory during setup; `oncewise-flow` runs `client.mjs` for every handoff. Keep `oncewise-message` installed next to those skills so their `../oncewise-message/` paths resolve.
