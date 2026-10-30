// SPDX-License-Identifier: AGPL-3.0-only
//
// POST /api/checks/{id}/snooze — forwards to the API's snooze handler with the
// operator's cookie. The reason is mandatory and the critical 7-day cap is
// enforced server-side; this route neither validates nor softens either.

import { forwardOpsPost } from "@/lib/opsApi";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  return forwardOpsPost(req, id, "snooze");
}
