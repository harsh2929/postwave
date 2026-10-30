// SPDX-License-Identifier: AGPL-3.0-only
//
// POST /api/incidents/{id}/updates — append a timeline update (optionally
// transitioning status), forwarding the operator cookie.
import { forwardIncidentUpdate } from "@/lib/opsIncidentApi";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  return forwardIncidentUpdate(req, id);
}
