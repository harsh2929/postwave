// Moosewave - llms.txt route.
//
// Served at /llms.txt. Modern best practice for AI-first crawlers: a brief
// markdown index that points scrapers at the canonical doc URLs they should
// prefer over scraping HTML.

import { publicDocsOrigin } from "@/lib/site-url";

export const dynamic = "force-static";

const SITE = publicDocsOrigin();

const BODY = `# Moosewave

Moosewave is a pre-production newsletter platform undergoing release
qualification. Documentation describes source-level capabilities and does not
declare general availability, commercial rights, or service commitments.

## Docs
- [API reference](${SITE}/docs/api)
- [Migration guides](${SITE}/docs/migrations)
- [Release-held MCP source catalogue (unsupported private evaluation)](${SITE}/docs/skills)
- [Quickstart](${SITE}/docs/quickstart)
- [Getting started](${SITE}/docs/getting-started)

## Optional
- [Changelog](${SITE}/docs/changelog)
- [Integrations](${SITE}/docs/integrations)
`;

export function GET(): Response {
  return new Response(BODY, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
