// SPDX-License-Identifier: AGPL-3.0-only
//
// POST /api/checks/{id}/action — forwards to the API's action executor with
// the operator's cookie. The body ({idempotency_key, input}) is passed
// through untouched: the executor is the only thing that decides whether this
// invocation runs or replays.

import { forwardOpsPost } from "@/lib/opsApi";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  return forwardOpsPost(req, id, "action");
}
