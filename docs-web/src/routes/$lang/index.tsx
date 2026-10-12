import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/components/home-page";
import { en, type HomeTexts, zh } from "@/lib/home-texts";
import { siteUrl } from "@/lib/shared";

const textsMap: Record<string, HomeTexts> = { en, zh };

export const Route = createFileRoute("/$lang/")({
  component: LangHome,
  head: ({ params }) =>
    // The English homepage also lives at "/" (the site root); mark /en as the
    // duplicate so search engines consolidate on the root URL. siteUrl already
    // carries the deploy base path. /zh is the canonical Chinese homepage.
    params.lang === "en"
      ? { links: [{ rel: "canonical", href: `${siteUrl}/` }] }
      : {},
});

function LangHome() {
  const { lang } = Route.useParams();
  const texts = textsMap[lang] ?? en;

  return (
    <HomePage
      texts={texts}
      docsLink={{
        to: "/$lang/docs/$",
        params: { lang, _splat: "getting-started" },
      }}
    />
  );
}
