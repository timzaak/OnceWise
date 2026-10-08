# OnceWise Flow

English | [简体中文](README.zh.md)

An intelligent form-automation assistant Chrome extension (WXT + React; English-first UI with built-in Chinese i18n; local-first storage) and the oncewise-ai-sync data-sync backend (Rust, account-free space model).

## Repository layout

- `extension/` — Chrome MV3 extension (clicking the toolbar icon opens the flow workbench sidepanel; flow import — flows carry their own site domain, and content scripts are injected dynamically per the flow's site; pre-run input forms and same-site sequential cross-page continuation; dry-run; the "Sync" tab shares flows via space codes)
- `backend/` — oncewise-ai-sync data-sync service (axum + PostgreSQL; spaces are addressed by a client-generated ID + key, with no account system)
- `demo/` — Playwright extension integration tests (`demo/e2e/extension/`, standalone fixtures loading the real build output)
- `scripts/` — test and demo runner scripts (Python runner)
- `docs/` — PRDs and user stories (PRD index: [docs/prd/00-index.md](docs/prd/00-index.md))
- `skills/oncewise-message/` — local flow-handoff programs (Node 22+; `host.mjs`/`client.mjs`/`install.mjs`/`uninstall.mjs`, distributed with the Skill; installation location and troubleshooting in `skills/oncewise-setup/references/native-host-setup.md`)
- `DESIGN.md` — visual spec (business constraints defer to `docs/`)

## Quick start

```bash
# Extension development (extension/)
cd extension && npm install && npm run dev     # load the build output manually into your daily Chrome
cd extension && npm run build                  # MV3 production build → .output/chrome-mv3

# Sync backend (backend/, external PostgreSQL; DATABASE_URL required, BIND_ADDR optional override)
docker run -d --name oncewise-demo-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:18-alpine
cd backend && DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres cargo run   # defaults to 0.0.0.0:8080

# Extension demo integration tests (first-time setup)
cd demo && npm install && npx playwright install chromium

# Run the extension demo smoke (build the extension first, then run)
cd extension && npm run build
uv run scripts/web-demo-test-runner.py demo/e2e/extension/verification/smoke.e2e.ts --run-id <unique-id>
```

All test and demo run instructions are maintained centrally in [scripts/index.md](scripts/index.md) (environment prerequisites, log locations, and failure recovery); this file does not duplicate those commands.

## Installing the Agent Skills

This repository ships three directories in the [Agent Skills open format](https://agentskills.io/specification); the root [.claude-plugin/marketplace.json](.claude-plugin/marketplace.json) declares them as the skill paths of a single plugin (`oncewise`). Each directory's `SKILL.md` is the entry point; `references/` and `examples/` hold that skill's accompanying materials:

| Skill | Purpose |
| --- | --- |
| [`oncewise-setup`](skills/oncewise-setup/SKILL.md) | First-time extension installation, Chrome DevTools MCP configuration, and checking that the AI can reach the extension's import page |
| [`oncewise-flow`](skills/oncewise-flow/SKILL.md) | Verify actions on the target web page, then validate and save the automation flow through the local channel (conversation confirmation is required before saving); enabling is done by the user themselves |
| [`oncewise-message`](skills/oncewise-message/SKILL.md) (companion programs, hard dependency) | Local flow-handoff host and AI-side CLI: `install.mjs` performs a user-level install, and `client.mjs` runs ping / validate / save / verify; the handoff steps of both other skills invoke it |

Tools that support the [Skills CLI](https://github.com/vercel-labs/skills) can let their installers discover and select the skills. From the repository root:

```bash
npx skills add . --list
npx skills add . --skill oncewise-setup --skill oncewise-flow --skill oncewise-message
```

When developing in this repository, `skills/` is the single source of truth and `.agents/skills/` holds local installed copies; the installed copies do not update automatically when the sources change. After changes run `python scripts/sync-skills.py`, then `python scripts/sync-skills.py --check` to confirm they match. To keep them in sync while editing, run `python scripts/sync-skills.py --watch` in a terminal (Ctrl+C to stop). Sync only overwrites the copies from the sources — including accompanying materials and programs — and prunes stale files inside the affected skill; other installed skills are left alone. A skill removed entirely from the source directory is not uninstalled automatically.

`oncewise-message` is a hard dependency of the other two skills, and all three must be installed side by side in the same location — `oncewise-flow` runs the handoff through `../oncewise-message/client.mjs`. If your tool installs only two skills (a manifest or `--list` that omits `oncewise-message` means the tool does not honor manifest declarations), copy or link `skills/oncewise-message/` into the same install location.

Once the repository is published and reachable, you can replace `.` with the repository Git URL or `owner/repo`. The installer picks the target AI tool and install location; `--list` only lists available skills and installs nothing. If a tool doesn't support the Skills CLI, import **all three complete skill directories** per that tool's instructions — do not copy just `SKILL.md`. Restart or refresh the tool if new skills don't show up.

Invoke `oncewise-setup` in whatever way your host tool supports to complete the environment checks, then invoke `oncewise-flow` and describe the web actions to automate. Installing the skills does **not** automatically install Chrome DevTools MCP or the OnceWise Flow extension; configure MCP per the [setup guide](skills/oncewise-setup/references/mcp-setup.md) and confirm it can invoke browser tools such as `list_pages`, `take_snapshot`, `fill`, and `click`.

Compatibility is settled by one actual connectivity check: the host must be able to read the accompanying materials, connect to the browser MCP running on the user's own machine (target-page exploration and verification), and run `skills/oncewise-message/client.mjs` on that machine to complete the Native Messaging handoff (Node 22+; `oncewise-setup` handles installation and `ping` verification). The extension is the sole validator and persistence point: explicit user confirmation in the conversation is required before saving, a saved flow starts out disabled, and enabling and rollback are performed only by the user in the extension UI. Skill upload alone, or only built-in web browsing, is not enough to prove the full flow works. Cloud execution environments in particular must confirm whether they can reach the user's local Chrome and the local channel.

The extension ships in two install flavors. **Chrome Web Store version** (recommended): install directly once the store listing is live; it runs under the store-assigned ID `dmmhmcdbkbbgbcidafhlhepdchjboenc` (the store rejects uploads containing a `key` field, so the store build cannot keep the fixed development ID below). **Source-code development version**: run `npm install` and `npm run build` in `extension/`, enable Developer mode on Chrome's `chrome://extensions` page, and use "Load unpacked" to select `extension/.output/chrome-mv3`. The development manifest pins a `key`, so the extension ID is permanently `fkkfdckchahnjkcbimnbhonbgcefnafi` (when installing the local host, pass `--extension-id fkkfdckchahnjkcbimnbhonbgcefnafi`; the default `allowed_origins` binds the store version's ID). The extension must be installed in the same Chrome instance that the MCP operates. Older keyless development instances derive a different ID, and flows saved locally under that ID are invisible to the new one — flows you need must be recreated through the AI local channel.

## License

This project is open-sourced under the [Apache License 2.0](LICENSE).
