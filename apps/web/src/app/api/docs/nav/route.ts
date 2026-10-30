// SPDX-License-Identifier: AGPL-3.0-only
//
// The full docs navigation tree. The docs layout inlines only a summary (group
// names + counts) into each document; the sidebar fetches this once — on the
// first expand, filter keystroke, or endpoint/skill page — and the browser
// then reuses it across every other /docs URL. Inlining it instead put ~200 KB
// of JSON in the flight payload of all ~2,260 docs documents.
import { docsNavIndex } from "@/lib/docs/nav-index";

export function GET(): Response {
  return Response.json(docsNavIndex(), {
    headers: {
      // Derived from build-time artifacts (the OpenAPI spec and the generated
      // skill catalogue), so it only changes on deploy. Same window the docs
      // search endpoint uses.
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
