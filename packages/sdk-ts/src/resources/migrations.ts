import { Resource } from "./_base.js";
import type {
  AdapterCapabilities,
  AutomationRebuildItem,
  DiscoveryReport,
  MigrationJob,
  OAuthStartResponse,
  PilotAcceptanceReport,
  RollbackRehearsalReport,
  RollbackProgress,
  RollbackStartResponse,
  ShadowCheckResponse,
  ShadowMonitorResponse,
  SourceEventMonitorResponse,
  SourceEventRecord,
  SourcePlatform,
  VerificationReport,
} from "../types.js";

type CutoverEvidenceEntries = [string, ...string[]];

type CutoverEvidencePayload =
  | { detail: string; evidence?: CutoverEvidenceEntries }
  | { detail?: string; evidence: CutoverEvidenceEntries };

export type SourceEventReviewInput =
  | {
      status: "reviewed";
      /** Reconciliation detail, limited to 1,000 Unicode characters. */
      detail: string;
      /** One to 50 non-secret references, each limited to 500 Unicode characters. */
      evidence: [string, ...string[]];
    }
  | {
      status: "pending";
      detail?: never;
      evidence?: never;
    };

export const CUTOVER_EVIDENCE_KEYS = [
  "activecampaign_consent_exclusion_review",
  "activecampaign_deliverability_review",
  "activecampaign_automation_rebuild_review",
  "activecampaign_segments_review",
  "activecampaign_audience_schema_review",
  "activecampaign_campaign_archive_fidelity_review",
  "activecampaign_templates_review",
  "activecampaign_forms_review",
  "activecampaign_custom_objects_review",
  "activecampaign_ecommerce_review",
  "activecampaign_crm_archive_review",
  "activecampaign_post_pilot_cleanup",
  "beehiiv_consent_reconciliation",
  "beehiiv_segment_rules_review",
  "beehiiv_campaign_archive_fidelity",
  "beehiiv_automation_retirement_review",
  "beehiiv_website_capture_rebuild_review",
  "beehiiv_boosts_recommendations_rebuild_review",
  "beehiiv_ad_network_review",
  "klaviyo_consent_suppression_review",
  "klaviyo_audience_snapshot_review",
  "klaviyo_flow_rebuild_review",
  "klaviyo_channel_identity_review",
  "klaviyo_deliverability_review",
  "klaviyo_ecosystem_dependencies_review",
  "customerio_consent_subscription_review",
  "customerio_identity_audience_review",
  "customerio_automation_rebuild_review",
  "customerio_channel_dependency_review",
  "customerio_deliverability_review",
  "customerio_ecosystem_dependencies_review",
  "hubspot_crm_bridge_scope_review",
  "hubspot_post_pilot_cleanup",
  "sms_readiness",
  "source_discovery_warnings",
  "source_archive_warnings",
] as const;

export type CutoverEvidenceKey = (typeof CUTOVER_EVIDENCE_KEYS)[number];

export type CutoverEvidenceInput = {
  key: CutoverEvidenceKey;
  status?: "pass" | "warning" | "blocker";
} & CutoverEvidencePayload;

export interface SourceSessionRefreshInput {
  /** Klaviyo private API key, Customer.io App API key, ActiveCampaign API token, HubSpot private app token, Beehiiv API key, or secret for another credential-based source. */
  api_key?: string;
  /** Caller-managed access token. For Klaviyo this selects Bearer auth; it is not a Moosewave-managed migration OAuth flow. */
  access_token?: string;
  /** Optional caller-managed refresh-token evidence. Supply a fresh access_token when refreshing the source session. */
  refresh_token?: string;
  /** Klaviyo account ID, Customer.io workspace ID, ActiveCampaign account API URL, optional HubSpot hub ID, or Beehiiv publication ID. Account-bound refreshes must preserve the original binding. */
  account_id?: string;
  /** Klaviyo accepts klaviyo_account_id; Customer.io accepts region=us|eu and workspace identity aliases; ActiveCampaign accepts API URL aliases; HubSpot accepts hub_id/portal_id; Beehiiv accepts publication_id. */
  extra?: Record<string, string>;
}

