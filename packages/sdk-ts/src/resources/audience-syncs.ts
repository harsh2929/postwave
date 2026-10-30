// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";
import { integrationPathSegment } from "./integrations.js";

export type AudienceSyncSchedule = "manual" | "hourly" | "daily" | string;

export interface AudienceSyncSource {
  list_id?: string | null;
  segment_id?: string | null;
}

export interface AudienceSyncDestination {
  type?: string;
  url?: string;
  secret?: string;
  secret_set?: boolean;
  secret_hint?: string;
  config?: Record<string, unknown>;
}

export interface AudienceSync {
  id: string;
  name: string;
  source: AudienceSyncSource;
  destination: AudienceSyncDestination;
  schedule: AudienceSyncSchedule;
  enabled: boolean;
  last_run_at?: string | null;
  last_run_status?: string;
  required_consent_purpose?: string;
  created_at: string;
  updated_at: string;
}

export interface AudienceSyncRun {
  id: string;
  sync_id: string;
  status: "running" | "succeeded" | "failed" | string;
  rows_exported: number;
  batches_sent: number;
  started_at: string;
  finished_at?: string | null;
  error?: string;
  external_job_id?: string;
  external_audience_id?: string;
  provider_message?: string;
  provider_status?: string;
  provider_checked_at?: string | null;
  provider_next_check_at?: string | null;
  provider_poll_attempts?: number;
  excluded_count: number;
}

export interface AudienceSyncListResponse {
  items: AudienceSync[];
}

export interface AudienceSyncRunsResponse {
  items: AudienceSyncRun[];
}

export interface AudienceSyncCreateInput {
  name: string;
  source: AudienceSyncSource;
  destination: AudienceSyncDestination;
  schedule: AudienceSyncSchedule;
  enabled?: boolean;
}

export interface AudienceSyncUpdateInput {
  name?: string;
  source?: AudienceSyncSource;
  destination?: AudienceSyncDestination;
  schedule?: AudienceSyncSchedule;
  enabled?: boolean;
}

export class AudienceSyncsResource extends Resource {
  list(): Promise<AudienceSyncListResponse> {
    return this.client.request("GET", "/api/v1/audience-syncs");
  }

  get(id: string): Promise<AudienceSync> {
    return this.client.request(
      "GET",
      `/api/v1/audience-syncs/${integrationPathSegment(id, "audience sync id")}`,
    );
  }

  create(input: AudienceSyncCreateInput): Promise<AudienceSync> {
    return this.client.request("POST", "/api/v1/audience-syncs", {
      body: input,
    });
  }

  update(id: string, input: AudienceSyncUpdateInput): Promise<AudienceSync> {
    return this.client.request(
      "PATCH",
      `/api/v1/audience-syncs/${integrationPathSegment(id, "audience sync id")}`,
      { body: input },
    );
  }

  delete(id: string): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/audience-syncs/${integrationPathSegment(id, "audience sync id")}`,
    );
  }

  run(id: string): Promise<AudienceSyncRun> {
    return this.client.request(
      "POST",
      `/api/v1/audience-syncs/${integrationPathSegment(id, "audience sync id")}/run`,
    );
  }

  runs(id: string): Promise<AudienceSyncRunsResponse> {
    return this.client.request(
      "GET",
      `/api/v1/audience-syncs/${integrationPathSegment(id, "audience sync id")}/runs`,
    );
  }
}
