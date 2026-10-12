import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";

// OpenAPI pages are virtual (one per operationId in the spec, grouped by tag).
// The prerender crawler can't discover them from virtual pages, so we list them
// explicitly — one per operationId, in both locales. Generated from openapi.json
// so it stays in sync when the backend adds/removes endpoints.
//
// `groupBy: "tag"` (src/lib/source.ts) nests each page under its tag folder,
// so the path is `/openapi/<tag>/<operationId>`. fumadocs-openapi slugifies the
// tag with `(s) => s.replace(/\s+/g, "-").toLowerCase()` — since our tags have
// no spaces, the lowercase tag is the folder segment verbatim.
function openapiPages() {
  try {
    const spec = JSON.parse(readFileSync("./openapi.json", "utf-8")) as {
      paths?: Record<
        string,
        Record<string, { operationId?: string; tags?: string[] }>
      >;
    };
    const seen = new Set<string>();
    const pages: { path: string }[] = [];
    for (const ops of Object.values(spec.paths ?? {})) {
      for (const op of Object.values(ops)) {
        if (!op.operationId || !op.tags?.[0]) continue;
        const tag = op.tags[0].toLowerCase();
        const id = op.operationId;
        const key = `${tag}/${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pages.push({ path: `/en/docs/openapi/${tag}/${id}` });
        pages.push({ path: `/zh/docs/openapi/${tag}/${id}` });
      }
    }
    return pages.sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    return [];
  }
}

// @tanstack/start-static-server-functions fetches its prerendered JSON cache
// from an origin-absolute "/__tsr/..." URL with no configurable base — on the
// /OnceWise sub-path deploy the fetch 404s into HTML and res.json() throws
// ("Unexpected token '<'"). Rewrite the client-side fetch against the vite
// base; the server-side cache writer must keep its unprefixed path (files land
// at .output/public/__tsr, which is exactly base + "/__tsr"). Upstream
// 1.167.40 still hardcodes it — the guard throws if the literal moves so the
// patch can't silently stop applying.
function patchStaticFnCacheBasePath(): Plugin {
  return {
    name: "patch-static-fn-cache-basepath",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("start-static-server-functions")) return;
      const target = 'fetch(url, { method: "GET" })';
      if (!code.includes(target)) {
        if (code.includes("staticServerFnCache")) {
          throw new Error(
            `${id}: "${target}" not found — @tanstack/start-static-server-functions changed, update the patch in vite.config.ts`,
          );
        }
        return;
      }
      return code.replace(
        target,
        'fetch(import.meta.env.BASE_URL + url.slice(1), { method: "GET" })',
      );
    },
  };
}

export default defineConfig({
  // Sub-path deploy (GitHub Pages project site): BASE_PATH=/OnceWise gives
  // base "/OnceWise/". Default "/" for the dev server.
  base: `${(process.env.BASE_PATH ?? "/").replace(/\/+$/, "")}/`,
  // Client bundles have no process.env — without these defines every
  // process.env.BASE_PATH read in client code collapses to undefined and
  // basePath degenerates to "" (unprefixed router basepath, links and fetch
  // URLs that 404 on the sub-path deploy).
  define: {
    "process.env.BASE_PATH": JSON.stringify(process.env.BASE_PATH ?? "/"),
    "process.env.SITE_URL": JSON.stringify(process.env.SITE_URL ?? ""),
  },
  server: {
    port: 3001,
  },
  // The build's prerender step serves .output through a vite preview server
  // and fetches it back over HTTP. Binding to "localhost" listens on ::1 only
  // on Linux while node's fetch resolves localhost to 127.0.0.1 — every page
  // fetch gets ECONNREFUSED and the build silently emits 0 prerendered pages.
  preview: {
    host: "127.0.0.1",
  },
  plugins: [
    patchStaticFnCacheBasePath(),
    mdx(),
    tailwindcss(),
    tanstackStart({
      // Every reachable route is prerendered (seeds + crawl), so no SPA shell
      // fallback is needed — and spa.enabled would claim "/" for the shell
      // mask page, blocking real content at the site root.
      prerender: {
        enabled: true,
        crawlLinks: true,
        concurrency: 3,
        retryCount: 3,
        retryDelay: 1000,
        failOnError: true,
      },

      pages: [
        {
          path: "/",
        },
        {
          path: "/en",
        },
        {
          path: "/zh",
        },
        {
          path: "/en/privacy",
        },
        {
          path: "/zh/privacy",
        },
        ...openapiPages(),
        {
          path: "/api/search",
        },
        {
          path: "llms-full.txt",
        },
        {
          path: "llms.txt",
        },
      ],
    }),
    react(),
    nitro(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
