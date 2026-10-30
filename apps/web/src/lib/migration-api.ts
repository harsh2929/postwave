// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed wrappers around the migration HTTP endpoints. All calls go through
// `api` from `./api`. `migration-mocks` are used only when explicit mock mode
// is enabled.

import { ApiError, api } from "./api";
import { isMockModeEnabled } from "./mock-mode";
import {
  isTerminal,
  type AdapterCapabilities,
  type AutomationRebuildItem,
  type AuditEntry,
  type DiscoveryReport,
  type MigrationJob,
  type PilotAcceptanceReport,
  type RollbackStatus,
  type ShadowMonitorResponse,
  type SourceEventMonitorResponse,
  type SourceEventRecord,
  type SourcePlatform,
  type VerificationReport,
} from "./types";

const USE_MOCKS = isMockModeEnabled();
const MIGRATIONS_BASE = "/api/v1/migrations";
const loadMocks = () => import("./migration-mocks");

function migrationJobPath(jobId: string): string {
  return `${MIGRATIONS_BASE}/${encodeURIComponent(jobId)}`;
}

async function withMockFallback<T>(
  realCall: () => Promise<T>,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (USE_MOCKS) return await fallback();
  return realCall();
}

export interface OAuthStartResponse {
  authorize_url: string;
  state: string;
}

export function listCapabilities(
  signal?: AbortSignal,
): Promise<AdapterCapabilities[]> {
  return withMockFallback(
    () =>
      api.get<AdapterCapabilities[]>(`${MIGRATIONS_BASE}/sources`, {
        signal,
        requireOnline: true,
        maxAttempts: 1,
      }),
    async () => (await loadMocks()).mockCapabilities(),
  );
}

export function startOAuth(
  source: SourcePlatform,
  jobId?: string,
  signal?: AbortSignal,
): Promise<OAuthStartResponse> {
  const suffix = jobId ? `?job_id=${encodeURIComponent(jobId)}` : "";
  return withMockFallback(
    () =>
      api.post<OAuthStartResponse>(
        `${MIGRATIONS_BASE}/${source}/oauth/start${suffix}`,
        undefined,
        { signal, requireOnline: true, maxAttempts: 1 },
      ),
    () => ({
      authorize_url: `/migrations/oauth/callback?code=mock_code&state=mock_state&source=${source}`,
      state: "mock_state",
    }),
  );
}

export function completeOAuth(
  source: SourcePlatform,
  code: string,
  state: string,
  signal?: AbortSignal,
): Promise<{ job_id: string; account_id: string }> {
  return withMockFallback(
    () =>
      api.get<{ job_id: string; account_id: string }>(
        `${MIGRATIONS_BASE}/${source}/oauth/callback`,
        {
          query: { code, state },
          signal,
          requireOnline: true,
          maxAttempts: 1,
        },
      ),
    async () => ({
      job_id: (await loadMocks()).mockStartJob(source, "awaiting_confirmation")
        .id,
      account_id: "mock",
    }),
  );
}

export function connectWithApiKey(
  source: SourcePlatform,
  apiKey: string,
  accountId?: string,
  extra?: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ job_id: string; account_id: string }> {
  return withMockFallback(
    () =>
      api.post<{ job_id: string; account_id: string }>(
        `${MIGRATIONS_BASE}/${source}/credentials`,
        {
          api_key: apiKey,
          account_id: accountId,
          extra: migrationCredentialExtra(source, accountId, extra),
        },
        { signal, requireOnline: true, maxAttempts: 1 },
      ),
    async () => ({
      job_id: (await loadMocks()).mockStartJob(source, "awaiting_confirmation")
        .id,
      account_id: accountId ?? "mock",
    }),
  );
}

export interface MigrationSourceCleanupResponse {
  job: MigrationJob;
  stored_source_data_removed: boolean;
  provider_access_revoked: false;
}

