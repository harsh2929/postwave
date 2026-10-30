// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  id: string;
  tenant_id: string;
  resource_type: string;
  resource_id: string;
  requested_by: string;
  status: ApprovalStatus;
  notes?: string;
  created_at: string;
  decided_at?: string;
}

export interface ApprovalListParams {
  status?: ApprovalStatus;
  cursor?: string;
}

export interface ApprovalListPage {
  items: Approval[];
  next_cursor?: string | null;
}

export interface ApprovalDecisionInput {
  decision: "approve" | "reject";
  notes?: string;
}

export class ApprovalsResource extends Resource {
  list(params: ApprovalListParams = {}): Promise<ApprovalListPage> {
    return this.client.request("GET", "/api/v1/approvals", {
      query: params as Record<string, string | undefined>,
    });
  }

  decide(id: string, input: ApprovalDecisionInput): Promise<Approval> {
    return this.client.request(
      "POST",
      `/api/v1/approvals/${encodeURIComponent(id)}/decision`,
      { body: input },
    );
  }
}
