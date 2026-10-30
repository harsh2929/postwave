// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";
import { integrationPathSegment } from "./integrations.js";

export type AudienceDestinationProvider =
  | "meta"
  | "google_ads"
  | "tiktok"
  | "linkedin"
  | "snap"
  | string;

export type AudienceDestinationStatus =
  | "draft"
  | "active"
  | "paused"
  | "syncing"
  | "error"
  | "disconnected"
  | string;

export interface AudienceDestination {
  id: string;
  tenant_id: string;
  provider: AudienceDestinationProvider;
  list_id?: string | null;
  segment_id?: string | null;
  external_audience_id?: string;
  status: AudienceDestinationStatus;
  last_synced_at?: string | null;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AudienceDestinationDisconnectCleanupEvidence {
  provider: string;
  status: string;
  recorded_at?: string;
  postwave_status: string;
  provider_cleanup_posture: string;
  managed_provider_cleanup: boolean;
  provider_scope_type?: string;
  provider_scope_id?: string;
  external_audience_id?: string;
  credential_ref_present?: boolean;
  audience_cleanup_status: string;
  audience_membership_cleanup_status: string;
  credential_cleanup_status: string;
  postwave_effects?: string[];
  provider_console_actions?: string[];
  provider_cleanup_evidence?: string[];
}

export interface AudienceDestinationDisconnectResponse {
  ok: boolean;
  provider_cleanup?: AudienceDestinationDisconnectCleanupEvidence;
}

export interface AudienceDestinationJob {
  id: string;
  tenant_id: string;
  destination_id: string;
  started_at: string;
  finished_at?: string | null;
  status: string;
  error?: string;
  members_synced: number;
  external_job_id?: string;
  external_audience_id?: string;
  provider_message?: string;
  provider_status?: string;
  provider_checked_at?: string | null;
  provider_next_check_at?: string | null;
  provider_poll_attempts?: number;
  created_at: string;
}

export interface AudienceDestinationListResponse {
  items: AudienceDestination[];
}

export interface AudienceDestinationJobsResponse {
  items: AudienceDestinationJob[];
}

export interface AudienceDestinationProvidersResponse {
  providers: AudienceDestinationProvider[];
}

export interface AudienceDestinationCreateInput {
  provider: AudienceDestinationProvider;
  list_id?: string | null;
  segment_id?: string | null;
  external_audience_id?: string;
  config?: Record<string, unknown>;
}

export interface AudienceDestinationUpdateInput {
  status?: AudienceDestinationStatus;
  external_audience_id?: string;
  config?: Record<string, unknown>;
}

export interface AudienceDestinationReadiness {
  provider: string;
  ready: boolean;
  status: string;
  detail: string;
  missing?: string[];
  docs?: string[];
}

export interface AudienceDestinationPreview {
  destination_id: string;
  provider: string;
  total_members: number;
  excluded_count: number;
  deliverable: number;
  truncated: boolean;
  firewall_active: boolean;
}

export interface AudienceDestinationSyncResponse {
  status: string;
  provider?: string;
  total_members?: number;
  excluded_count?: number;
  members_sent?: number;
  external_job_id?: string;
  external_audience_id?: string;
  provider_message?: string;
  truncated?: boolean;
  job?: AudienceDestinationJob;
  destination?: AudienceDestination;
}

export interface AudienceDestinationJobDiagnostics {
  provider: string;
  external_job_id?: string;
  external_audience_id?: string;
  provider_message?: string;
  provider_status?: string;
  provider_response?: Record<string, unknown>;
}

export interface AudienceDestinationJobDiagnosticsResponse {
  destination: AudienceDestination;
  job: AudienceDestinationJob;
  diagnostics: AudienceDestinationJobDiagnostics;
}

export class AudienceDestinationsResource extends Resource {
  providers(): Promise<AudienceDestinationProvidersResponse> {
    return this.client.request(
      "GET",
      "/api/v1/audience-destinations/providers",
    );
  }

  list(provider?: string): Promise<AudienceDestinationListResponse> {
    return this.client.request("GET", "/api/v1/audience-destinations", {
      query: provider ? { provider } : undefined,
    });
  }

  get(id: string): Promise<AudienceDestination> {
    return this.client.request(
      "GET",
      `/api/v1/audience-destinations/${integrationPathSegment(id, "audience destination id")}`,
    );
  }

  create(input: AudienceDestinationCreateInput): Promise<AudienceDestination> {
    return this.client.request("POST", "/api/v1/audience-destinations", {
      body: input,
    });
  }

  update(
    id: string,
    input: AudienceDestinationUpdateInput,
  ): Promise<AudienceDestination> {
    return this.client.request(
      "PATCH",
      `/api/v1/audience-destinations/${integrationPathSegment(id, "audience destination id")}`,
      { body: input },
    );
  }

  disconnect(id: string): Promise<AudienceDestinationDisconnectResponse> {
    return this.client.request(
      "DELETE",
      `/api/v1/audience-destinations/${integrationPathSegment(id, "audience destination id")}`,
    );
  }

  readiness(
    provider: string,
    config: Record<string, unknown> = {},
  ): Promise<AudienceDestinationReadiness> {
    return this.client.request(
      "POST",
      `/api/v1/audience-destinations/${integrationPathSegment(provider, "audience destination provider")}/readiness`,
      { body: { config } },
    );
  }

  preview(id: string): Promise<AudienceDestinationPreview> {
    return this.client.request(
      "GET",
      `/api/v1/audience-destinations/${integrationPathSegment(id, "audience destination id")}/preview`,
    );
  }

  sync(id: string): Promise<AudienceDestinationSyncResponse> {
    return this.client.request(
      "POST",
      `/api/v1/audience-destinations/${integrationPathSegment(id, "audience destination id")}/sync`,
      { body: {} },
    );
  }

  jobs(id: string): Promise<AudienceDestinationJobsResponse> {
    return this.client.request(
      "GET",
      `/api/v1/audience-destinations/${integrationPathSegment(id, "audience destination id")}/jobs`,
    );
  }

  jobDiagnostics(
    id: string,
    jobId: string,
  ): Promise<AudienceDestinationJobDiagnosticsResponse> {
    return this.client.request(
      "GET",
      `/api/v1/audience-destinations/${integrationPathSegment(id, "audience destination id")}/jobs/${integrationPathSegment(jobId, "audience destination job id")}/diagnostics`,
    );
  }
}