export function removeMigrationSourceData(
  jobId: string,
  signal?: AbortSignal,
): Promise<MigrationSourceCleanupResponse> {
  return api.delete<MigrationSourceCleanupResponse>(
    `${migrationJobPath(jobId)}/source-session`,
    { signal, requireOnline: true, maxAttempts: 1 },
  );
}

export function refreshSourceSessionWithApiKey(
  jobId: string,
  source: SourcePlatform,
  apiKey: string,
  accountId?: string,
  extra?: Record<string, string>,
  signal?: AbortSignal,
): Promise<MigrationJob> {
  return withMockFallback(
    () =>
      api.post<MigrationJob>(
        `${migrationJobPath(jobId)}/source-session`,
        {
          api_key: apiKey,
          account_id: accountId,
          extra: migrationCredentialExtra(source, accountId, extra),
        },
        { signal, requireOnline: true, maxAttempts: 1 },
      ),
    async () => ({
      ...(await loadMocks()).mockGetJob(jobId),
      source,
      source_session_expires_at: new Date(
        Date.now() + 90 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    }),
  );
}

function migrationCredentialExtra(
  source: SourcePlatform,
  accountId?: string,
  extra?: Record<string, string>,
): Record<string, string> | undefined {
  const sourceBinding =
    source === "beehiiv" && accountId
      ? { publication_id: accountId }
      : source === "activecampaign" && accountId
        ? { api_url: accountId }
        : source === "hubspot" && accountId
          ? { hub_id: accountId }
          : {};
  const merged = Object.fromEntries(
    Object.entries({ ...sourceBinding, ...extra }).filter(
      ([, value]) => typeof value === "string" && value.trim() !== "",
    ),
  );
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function connectWithFile(
  source: SourcePlatform,
  fileName: string,
): Promise<{ job_id: string; account_id: string }> {
  return withMockFallback(
    () =>
      api.post<{ job_id: string; account_id: string }>(
        `${MIGRATIONS_BASE}/${source}/credentials`,
        {
          api_key: "local-upload",
          account_id: fileName,
          extra: { file_name: fileName },
        },
      ),
    async () => ({
      job_id: (await loadMocks()).mockStartJob(source, "awaiting_confirmation")
        .id,
      account_id: fileName,
    }),
  );
}

export interface ResumableUploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  uploadId: string;
}

export interface MigrationUploadOptions {
  signal?: AbortSignal;
  /** Stable tenant/user/effective-role/viewer-mode scope for resume isolation. */
  scopeKey?: string;
}

interface UploadLedger {
  uploadId: string;
  uploadedBytes: number;
  updatedAt: number;
}

const UPLOAD_CHUNK_SIZE = 512 * 1024;
const UPLOAD_LEDGER_PREFIX = "postwave.web.migration-upload.v1:";
const MAX_UPLOAD_LEDGER_BYTES = 8 * 1024;
const MAX_UPLOAD_FILENAME_CHARS = 180;
const UPLOAD_LEDGER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function uploadMigrationFile(
  source: SourcePlatform,
  file: File,
  onProgress?: (progress: ResumableUploadProgress) => void,
  options: MigrationUploadOptions = {},
): Promise<{ job_id: string; account_id: string }> {
  options.signal?.throwIfAborted();
  if (USE_MOCKS) return connectWithFile(source, file.name);
  const ledgerKey = uploadLedgerKey(source, file, options.scopeKey);
  const ledger = readUploadLedger(ledgerKey);
  const uploadId = ledger?.uploadId ?? newUploadID();
  const filename = safeUploadFilename(file.name);
  let offset = 0;
  if (ledger) {
    try {
      const status = await api.get<{ received: number; total: number }>(
        `${MIGRATIONS_BASE}/${source}/uploads/${encodeURIComponent(uploadId)}`,
        {
          signal: options.signal,
          requireOnline: true,
          maxAttempts: 1,
        },
      );
      options.signal?.throwIfAborted();
      if (status.total !== file.size) {
        throw new Error("The saved upload does not match the selected file.");
      }
      if (!Number.isFinite(status.received)) {
        throw new Error("The upload server returned an invalid resume offset.");
      }
      offset = Math.min(Math.max(status.received, 0), file.size);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
      // The server no longer has the temporary upload. Reusing the opaque ID
      // from byte zero is safe and prevents a local ledger from skipping data.
    }
  }
  writeUploadLedger(ledgerKey, {
    uploadId,
    uploadedBytes: offset,
    updatedAt: Date.now(),
  });

  if (offset > 0) {
    onProgress?.({ uploadedBytes: offset, totalBytes: file.size, uploadId });
  }
  while (offset < file.size) {
    options.signal?.throwIfAborted();
    const end = Math.min(offset + UPLOAD_CHUNK_SIZE, file.size) - 1;
    const chunk = file.slice(offset, end + 1);
    const acknowledged = await putUploadChunk(
      source,
      uploadId,
      filename,
      chunk,
      offset,
      end,
      file.size,
      options.signal,
    );
    options.signal?.throwIfAborted();
    const expectedOffset = end + 1;
    if (acknowledged !== undefined && acknowledged !== expectedOffset) {
      throw new Error(
        `The upload server acknowledged byte ${acknowledged}, expected ${expectedOffset}.`,
      );
    }
    offset = expectedOffset;
    writeUploadLedger(ledgerKey, {
      uploadId,
      uploadedBytes: offset,
      updatedAt: Date.now(),
    });
    onProgress?.({ uploadedBytes: offset, totalBytes: file.size, uploadId });
  }

  const result = await api.post<{ job_id: string; account_id: string }>(
    `${MIGRATIONS_BASE}/${source}/uploads/${encodeURIComponent(uploadId)}/complete`,
    undefined,
    {
      signal: options.signal,
      requireOnline: true,
      maxAttempts: 1,
    },
  );
  options.signal?.throwIfAborted();
  clearUploadID(ledgerKey);
  return result;
}

async function putUploadChunk(
  source: SourcePlatform,
  uploadId: string,
  filename: string,
  chunk: Blob,
  start: number,
  end: number,
  total: number,
  signal?: AbortSignal,
): Promise<number | undefined> {
  const params = new URLSearchParams({ filename });
  const ack = await api.putRaw<{ received?: unknown }>(
    `${MIGRATIONS_BASE}/${source}/uploads/${encodeURIComponent(uploadId)}?${params}`,
    chunk,
    {
      maxAttempts: 1,
      requireOnline: true,
      signal,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Range": `bytes ${start}-${end}/${total}`,
      },
    },
  );
  return typeof ack?.received === "number" && Number.isFinite(ack.received)
    ? ack.received
    : undefined;
}

