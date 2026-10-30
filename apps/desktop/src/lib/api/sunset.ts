import { apiRequest, type ApiResult } from "../api-client";

// This API serializes camelCase (Klaviyo-style), not the usual snake_case.
export interface SunsetPolicy {
  id: string;
  tenantId: string;
  name: string;
  /** 30..730 (server-validated). */
  inactiveDays: number;
  /** suppress | tag | winback */
  action: string;
  enabled: boolean;
  excludedTags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SunsetPolicyInput {
  name: string;
  inactiveDays: number;
  action: string;
  enabled?: boolean;
  excludedTags?: string[];
}

export interface SunsetExecution {
  id: string;
  tenantId: string;
  policyId: string;
  subscriberId: string;
  actionTaken: string;
  reason?: string;
  executedAt: string;
}

export interface SunsetRunSummary {
  policyId: string;
  startedAt: string;
  completedAt: string;
  candidatesSeen: number;
  byAction: Record<string, number>;
  errors?: string[];
}

/** Customer-supplied brand fields. NO json tags server-side — Go field
 *  names go over the wire verbatim (sunset.BrandSnapshot). */
export interface SunsetBrandSnapshot {
  WorkspaceName?: string;
  SenderName?: string;
  ProductName?: string;
  /** "casual" | "formal" | "professional" */
  Tone?: string;
  UnsubscribeURL?: string;
  HomepageURL?: string;
}

export interface SunsetReengagementTemplate {
  subject: string;
  preheader: string;
  bodyText: string;
  bodyHtml: string;
  primaryCta: string;
  candidateCount: number;
  variant: string;
}

export const sunsetApi = {
  /** GET /api/v1/sunset/policies (admin) -> `{items}`. */
  listPolicies(): Promise<ApiResult<{ items: SunsetPolicy[] }>> {
    return apiRequest<{ items: SunsetPolicy[] }>("/api/v1/sunset/policies");
  },
  /** POST /api/v1/sunset/policies (admin) — 201, returns the row. */
  createPolicy(input: SunsetPolicyInput): Promise<ApiResult<SunsetPolicy>> {
    return apiRequest<SunsetPolicy>("/api/v1/sunset/policies", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  /** GET /api/v1/sunset/policies/{id} (admin). */
  getPolicy(id: string): Promise<ApiResult<SunsetPolicy>> {
    return apiRequest<SunsetPolicy>(
      `/api/v1/sunset/policies/${encodeURIComponent(id)}`,
    );
  },
  /** PUT /api/v1/sunset/policies/{id} (admin) — full replace. */
  updatePolicy(
    id: string,
    input: SunsetPolicyInput,
  ): Promise<ApiResult<SunsetPolicy>> {
    return apiRequest<SunsetPolicy>(
      `/api/v1/sunset/policies/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  },
  /** DELETE /api/v1/sunset/policies/{id} (admin). */
  deletePolicy(id: string): Promise<ApiResult<void>> {
    return apiRequest<void>(
      `/api/v1/sunset/policies/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
  /** POST /api/v1/sunset/policies/{id}/run (admin) — synchronous sweep. */
  runPolicy(id: string): Promise<ApiResult<SunsetRunSummary>> {
    return apiRequest<SunsetRunSummary>(
      `/api/v1/sunset/policies/${encodeURIComponent(id)}/run`,
      { method: "POST", body: JSON.stringify({}) },
      { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
    );
  },
  /** GET /api/v1/sunset/policies/{id}/executions?limit= -> `{items}`. */
  listExecutions(
    id: string,
    limit?: number,
  ): Promise<ApiResult<{ items: SunsetExecution[] }>> {
    const qs = limit != null ? `?limit=${limit}` : "";
    return apiRequest<{ items: SunsetExecution[] }>(
      `/api/v1/sunset/policies/${encodeURIComponent(id)}/executions${qs}`,
    );
  },
  /** POST /api/v1/sunset/reengagement/preview — pure-function template. */
  previewReengagement(input: {
    brand: SunsetBrandSnapshot;
    candidateCount?: number;
    variant?: string;
  }): Promise<ApiResult<SunsetReengagementTemplate>> {
    return apiRequest<SunsetReengagementTemplate>(
      "/api/v1/sunset/reengagement/preview",
      { method: "POST", body: JSON.stringify(input) },
    );
  },
};
