import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

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

export default defineConfig({
  // Sub-path deploy (GitHub Pages project site): BASE_PATH=/OnceWise gives
  // base "/OnceWise/". Default "/" for the dev server.
  base: `${(process.env.BASE_PATH ?? "/").replace(/\/+$/, "")}/`,
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
    mdx(),
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
        prerender: {
          enabled: true,
          crawlLinks: true,
        },
      },

      // Prerender tuning for the virtual OpenAPI pages.
      // Defaults: concurrency = os.cpus().length (too high — overwhelms the
      // localhost prerender server → ETIMEDOUT). Lower concurrency eases the
      // server, retries absorb transient timeouts, and failOnError turns a
      // dropped page into a build failure instead of a silent gap.
      prerender: {
        concurrency: 3,
        retryCount: 3,
        retryDelay: 1000,
        failOnError: true,
      },

      pages: [
        {
          path: "/docs",
        },
        {
          path: "/en/docs",
        },
        {
          path: "/zh/docs",
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