function uploadLedgerKey(
  source: SourcePlatform,
  file: File,
  scopeKey?: string,
): string {
  const scope = encodeURIComponent(scopeKey ?? "legacy");
  return `${UPLOAD_LEDGER_PREFIX}${scope}:${source}:${uploadLedgerFingerprint(
    file.name,
    file.size,
    file.lastModified,
  )}:${file.size}:${file.lastModified}`;
}

/** Remove only resumable migration-upload metadata; never touches other keys. */
export function clearMigrationUploadLedgers(): void {
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(UPLOAD_LEDGER_PREFIX)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Storage may be blocked. In-memory component state is still discarded.
  }
}

function uploadLedgerFingerprint(
  filename: string,
  size: number,
  lastModified: number,
): string {
  let hash = 2166136261;
  const value = `${filename}:${size}:${lastModified}`;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function safeUploadFilename(filename: string): string {
  const basename = (filename.split(/[\\/]/).pop() ?? "").trim() || "upload.csv";
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[?#&=]/g, "_")
    .replace(/\s+/g, " ");
  return cleaned.slice(0, MAX_UPLOAD_FILENAME_CHARS) || "upload.csv";
}

function readUploadLedger(key: string): UploadLedger | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    if (storageByteLength(raw) > MAX_UPLOAD_LEDGER_BYTES) {
      window.localStorage.removeItem(key);
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<UploadLedger>;
      if (
        typeof parsed.uploadId !== "string" ||
        parsed.uploadId.trim() === "" ||
        typeof parsed.updatedAt !== "number" ||
        !Number.isFinite(parsed.updatedAt) ||
        Date.now() - parsed.updatedAt > UPLOAD_LEDGER_MAX_AGE_MS
      ) {
        window.localStorage.removeItem(key);
        return null;
      }
      return {
        uploadId: parsed.uploadId,
        uploadedBytes:
          typeof parsed.uploadedBytes === "number" &&
          Number.isFinite(parsed.uploadedBytes)
            ? parsed.uploadedBytes
            : 0,
        updatedAt: parsed.updatedAt,
      };
    } catch {
      // Backward compatibility with the old ledger value that stored only
      // the upload id string.
      window.localStorage.removeItem(key);
      return null;
    }
  } catch {
    return null;
  }
}