type MigrationCredentialBinding = {
  account_id?: string;
  extra?: Record<string, string>;
};

/**
 * Credential handoff for a migration source. Klaviyo's API supports either a
 * private key or a caller-managed bearer token; interactive Moosewave surfaces
 * intentionally expose only the private-key path.
 */
export type MigrationCredentialInput = MigrationCredentialBinding &
  (
    | {
        api_key: string;
        access_token?: never;
        refresh_token?: never;
      }
    | {
        api_key?: never;
        access_token: string;
        refresh_token?: string;
      }
  );

const MIGRATION_SOURCES = new Set<string>([
  "mailchimp",
  "klaviyo",
  "customerio",
  "constant-contact",
  "aweber",
  "drip",
  "campaign-monitor",
  "omnisend",
  "loops",
  "flodesk",
  "bento",
  "activecampaign",
  "hubspot",
  "convertkit",
  "brevo",
  "substack",
  "beehiiv",
  "mailerlite",
  "sendy",
  "csv",
]);

export function migrationSourcePathSegment(source: SourcePlatform): string {
  if (!MIGRATION_SOURCES.has(source)) {
    throw new Error(`Unsupported migration source: ${source}`);
  }
  return encodeURIComponent(source);
}

export function migrationJobPathSegment(jobId: string): string {
  const trimmed = jobId.trim();
  if (!trimmed) {
    throw new Error("Migration job ID is required");
  }
  return encodeURIComponent(trimmed);
}

export function migrationSourceEventPathSegment(eventId: string): string {
  const trimmed = eventId.trim();
  if (!trimmed) {
    throw new Error("Migration source-event result ID is required");
  }
  return encodeURIComponent(trimmed);
}

export function migrationUploadPathSegment(uploadId: string): string {
  const trimmed = uploadId.trim();
  if (!trimmed) {
    throw new Error("Migration upload ID is required");
  }
  return encodeURIComponent(trimmed);
}

export interface MigrationUploadStatus {
  upload_id: string;
  received: number;
  total: number;
  updated_at: string;
}

function migrationRunBody(
  source: SourcePlatform,
  jobId: string,
  selectedAudienceIds: readonly string[] | undefined,
  requireMailchimpScope: boolean,
): { job_id: string; selected_audience_ids?: string[] } {
  if (
    requireMailchimpScope &&
    source === "mailchimp" &&
    (!selectedAudienceIds || selectedAudienceIds.length === 0)
  ) {
    throw new Error(
      "Mailchimp dry-run and commit require at least one selected audience ID",
    );
  }
  const body: { job_id: string; selected_audience_ids?: string[] } = {
    job_id: jobId,
  };
  if (selectedAudienceIds !== undefined) {
    body.selected_audience_ids = [...selectedAudienceIds];
  }
  return body;
}

/** Migrations: Mailchimp, Klaviyo, Customer.io, ActiveCampaign, HubSpot, ConvertKit, Brevo, Beehiiv, Substack, MailerLite, Sendy, CSV, and CSV-export backed ESP sources. */
export class MigrationsResource extends Resource {
  /** Read the authoritative server offset before resuming a file upload. */
  uploadStatus(
    source: SourcePlatform,
    uploadId: string,
  ): Promise<MigrationUploadStatus> {
    return this.client.request(
      "GET",
      `/api/v1/migrations/${migrationSourcePathSegment(source)}/uploads/${migrationUploadPathSegment(uploadId)}`,
    );
  }

  /**
   * Begin OAuth handshake; returns the authorize URL to send the user to.
   * Pass an existing, non-running job ID to reconnect OAuth to that same job.
   */
  start(source: SourcePlatform, jobId?: string): Promise<OAuthStartResponse> {
    const reconnectJobId = jobId?.trim();
    if (jobId !== undefined && !reconnectJobId) {
      throw new Error("Migration job ID is required for OAuth reconnect");
    }
    return this.client.request(
      "POST",
      `/api/v1/migrations/${migrationSourcePathSegment(source)}/oauth/start`,
      {
        query: reconnectJobId ? { job_id: reconnectJobId } : undefined,
      },
    );
  }

