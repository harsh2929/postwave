// SPDX-License-Identifier: AGPL-3.0-only
//
// POST /api/incidents — declare an incident, forwarding the operator cookie to
// the API's audited open-incident endpoint.
import { forwardIncidentOpen } from "@/lib/opsIncidentApi";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return forwardIncidentOpen(req);
}
