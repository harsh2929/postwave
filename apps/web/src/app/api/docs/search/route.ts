// SPDX-License-Identifier: AGPL-3.0-only
import { getSearchIndex } from "@/lib/docs/search.server";
import { searchIndex } from "@/lib/docs/search";

const MAX_QUERY_LENGTH = 100;

export function GET(request: Request): Response {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (query.length > MAX_QUERY_LENGTH) {
    return Response.json(
      { error: "query_too_long" },
      { status: 400, headers: responseHeaders("no-store") },
    );
  }
  if (query.length < 2) {
    return Response.json(
      { results: [] },
      { headers: responseHeaders("public, max-age=300") },
    );
  }

  const results = searchIndex(getSearchIndex(), query, 12).map(
    ({ doc, score }) => ({
      doc: {
        id: doc.id,
        title: doc.title,
        url: doc.url,
        section: doc.section,
      },
      score,
    }),
  );
  return Response.json(
    { results },
    { headers: responseHeaders("public, max-age=300") },
  );
}

function responseHeaders(cacheControl: string): HeadersInit {
  return {
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  };
}
