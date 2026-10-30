// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

export interface PaidMember {
  subscriber_email: string;
  status: "active" | "past_due" | "canceled" | "paused" | string;
  stripe_subscription_id?: string | null;
  tier?: string | null;
  started_at: string;
  cancelled_at?: string | null;
  metadata: Record<string, unknown>;
}

export interface ListMembersResp {
  members: PaidMember[];
  total: number;
  page: number;
  per_page: number;
}

export function listPaidMembers(
  status?: string,
  page = 1,
  perPage = 50,
  email?: string,
): Promise<ListMembersResp> {
  return api.get<ListMembersResp>("/api/v1/paid-members", {
    // SUB-050: `email` searches the full registry server-side.
    query: { status, page, per_page: perPage, email: email || undefined },
  });
}

export function grantPaidMember(input: {
  subscriber_email: string;
  tier?: string;
  status?: string;
}): Promise<{ ok: true }> {
  return api.post<{ ok: true }>("/api/v1/paid-members", input);
}

export function revokePaidMember(email: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(
    `/api/v1/paid-members/${encodeURIComponent(email)}`,
  );
}
