import { createFileRoute } from "@tanstack/react-router";
import { absoluteUrls, getLLMText, source } from "@/lib/source";

export const Route = createFileRoute("/llms-full.txt")({
  server: {
    handlers: {
      GET: async () => {
        const scan = source.getPages().map(getLLMText);
        const scanned = await Promise.all(scan);
        return new Response(absoluteUrls(scanned.join("\n\n")));
      },
    },
  },
});
