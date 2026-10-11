# docs-web

OnceWise Flow documentation site. Built with [Fumadocs](https://fumadocs.dev) on TanStack Start (React + Vite), with English / Chinese i18n, Mermaid diagram support, and an OpenAPI reference generated from the backend's utoipa spec.

## Develop

```bash
npm install
npm run generate-api-docs   # once, and whenever backend endpoints change
npm run dev
```

Open http://localhost:3001 — `/` redirects to `/en`.

- Source content lives in `content/docs/` (English) and `content/docs/zh/` (Chinese), as MDX.
- Sidebar ordering is controlled by `content/docs/meta.json` and `content/docs/zh/meta.json`.
- `openapi.json` is generated from the backend (`cargo run --bin export-openapi`) and gitignored; the OpenAPI pages disappear from the build if it is missing.

## Build

```bash
npm run generate-api-docs
npm run build
```

Produces static output in `.output/public/` (SPA prerender) plus a generated `sitemap.xml`.

## GitHub Pages deployment

The site is published at <https://timzaak.github.io/OnceWise/> from a sub path, so the production build carries a base path:

```bash
BASE_PATH=/OnceWise npm run build
```

`.github/workflows/docs-pages.yml` does this on every push to `main` that touches `docs-web/**` or the backend OpenAPI surface, and deploys the artifact via `actions/deploy-pages` (no `gh-pages` branch involved).

One-time enablement (needs the repository public, see `docs/privacy-policy.md`):

```bash
gh api -X POST repos/timzaak/OnceWise/pages -f 'build_type=workflow'
```

`SITE_URL` (default `https://timzaak.github.io/OnceWise`) drives `sitemap.xml` and the absolute links in `llms.txt` / `llms-full.txt`; `robots.txt` points at the same sitemap. When the store listing goes live, the Privacy policy URL for the developer console is `https://timzaak.github.io/OnceWise/en/privacy` (the site home replaces the old standalone `gh-pages` page — see the note in `docs/privacy-policy.md`).
