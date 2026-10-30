// SPDX-License-Identifier: AGPL-3.0-only
//
// POST /api/tenants/{id}/kill-switch — forwards to the API's per-tenant kill
// switch with the operator's cookie. The body ({paused, reason}) passes through
// untouched: the API is the only thing that applies the pause and audits it.

import { forwardKillSwitch } from "@/lib/opsTenantApi";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  return forwardKillSwitch(req, id);
}