  /** Complete OAuth — typically called by the gateway, exposed for tests. */
  callback(
    source: SourcePlatform,
    code: string,
    state: string,
  ): Promise<{ job_id: string; account_id: string }> {
    return this.client.request(
      "GET",
      `/api/v1/migrations/${migrationSourcePathSegment(source)}/oauth/callback`,
      {
        query: { code, state },
      },
    );
  }

  /** Create a migration job for credential-based sources. Customer.io uses an App API key plus extra.region=us|eu and an account_id workspace selection when the key exposes multiple workspaces; the same unrolled-back region/workspace lineage must be reused. Klaviyo accepts a private api_key or a caller-managed access_token bearer; this does not initiate managed OAuth. An existing unrolled-back Klaviyo tenant/account lineage must refresh and run deltas on its original job; creating a second same-account job is rejected. For ActiveCampaign, send api_key plus the account API URL. For HubSpot, send the private app token and optional hub ID. For Beehiiv, send the API key and an optional account_id/extra.publication_id; selection is required when the credential can access multiple publications. */
  credentials(
    source: SourcePlatform,
    input: MigrationCredentialInput,
  ): Promise<{ job_id: string; account_id: string }> {
    return this.client.request(
      "POST",
      `/api/v1/migrations/${migrationSourcePathSegment(source)}/credentials`,
      { body: input },
    );
  }

  /** Pre-flight inventory of what's in the source account. */
  discover(
    source: SourcePlatform,
    jobId: string,
    selectedAudienceIds?: readonly string[],
  ): Promise<DiscoveryReport> {
    return this.client.request(
      "POST",
      `/api/v1/migrations/${migrationSourcePathSegment(source)}/discover`,
      {
        body: migrationRunBody(source, jobId, selectedAudienceIds, false),
      },
    );
  }

  /** Kick off a dry-run migration (verification report only). */
  dryRun(
    source: SourcePlatform,
    jobId: string,
    selectedAudienceIds?: readonly string[],
  ): Promise<{ job_id: string }> {
    return this.client.request(
      "POST",
      `/api/v1/migrations/${migrationSourcePathSegment(source)}/dry-run`,
      {
        body: migrationRunBody(source, jobId, selectedAudienceIds, true),
      },
    );
  }

  /** Run the full migration into Moosewave. */
  commit(
    source: SourcePlatform,
    jobId: string,
    selectedAudienceIds?: readonly string[],
  ): Promise<{ job_id: string }> {
    return this.client.request(
      "POST",
      `/api/v1/migrations/${migrationSourcePathSegment(source)}/commit`,
      {
        body: migrationRunBody(source, jobId, selectedAudienceIds, true),
      },
    );
  }

  /** Replay an authenticated job to import source-side changes since the last run. */
  deltaImport(
    source: SourcePlatform,
    jobId: string,
  ): Promise<{ job_id: string; mode: string }> {
    return this.client.request(
      "POST",
      `/api/v1/migrations/${migrationSourcePathSegment(source)}/delta-import`,
      { body: { job_id: jobId } },
    );
  }

  /** Compare current source inventory with the latest verification report. */
  shadowCheck(
    source: SourcePlatform,
    jobId: string,
  ): Promise<ShadowCheckResponse> {
    return this.client.request(
      "POST",
      `/api/v1/migrations/${migrationSourcePathSegment(source)}/shadow-check`,
      { body: { job_id: jobId } },
    );
  }

  /** Enable periodic shadow checks during a customer pilot overlap window. */
  startShadowMonitor(
    source: SourcePlatform,
    jobId: string,
    intervalSeconds = 3600,
  ): Promise<ShadowMonitorResponse> {
    return this.client.request(
      "POST",
      `/api/v1/migrations/sources/${migrationSourcePathSegment(source)}/shadow-monitor`,
      {
        body: { job_id: jobId, interval_seconds: intervalSeconds },
      },
    );
  }

