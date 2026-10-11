import { docs } from "collections/server";
import { loader, multiple } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";
import { openapiPlugin, openapiSource } from "fumadocs-openapi/server";
import { i18n } from "./i18n";
import { openapi } from "./openapi";
import { siteUrl } from "./shared";

const docsRoute = "/docs";

export const source = loader(
  multiple({
    docs: docs.toFumadocsSource(),
    openapi: await openapiSource(openapi, {
      baseDir: "openapi",
      groupBy: "tag",
    }),
  }),
  {
    baseUrl: docsRoute,
    i18n,
    url(slugs, locale) {
      const loc = locale || i18n.defaultLanguage;
      return `/${[loc, "docs", ...slugs.filter(Boolean)].join("/")}`;
    },
    plugins: [lucideIconsPlugin(), openapiPlugin()],
  },
);

export function markdownPathToSlugs(segs: string[]) {
  if (segs.length === 0) return [];

  const out = [...segs];
  out[out.length - 1] = out[out.length - 1].replace(/\.md$/, "");
  if (out.length === 1 && out[0] === "index") out.pop();
  return out;
}

export function slugsToMarkdownPath(slugs: string[], locale?: string) {
  const segments = [...slugs];
  if (segments.length === 0) {
    segments.push("index.md");
  } else {
    segments[segments.length - 1] += ".md";
  }

  const base = locale ? `/${locale}${docsRoute}` : docsRoute;
  return {
    segments,
    url: `${base}/${segments.join("/")}`,
  };
}

export function getPageMarkdownUrl(slugs: string[]) {
  const segments = [...slugs];
  if (segments.length === 0) {
    segments.push("index.md");
  } else {
    segments[segments.length - 1] += ".md";
  }

  return {
    segments,
    url: `${docsRoute}/${segments.join("/")}`,
  };
}

export async function getLLMText(page: (typeof source)["$inferPage"]) {
  if (page.data.type === "openapi") {
    // Dumping every full schema into llms-full.txt bloats the file fast.
    // Emit a compact per-operation summary instead; the full schema stays
    // available on each page's HTML.
    const schema = page.data.getSchema() as { paths?: Record<string, unknown> };
    const paths = schema.paths ?? {};
    const lines: string[] = [`# ${page.data.title} (${page.url})`, ""];
    for (const [path, ops] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(
        ops as Record<string, unknown>,
      )) {
        const summary = (op as { summary?: string }).summary ?? "";
        lines.push(`- ${method.toUpperCase()} ${path} — ${summary}`);
      }
    }
    return lines.join("\n");
  }

  const processed = await page.data.getText("processed");

  return `# ${page.data.title} (${page.url})

${processed}`;
}

// Page URLs in the tree are root-absolute ("/en/docs/x"); the site is served
// from a sub path, so llms.txt consumers need the full origin. Rewrite the two
// shapes llms output produces: markdown links "](/en/...)" and page headers
// "# Title (/en/...)".
export function absoluteUrls(text: string) {
  return text
    .replaceAll("](/en/", `](${siteUrl}/en/`)
    .replaceAll("](/zh/", `](${siteUrl}/zh/`)
    .replaceAll("(/en/docs", `(${siteUrl}/en/docs`)
    .replaceAll("(/zh/docs", `(${siteUrl}/zh/docs`);
}
