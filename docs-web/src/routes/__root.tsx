import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
  useLocation,
} from "@tanstack/react-router";
import { defineI18nUI } from "fumadocs-ui/i18n";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import SearchDialog from "@/components/search";
import { i18n } from "@/lib/i18n";
import { basePath } from "@/lib/shared";
import appCss from "@/styles/app.css?url";

const { provider } = defineI18nUI(i18n, {
  translations: {
    en: { displayName: "English", search: "Search Docs" },
    zh: { displayName: "中文", search: "搜索文档" },
  },
});

function useLocale() {
  const location = useLocation();
  const segments = location.pathname.split("/").filter(Boolean);
  // On a sub-path deploy (/OnceWise/en/docs) the base segment comes first.
  if (segments[0] === basePath.replace(/^\//, "")) segments.shift();
  if (
    segments.length > 0 &&
    i18n.languages.includes(segments[0] as (typeof i18n.languages)[number])
  ) {
    return segments[0];
  }
  return i18n.defaultLanguage;
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "OnceWise Flow",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  const locale = useLocale();
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex flex-col min-h-screen">
        <RootProvider search={{ SearchDialog }} i18n={provider(locale)}>
          <Outlet />
        </RootProvider>
        <Scripts />
      </body>
    </html>
  );
}
