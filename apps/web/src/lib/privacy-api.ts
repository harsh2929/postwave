// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "./api";

export type PrivacyRegion = "GDPR" | "CCPA" | "LGPD" | "OTHER";

export interface PrivacyWorkflowResponse {
  request_id: string;
  status: "queued";
  requested_at: string;
  estimated_ready_at: string;
}

export interface PrivacyRequestRecord {
  request_id: string;
  type:
    | "data_export"
    | "account_deletion"
    | "subscriber_erasure"
    | "correction"
    | "opt_out_sale_share"
    | "opt_out_targeted_advertising"
    | "limit_sensitive_data"
    | "appeal";
  region: PrivacyRegion;
  status:
    | "queued"
    | "verifying"
    | "in_progress"
    | "blocked_legal_hold"
    | "blocked_ownership"
    | "fulfilled"
    | "rejected"
    | "cancelled"
    | "appealed";
  subject_type: "tenant_admin" | "subscriber" | "consumer" | "account_user";
  subject_email?: string;
  requester_email?: string;
  requested_at: string;
  due_at: string;
  completed_at?: string;
  legal_hold: boolean;
  notes?: string;
  fulfillment: Record<string, unknown>;
}

export interface PrivacyRequestsResponse {
  requests: PrivacyRequestRecord[];
}

export function requestDataExport(
  body: {
    region?: PrivacyRegion;
    notes?: string;
  } = {},
): Promise<PrivacyWorkflowResponse> {
  return api.post<PrivacyWorkflowResponse>(
    "/api/v1/privacy/export-requests",
    body,
  );
}

export function listPrivacyRequests(signal?: AbortSignal): Promise<PrivacyRequestsResponse> {
  return api.get<PrivacyRequestsResponse>("/api/v1/privacy/requests", { signal });
}

export function dataExportDownloadPath(requestId: string): string {
  return `/api/v1/privacy/export-requests/${encodeURIComponent(
    requestId,
  )}/download`;
}

// This is the tenant/workspace-wide administrative review. Personal account
// deletion uses DELETE /api/v1/account in account-deletion-api.ts.
export function requestWorkspaceDeletion(
  body: {
    region?: PrivacyRegion;
    notes?: string;
  } = {},
): Promise<PrivacyWorkflowResponse> {
  return api.post<PrivacyWorkflowResponse>(
    "/api/v1/privacy/deletion-requests",
    body,
  );
}

/**
 * Subscriber/consumer-level DSAR request types that a workspace admin can file
 * on a data subject's behalf (SETA-009). Export + account/workspace deletion
 * have their own dedicated endpoints; these route through the generic
 * privacy-workflow engine (POST /api/v1/privacy/requests).
 */
export type DsarRequestType =
  | "subscriber_erasure"
  | "correction"
  | "opt_out_sale_share"
  | "opt_out_targeted_advertising"
  | "limit_sensitive_data"
  | "appeal";

export const DSAR_REQUEST_TYPES: {
  value: DsarRequestType;
  label: string;
  description: string;
}[] = [
  {
    value: "subscriber_erasure",
    label: "Erasure (right to be forgotten)",
    description: "Delete this subscriber's personal data.",
  },
  {
    value: "correction",
    label: "Correction / rectification",
    description: "Correct inaccurate personal data.",
  },
  {
    value: "opt_out_sale_share",
    label: "Opt out of sale/share",
    description: "CCPA/CPRA opt-out of the sale or sharing of personal data.",
  },
  {
    value: "opt_out_targeted_advertising",
    label: "Opt out of targeted advertising",
    description: "Opt out of processing for targeted advertising.",
  },
  {
    value: "limit_sensitive_data",
    label: "Limit use of sensitive data",
    description: "Restrict the use of sensitive personal information.",
  },
  {
    value: "appeal",
    label: "Appeal a decision",
    description: "Appeal the outcome of a prior privacy request.",
  },
];

export function createPrivacyRequest(body: {
  type: DsarRequestType;
  subject_email: string;
  region?: PrivacyRegion;
  notes?: string;
}): Promise<PrivacyRequestRecord> {
  return api.post<PrivacyRequestRecord>("/api/v1/privacy/requests", body);
}

// Data Processing Agreement metadata + downloadable artifact (SETA-040).
// Backend: apps/api/internal/privacy/dpa.go.
export interface DpaMetadata {
  version: string;
  generated_at: string;
  processor_name: string;
  controller_name: string;
  controller_address?: string;
  body_sha256: string;
  download_url: string;
}

export function getDpaMetadata(): Promise<DpaMetadata> {
  return api.get<DpaMetadata>("/api/v1/privacy/dpa");
}

export const DPA_DOWNLOAD_PATH = "/api/v1/privacy/dpa/download";