function writeUploadLedger(key: string, ledger: UploadLedger): void {
  try {
    const payload = JSON.stringify(ledger);
    if (storageByteLength(payload) > MAX_UPLOAD_LEDGER_BYTES) return;
    window.localStorage.setItem(key, payload);
  } catch {
    /* ignore */
  }
}

function storageByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function clearUploadID(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function newUploadID(): string {
  const c: Crypto | undefined =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return `upload-${Array.from(bytes, (b: number) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  return `upload-${Date.now().toString(36)}`;
}

export function discover(
  source: SourcePlatform,
  jobId: string,
  selectedAudienceIds?: string[],
  signal?: AbortSignal,
): Promise<DiscoveryReport> {
  return withMockFallback(
    () =>
      api.post<DiscoveryReport>(
        `${MIGRATIONS_BASE}/${source}/discover`,
        {
          job_id: jobId,
          ...(selectedAudienceIds
            ? { selected_audience_ids: selectedAudienceIds }
            : {}),
        },
        { signal, requireOnline: true, maxAttempts: 1 },
      ),
    async () => (await loadMocks()).mockDiscovery(source),
  );
}

export function dryRun(
  source: SourcePlatform,
  jobId: string,
  selectedAudienceIds?: string[],
  signal?: AbortSignal,
): Promise<{ job_id: string }> {
  requireMailchimpAudienceScope(source, selectedAudienceIds, "dry-run");
  return withMockFallback(
    () =>
      api.post<{ job_id: string }>(
        `${MIGRATIONS_BASE}/${source}/dry-run`,
        {
          job_id: jobId,
          ...(selectedAudienceIds
            ? { selected_audience_ids: selectedAudienceIds }
            : {}),
        },
        { signal, requireOnline: true, maxAttempts: 1 },
      ),
    async () => ({
      job_id: (await loadMocks()).mockStartJob(source, "awaiting_confirmation")
        .id,
    }),
  );
}

export function commit(
  source: SourcePlatform,
  jobId: string,
  selectedAudienceIds?: string[],
  // MIGR-038: optional ISO instant to defer the import until (off-peak).
  scheduledFor?: string,
  signal?: AbortSignal,
): Promise<{ job_id: string }> {
  requireMailchimpAudienceScope(source, selectedAudienceIds, "commit");
  return withMockFallback(
    () =>
      api.post<{ job_id: string }>(
        `${MIGRATIONS_BASE}/${source}/commit`,
        {
          job_id: jobId,
          ...(selectedAudienceIds
            ? { selected_audience_ids: selectedAudienceIds }
            : {}),
          ...(scheduledFor ? { scheduled_for: scheduledFor } : {}),
        },
        { signal, requireOnline: true, maxAttempts: 1 },
      ),
    async () => ({
      job_id: (await loadMocks()).mockStartJob(source, "importing").id,
    }),
  );
}

function requireMailchimpAudienceScope(
  source: SourcePlatform,
  selectedAudienceIds: string[] | undefined,
  action: "dry-run" | "commit",
): void {
  if (source === "mailchimp" && (selectedAudienceIds?.length ?? 0) === 0) {
    throw new Error(
      `Mailchimp ${action} requires at least one explicit audience selection.`,
    );
  }
}

export function deltaImport(
  source: SourcePlatform,
  jobId: string,
  // MIGR-038: optional ISO instant to defer the delta import until.
  scheduledFor?: string,
): Promise<{ job_id: string; mode: string }> {
  return withMockFallback(
    () =>
      api.post<{ job_id: string; mode: string }>(
        `${MIGRATIONS_BASE}/${source}/delta-import`,
        {
          job_id: jobId,
          ...(scheduledFor ? { scheduled_for: scheduledFor } : {}),
        },
      ),
    async () => ({
      job_id: (await loadMocks()).mockStartJob(source, "importing").id,
      mode: "delta_import",
    }),
  );
}

export function getJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<MigrationJob> {
  return withMockFallback(
    () =>
      api.get<MigrationJob>(migrationJobPath(jobId), {
        signal,
        requireOnline: true,
        maxAttempts: 1,
      }),
    async () => (await loadMocks()).mockGetJob(jobId),
  );
}

export function listJobs(signal?: AbortSignal): Promise<MigrationJob[]> {
  return withMockFallback(
    () =>
      api.get<MigrationJob[]>(MIGRATIONS_BASE, {
        signal,
        requireOnline: true,
        maxAttempts: 1,
      }),
    async () => (await loadMocks()).mockListJobs(),
  );
}

// MIGR-037: name/annotate a migration. Absent fields are left unchanged; an
// empty string clears the column. Returns the updated job.
export function updateMigrationJob(
  jobId: string,
  patch: { label?: string; notes?: string },
): Promise<MigrationJob> {
  return withMockFallback(
    () => api.patch<MigrationJob>(migrationJobPath(jobId), patch),
    async () => ({ ...(await loadMocks()).mockGetJob(jobId), ...patch }),
  );
}

export function getVerification(
  jobId: string,
  signal?: AbortSignal,
): Promise<VerificationReport> {
  return withMockFallback(
    () =>
      api.get<VerificationReport>(`${migrationJobPath(jobId)}/verification`, {
        signal,
        requireOnline: true,
        maxAttempts: 1,
      }),
    async () => (await loadMocks()).mockVerification(jobId),
  );
}

export function getPilotAcceptance(
  jobId: string,
): Promise<PilotAcceptanceReport> {
  return withMockFallback(
    () =>
      api.get<PilotAcceptanceReport>(
        `${migrationJobPath(jobId)}/pilot-acceptance`,
      ),
    async () => ({
      job_id: jobId,
      source: "activecampaign",
      generated_at: new Date().toISOString(),
      status: "warning",
      blockers: 0,
      warnings: 1,
      items: [
        {
          key: "mock",
          label: "Mock acceptance",
          status: "warning",
          detail: "Mock data only.",
        },
      ],
    }),
  );
}

type CutoverEvidenceEntries = [string, ...string[]];

type CutoverEvidencePayload =
  | { detail: string; evidence?: CutoverEvidenceEntries }
  | { detail?: string; evidence: CutoverEvidenceEntries };

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

const CUTOVER_EVIDENCE_LABELS: Record<CutoverEvidenceKey, string> = {
  activecampaign_consent_exclusion_review:
    "ActiveCampaign consent/exclusion/contact-identity review",
  activecampaign_deliverability_review: "ActiveCampaign deliverability review",
  activecampaign_automation_rebuild_review:
    "ActiveCampaign automation rebuild review",
  activecampaign_segments_review: "ActiveCampaign segment review",
  activecampaign_templates_review: "ActiveCampaign templates/messages review",
  activecampaign_forms_review: "ActiveCampaign forms review",
  activecampaign_custom_objects_review: "ActiveCampaign custom objects review",
  activecampaign_ecommerce_review: "ActiveCampaign ecommerce review",
  activecampaign_crm_archive_review: "ActiveCampaign CRM archive review",
  activecampaign_post_pilot_cleanup:
    "ActiveCampaign post-pilot credential cleanup authorization",
  beehiiv_consent_reconciliation:
    "Beehiiv consent and suppression reconciliation",
  beehiiv_segment_rules_review: "Beehiiv dynamic segment rules review",
  beehiiv_campaign_archive_fidelity: "Beehiiv campaign archive fidelity review",
  beehiiv_automation_retirement_review:
    "Beehiiv source-automation retirement review",
  beehiiv_website_capture_rebuild_review:
    "Beehiiv website/theme/capture rebuild review",
  beehiiv_boosts_recommendations_rebuild_review:
    "Beehiiv Boosts/recommendations rebuild review",
  beehiiv_ad_network_review: "Beehiiv Ad Network review",
  klaviyo_consent_suppression_review:
    "Klaviyo profile identity, consent, and suppression review",
  klaviyo_audience_snapshot_review: "Klaviyo list and segment snapshot review",
  klaviyo_flow_rebuild_review: "Klaviyo flow rebuild review",
  klaviyo_channel_identity_review: "Klaviyo channel identity and sender review",
  klaviyo_deliverability_review: "Klaviyo deliverability review",
  klaviyo_ecosystem_dependencies_review: "Klaviyo ecosystem dependency review",
  customerio_consent_subscription_review:
    "Customer.io consent and subscription review",
  customerio_identity_audience_review:
    "Customer.io profile identity and audience review",
  customerio_automation_rebuild_review:
    "Customer.io campaign and broadcast rebuild review",
  customerio_channel_dependency_review:
    "Customer.io channel identity and dependency review",
  customerio_deliverability_review: "Customer.io deliverability review",
  customerio_ecosystem_dependencies_review:
    "Customer.io ecosystem dependency review",
  hubspot_crm_bridge_scope_review: "HubSpot CRM-bridge scope review",
  hubspot_post_pilot_cleanup:
    "HubSpot post-pilot source-session cleanup authorization",
  activecampaign_audience_schema_review:
    "ActiveCampaign audience field/tag schema review",
  activecampaign_campaign_archive_fidelity_review:
    "ActiveCampaign campaign archive fidelity review",
  sms_readiness: "SMS pilot readiness",
  source_discovery_warnings: "Source discovery warnings",
  source_archive_warnings: "Source archive warnings",
};

export function recordCutoverEvidence(
  jobId: string,
  input: CutoverEvidenceInput,
): Promise<PilotAcceptanceReport> {
  const label = cutoverEvidenceLabel(input.key);
  return withMockFallback(
    () =>
      api.patch<PilotAcceptanceReport>(
        `${migrationJobPath(jobId)}/cutover-evidence`,
        input,
      ),
    async () => ({
      job_id: jobId,
      source: "activecampaign",
      generated_at: new Date().toISOString(),
      status: "pass",
      blockers: 0,
      warnings: 0,
      items: [
        {
          key: input.key,
          label,
          status: input.status ?? "pass",
          detail: input.detail ?? `Mock ${label.toLowerCase()} recorded.`,
          evidence: input.evidence,
        },
      ],
    }),
  );
}

export function isCutoverEvidenceKey(key: string): key is CutoverEvidenceKey {
  return (CUTOVER_EVIDENCE_KEYS as readonly string[]).includes(key);
}

function cutoverEvidenceLabel(key: CutoverEvidenceKey): string {
  return CUTOVER_EVIDENCE_LABELS[key];
}

export interface RollbackRehearsalItem {
  key: string;
  label: string;
  status: "pass" | "warning" | "blocker";
  count?: number;
  order?: number;
  detail?: string;
}

export interface RollbackRehearsalReport {
  job_id: string;
  status?: "pass" | "warning" | "blocker";
  rollbackable?: boolean;
  generated_at?: string;
  items?: RollbackRehearsalItem[];
  detail?: string;
  message?: string;
}

export function getRollbackRehearsal(
  jobId: string,
): Promise<RollbackRehearsalReport> {
  return withMockFallback(
    () =>
      api.get<RollbackRehearsalReport>(
        `${migrationJobPath(jobId)}/rollback-rehearsal`,
      ),
    async () => ({
      job_id: jobId,
      status: "warning",
      rollbackable: true,
      generated_at: new Date().toISOString(),
      detail: "Mock rollback rehearsal.",
      items: [],
    }),
  );
}

export function startShadowMonitor(
  source: SourcePlatform,
  jobId: string,
  intervalSeconds = 3600,
): Promise<ShadowMonitorResponse> {
  return withMockFallback(
    () =>
      api.post<ShadowMonitorResponse>(
        `${MIGRATIONS_BASE}/sources/${source}/shadow-monitor`,
        { job_id: jobId, interval_seconds: intervalSeconds },
      ),
    async () => ({
      monitor: {
        job_id: jobId,
        tenant_id: "mock",
        source,
        enabled: true,
        interval_seconds: intervalSeconds,
        last_recommended_action: "ready_for_cutover_review",
      },
      history: [],
    }),
  );
}

export function getShadowMonitor(
  jobId: string,
): Promise<ShadowMonitorResponse> {
  return withMockFallback(
    () =>
      api.get<ShadowMonitorResponse>(
        `${migrationJobPath(jobId)}/shadow-monitor`,
      ),
    async () => ({
      monitor: {
        job_id: jobId,
        tenant_id: "mock",
        source: "activecampaign",
        enabled: false,
        interval_seconds: 3600,
      },
      history: [],
    }),
  );
}

export function stopShadowMonitor(
  jobId: string,
): Promise<{ job_id: string; enabled: boolean }> {
  return withMockFallback(
    () =>
      api.delete<{ job_id: string; enabled: boolean }>(
        `${migrationJobPath(jobId)}/shadow-monitor`,
      ),
    async () => ({ job_id: jobId, enabled: false }),
  );
}

export function startSourceEvents(
  source: SourcePlatform,
  jobId: string,
  intervalSeconds = 3600,
): Promise<SourceEventMonitorResponse> {
  return withMockFallback(
    () =>
      api.post<SourceEventMonitorResponse>(
        `${MIGRATIONS_BASE}/sources/${source}/source-events`,
        { job_id: jobId, interval_seconds: intervalSeconds },
      ),
    async () => ({
      monitor: {
        job_id: jobId,
        tenant_id: "mock",
        source,
        enabled: true,
        interval_seconds: intervalSeconds,
      },
      events: [],
    }),
  );
}

export function getSourceEvents(
  jobId: string,
): Promise<SourceEventMonitorResponse> {
  return withMockFallback(
    () =>
      api.get<SourceEventMonitorResponse>(
        `${migrationJobPath(jobId)}/source-events`,
      ),
    async () => ({
      monitor: {
        job_id: jobId,
        tenant_id: "mock",
        source: "klaviyo",
        enabled: false,
        interval_seconds: 3600,
      },
      events: [],
    }),
  );
}

export function stopSourceEvents(
  jobId: string,
  postPilotCleanup = false,
): Promise<{
  job_id: string;
  enabled: boolean;
  source_session_cleared: boolean;
}> {
  return withMockFallback(
    () =>
      api.delete<{
        job_id: string;
        enabled: boolean;
        source_session_cleared: boolean;
      }>(
        `${migrationJobPath(jobId)}/source-events${
          postPilotCleanup ? "?post_pilot_cleanup=1" : ""
        }`,
      ),
    async () => ({
      job_id: jobId,
      enabled: false,
      source_session_cleared: postPilotCleanup,
    }),
  );
}

export type SourceEventReviewInput =
  | {
      status: "reviewed";
      detail: string;
      evidence: [string, ...string[]];
    }
  | {
      status: "pending";
      detail?: never;
      evidence?: never;
    };

export function updateSourceEventReview(
  jobId: string,
  eventId: string,
  input: SourceEventReviewInput,
): Promise<SourceEventRecord> {
  return withMockFallback(
    () =>
      api.patch<SourceEventRecord>(
        `${migrationJobPath(jobId)}/source-events/${encodeURIComponent(eventId)}/review`,
        input,
      ),
    async () => ({
      id: eventId,
      job_id: jobId,
      tenant_id: "mock",
      source: "activecampaign",
      source_event_id: "[redacted-activecampaign-source-event-id]",
      resource_type: "activecampaign_non_email_contact",
      action: "manual_review",
      applied: false,
      review_status: input.status,
      review_detail: input.status === "reviewed" ? input.detail : undefined,
      review_evidence: input.status === "reviewed" ? input.evidence : undefined,
      reviewed_at:
        input.status === "reviewed" ? new Date().toISOString() : null,
      payload: {},
    }),
  );
}

export function listAutomationRebuilds(
  jobId: string,
): Promise<{ items: AutomationRebuildItem[] }> {
  return withMockFallback(
    () =>
      api.get<{ items: AutomationRebuildItem[] }>(
        `${migrationJobPath(jobId)}/automation-rebuilds`,
      ),
    async () => ({
      items:
        (await loadMocks()).mockVerification(jobId).automation_rebuilds ?? [],
    }),
  );
}

export function updateAutomationRebuild(
  jobId: string,
  item: AutomationRebuildItem,
): Promise<AutomationRebuildItem> {
  return withMockFallback(
    () =>
      api.patch<AutomationRebuildItem>(
        `${migrationJobPath(jobId)}/automation-rebuilds`,
        item,
      ),
    async () => ({ ...item, updated_at: new Date().toISOString() }),
  );
}

export function rollback(
  jobId: string,
): Promise<{ job_id: string; state: string }> {
  return withMockFallback(
    () =>
      api.post<{ job_id: string; state: string }>(
        `${migrationJobPath(jobId)}/rollback`,
      ),
    async () => (await loadMocks()).mockStartRollback(jobId),
  );
}

export function resumeMigrationJob(
  jobId: string,
): Promise<{ job_id: string; status: string }> {
  return withMockFallback(
    () =>
      api.post<{ job_id: string; status: string }>(
        `${migrationJobPath(jobId)}/resume`,
      ),
    async () => ({ job_id: jobId, status: "importing" }),
  );
}

export function getRollbackStatus(jobId: string): Promise<RollbackStatus> {
  return withMockFallback(
    () => api.get<RollbackStatus>(`${migrationJobPath(jobId)}/rollback-status`),
    async () => (await loadMocks()).mockRollbackStatus(jobId),
  );
}

export function getAuditLog(jobId: string): Promise<AuditEntry[]> {
  return withMockFallback(
    () => api.get<AuditEntry[]>(`${migrationJobPath(jobId)}/audit`),
    async () => (await loadMocks()).mockAuditLog(jobId),
  );
}

export interface PollOptions {
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Poll a job every `intervalMs` (default 2s) until it reaches a terminal
 * state, calling `onUpdate` on each tick. Resolves with the terminal job, or
 * rejects if the abort signal fires.
 */
export function pollJob(
  jobId: string,
  onUpdate: (job: MigrationJob) => void,
  opts: PollOptions = {},
): Promise<MigrationJob> {
  const intervalMs = clampPollInterval(opts.intervalMs, 2000);
  return new Promise<MigrationJob>((resolve, reject) => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cancelled = true;
      cleanup();
      reject(new DOMException("Polling aborted", "AbortError"));
    };
    if (opts.signal) {
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const tick = async () => {
      if (cancelled) return;
      try {
        const job = await getJob(jobId);
        if (cancelled) return;
        onUpdate(job);
        if (isTerminal(job.status)) {
          cleanup();
          resolve(job);
          return;
        }
        timer = setTimeout(tick, intervalMs);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
    void tick();
  });
}

function clampPollInterval(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(60_000, Math.max(500, Math.floor(value)));
}
