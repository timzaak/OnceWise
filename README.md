# OnceWise Flow

English | [简体中文](README.zh.md)

Same page, same form, same twenty clicks, every day — OnceWise Flow does them for you. Describe a routine to your AI assistant; it tries the steps on the real page, turns them into a constrained flow, and hands it over through a channel that never leaves your machine. You review the flow once and press Enable; from then on, the steps run whenever you open a matching page.

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/dmmhmcdbkbbgbcidafhlhepdchjboenc)** | [Getting-started tutorial](https://timzaak.github.io/OnceWise/en/docs/getting-started) | [Documentation](https://timzaak.github.io/OnceWise/) | [Privacy policy](https://timzaak.github.io/OnceWise/en/privacy)

## Highlights

- **Constrained flows, not arbitrary scripts** — flows are step sequences with time budgets (fill, click, read, wait, assert, loop), safe to run on pages you log into
- **Local-first** — flows, settings and version history stay in your browser; no accounts, no analytics, no tracking
- **Site-scoped** — a flow only runs on the site it was written for
- **You stay in charge** — every flow arrives disabled; you review it, enable it yourself, and can roll back through a 10-version history
- **Optional self-hosted sync** — share selected flows as versioned scripts across devices and teammates; the extension works fully without it

## Get started

1. Install the extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/dmmhmcdbkbbgbcidafhlhepdchjboenc).
2. Install the OnceWise skills in your AI tool (Claude Code, Cursor, ZCode, or anything that supports the Agent Skills format):

   ```bash
   npx skills add timzaak/OnceWise --skill oncewise-setup --skill oncewise-flow --skill oncewise-message
   ```

3. Install the native host once (Node 22+): `node skills/oncewise-message/install.mjs`
4. Ask your assistant to automate the page you are on, review the flow in the side panel, and press Enable.

The full walkthrough — source-code build, MCP setup, native-host troubleshooting, your first flow — lives in the tutorial: [English](https://timzaak.github.io/OnceWise/en/docs/getting-started) · [简体中文](https://timzaak.github.io/OnceWise/zh/docs/getting-started)

## Repository layout

- `extension/` — Chrome MV3 extension (WXT + React): flow workbench sidepanel, pre-run input forms, same-site cross-page continuation, dry-run, sync tab
- `backend/` — oncewise-ai-sync data-sync service (axum + PostgreSQL; spaces addressed by a client-generated ID + key, no account system)
- `skills/` — the three Agent Skills (`oncewise-setup` / `oncewise-flow` / `oncewise-message`) and the native-messaging host they hand over through (declared as one plugin in `.claude-plugin/marketplace.json`)
- `demo/` — Playwright extension integration tests
- `docs/` — PRDs and user stories ([index](docs/prd/00-index.md)); `docs/store-listing/` holds the Chrome Web Store materials
- `DESIGN.md` — visual spec

## Development

```bash
# Extension (MV3 build → extension/.output/chrome-mv3; load unpacked on chrome://extensions)
cd extension && npm install && npm run build

# Sync backend (external PostgreSQL required; defaults to 0.0.0.0:8080)
docker run -d --name oncewise-demo-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:18-alpine
cd backend && DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres cargo run
```

All test and demo run instructions live in [scripts/index.md](scripts/index.md); contributor conventions (including the `skills/` → `.agents/skills/` sync discipline) in [AGENTS.md](AGENTS.md).

## License

This project is open-sourced under the [Apache License 2.0](LICENSE).
