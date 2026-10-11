import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/docs/$")({
  beforeLoad: ({ location, params }) => {
    const slugs = params._splat?.split("/").filter(Boolean) ?? [];
    const [first, ...rest] = slugs;
    const locale = first === "zh" ? "zh" : "en";
    const docsSlugs = first === "zh" ? rest : slugs;
    const path = `/${[locale, "docs", ...docsSlugs].join("/")}`;
    throw redirect({
      href: `${path}${location.searchStr}${location.hash ? `#${location.hash}` : ""}`,
    });
  },
});
