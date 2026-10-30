// SPDX-License-Identifier: AGPL-3.0-only

import { getSpec } from "@/lib/docs/loadOpenAPI";

export const dynamic = "force-static";

export function GET(): Response {
  return Response.json(getSpec(), {
    headers: {
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
