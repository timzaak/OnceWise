import { createTokenizer } from "@orama/tokenizers/mandarin";
import { createFileRoute } from "@tanstack/react-router";
import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

const server = createFromSource(source, {
  localeMap: {
    en: { language: "english" },
    zh: {
      components: {
        tokenizer: createTokenizer(),
      },
    },
  },
});

export const Route = createFileRoute("/api/search")({
  server: {
    handlers: {
      GET: () => server.staticGET(),
    },
  },
});
