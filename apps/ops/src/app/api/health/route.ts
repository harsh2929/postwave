// SPDX-License-Identifier: AGPL-3.0-only

export const dynamic = "force-dynamic";

/** Process liveness only. Dependency health belongs to /api/ready. */
export function GET(): Response {
  return Response.json(
    { status: "ok" },
    { headers: { "cache-control": "no-store" } },
  );
}