  shadowMonitor(jobId: string): Promise<ShadowMonitorResponse> {
    return this.client.request(
      "GET",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}/shadow-monitor`,
    );
  }

  stopShadowMonitor(
    jobId: string,
  ): Promise<{ job_id: string; enabled: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}/shadow-monitor`,
    );
  }

  /** Enable incremental source-event polling for adapters such as ActiveCampaign, HubSpot, or Klaviyo. */
  startSourceEvents(
    source: SourcePlatform,
    jobId: string,
    intervalSeconds = 3600,
  ): Promise<SourceEventMonitorResponse> {
    return this.client.request(
      "POST",
      `/api/v1/migrations/sources/${migrationSourcePathSegment(source)}/source-events`,
      {
        body: { job_id: jobId, interval_seconds: intervalSeconds },
      },
    );
  }

  sourceEvents(jobId: string): Promise<SourceEventMonitorResponse> {
    return this.client.request(
      "GET",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}/source-events`,
    );
  }

  stopSourceEvents(
    jobId: string,
    postPilotCleanup = false,
  ): Promise<{
    job_id: string;
    enabled: boolean;
    source_session_cleared: boolean;
  }> {
    return this.client.request(
      "DELETE",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}/source-events`,
      { query: postPilotCleanup ? { post_pilot_cleanup: "1" } : undefined },
    );
  }

  /** Attach up to 50 auditable references to an intentionally unapplied manual-review event, or reopen it. */
  updateSourceEventReview(
    jobId: string,
    eventId: string,
    input: SourceEventReviewInput,
  ): Promise<SourceEventRecord> {
    return this.client.request(
      "PATCH",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}/source-events/${migrationSourceEventPathSegment(eventId)}/review`,
      { body: input },
    );
  }

  /** Poll a migration job. */
  get(jobId: string): Promise<MigrationJob> {
    return this.client.request(
      "GET",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}`,
    );
  }

  /** Refresh the encrypted source session for an existing job without creating a new migration. */
  refreshSourceSession(
    jobId: string,
    input: SourceSessionRefreshInput,
  ): Promise<MigrationJob> {
    return this.client.request(
      "POST",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}/source-session`,
      { body: input },
    );
  }

  /** List recent migration jobs for the tenant. */
  list(): Promise<MigrationJob[]> {
    return this.client.request("GET", `/api/v1/migrations`);
  }

  verification(jobId: string): Promise<VerificationReport> {
    return this.client.request(
      "GET",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}/verification`,
    );
  }

  pilotAcceptance(jobId: string): Promise<PilotAcceptanceReport> {
    return this.client.request(
      "GET",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}/pilot-acceptance`,
    );
  }

  recordCutoverEvidence(
    jobId: string,
    input: CutoverEvidenceInput,
  ): Promise<PilotAcceptanceReport> {
    return this.client.request(
      "PATCH",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}/cutover-evidence`,
      { body: input },
    );
  }

  rollbackRehearsal(jobId: string): Promise<RollbackRehearsalReport> {
    return this.client.request(
      "GET",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}/rollback-rehearsal`,
    );
  }

  automationRebuilds(
    jobId: string,
  ): Promise<{ items: AutomationRebuildItem[] }> {
    return this.client.request(
      "GET",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}/automation-rebuilds`,
    );
  }

  updateAutomationRebuild(
    jobId: string,
    item: AutomationRebuildItem,
  ): Promise<AutomationRebuildItem> {
    return this.client.request(
      "PATCH",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}/automation-rebuilds`,
      { body: item },
    );
  }

  /**
   * Start rollback for an eligible completed, cancelled, or partially failed
   * migration within its rollback window. Poll rollbackStatus for progress.
   */
  rollback(jobId: string): Promise<RollbackStartResponse> {
    return this.client.request(
      "POST",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}/rollback`,
    );
  }

  rollbackStatus(jobId: string): Promise<RollbackProgress> {
    return this.client.request(
      "GET",
      `/api/v1/migrations/${migrationJobPathSegment(jobId)}/rollback-status`,
    );
  }

  /** Adapter capability matrix. */
  listSources(): Promise<AdapterCapabilities[]> {
    return this.client.request("GET", `/api/v1/migrations/sources`);
  }
}
