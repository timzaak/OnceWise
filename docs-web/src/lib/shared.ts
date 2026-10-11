export const appName = "OnceWise Flow";
export const docsRoute = "/docs";

export const gitConfig = {
  user: "timzaak",
  repo: "OnceWise",
  branch: "main",
};

export const contactEmail = "zsy.evan@gmail.com";

// The static build is published to a GitHub Pages project site
// (https://timzaak.github.io/OnceWise/), so every asset URL and router link
// carries this prefix. BASE_PATH is set at build time by the Pages workflow;
// empty at the dev-server root. SITE_URL is the canonical origin of the
// deployed site, used for the sitemap and absolute links.
export const basePath = (process.env.BASE_PATH ?? "/").replace(/\/+$/, "");

export const siteUrl = (
  process.env.SITE_URL ?? "https://timzaak.github.io/OnceWise"
).replace(/\/+$/, "");
