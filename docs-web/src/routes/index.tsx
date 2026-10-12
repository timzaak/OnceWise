import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/components/home-page";
import { en } from "@/lib/home-texts";

// The site root serves the English homepage directly (the highest-authority
// URL must be real content, not a redirect); /zh is the Chinese homepage.
export const Route = createFileRoute("/")({
  component: () => (
    <HomePage
      texts={en}
      docsLink={{
        to: "/$lang/docs/$",
        params: { lang: "en", _splat: "getting-started" },
      }}
    />
  ),
});
