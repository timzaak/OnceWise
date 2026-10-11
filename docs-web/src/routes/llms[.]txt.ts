import { createFileRoute } from "@tanstack/react-router";
import { llms } from "fumadocs-core/source";
import { absoluteUrls, source } from "@/lib/source";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET() {
        return new Response(absoluteUrls(llms(source).index()));
      },
    },
  },
});
