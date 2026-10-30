/**
 * Moosewave API client — typed, no-throw, discriminated-union results.
 *
 * Reads config from localStorage at every call (cheap, lets Settings page
 * update API URL without a reload). Methods return `{ data } | { error }`
 * so UI doesn't need try/catch around every call.
 */
import {
  denialGuidance,
  formatErrorMessage,
  parseErrorEnvelope,
} from "@postwave/errors";
import { CONTEXT_EPOCH_HEADER, observeContextEpoch } from "./context-epoch";
import {
  observeApiAuthority,
  observeApiCredentialBoundary,
} from "./api-authority";

import {
  DEFAULT_API_URL,
  DEMO_DATA_FALLBACK_ENABLED,
  validateApiUrl,
} from "./config";
import {
  desktopAuthLinkStart,
  type DesktopAuthLinkProof,
} from "./auth-link-contract";
import {
  OFFLINE_REPLAY_POLICY_CHANGED_MESSAGE,
  OUTBOX_MAX_ATTEMPTS,
  isOfflineCacheableGet,
  isQueueableMutation,
  offlineQueueProbablyEmpty,
  getOfflineIdentity,
  resourceOfPath,
  setOfflineIdentity,
  stageOfflineReplayAttempt,
  updateOfflineMutation,
  writeCachedResponse,
  type OfflineMutation,
} from "./offline-store";
import {
  completeOutboxItemDurably,
  drainOutbox,
  moveToDeadLetter,
} from "./outbox";
import {
  getOnlineStatus,
  noteRequestFailure,
  noteRequestSuccess,
  subscribeOnlineStatus,
} from "./online-manager";
import {
  CONCRETE_EVENT_BUS_TOPICS,
  normalizeEventBusTopics,
} from "./event-bus-topics";
import { vaultSetJSON } from "./secure-vault";
import { sensitiveVaultCacheKey } from "./sensitive-vault-cache-key";
import { acquireWebhookPlaygroundFireIdentityTransitionLease } from "./webhook-playground-fire-identity-transition";
import {
  clearMigrationUploadLedger,
  migrationUploadLedgerScope,
  migrationUploadScopeIsCurrent,
  newMigrationUploadID,
  readMigrationUploadLedger,
  safeMigrationUploadFilename,
  writeMigrationUploadLedger,
} from "./migration-upload-ledger";
import { parseJsonStreamPayload } from "./stream-payload";
import {
  credentialIdentityHash,
  normalizeDesktopApiKey as normalizeApiKey,
  retryCredentialOperation,
  SecureCredentialStorageError,
} from "./secure-api-key";
import { isTauri, tauriApi } from "./tauri";
import { httpFetch, isMutationMethod, newUUIDv7 } from "./http-fetch";
import { rfc3339EpochNanoseconds } from "./rfc3339-revision";
import {
  isReplayableRequestBody,
  parseStepUpChallenge,
  requestStepUpProof,
} from "./step-up";
import {
  apiIdentityAwareNativeFetch,
  nativeAwareFetch,
} from "./api-identity-native-fetch";
import * as roadmapApi from "./api-client-roadmap";
import { invalidateReplayedQueryPrefix } from "./replay-query-invalidator";
import { createAgentRoutinesApi } from "./api/agent-routines";
import { createAnalyticsIntegrationsApi } from "./api/analytics-integrations";
import { createAnalyticsNlqApi } from "./api/analytics-nlq";
import type { ArchiveListResponse } from "./api/archive-referral-operations";
import {
  createAuditOperationsMethods,
  decodeAuditCountPayload,
  decodeAuditListPayload,
  serializeAuditQuery,
  type AuditCountResponse,
  type AuditQueryFilters,
  type AuditRow,
} from "./api/audit-operations";
import { createAudienceSegmentationMethods } from "./api/audience-segmentation";
import { createCampaignAuthoringApis } from "./api/campaign-authoring";
import {
  createCampaignSequenceOperationsMethods,
  type Campaign,
  type Sequence,
  type SequenceDetail,
  type SequenceRegeneratedEmail,
  type SequenceStoredStep,
} from "./api/campaign-sequence-operations";
import { createCommerceApi } from "./api/commerce";
import { createConsentPrivacyOperationsMethods } from "./api/consent-privacy-operations";
import type * as DashboardStatsContract from "./api/dashboard-stats";
import { createNextBestProductApi } from "./api/next-best-product";
import { createDeliverabilityControlApi } from "./api/deliverability-control";
import { createOptimizerRunsApi } from "./api/optimizer-runs";
import { createCohortsApi } from "./api/cohorts";
import { createDomainWarmupApi } from "./api/domain-warmup";
import { createBotOpensApi } from "./api/bot-opens";
import { createVerificationApi } from "./api/verification";
import { createActivationExclusionsApi } from "./api/activation-exclusions";
import { createMaintenanceWindowsApi } from "./api/maintenance-windows";
import { createOnboardingDecisionsApi } from "./api/onboarding-decisions";
import { createfeedbackApi } from "./api/feedback";
import { createSendSettingsApi } from "./api/send-settings";
import { createprofileTransformRulesApi } from "./api/profile-transform-rules";
import type { DnsHealthStatus } from "./api/domain-deliverability-operations";
import { createCrmIntegrationsApi } from "./api/crm-integrations";
import { createFeedSourcesApi } from "./api/feed-sources";
import { createIntegrationsCatalogApi } from "./api/integrations-catalog";
import { createListWebhookOperations } from "./api/list-webhook-operations";
import { createListsAndSuppressionsApis } from "./api/lists-and-suppressions";
import { createPushSuppressionsApi } from "./api/push-suppressions";
import type {
  SuppressionAuditPage,
  SuppressionChannel,
  SuppressionReason,
  SuppressionScope,
} from "./api/lists-and-suppressions";
import { createLeadIntegrationsApi } from "./api/lead-integrations";
import type { ListsResponse, TagsResponse } from "./api/list-tag-operations";
import { createLoyaltyIntegrationsApi } from "./api/loyalty-integrations";
import { createMonetizationApi } from "./api/monetization";
import { createPlatformOperationsApis } from "./api/platform-operations";
import { createReportingApi } from "./api/reporting";
import { createReviewIntegrationsApi } from "./api/review-integrations";
import { createReviewsApi } from "./api/reviews";
import { createSegmentInsightsApi } from "./api/segment-insights";
import { createServiceSuiteApi } from "./api/service-suite";
import { createSmsBroadcastsApi } from "./api/sms-broadcasts";
import { createSubscriberDataOperationsMethods } from "./api/subscriber-data-operations";
import { createSubscriberIntelligenceApis } from "./api/subscriber-intelligence";
import { isExactSubscriberVersionFor } from "./api/subscriber-profiles";
import { createSubscriptionIntegrationsApi } from "./api/subscription-integrations";
import { createSupportIntegrationsApi } from "./api/support-integrations";
import { createVoiceRoadmapApi } from "./api/voice-roadmap";
import { createWarehouseApis } from "./api/warehouse";
import {
  createCanonicalOutboundWebhookOperations as createOutboundOps,
  decodeInboundWebhookEndpointResult,
  type InboundWebhookEndpoint,
  type InboundWebhookListResponse,
} from "./api/webhook-event-operations";
import {
  decodeWebhookPlaygroundEventCatalogResult,
  decodeWebhookPlaygroundFireReceiptResult,
  decodeWebhookPlaygroundFireResult,
  type WebhookPlaygroundEventCatalogResponse,
  type WebhookPlaygroundFireReceipt,
  type WebhookPlaygroundFireResponse,
} from "./api/webhook-playground-contract";
import { DEFERRED_ROUTE_API_METHOD_NAMES } from "./api-client-route-methods";
import type { DeferredRouteApi } from "./api-client-route-runtime";
import { registerRouteApiTransport } from "./api-client-request-bridge";
import {
  migrationUploadAckError,
  parseMigrationDiscoveryReport,
  parseMigrationDryRunAcknowledgement,
  parseMigrationSourceCapabilities,
  reconcileMigrationUpload,
  type MigrationDiscoveryReport,
  type MigrationDryRunAcknowledgement,
  type MigrationSource,
  type MigrationSourceCapability,
} from "./api/migrations";
import type { DiscountsAndGiftsApi } from "./api/monetization";
import {
  type ApiErr,
  type ApiResponseMetadata,
  type ApiResult,
  type QueueableApiResult,
} from "./api/result";
import {
  beginApiIdentityTransition,
  apiIdentityGenerationIsCurrent,
  apiIdentitySignal,
  apiIdentityTransitionError,
  captureApiIdentityGeneration,
  hasPendingWorkspaceSwitch,
  pendingWorkspaceSwitchIsKnownAbsent,
  releaseApiIdentityTransition,
} from "./api-identity-transition";
import {
  isSensitiveVaultGet,
  requestIsOffline,
  resolveOfflineRequest,
} from "./api-client-offline-request";
import { probeOAuthAvailability } from "./oauth-availability";
import { reconcilePendingWorkspaceSwitch } from "./workspaces";
export type * from "./api-client-roadmap";
export type {
  WebhookPlaygroundEventCatalogEntry,
  WebhookPlaygroundEventCatalogResponse,
  WebhookPlaygroundFireReceipt,
  WebhookPlaygroundFireResponse,
} from "./api/webhook-playground-contract";
export type * from "./api/aeo-operations";
export type * from "./api/agency-operations";
export type * from "./api/ai-regression-operations";
export type * from "./api/agent-routines";
export type * from "./api/analytics-integrations";
export type * from "./api/analytics-nlq";
export type * from "./api/archive-referral-operations";
export type * from "./api/audit-delivery-operations";
export type * from "./api/audit-operations";
export type * from "./api/audience-segmentation";
export type * from "./api/campaign-authoring";
export type * from "./api/campaign-sequence-operations";
export type * from "./api/commerce";
export type * from "./api/consent-privacy-operations";
export type * from "./api/dashboard-stats";
export type * from "./api/crm-integrations";
export type * from "./api/domain-deliverability-operations";
export type * from "./api/enterprise-governance-operations";
export type * from "./api/feed-sources";
export type * from "./api/integrations-catalog";
export type * from "./api/list-webhook-operations";
export type * from "./api/lists-and-suppressions";
export type * from "./api/lead-integrations";
export type * from "./api/list-tag-operations";
export type * from "./api/loyalty-integrations";
export type * from "./api/monetization";
export type * from "./api/platform-operations";
export type * from "./api/reporting";
export type * from "./api/review-integrations";
export type * from "./api/reviews";
export type * from "./api/segment-insights";
export type * from "./api/service-suite";
export type * from "./api/sms-inbox-operations";
export type * from "./api/sms-broadcasts";
export type * from "./api/subscriber-data-operations";
export type * from "./api/subscriber-intelligence";
export type * from "./api/subscriber-profiles";
export type * from "./api/subscription-integrations";
export type * from "./api/support-integrations";
export type * from "./api/voice-roadmap";
export type * from "./api/warehouse";
export type * from "./api/webhook-event-operations";
export {
  getInboundWebhookSignatureState,
  OUTBOUND_WEBHOOK_EVENTS,
  OUTBOUND_WEBHOOK_SIGNING_ALGORITHMS,
} from "./api/webhook-event-operations";
export { LIST_SCOPED_WEBHOOK_EVENTS } from "./api/list-webhook-operations";
export { ANOMALY_BRIEF_METRICS } from "./api/analytics-nlq";
export {
  LOOKALIKE_DEFAULT_SIZE,
  LOOKALIKE_MAX_SIZE,
  LOOKALIKE_MIN_SIZE,
} from "./api/audience-segmentation";
export {
  isMergeFieldSchema,
  isSegmentAIProcessingDisclosure,
} from "./api/audience-segmentation";
export {
  isExactSubscriberVersion,
  MAX_EMAILS_PER_PROFILE,
  SIGNUP_SOURCES,
  SUBSCRIBER_LIFECYCLE_STAGES,
  signupSourceLabel,
} from "./api/subscriber-profiles";
export {
  PUSH_PLATFORMS,
  PUSH_SUPPRESSION_REASONS,
  SMS_SUPPRESSION_REASONS,
  SUPPRESSION_REASONS_X1,
} from "./api/lists-and-suppressions";
export type {
  MigrationDiscoveryReport,
  MigrationDryRunAcknowledgement,
  MigrationSource,
  MigrationSourceCapability,
  MigrationUploadServerStatus,
} from "./api/migrations";
export type {
  ApiErr,
  ApiOk,
  ApiQueued,
  ApiResult,
  QueueReceipt,
  QueueableApiResult,
} from "./api/result";
export { queueReceiptMessage } from "./api/result";
const LS_API_URL = "postwave_api_url";
const LS_API_KEY = "postwave_api_key";
const TIMEOUT_MS = 5000;
const MAX_API_RESPONSE_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_API_RESPONSE_TEXT_OVERRIDE_BYTES = 8 * 1024 * 1024;
const MAX_API_ERROR_TEXT_BYTES = 64 * 1024;
const MAX_STORED_API_URL_BYTES = 2 * 1024;
const MAX_STORED_API_KEY_BYTES = 8 * 1024;
const MAX_SESSION_HINT_BYTES = 8 * 1024;
const MAX_SESSION_HINT_FIELD_CHARS = 512;
const MAX_OAUTH_REDIRECT_TO_BYTES = 2 * 1024;
const MAX_OAUTH_RETURN_STATE_BYTES = 256;
const MIGRATION_UPLOAD_CHUNK_SIZE = 512 * 1024;

/**
 * Sent on every API request so the backend Origin/CSRF gate treats this
 * Tauri desktop build as a first-party native client (see
 * apps/api/internal/middleware/origin_csrf.go — isTrustedNativeClient).
 *
 * Tauri webviews issue requests from the `tauri://localhost` origin,
 * which is NOT in the server's CORS/CSRF Origin allow-list, so a
 * session-cookie-mode mutating request would otherwise be rejected with
 * 403. The value is not a secret; the CSRF protection is that a hostile
 * website cannot set a custom request header cross-origin without a CORS
 * preflight the server would deny. Mirrors apps/mobile's
 * NATIVE_CLIENT_HEADERS = {"X-Postwave-Client":"mobile"}.
 */
export const NATIVE_CLIENT_HEADERS: Readonly<Record<string, string>> = {
  "X-Postwave-Client": "desktop",
  // Client-version fabric (dim 10): lets the gateway enforce a min-version.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "X-Postwave-Version":
    (typeof window !== "undefined" &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((import.meta as any).env?.VITE_APP_VERSION as string | undefined)) ||
    "dev",
};

let cachedApiKey: string | null | undefined;
let replayInFlight = false;
const OFFLINE_CHECKPOINT_RETRY_MESSAGE =
  "The server accepted this queued change, but Moosewave could not securely checkpoint its sync receipt. It will retry with the same idempotency key after secure storage is available.";

export { SecureCredentialStorageError } from "./secure-api-key";
/* ---------- session-replay-deeplink helpers --------------------------- */
//
// The browser session id lives in a cookie (pw_session_id) set by the
// auth shell on first load — we don't manage it here. We do own the
// monotonic per-action counter the server reads from
// X-Postwave-Event-Seq; it lets the server preserve a stable in-session
// ordering on audit_log rows even when wall-clock timestamps tie.

const SESSION_ID_COOKIE = "pw_session_id";

// In-memory counter (no localStorage). The sequence is meaningful only
// within a single browser session; a reload starts a new session_id
// cookie cycle anyway, so persisting the seq across reloads has no
// auditor value and would pollute localStorage / interfere with
// storage-size assertions in unrelated upload tests.
let cachedClientEventSeq = 0;

/** Increments the per-action counter and returns the new value. Called
 *  once per non-idempotent request so audit_log rows can be ordered in
 *  the sequence the SPA emitted them, even when their wall-clock `at`
 *  timestamps collide at the millisecond. */
export function nextClientEventSeq(): number {
  cachedClientEventSeq += 1;
  return cachedClientEventSeq;
}

/** Reads the cookie-derived session id. Returns null in cookieless
 *  contexts (Electron with cookies disabled, SSR, tests). */
export function getSessionID(): string | null {
  try {
    if (typeof document === "undefined") return null;
    const cookies = document.cookie ? document.cookie.split(";") : [];
    for (const raw of cookies) {
      const [k, ...rest] = raw.trim().split("=");
      if (k === SESSION_ID_COOKIE) {
        return decodeURIComponent(rest.join("=")) || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function sequencePositionPathSegment(position: number): string | null {
  if (!Number.isSafeInteger(position) || position < 1) return null;
  return String(position);
}

/**
 * Pull the email content at a flat top-level position out of a
 * SequenceDetail — canvas step (steps[].email) first, then the legacy
 * emails projection. Mirrors services/voice's applyRegeneratedEmail so the
 * client reads back exactly what the backend wrote (D07#2).
 */
function extractSequenceEmailAt(
  detail: { steps?: unknown[]; emails?: unknown[] } | undefined,
  position: number,
): SequenceRegeneratedEmail | null {
  if (!detail) return null;
  for (const s of detail.steps ?? []) {
    const step = s as {
      type?: string;
      position?: number;
      email?: { subject?: string; body?: string; body_html?: string };
    };
    if (step?.type === "email" && step.position === position && step.email) {
      return {
        subject: step.email.subject ?? "",
        body: step.email.body ?? step.email.body_html ?? "",
      };
    }
  }
  const legacy = (detail.emails ?? [])[position - 1] as
    | { subject?: string; body?: string; body_html?: string }
    | undefined;
  if (legacy) {
    return {
      subject: legacy.subject ?? "",
      body: legacy.body ?? legacy.body_html ?? "",
    };
  }
  return null;
}

const SEQUENCE_JOB_POLL_MS = 1500;
const SEQUENCE_JOB_POLL_TIMEOUT_MS = 90_000;

/**
 * Poll GET /api/v1/voice/sequences/jobs/{job_id} until the async
 * regenerate job reaches a terminal state. Returns an error on
 * failure/timeout, or undefined once the job has succeeded (D07#2).
 */
async function pollSequenceJob(
  jobId: string,
): Promise<ApiErr["error"] | undefined> {
  const deadline = Date.now() + SEQUENCE_JOB_POLL_TIMEOUT_MS;
  for (;;) {
    const res = await request<{ status?: string; error_message?: string }>(
      `/api/v1/voice/sequences/jobs/${encodeURIComponent(jobId)}`,
    );
    if (res.error) return res.error;
    const status = res.data?.status ?? "";
    if (status === "succeeded") return undefined;
    if (status === "failed") {
      return {
        kind: "http",
        message: res.data?.error_message?.trim() || "AI regenerate job failed.",
      };
    }
    if (Date.now() >= deadline) {
      return { kind: "timeout", message: "AI regenerate timed out." };
    }
    await new Promise((resolve) => setTimeout(resolve, SEQUENCE_JOB_POLL_MS));
  }
}

/* ---------- types ---------------------------------------------------- */
/**
 * One api_key_calls row as the server returns it. The MCP guide page
 * renders these in reverse-chronological order.
 *
 * `apiKeyPrefix` falls back through (frozen-column → live-JOIN-prefix
 * → empty string) so the dashboard always has SOMETHING to show, even
 * for revoked keys.
 */
export interface MCPExecution {
  id: number;
  tenantId: string;
  apiKeyId?: string;
  apiKeyPrefix?: string;
  method: string;
  path: string;
  /**
   * Server-minimized query-key shape (without retained values). This is
   * observability metadata, not a replayable request query.
   */
  queryString?: string;
  toolName?: string;
  statusCode: number;
  latencyMs: number;
  userAgent?: string;
  remoteIp?: string;
  errorCode?: string;
  /** Bounded request-body shape with scalar values removed by the server. */
  requestBody?: unknown;
  /** @deprecated Compatibility field; it is only a caller header assertion. */
  dryRun?: boolean;
  /** True only when the recorder observed the caller-controlled dry-run header. */
  dryRunAsserted?: boolean;
  /** Per-call cost in micros (1e-6 USD). 0 for free endpoints. */
  costMicros: number;
  calledAt: string; // RFC3339
}

export interface MCPExecutionsResponse {
  /** Canonical active workspace binding, including for an empty page. */
  tenantId: string;
  rows: MCPExecution[];
  /** Exact server minimization contract required before rows enter UI state. */
  detailPolicy: "minimized_v1";
  /** This recorder is mutable, asynchronous, and may omit calls. */
  evidenceClass: "best_effort_observability";
  /** Cursor for the next page; pass as `before_id` on the next call. */
  nextBeforeId?: number;
}

export interface MCPToolFrequency {
  toolName: string;
  calls: number;
}

export interface MCPKeyFrequency {
  apiKeyId?: string;
  apiKeyPrefix: string;
  calls: number;
}

export interface MCPStatusFrequency {
  /** Leading digit of the HTTP status (2|3|4|5). */
  class: number;
  calls: number;
}

export interface MCPStats {
  tenantId: string;
  windowHours: number;
  totalCalls: number;
  successfulCalls: number;
  successRate: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  lastCallAt?: string;
  topTools: MCPToolFrequency[];
  topApiKeys: MCPKeyFrequency[];
  statusBreakdown: MCPStatusFrequency[];
  /** Sum of per-call cost in micros (1e-6 USD) across the window. */
  totalCostMicros: number;
}

export interface MCPToolQuota {
  toolName: string;
  dailyLimit?: number | null;
  estimatedCostMicros: number;
  usedToday: number;
}

export interface MCPTrendPoint {
  /** RFC3339, hour-aligned UTC bucket boundary. */
  bucket: string;
  calls: number;
}

export interface MCPTrendResponse {
  tenantId: string;
  points: MCPTrendPoint[];
  windowHours: number;
}

export interface MCPQuotaResponse {
  tenantId: string;
  quotas: MCPToolQuota[];
  enforcementMode: "advisory_unverified";
  authoritative: false;
  releaseHold: "mcp_quota_enforcement_release_held";
}

export interface MCPCatalogEntry {
  name: string;
  category: string;
  description: string;
}

/* ---------- API keys ---------- */

export interface ApiKeyRow {
  id: string;
  tenantId?: string;
  label: string;
  prefix: string;
  scopes: string[];
  createdAt?: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  sandboxOnly?: boolean;
  allowedIps?: string[];
  revokedAt?: string | null;
  [extra: string]: unknown;
}

export interface ApiKeysListResponse {
  items?: ApiKeyRow[];
  keys?: ApiKeyRow[];
  data?: ApiKeyRow[];
  [extra: string]: unknown;
}

export interface CreateApiKeyResponse {
  /** The created row (no plaintext). */
  key?: ApiKeyRow;
  /** The plaintext key, only returned on creation/rotation. */
  plaintext?: string;
  [extra: string]: unknown;
}

/* ---------- Approvals delegation + escalation ---------- */

export interface ApprovalDelegation {
  id: string;
  tenantId: string;
  fromUserId: string;
  toUserId: string;
  /** RFC3339. Half-open window with endsAt. */
  startsAt: string;
  /** RFC3339; null = open-ended. */
  endsAt?: string | null;
  reason?: string;
  createdByUserId?: string;
  createdAt: string;
  /** RFC3339 when set. Soft-deleted rows are inactive. */
  revokedAt?: string | null;
}

export interface ApprovalEscalationPolicy {
  tenantId: string;
  /** null/undefined = escalation disabled. */
  escalateAfterHours?: number | null;
  notifyOwners: boolean;
}

export interface HealthResponse {
  status: string;
  version: string;
  service: string;
}

export interface MeResponse {
  tenant: string | null;
  user: string | null;
}

export interface ApiKeySelfInfoResponse {
  tenant_id: string;
  tenant_slug?: string;
  scopes: string[];
  actor?: string;
}

export interface ApiConnectionValidation {
  health: HealthResponse;
  me?: MeResponse;
  authenticated: boolean;
}

export interface StreamTokenResponse {
  token: string;
  expires_at: string;
  ttl_seconds: number;
}

/** sto-message-prioritization (P2): priority range exposed for client
 *  validation. Keep in lockstep with internal/campaigns/types.go +
 *  migration 0298_campaigns_priority.sql. */
export const CAMPAIGN_PRIORITY_MIN = 1;
export const CAMPAIGN_PRIORITY_MAX = 10;
export const CAMPAIGN_PRIORITY_DEFAULT = 5;
export const CAMPAIGN_PRIORITY_TRANSACTIONAL = 10;

export interface CampaignsResponse {
  items?: Campaign[];
  data?: Campaign[];
  results?: Campaign[];
  total?: number;
}

export interface CampaignCountResponse {
  total: number;
  by_status: Record<string, number>;
}

export interface AutomationJourney {
  id: string;
  name: string;
  status: string;
  version?: number;
  triggers?: Array<Record<string, unknown>>;
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  goals?: Array<Record<string, unknown>>;
  analytics?: Record<string, unknown>;
  published_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AutomationJourneyInput {
  name: string;
  status?: "draft" | "active" | "paused" | "archived";
  triggers?: Array<Record<string, unknown>>;
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<Record<string, unknown>>;
  goals?: Array<Record<string, unknown>>;
  analytics?: Record<string, unknown>;
}

export interface SequencesResponse {
  items?: Sequence[];
  data?: Sequence[];
  sequences?: Sequence[];
  total?: number;
}

/* ---------- onboarding progress ------------------------------------- */
/*
 * One step in the home-page setup checklist. Server (Go) returns the
 * canonical list of ~10 steps; the desktop maps a subset of `key`s to
 * the 5 user-visible steps in OnboardingChecklist.
 *
 * Adding a new step server-side does NOT break older desktop builds —
 * unknown keys are ignored by the mapper.
 */
export interface OnboardingStep {
  key: string;
  label: string;
  description: string;
  completed: boolean;
}
export interface OnboardingProgressResponse {
  steps: OnboardingStep[];
  completed: number;
  total: number;
  percent: number;
  all_done: boolean;
}

/* ---------- approvals ----------------------------------------------- */

/**
 * Mirrors the Go `approvals.Approval` struct (camelCase JSON tags). Decision
 * fields are populated after Decide, so they're optional. All other fields
 * are optional defensively because the server returns the row as-is.
 */
export interface ApprovalRow {
  id: string;
  tenantId?: string;
  resourceType?: string;
  resourceId?: string;
  requestedByActorType?: string;
  requestedByActorLabel?: string;
  requestedByApiKeyId?: string;
  status: "pending" | "approved" | "rejected" | "expired" | string;
  requestedAt?: string;
  decidedAt?: string;
  decidedByUserId?: string;
  /** Free-form decision notes / reject reason. */
  notes?: string;
  expiresAt?: string;
  /** Defensive — some deployments may attach a metadata blob. */
  metadata?: Record<string, unknown> | null;
  // Tolerate extra server fields without losing strict typing on the rest.
  [extra: string]: unknown;
}

export interface ApprovalListResponse {
  /** Server returns BOTH `approvals` and `items`; either is canonical. */
  approvals?: ApprovalRow[];
  items?: ApprovalRow[];
  data?: ApprovalRow[];
  results?: ApprovalRow[];
}

/* ---------- config helpers ------------------------------------------ */

// Validated URL cache; invalidated whenever Settings changes the base.
let cachedApiUrl: string | null = null;

export function getApiUrl(): string {
  if (cachedApiUrl !== null) {
    observeApiAuthority(cachedApiUrl);
    return cachedApiUrl;
  }
  try {
    const v = readBoundedStorageValue(LS_API_URL, MAX_STORED_API_URL_BYTES);
    const validation = validateApiUrl(v);
    cachedApiUrl = validation.ok ? validation.url : DEFAULT_API_URL;
    observeApiAuthority(cachedApiUrl);
    return cachedApiUrl;
  } catch {
    cachedApiUrl = DEFAULT_API_URL;
    observeApiAuthority(cachedApiUrl);
    return cachedApiUrl;
  }
}

/** Clear the cached API URL. Call this when Settings saves a new URL. */
export function invalidateApiUrlCache(): void {
  cachedApiUrl = null;
  // Re-read and publish synchronously after Settings/workspace persistence so
  // identity-bearing consumers clear the previous authority before any later
  // capture or write can inherit it.
  getApiUrl();
  invalidateStreamTokenCache();
}

function apiUrl(path: string): string {
  return apiUrlFromBase(getApiUrl(), path);
}

function apiUrlFromBase(baseUrl: string, path: string): string {
  const base = `${baseUrl.replace(/\/+$/, "")}/`;
  const rawPath = String(path || "");
  if (rawPath.trim() !== rawPath || /[\r\n]/.test(rawPath)) {
    throw new Error("Unsafe API path");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath) || rawPath.startsWith("//")) {
    throw new Error("Unsafe API path");
  }
  const relativePath = rawPath.replace(/^\/+/, "");
  const pathOnly = relativePath.split(/[?#]/, 1)[0] ?? "";
  if (
    pathOnly.split("/").some((segment) => {
      const lower = segment.toLowerCase();
      return (
        segment === "." ||
        segment === ".." ||
        lower === "%2e" ||
        lower === "%2e." ||
        lower === ".%2e" ||
        lower === "%2e%2e"
      );
    })
  ) {
    throw new Error("Unsafe API path");
  }
  const url = new URL(`./${relativePath}`, base);
  if (url.origin !== new URL(base).origin) {
    throw new Error("Unsafe API path");
  }
  return url.toString();
}

export function getApiKey(): string | null {
  if (isTauri()) return null;
  if (cachedApiKey !== undefined) return cachedApiKey;
  cachedApiKey = readLegacyApiKey();
  // Hydration owns write-then-delete migration of the legacy copy.
  return cachedApiKey;
}

/** Stored native credentials are represented only by a boolean capability. */
export function hasApiCredential(): boolean {
  return isTauri()
    ? tauriApi.apiBrokerStatus().configured
    : Boolean(getApiKey());
}

/**
 * A configured loopback broker remains reachable even when WebKit reports
 * `navigator.onLine === false` (for example during a network transition).
 * Only this exact native/local case may bypass the browser offline hint.
 */
export function hasLocalNativeApiCredential(): boolean {
  if (!isTauri()) return false;
  const status = tauriApi.apiBrokerStatus();
  if (!status.configured || !status.baseUrl) return false;
  try {
    const hostname = new URL(status.baseUrl).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

// Cache the short-lived stream token across simultaneous stream opens.
interface CachedStreamToken {
  token: string;
  expires_ms: number;
  identity_generation: number;
  api_base_url: string;
  cache_epoch: number;
}
let cachedStreamToken: CachedStreamToken | null = null;
interface StreamTokenContext {
  identityGeneration: number;
  apiBaseUrl: string;
  cacheEpoch: number;
}
interface InflightStreamTokenFetch extends StreamTokenContext {
  promise: Promise<StreamTokenResponse | null>;
}
let inflightTokenFetch: InflightStreamTokenFetch | null = null;
let streamTokenCacheEpoch = 0;
const STREAM_TOKEN_REUSE_MS = 25_000;

function invalidateStreamTokenCache(): void {
  streamTokenCacheEpoch += 1;
  cachedStreamToken = null;
  // An old promise cannot be cancelled here, but disassociating it prevents a
  // new identity from awaiting it. Its epoch/current-identity guard below also
  // prevents the late result from repopulating this cache.
  inflightTokenFetch = null;
}

/**
 * Drop a stream credential after a server-declared terminal close so an
 * explicit reconnect cannot reuse the credential that just expired.
 */
export function invalidateStreamCredential(): void {
  invalidateStreamTokenCache();
}

function streamTokenContextIsCurrent(context: StreamTokenContext): boolean {
  return (
    context.cacheEpoch === streamTokenCacheEpoch &&
    apiIdentityGenerationIsCurrent(context.identityGeneration) &&
    getApiUrl() === context.apiBaseUrl
  );
}

async function fetchStreamToken(
  context: StreamTokenContext,
): Promise<StreamTokenResponse | null> {
  // Dedupe only callers from the exact same identity/origin/epoch. A request
  // left over from another account or API connection is never reusable.
  if (
    inflightTokenFetch &&
    inflightTokenFetch.identityGeneration === context.identityGeneration &&
    inflightTokenFetch.apiBaseUrl === context.apiBaseUrl &&
    inflightTokenFetch.cacheEpoch === context.cacheEpoch
  ) {
    return inflightTokenFetch.promise;
  }
  const promise = (async (): Promise<StreamTokenResponse | null> => {
    const tokenRes = await request<StreamTokenResponse>(
      "/api/v1/streams/token",
      { method: "POST" },
    );
    if (tokenRes.data?.token && streamTokenContextIsCurrent(context)) {
      const ttlMs = (tokenRes.data.ttl_seconds || 30) * 1000;
      cachedStreamToken = {
        token: tokenRes.data.token,
        expires_ms: Date.now() + Math.min(ttlMs - 5_000, STREAM_TOKEN_REUSE_MS),
        identity_generation: context.identityGeneration,
        api_base_url: context.apiBaseUrl,
        cache_epoch: context.cacheEpoch,
      };
      return tokenRes.data;
    }
    return null;
  })();
  const currentFetch: InflightStreamTokenFetch = {
    ...context,
    promise,
  };
  inflightTokenFetch = currentFetch;
  try {
    return await promise;
  } finally {
    if (inflightTokenFetch === currentFetch) inflightTokenFetch = null;
  }
}

export async function buildStreamUrl(path: string): Promise<string> {
  const identityGeneration = captureApiIdentityGeneration();
  if (identityGeneration === null) {
    throw new Error("Workspace identity is changing; stream creation paused.");
  }
  const base = getApiUrl();
  const context: StreamTokenContext = {
    identityGeneration,
    apiBaseUrl: base,
    cacheEpoch: streamTokenCacheEpoch,
  };
  const url = new URL(apiUrlFromBase(base, path));

  // Cache hit — reuse the token if it's still well inside its TTL.
  if (
    cachedStreamToken &&
    Date.now() < cachedStreamToken.expires_ms &&
    cachedStreamToken.identity_generation === identityGeneration &&
    cachedStreamToken.api_base_url === base &&
    cachedStreamToken.cache_epoch === context.cacheEpoch &&
    streamTokenContextIsCurrent(context)
  ) {
    url.searchParams.set("stream_token", cachedStreamToken.token);
    return url.toString();
  }

  const token = await fetchStreamToken(context);
  if (!streamTokenContextIsCurrent(context)) {
    throw new Error("Workspace changed before the stream could be opened.");
  }
  if (token?.token) {
    url.searchParams.set("stream_token", token.token);
    return url.toString();
  }

  // Cookie/session authentication remains the only fallback. API credentials
  // are never serialized into URLs, including loopback development streams.
  return url.toString();
}

export async function hydrateSecureApiConfig(): Promise<void> {
  if (!isTauri()) {
    const legacy = readLegacyApiKey();
    if (!cachedApiKey) {
      cachedApiKey = legacy;
    }
    removeLegacyApiKey();
    await syncOfflineIdentity();
    return;
  }
  const legacy = cachedApiKey ?? readLegacyApiKey();
  try {
    const configuredUrl = getApiUrl();
    const status = await retryCredentialOperation(() =>
      tauriApi.initializeApiBroker(configuredUrl, legacy),
    );
    cachedApiKey = null;
    removeLegacyApiKey();
    if (hasPendingWorkspaceSwitch()) {
      await reconcilePendingWorkspaceSwitch(status);
    } else if (status.baseUrl && status.baseUrl !== getApiUrl()) {
      window.localStorage.setItem(LS_API_URL, status.baseUrl);
      invalidateApiUrlCache();
    }
    await retryCredentialOperation(() =>
      tauriApi.initializeSessionBroker(getApiUrl()),
    );
    await syncOfflineIdentity();
    return;
  } catch {
    cachedApiKey = null;
    removeLegacyApiKey();
    if (pendingWorkspaceSwitchIsKnownAbsent()) await syncOfflineIdentity();
    throw new SecureCredentialStorageError();
  }
}

export function setApiConfig(
  url: string | null,
  key?: string | null,
): Promise<void> {
  let normalizedUrl: string | null | undefined = undefined;
  if (url && url.trim()) {
    const validation = validateApiUrl(url);
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    normalizedUrl = validation.url;
  } else if (url === null) {
    normalizedUrl = null;
  }
  const requestedKey = key?.trim() ?? "";
  if (
    key !== undefined &&
    requestedKey &&
    storageByteLength(requestedKey) > MAX_STORED_API_KEY_BYTES
  ) {
    throw new Error("API key is too large.");
  }

  return persistApiConfig(normalizedUrl, key, requestedKey);
}

async function persistApiConfig(
  normalizedUrl: string | null | undefined,
  key: string | null | undefined,
  requestedKey: string,
): Promise<void> {
  const previousUrl = getApiUrl();
  const nextUrl = normalizedUrl ?? previousUrl;
  const changesApiIdentity = key !== undefined || normalizedUrl !== undefined;
  let recoveryTransitionLease: ReturnType<
    typeof acquireWebhookPlaygroundFireIdentityTransitionLease
  > | null = null;
  let identityTransition: ReturnType<typeof beginApiIdentityTransition> | null =
    null;
  try {
    if (changesApiIdentity) {
      recoveryTransitionLease =
        acquireWebhookPlaygroundFireIdentityTransitionLease();
      identityTransition = beginApiIdentityTransition();
      observeApiCredentialBoundary(nextUrl);
    }
    // Persist the credential before changing renderer state.
    if (key !== undefined && isTauri()) {
      // Native broker mutation occurs outside the renderer event loop. Clear
      // authority-bound telemetry before IPC starts, then restore the prior
      // authority if the command rejects. This closes the interval where Rust
      // may already have committed while the renderer is still awaiting IPC.
      try {
        await retryCredentialOperation(() =>
          tauriApi.configureApiBroker(
            nextUrl,
            requestedKey || null,
            key !== null &&
              !requestedKey &&
              tauriApi.apiBrokerStatus().configured,
          ),
        );
      } catch (error) {
        observeApiAuthority(previousUrl);
        removeLegacyApiKey();
        if (
          error instanceof Error &&
          error.message.includes("Re-enter the API key")
        ) {
          throw new Error(
            "Re-enter the API key when changing the API URL; stored credentials are origin-bound.",
          );
        }
        throw new SecureCredentialStorageError();
      }
    }
    if (normalizedUrl !== undefined || key !== undefined) {
      invalidateStreamTokenCache();
    }
    try {
      if (normalizedUrl) {
        window.localStorage.setItem(LS_API_URL, normalizedUrl);
        invalidateApiUrlCache();
      } else if (normalizedUrl === null) {
        window.localStorage.removeItem(LS_API_URL);
        invalidateApiUrlCache();
      }
    } catch {
      /* localStorage locked down — ignore */
    }
    if (isTauri() && normalizedUrl !== undefined) {
      try {
        await retryCredentialOperation(() =>
          tauriApi.initializeSessionBroker(getApiUrl()),
        );
      } catch {
        throw new SecureCredentialStorageError();
      }
    }
    if (key !== undefined) {
      cachedApiKey = requestedKey && !isTauri() ? requestedKey : null;
      removeLegacyApiKey();
      // Identity isolation is security state, not optional persistence: run it
      // even when localStorage URL writes are unavailable.
      await syncOfflineIdentity();
    }
  } finally {
    if (identityTransition) releaseApiIdentityTransition(identityTransition);
    recoveryTransitionLease?.release();
  }
}

/* ---------- offline identity scoping (audit §3.1 wiring) ------------ */

/** Scope offline state to an origin-bound, opaque authenticated identity. */
export async function syncOfflineIdentity(): Promise<void> {
  try {
    // A configured native broker wins over cookies: every same-origin API
    // call carries its bearer and Authorization takes precedence server-side.
    // Keeping this identity stable also preserves encrypted crash recovery
    // when /auth/me later writes a remembered user hint.
    const broker = isTauri() ? tauriApi.apiBrokerStatus() : null;
    if (broker?.configured) {
      const legacyIdentity = broker.credentialFingerprint
        ? `apikey:native:${broker.credentialFingerprint}`
        : null;
      await setOfflineIdentity(
        legacyIdentity
          ? JSON.stringify([
              2,
              getApiUrl(),
              "native-api-key",
              broker.credentialFingerprint,
            ])
          : null,
        legacyIdentity ? { legacyIdentities: [legacyIdentity] } : undefined,
      );
      return;
    }
    const hint = getRememberedSession();
    if (hint) {
      const legacyIdentity = `user:${hint.user_id}:${hint.tenant_id}`;
      await setOfflineIdentity(
        JSON.stringify([
          2,
          getApiUrl(),
          "session",
          hint.user_id,
          hint.tenant_id,
        ]),
        { legacyIdentities: [legacyIdentity] },
      );
      return;
    }
    const key = cachedApiKey;
    if (key) {
      const identityProof = await credentialIdentityHash(getApiUrl(), key);
      await setOfflineIdentity(identityProof);
      return;
    }
    await setOfflineIdentity(null);
  } catch {
    /* storage unavailable — leave the current identity untouched */
  }
}

export async function clearApiConfig(): Promise<void> {
  invalidateStreamTokenCache();
  cachedApiKey = null;
  removeLegacyApiKey();
  rememberSession(null); // also re-syncs the offline identity to null
  try {
    window.localStorage.removeItem(LS_API_URL);
  } catch {
    /* ignore */
  }
  // The cached URL must not outlive the stored one — otherwise the
  // next getApiUrl() keeps serving the cleared config.
  invalidateApiUrlCache();
  if (isTauri()) {
    try {
      await tauriApi.clearApiBroker();
    } catch {
      /* keychain unavailable; legacy localStorage was already cleared */
    }
    try {
      await tauriApi.initializeSessionBroker(getApiUrl());
    } catch {
      /* session dispatch remains bound to its previous fail-closed origin */
    }
  }
}

function readLegacyApiKey(): string | null {
  try {
    const v = readBoundedStorageValue(LS_API_KEY, MAX_STORED_API_KEY_BYTES);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

function removeLegacyApiKey(): void {
  try {
    window.localStorage.removeItem(LS_API_KEY);
  } catch {
    /* ignore */
  }
}

export function isApiConfigured(): boolean {
  try {
    const v = readBoundedStorageValue(LS_API_URL, MAX_STORED_API_URL_BYTES);
    return Boolean(v && validateApiUrl(v).ok);
  } catch {
    return false;
  }
}

/* ---------- 401 hook (session-expired) ----------------------------- */

/**
 * Registry for "the server just told us the user is unauthenticated"
 * listeners. Registered by App.tsx's <AuthGate> on mount so the store
 * can wipe `me` + the local API key and re-render the SignIn screen
 * in-place — no full page reload, no half-rendered workspace.
 *
 * We deliberately scope this to genuine 401 responses on the
 * application surface (i.e. the cross-cutting {@link request} core).
 * Auth probes that EXPECT a 401 (the cookie-session detect path) call
 * into a different code path so they don't trip the hook on a normal
 * "user not logged in yet" boot.
 *
 * Set, not array: a second registration overwrites the first listener
 * for the same callback identity, but multiple distinct listeners are
 * supported (e.g. tests + the real gate).
 */
const unauthorizedListeners = new Set<() => void>();

/**
 * Register a callback that fires when any cross-cutting API request
 * receives HTTP 401. Returns an unsubscribe function. Idempotent on the
 * same callback identity.
 */
export function onApiUnauthorized(cb: () => void): () => void {
  unauthorizedListeners.add(cb);
  return () => {
    unauthorizedListeners.delete(cb);
  };
}

/**
 * Internal: fire all 401 listeners. Errors in listeners are isolated —
 * one throwing listener never breaks the others or the request path.
 */
function fireUnauthorized(): void {
  for (const fn of unauthorizedListeners) {
    try {
      fn();
    } catch {
      /* listener threw — ignore */
    }
  }
}

/* ---------- core request -------------------------------------------- */

interface RequestOpts {
  /** Override the per-call timeout. Falls back to TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Raise or lower the bounded success-body reader for a known endpoint.
   * Overrides are still hard-capped at 8 MiB; ordinary calls remain at 2 MiB.
   */
  maxResponseTextBytes?: number;
  /** Override the retry attempt count (default 3). */
  maxAttempts?: number;
  /**
   * Whether a successful step-up proof may resend this request. Defaults to
   * true. Set false for outcome-ambiguous writes that prohibit every second
   * wire attempt, even when the first response was an auth challenge.
   */
  allowStepUpRetry?: boolean;
  /**
   * When true, the caller refuses to be queued offline — the request
   * either succeeds online or fails fast with an offline error. Used
   * for destructive / send-now / billing / privacy surfaces that must
   * never be replayed silently on reconnect.
   */
  requireOnline?: boolean;
  /**
   * Override automatic mutation idempotency. Pass `null` only for a reviewed
   * endpoint whose contract forbids the header and requires one-attempt,
   * non-replayable transport (including reveal-once POSTs and the
   * sending-settings PUT). It suppresses the header and makes offline queue
   * admission impossible. Ordinary mutations continue to auto-mint when
   * omitted.
   */
  idempotencyKey?: string | null;
  /**
   * Caller-supplied cancellation signal. A caller abort is TERMINAL:
   * httpFetch never retries past it, and the result surfaces as
   * `{error: {kind: "network", code: "aborted"}}` without flipping the
   * online-manager to offline (an intentional cancel is not a link
   * failure). Takes precedence over `init.signal` when both are set.
   */
  signal?: AbortSignal;
  /** Inspect the final response headers without changing response decoding. */
  onResponseHeaders?: (headers: Headers) => void;
}

export type ApiRequestOpts = RequestOpts;

/**
 * Options for every LLM-backed call (voice generate, AI compose, audit
 * NLQ, presend verdict, …). Two deliberate choices (audit §4.3):
 *   - timeoutMs 60s — generations routinely outlive the 5s default;
 *     the old inherited timeout made AI features look flaky.
 *   - maxAttempts 1 — mutations always carry an Idempotency-Key, which
 *     made them auto-retryable; each user click could fire up to 3
 *     server-side LLM invocations. Expensive generations are never
 *     re-fired automatically.
 */
const LLM_REQUEST_OPTS: RequestOpts = { timeoutMs: 60_000, maxAttempts: 1 };

/**
 * Carried across a step-up retry, and NOT part of {@link RequestOpts}.
 *
 * A call site has no business setting either field: the whole value of the
 * one-shot guard is that only `requestInternal` itself can declare a request
 * already retried, so no caller can accidentally re-arm an infinite
 * prompt→retry→prompt loop.
 */
interface StepUpRetryState {
  /**
   * The Idempotency-Key the FIRST attempt sent, reused verbatim so the retry is
   * the SAME write rather than a second one. A mutation that reached the server
   * and was refused at the step-up gate is, from here, indistinguishable from
   * one the server applied — re-minting the key would let a confirmation prompt
   * double a charge.
   */
  idempotencyKey?: string;
  /** True once this request has already been retried after a proof. */
  retried?: boolean;
}

async function demoReadFallback<T>(
  path: string,
  method: string,
  current?: unknown,
): Promise<{ data: T } | null> {
  if (!DEMO_DATA_FALLBACK_ENABLED || method !== "GET") return null;
  const demo = await import("./demo-data");
  const data = demo.demoDataForRequest(path, current);
  return data === undefined ? null : { data: data as T };
}

async function requestInternal<T>(
  path: string,
  init: RequestInit = {},
  opts: RequestOpts = {},
  stepUpRetry: StepUpRetryState = {},
): Promise<QueueableApiResult<T>> {
  const method = (init.method ?? "GET").toUpperCase();
  const bodyForQueue = parseRequestBody(init.body);
  const identityGeneration = captureApiIdentityGeneration();
  if (identityGeneration === null) {
    return apiIdentityTransitionError("identity_transition", bodyForQueue);
  }
  const url = apiUrl(path);
  // Mint UUIDv7 up front so an offline enqueue and any future online replay
  // share the same Idempotency-Key. Reviewed read-only POSTs opt out explicitly;
  // GETs/HEADs skip the header, and a step-up retry reuses the original key.
  const mintedIdempotencyKey =
    isMutationMethod(method) && opts.idempotencyKey !== null
      ? (stepUpRetry.idempotencyKey ?? opts.idempotencyKey ?? newUUIDv7())
      : undefined;
  // Offline decision combines navigator.onLine with the heartbeat-based
  // onlineManager (audit §3.5): navigator.onLine lies on router-up/
  // WAN-down links, where the manager's probe has already declared
  // "offline". The transient "connecting" state is NOT treated as
  // offline — it occurs at every boot before the first probe resolves,
  // and queueing/failing requests during that window would be worse
  // than attempting them (a real failure flips the manager to offline
  // via noteRequestFailure and the NEXT edit queues correctly).
  if (requestIsOffline() && !hasLocalNativeApiCredential()) {
    // Demo GETs are local fixtures, so a cold/offline demo must not fail before
    // the fallback has a chance to answer. Unsupported paths still use the
    // ordinary offline contract below.
    const offlineDemoFallback = await demoReadFallback<T>(path, method);
    if (offlineDemoFallback) return offlineDemoFallback;
    return resolveOfflineRequest<T>({
      path,
      method,
      body: bodyForQueue,
      headers: init.headers,
      idempotencyKey: mintedIdempotencyKey,
      requireOnline:
        opts.requireOnline === true || opts.idempotencyKey === null,
      identityGeneration,
      kickOutbox: () => {
        ensureOutboxFlushScheduler();
        void flushQueuedMutations();
      },
    });
  }
  // Flush triggers live on online-transitions + a 60s interval + post-
  // enqueue (audit §4.3 I1) — NOT at the top of every request anymore.
  ensureOutboxFlushScheduler();
  const key = normalizeApiKey(getApiKey());
  const callerSignal = opts.signal ?? init.signal ?? null;
  const requestSignal = apiIdentitySignal(callerSignal);
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...NATIVE_CLIENT_HEADERS,
  };
  if (init.body !== undefined) {
    // Skip the JSON Content-Type for FormData so the browser injects
    // the correct `multipart/form-data; boundary=...` header. Setting
    // it ourselves would corrupt the multipart envelope on the server.
    const isMultipart =
      typeof FormData !== "undefined" && init.body instanceof FormData;
    if (!isMultipart) {
      headers["Content-Type"] = "application/json";
    }
  }
  if (key) headers["Authorization"] = `Bearer ${key}`;
  // session-replay-deeplink: forward the per-action UI counter so the
  // server can persist a stable in-session ordering on audit_log rows.
  // The cookie carrying SessionCookieName is sent automatically because
  // credentials: "include" is set below.
  if (method !== "GET" && method !== "HEAD") {
    headers["X-Postwave-Event-Seq"] = String(nextClientEventSeq());
  }
  if (mintedIdempotencyKey) {
    headers["Idempotency-Key"] = mintedIdempotencyKey;
  }
  // Allow caller-supplied headers to override.
  if (init.headers) {
    for (const [k, v] of Object.entries(
      init.headers as Record<string, string>,
    )) {
      headers[k] = v;
    }
  }
  if (opts.idempotencyKey === null) {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "idempotency-key") delete headers[name];
    }
  }

  const { res, err, exhausted } = await httpFetch(
    url,
    {
      ...init,
      headers,
      mode: "cors",
      credentials: "include",
      cache: "no-store",
    },
    {
      timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
      maxAttempts: opts.maxAttempts,
      signal: requestSignal,
    },
  );
  if (!apiIdentityGenerationIsCurrent(identityGeneration))
    return apiIdentityTransitionError("identity_changed", bodyForQueue);
  if (!res) {
    // Caller-driven abort is terminal (httpFetch never retries past it)
    // and intentional — don't feed the online-manager a failure, and
    // surface a distinct `aborted` code so UIs can ignore it silently.
    if (callerSignal?.aborted) {
      return {
        error: {
          kind: "network",
          code: "aborted",
          message: "Request was cancelled.",
        },
        retryability: "not-retryable",
        ...(bodyForQueue === undefined ? {} : { preservedDraft: bodyForQueue }),
      };
    }
    const demoFallback = await demoReadFallback<T>(path, method);
    if (demoFallback) return demoFallback;
    // Transport-level failure (DNS/connect/timeout) — feed the unified
    // online-manager so the status chip + offline gating react without
    // waiting for the next heartbeat (audit §3.5 / contract #22).
    noteRequestFailure();
    return {
      error: transportError(err),
      retryability: "manual",
      ...(bodyForQueue === undefined ? {} : { preservedDraft: bodyForQueue }),
    };
  }
  try {
    opts.onResponseHeaders?.(res.headers);
  } catch {
    // Observation is advisory; an endpoint that requires a header fails
    // closed when its observer did not capture the proof.
  }
  // ANY HTTP response — including 4xx/5xx — proves the link is alive.
  noteRequestSuccess();
  // Record the context this response was computed under.
  //
  // THIS is the data path. Every screen, hook and poll reaches the server
  // through here; `authRequest` below serves only `/api/v1/auth/*`, so an
  // epoch observed solely there would be learned at sign-in and never again —
  // and the headline case (an admin demotes someone whose window stays open)
  // would never be noticed at all.
  observeContextEpoch(res.headers.get(CONTEXT_EPOCH_HEADER));
  if (!res.ok) {
    // 401 → session expired (or never existed). Fire the registered
    // listener so the App-root <AuthGate> can swap to SignIn in-place.
    // We deliberately exclude the bootstrap /auth/me probe — it
    // expects a 401 on a cold boot — by suppressing the hook on that
    // exact path. 401 is in the non-retryable set inside httpFetch so
    // by the time we get here the request is necessarily final; we
    // never fire while a retry is still in flight.
    void exhausted;
    // A step-up challenge is a LIVE session asking a question, not a dead one.
    // Resolved before the branch above can run, because that branch is a
    // logout: it fires <AuthGate>, which wipes `me` and re-renders SignIn. Read
    // the server's own comment on writeChallenge — "the difference between
    // showing a dialog and logging somebody out" — and note that on this
    // surface the difference is also the loss of everything queued in the
    // outbox.
    const challenge = await readStepUpChallenge(res);
    if (challenge) {
      // Exactly one retry, and only for a request that can be re-sent
      // unchanged. Bounded on purpose: a proof that does not actually refresh
      // the server's freshness clock (a clock skew, a session rotated
      // mid-prompt) would otherwise prompt→retry→prompt forever, and an
      // unbounded loop asking for authenticator codes is indistinguishable
      // from an attack on the person using it.
      if (!stepUpRetry.retried && isReplayableRequestBody(init.body)) {
        const proved = await requestStepUpProof(challenge);
        if (proved && opts.allowStepUpRetry !== false) {
          return requestInternal<T>(path, init, opts, {
            ...(mintedIdempotencyKey === undefined
              ? {}
              : { idempotencyKey: mintedIdempotencyKey }),
            retried: true,
          });
        }
      }
    } else if (res.status === 401 && !path.startsWith("/api/v1/auth/me")) {
      fireUnauthorized();
    }
    if (res.status !== 401 && res.status !== 403) {
      const demoFallback = await demoReadFallback<T>(path, method);
      if (demoFallback) return demoFallback;
    }
    const error = await errorFromResponse(res);
    if (!apiIdentityGenerationIsCurrent(identityGeneration))
      return apiIdentityTransitionError("identity_changed", bodyForQueue);
    return {
      error,
      ...sendingCapResponseMetadata(res),
      retryability:
        error.status === 408 ||
        error.status === 429 ||
        (error.status ?? 0) >= 500
          ? "manual"
          : "not-retryable",
      ...(bodyForQueue === undefined ? {} : { preservedDraft: bodyForQueue }),
    };
  }
  if (res.status === 204) {
    return {
      data: undefined as unknown as T,
      ...serverVersionFromResponse(res),
      ...sendingCapResponseMetadata(res),
    };
  }
  let text: string;
  try {
    text = await readTextLimited(
      res,
      boundedResponseTextBytes(opts.maxResponseTextBytes),
    );
  } catch (readErr) {
    if (!apiIdentityGenerationIsCurrent(identityGeneration))
      return apiIdentityTransitionError("identity_changed", bodyForQueue);
    return {
      error: transportError(readErr),
      ...sendingCapResponseMetadata(res),
    };
  }
  if (!apiIdentityGenerationIsCurrent(identityGeneration))
    return apiIdentityTransitionError("identity_changed", bodyForQueue);
  if (!text) {
    return {
      data: undefined as unknown as T,
      ...serverVersionFromResponse(res),
      ...sendingCapResponseMetadata(res),
    };
  }
  try {
    const parsed = JSON.parse(text) as T;
    const demoFallback = await demoReadFallback<T>(path, method, parsed);
    const data = demoFallback?.data ?? parsed;
    if (method === "GET" && isOfflineCacheableGet(path)) {
      writeCachedResponse(path, data);
    }
    if (method === "GET" && isSensitiveVaultGet(path)) {
      const vaultKey = await sensitiveVaultCacheKey(getOfflineIdentity(), path);
      if (!apiIdentityGenerationIsCurrent(identityGeneration))
        return apiIdentityTransitionError("identity_changed", bodyForQueue);
      if (vaultKey) void vaultSetJSON(vaultKey, data).catch(() => undefined);
    }
    return {
      data,
      ...serverVersionFromResponse(res),
      ...sendingCapResponseMetadata(res),
    };
  } catch {
    return {
      error: {
        kind: "parse",
        message: "API returned invalid JSON. Please refresh and try again.",
      },
      ...sendingCapResponseMetadata(res),
    };
  }
}

/**
 * Public escape hatch over the cross-cutting {@link request} core —
 * exists so callers can thread an AbortSignal (RequestOpts.signal)
 * into requests the typed wrappers don't parameterize, e.g. cancelling
 * an in-flight search GET on keystroke. Prefer the typed wrappers for
 * everything else; this is intentionally the ONLY exported untyped
 * request surface.
 */
function request<T>(
  path: string,
  init: RequestInit = {},
  opts: RequestOpts = {},
): Promise<ApiResult<T>> {
  // Only wrappers whose endpoint is on the reviewed offline allowlist use
  // queueableRequest below. Keeping the default type server-only prevents
  // unrelated reads/online-only writes from forcing meaningless queue guards.
  return requestInternal<T>(path, init, opts) as Promise<ApiResult<T>>;
}

function queueableRequest<T>(
  path: string,
  init: RequestInit = {},
  opts: RequestOpts = {},
): Promise<QueueableApiResult<T>> {
  return requestInternal<T>(path, init, opts);
}

export const apiRequest = request;
export const queueableApiRequest = queueableRequest;

/* ---------- outbox flush scheduling (audit §4.3 I1/I2) -------------- */

/**
 * Idempotent installer for the outbox flush triggers:
 *   (a) online transitions — subscribe to the unified onlineManager and
 *       drain when the status lands on "online";
 *   (b) a 60s safety interval (cheap: the empty fast-path below is one
 *       raw localStorage read);
 *   (c) post-enqueue kicks fire directly from request().
 * Installed lazily from the request path so module import stays
 * side-effect-free (node test environments never start timers unless
 * a request is actually made).
 */
let flushSchedulerInstalled = false;
function ensureOutboxFlushScheduler(): void {
  if (flushSchedulerInstalled) return;
  flushSchedulerInstalled = true;
  let last = getOnlineStatus();
  subscribeOnlineStatus(() => {
    const next = getOnlineStatus();
    if (next === "online" && last !== "online") {
      void flushQueuedMutations();
    }
    last = next;
  });
  if (
    typeof window !== "undefined" &&
    typeof window.setInterval === "function"
  ) {
    window.setInterval(() => {
      void flushQueuedMutations();
    }, 60_000);
  }
}

/** Maps an outbox resource bucket to the TanStack query-key prefixes
 *  (query-keys.ts qk factory: keys always start with the resource
 *  string) that must be invalidated after a successful replay.
 *  `campaigns` + `subscribers` are LIVE buckets since the safe-write
 *  expansion (singleton subscriber PATCH + campaign draft PATCH are
 *  now queueable) — both list and detail key prefixes invalidate. */
const OUTBOX_RESOURCE_QUERY_PREFIXES: Record<string, string[]> = {
  campaigns: ["campaigns", "campaign"],
  subscribers: ["subscribers", "subscriber"],
  segments: ["segments"],
  templates: ["templates"],
  lists: ["lists"],
  tags: ["tags"],
  forms: ["forms"],
};

export async function flushQueuedMutations(): Promise<{
  replayed: number;
  conflicts: number;
  failed: number;
}> {
  const identityGeneration = captureApiIdentityGeneration();
  if (identityGeneration === null) {
    return { replayed: 0, conflicts: 0, failed: 0 };
  }
  if (replayInFlight) return { replayed: 0, conflicts: 0, failed: 0 };
  // Identity hashing and any authenticated v1->v2 rewrite must settle before
  // the fast path reads the in-memory journal.
  await syncOfflineIdentity();
  if (!apiIdentityGenerationIsCurrent(identityGeneration))
    return { replayed: 0, conflicts: 0, failed: 0 };
  // Fast path: one raw storage read, no JSON parse (audit §4.3 I2).
  if (offlineQueueProbablyEmpty()) {
    return { replayed: 0, conflicts: 0, failed: 0 };
  }
  // Gate on the unified signal, not just navigator.onLine — a drain
  // attempted on a router-up/WAN-down link would burn attempt budget.
  if (
    (typeof navigator !== "undefined" && navigator.onLine === false) ||
    getOnlineStatus() === "offline"
  ) {
    return { replayed: 0, conflicts: 0, failed: 0 };
  }
  replayInFlight = true;
  const replayedResources = new Set<string>();
  try {
    // Per-resource FIFO: items in different buckets (campaigns vs.
    // subscribers vs. segments…) replay concurrently; items within a
    // bucket replay serially so a single conflict can't reorder later
    // edits to the same resource.
    const summary = await drainOutbox(async (item) => {
      if (!isQueueableMutation(item.method, item.path, item.body)) {
        updateOfflineMutation(item.id, {
          status: "failed",
          body: undefined,
          headers: undefined,
          lastError: OFFLINE_REPLAY_POLICY_CHANGED_MESSAGE,
        });
        return "failed";
      }
      const nextAttempts = item.attempts + 1;
      stageOfflineReplayAttempt(item.id, nextAttempts);
      try {
        const res = await replayMutation(item);
        if (res.status === 409 || res.status === 412) {
          updateOfflineMutation(item.id, {
            status: "conflict",
            attempts: nextAttempts,
            lastError: `Server reported a write conflict (${res.status}).`,
          });
          return "conflict";
        }
        if (!res.ok) {
          const msg = `Replay failed with HTTP ${res.status}.`;
          // Capture a server Retry-After (mainly on 429) so the next
          // mid-drain backoff honors server backpressure instead of just
          // jittering. Always (re)set the field — undefined clears any
          // stale value from a previous attempt.
          const raSeconds = parseRetryAfter(res.headers.get("retry-after"));
          const retryAfterMs =
            raSeconds !== undefined ? Math.max(0, raSeconds * 1000) : undefined;
          if (nextAttempts >= OUTBOX_MAX_ATTEMPTS) {
            moveToDeadLetter(item.id, msg);
          } else {
            updateOfflineMutation(item.id, {
              status: "failed",
              attempts: nextAttempts,
              lastError: msg,
              retryAfterMs,
            });
          }
          return "failed";
        }
        const subscriberMatch =
          item.resource === "subscribers" &&
          item.method.toUpperCase() === "PATCH"
            ? /^\/api\/v1\/subscribers\/([^/?#]+)$/u.exec(item.path)
            : null;
        let subscriberID: string | null = null;
        if (subscriberMatch?.[1]) {
          try {
            subscriberID = decodeURIComponent(subscriberMatch[1]);
          } catch {
            subscriberID = null;
          }
        }
        const responseVersion = res.headers.get("etag");
        const replayedSubscriberVersion =
          subscriberID !== null &&
          isExactSubscriberVersionFor(responseVersion, subscriberID)
            ? responseVersion
            : undefined;
        const checkpointed = await completeOutboxItemDurably(
          item.id,
          replayedSubscriberVersion,
        );
        if (!checkpointed) {
          updateOfflineMutation(item.id, {
            status: "failed",
            attempts: item.attempts,
            lastError: OFFLINE_CHECKPOINT_RETRY_MESSAGE,
            retryAfterMs: undefined,
          });
          return "failed";
        }
        replayedResources.add(item.resource || resourceOfPath(item.path));
        return "replayed";
      } catch {
        const msg = "Replay transport failed. Reconnect and try again.";
        if (nextAttempts >= OUTBOX_MAX_ATTEMPTS) {
          moveToDeadLetter(item.id, msg);
        } else {
          // A thrown attempt carries no response/Retry-After — clear any
          // stale value from a prior 429 so the next mid-drain backoff
          // doesn't honor a Retry-After that belonged to a different
          // failure.
          updateOfflineMutation(item.id, {
            status: "failed",
            attempts: nextAttempts,
            lastError: msg,
            retryAfterMs: undefined,
          });
        }
        return "failed";
      }
    });
    if (summary.replayed > 0) {
      await invalidateQueriesForReplayedResources(replayedResources);
    }
    return {
      replayed: summary.replayed,
      conflicts: summary.conflicts,
      failed: summary.failed,
    };
  } finally {
    replayInFlight = false;
  }
}

/**
 * Coarse per-resource TanStack cache invalidation after a drain that
 * replayed ≥1 mutation (audit §3.5: the UI used to show pre-replay data
 * until staleTime, making reconnect "sync" look like a no-op). The qk
 * factory keys always lead with the resource string, so prefix
 * invalidation covers every tenant/role/params variant. The small callback
 * boundary keeps the API/query graph acyclic without a fake dynamic import.
 */
async function invalidateQueriesForReplayedResources(
  resources: Set<string>,
): Promise<void> {
  if (resources.size === 0) return;
  for (const resource of resources) {
    const prefixes = OUTBOX_RESOURCE_QUERY_PREFIXES[resource] ?? [resource];
    for (const prefix of prefixes) {
      invalidateReplayedQueryPrefix(prefix);
    }
  }
}

/**
 * Replay one queued mutation through the shared httpFetch core so the
 * replay inherits jittered backoff + Retry-After handling (audit §3.2:
 * the old raw-fetch replay had neither). The item's STORED
 * Idempotency-Key is reused so every wire attempt hits the same server
 * dedup row.
 */
async function replayMutation(item: OfflineMutation): Promise<Response> {
  const identityGeneration = captureApiIdentityGeneration();
  if (identityGeneration === null) {
    throw new Error("Workspace identity transition interrupted replay");
  }
  const key = normalizeApiKey(getApiKey());
  // Strip any case-variant If-Match the item carried (reissueAsOverwrite
  // sets a lowercase "if-match": "*") so we never emit TWO case-distinct
  // keys — fetch combines them into one wire header "If-Match: *, *", which
  // the backend parses as a non-wildcard token and 412s forever, so
  // "Keep mine"/"Edit & retry" conflict-overwrite can never succeed (D01#1).
  const carriedHeaders: Record<string, string> = { ...(item.headers ?? {}) };
  let carriedIfMatch: string | undefined;
  for (const k of Object.keys(carriedHeaders)) {
    if (k.toLowerCase() === "if-match") {
      carriedIfMatch = carriedHeaders[k];
      delete carriedHeaders[k];
    }
  }
  const ifMatch = item.baseVersion || carriedIfMatch;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...NATIVE_CLIENT_HEADERS,
    ...(item.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...carriedHeaders,
    "Idempotency-Key": item.idempotencyKey,
    ...(ifMatch ? { "If-Match": ifMatch } : {}),
  };
  const { res, err } = await httpFetch(
    apiUrl(item.path),
    {
      method: item.method,
      headers,
      ...(item.body !== undefined ? { body: JSON.stringify(item.body) } : {}),
      mode: "cors",
      credentials: "include",
      cache: "no-store",
    },
    // Single wire attempt per replay: the outbox drain owns the retry
    // budget (attempts counter + jittered re-tries). Letting httpFetch
    // also retry 3× would multiply to 18 attempts per item.
    {
      timeoutMs: TIMEOUT_MS,
      maxAttempts: 1,
      signal: apiIdentitySignal(null),
    },
  );
  if (!apiIdentityGenerationIsCurrent(identityGeneration))
    throw new Error("Workspace changed before replay completed");
  if (!res) {
    noteRequestFailure();
    throw err instanceof Error ? err : new Error("Replay transport failure");
  }
  noteRequestSuccess();
  // The outbox replay transport is a third path to the server. A drain that
  // learns nothing about the context is a drain that cannot notice it moved.
  observeContextEpoch(res.headers.get(CONTEXT_EPOCH_HEADER));
  return res;
}

function parseRequestBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function storageByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function readBoundedStorageValue(key: string, maxBytes: number): string | null {
  const value = window.localStorage.getItem(key);
  if (!value) return null;
  if (storageByteLength(value) > maxBytes) {
    window.localStorage.removeItem(key);
    return null;
  }
  return value;
}

function boundedSessionHintString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_SESSION_HINT_FIELD_CHARS) {
    return null;
  }
  return value;
}

async function errorFromResponse(res: Response): Promise<ApiErr["error"]> {
  const requestId = res.headers.get("x-request-id") ?? undefined;
  const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"));
  let parsed: unknown;
  let text = "";
  try {
    text = await readTextLimited(res, MAX_API_ERROR_TEXT_BYTES);
    parsed = text ? safeJson(text) : undefined;
  } catch {
    parsed = undefined;
  }

  const env = parseErrorEnvelope(parsed);
  const rawMessage =
    env.message || (text ? text.slice(0, 200) : `HTTP ${res.status}`);
  // The header is the fallback, but for guidance the merged value is what the
  // reader needs: the server mirrors `retry_after_seconds` into `Retry-After`,
  // and a proxy can strip either one.
  const mergedRetryAfter = env.retryAfterSeconds ?? retryAfterSeconds;
  const denial = env.denial
    ? mergedRetryAfter === undefined
      ? env.denial
      : { ...env.denial, retryAfterSeconds: mergedRetryAfter }
    : undefined;
  const safeMessage = withRequestId(
    // The denial vocabulary, applied at THE transport chokepoint rather than in
    // a screen. Every `api.*` call already funnels through here, so a refusal
    // arrives explained everywhere at once — which is the difference between
    // "you cannot do this" and "ask a workspace editor" / "upgrade your plan" /
    // "try again in 2 minutes". Sanitisation runs FIRST so the guidance is
    // appended to the copy the user will actually see, never to a leaked
    // driver string that sanitizeApiMessage is about to discard.
    denialGuidance(
      sanitizeApiMessage(rawMessage, res.status, Boolean(denial)),
      denial,
    ),
    requestId ?? env.requestId,
  );

  return {
    kind: "http",
    status: res.status,
    code: env.code ?? `http_${res.status}`,
    requestId: requestId ?? env.requestId,
    retryAfterSeconds: mergedRetryAfter,
    message: safeMessage,
    details: env.details,
    ...(denial ? { denial } : {}),
  };
}

/**
 * Read a step-up challenge off a response WITHOUT consuming it.
 *
 * The caller still needs the original body for `errorFromResponse`, so this
 * reads a bounded clone. Only 401s are inspected: `Response.clone()` buffers,
 * and paying for that on every 4xx/5xx to look for a marker the server only
 * ever puts on a 401 would be a cost with no possible finding.
 *
 * A clone that cannot be read degrades to header-only detection rather than
 * throwing — and on this surface the header is the half most likely to be
 * missing (CORS hides it from `tauri://localhost` unless the API names it in
 * Access-Control-Expose-Headers), which is exactly why both halves are tried.
 */
async function readStepUpChallenge(
  res: Response,
): Promise<ReturnType<typeof parseStepUpChallenge>> {
  if (res.status !== 401) return null;
  let parsed: unknown;
  try {
    const text = await readTextLimited(res.clone(), MAX_API_ERROR_TEXT_BYTES);
    parsed = text ? safeJson(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return parseStepUpChallenge(res.status, res.headers, parsed);
}

function transportError(err: unknown): ApiErr["error"] {
  if (err instanceof ApiBodyTooLargeError) {
    return {
      kind: "parse",
      code: "response_too_large",
      message: "API response was too large. Please refresh and try again.",
    };
  }
  if (err instanceof Error && err.name === "AbortError") {
    return {
      kind: "timeout",
      code: "request_timeout",
      message: "Request timed out. Check your connection and try again.",
    };
  }
  return {
    kind: "network",
    code: "network_error",
    message: "Network error. Check your connection and try again.",
  };
}

function migrationUploadIdentityChanged(): ApiErr {
  return {
    error: {
      kind: "parse",
      code: "upload_identity_changed",
      message:
        "The active workspace changed, so this upload was stopped before any resume state could cross accounts. Select the file again in the current workspace.",
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Timeout applied to blob/download helpers (audit §4.3 L8) — covers
 *  both the response headers and the body read, so a hung server can't
 *  leave the UI on "preparing…" forever. */
const BLOB_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * AbortController wrapper for blob downloads: 60s timeout + optional
 * caller-signal chaining. Call `dispose()` in a finally block.
 */
function createDownloadController(callerSignal?: AbortSignal | null): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BLOB_DOWNLOAD_TIMEOUT_MS);
  const onAbort = (): void => ctrl.abort();
  if (callerSignal) {
    if (callerSignal.aborted) ctrl.abort();
    else callerSignal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
    },
  };
}

async function readTextLimited(
  res: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ApiBodyTooLargeError();
  }
  if (!res.body) {
    const read = res.text.bind(res);
    const text = await read();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new ApiBodyTooLargeError();
    }
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ApiBodyTooLargeError();
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function boundedResponseTextBytes(requested?: number): number {
  if (requested === undefined) return MAX_API_RESPONSE_TEXT_BYTES;
  if (!Number.isFinite(requested) || requested <= 0) {
    return MAX_API_RESPONSE_TEXT_BYTES;
  }
  return Math.min(
    Math.max(1, Math.trunc(requested)),
    MAX_API_RESPONSE_TEXT_OVERRIDE_BYTES,
  );
}

class ApiBodyTooLargeError extends Error {
  constructor() {
    super("API response body exceeded safety limit");
    this.name = "ApiBodyTooLargeError";
  }
}

// parseErrorEnvelope now comes from @postwave/errors (the one shared parser) —
// its superset covers this surface's former local copy (string body,
// `{error:"string"}`, and the `details`-lifting of unknown inner keys) plus
// RFC-7807 `detail`, region/correct_endpoint, and field errors.

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    const seconds = Math.ceil((asDate - Date.now()) / 1000);
    if (seconds > 0) return seconds;
  }
  return undefined;
}

function serverVersionFromResponse(response: Response): {
  serverVersion?: string;
  responseLocation?: string;
} {
  const value =
    response.headers.get("etag") ??
    response.headers.get("x-resource-version") ??
    response.headers.get("last-modified");
  const location = response.headers.get("location");
  return {
    ...(value ? { serverVersion: value } : {}),
    ...(location ? { responseLocation: location } : {}),
  };
}

function sendingCapResponseMetadata(response: Response): {
  responseMetadata?: ApiResponseMetadata;
} {
  const value = response.headers.get("x-postwave-sending-cap-outcome");
  if (
    value !== "not-committed" &&
    value !== "committed" &&
    value !== "committed-conservatively-fenced" &&
    value !== "commit-outcome-unknown-conservatively-fenced"
  ) {
    return {};
  }
  return {
    responseMetadata: {
      status: response.status,
      sendingCapOutcome: value,
    },
  };
}

/**
 * `classifiedDenial` exempts a message from the blanket 5xx rule — NOT from the
 * internals check below it.
 *
 * The blanket rule exists because an anonymous 5xx body may be an incident
 * leaking a driver string. A denial is the opposite: `entitlement.Denial.Message`
 * is documented as human-facing, safe to show, and forbidden from naming the
 * configuration that produced the decision. Only `runtime` denials are affected,
 * since it is the one reason `entitlement.Reason.httpStatus` maps to a 5xx (503)
 * — and they are exactly the ones worth reading. Without this,
 * `handlers/security.go`'s "Single sign-on is not available in this deployment.
 * Saving a provider here would not change how anyone signs in." reached the user
 * as "Server error. Please try again.", which is both wrong and alarming: the
 * server deliberately explained a product boundary and desktop reported an
 * outage. The class still arrives on `error.denial` either way; this is about
 * the sentence.
 *
 * The leak-pattern check still runs, so a denial that somehow carried a driver
 * string is redacted like anything else.
 */
function sanitizeApiMessage(
  message: string,
  status: number,
  classifiedDenial = false,
): string {
  if (!message) return "Something went wrong. Please try again.";
  const anonymousServerError = status >= 500 && !classifiedDenial;
  if (
    anonymousServerError ||
    /pq:|sql:|SQLSTATE|stack trace|panic:/i.test(message)
  ) {
    return "Server error. Please try again.";
  }
  return message;
}

function withRequestId(message: string, requestId?: string): string {
  // Shared render (@postwave/errors) — one source for the request-id suffix
  // across web + desktop.
  return formatErrorMessage(message, requestId, message);
}

async function requestWithConfig<T>(
  baseUrl: string,
  path: string,
  key?: string | null,
): Promise<ApiResult<T>> {
  const identityGeneration = captureApiIdentityGeneration();
  if (identityGeneration === null) {
    return apiIdentityTransitionError("identity_transition");
  }
  const validation = validateApiUrl(baseUrl);
  if (!validation.ok) {
    return {
      error: { kind: "invalid_config", message: validation.message },
    };
  }
  const url = apiUrlFromBase(validation.url, path);
  const headers: Record<string, string> = { Accept: "application/json" };
  const bearer = normalizeApiKey(key);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  let res: Response | undefined;
  let err: unknown;
  const setupProbe =
    isTauri() &&
    (Boolean(bearer) || tauriApi.apiBrokerStatus().baseUrl !== validation.url);
  if (setupProbe) {
    try {
      res = await tauriApi.probeApiConnection(validation.url, url, bearer);
    } catch (error) {
      err = error;
    }
  } else {
    ({ res, err } = await httpFetch(
      url,
      { headers, mode: "cors", cache: "no-store" },
      {
        timeoutMs: TIMEOUT_MS,
        signal: apiIdentitySignal(null),
      },
    ));
  }
  if (!apiIdentityGenerationIsCurrent(identityGeneration))
    return apiIdentityTransitionError("identity_changed");
  if (!res) return { error: transportError(err) };
  if (!res.ok) {
    const error = await errorFromResponse(res);
    if (!apiIdentityGenerationIsCurrent(identityGeneration))
      return apiIdentityTransitionError("identity_changed");
    return { error };
  }
  if (res.status === 204) return { data: undefined as unknown as T };
  let text: string;
  try {
    text = await readTextLimited(res, MAX_API_RESPONSE_TEXT_BYTES);
  } catch (readErr) {
    if (!apiIdentityGenerationIsCurrent(identityGeneration))
      return apiIdentityTransitionError("identity_changed");
    return { error: transportError(readErr) };
  }
  if (!apiIdentityGenerationIsCurrent(identityGeneration))
    return apiIdentityTransitionError("identity_changed");
  if (!text) return { data: undefined as unknown as T };
  try {
    return { data: JSON.parse(text) as T };
  } catch {
    return {
      error: {
        kind: "parse",
        message: "API returned invalid JSON. Please refresh and try again.",
      },
    };
  }
}

export async function validateApiConnection(
  url: string,
  key?: string | null,
): Promise<ApiResult<ApiConnectionValidation>> {
  const health = await requestWithConfig<HealthResponse>(url, "/api/health");
  if (health.error) return health;

  const checkedUrl = validateApiUrl(url);
  const usesStoredNativeKey =
    isTauri() &&
    checkedUrl.ok &&
    tauriApi.apiBrokerStatus().configured &&
    tauriApi.apiBrokerStatus().baseUrl === checkedUrl.url;
  if (!normalizeApiKey(key) && !usesStoredNativeKey) {
    return {
      data: {
        health: health.data,
        authenticated: false,
      },
    };
  }

  // Session identity and API-key identity are intentionally separate auth
  // surfaces. /auth/me rejects bearer credentials; the key-scoped self-info
  // route is the authoritative proof that the supplied bearer resolved.
  const me = await requestWithConfig<MeResponse>(
    url,
    "/api/v1/api-keys/me",
    key,
  );
  if (me.error) {
    return {
      error: {
        message: `API reachable, but API key validation failed: ${me.error.message}`,
        status: me.error.status,
      },
    };
  }
  return {
    data: {
      health: health.data,
      me: me.data,
      authenticated: true,
    },
  };
}

/* ---------- public methods ------------------------------------------ */

const auditOperationsMethods = createAuditOperationsMethods({
  request,
  getApiUrl,
  buildStreamUrl,
  createDownloadController,
  getApiKey,
  normalizeApiKey,
  nativeAwareFetch: apiIdentityAwareNativeFetch,
  apiUrl,
  errorFromResponse,
  transportError,
  llmRequestOptions: LLM_REQUEST_OPTS,
});

const subscriberDataOperationsMethods = createSubscriberDataOperationsMethods({
  request,
  createDownloadController,
  normalizeApiKey,
  getApiKey,
  nativeAwareFetch: apiIdentityAwareNativeFetch,
  apiUrl,
  errorFromResponse,
  transportError,
  buildStreamUrl,
  nativeClientHeaders: NATIVE_CLIENT_HEADERS,
});

const campaignSequenceOperationsMethods =
  createCampaignSequenceOperationsMethods({
    request,
    queueableRequest,
    llmRequestOptions: LLM_REQUEST_OPTS,
    sequencePositionPathSegment,
    pollSequenceJob,
    extractSequenceEmailAt,
  });

const consentPrivacyOperationsMethods = createConsentPrivacyOperationsMethods({
  request,
  createDownloadController,
  normalizeApiKey,
  getApiKey,
  nativeAwareFetch: apiIdentityAwareNativeFetch,
  apiUrl,
  errorFromResponse,
  transportError,
});

function isStrongFormEntityTag(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === value &&
    !trimmed.startsWith("W/") &&
    /^"[^"\r\n]+"$/.test(trimmed)
  );
}

// Core method bag. Domain method bags are composed with this exactly once
// below; the exported facade is never augmented after construction.
const coreApi = {
  health(): Promise<ApiResult<HealthResponse>> {
    return request<HealthResponse>("/api/health");
  },
  getMe(): Promise<ApiResult<MeResponse>> {
    // /api/v1/me returns the legacy {tenant, user} shape this MeResponse
    // type models (handlers.Me). /api/v1/auth/me returns a different
    // flat {user_id, tenant_id, …} shape, so pointing here left the
    // sidebar identity row + API-key identity path blank (D15#1).
    return request<MeResponse>("/api/v1/me");
  },
  getApiKeySelfInfo(): Promise<ApiResult<ApiKeySelfInfoResponse>> {
    return request<ApiKeySelfInfoResponse>("/api/v1/api-keys/me");
  },
  /**
   * GET /api/v1/dashboard/stats — tenant overview rollups.
   *
   * Refined Dashboard (PR 1): accepts `range` (7d|30d|90d, default 30d),
   * `compare` (default true → server includes the previous-window
   * counts), `sparklines` (default true → server includes daily
   * buckets and anomaly flags). All three default to "rich" mode so
   * the new dashboard renders fully on the first request.
   */
  async listDashboardAnomalies(
    opts: { limit?: number } = {},
  ): Promise<ApiResult<{ items: DashboardAnomalyRow[] }>> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const res = await request<{ items: DashboardAnomalyRow[] }>(
      `/api/v1/dashboard/anomalies${qs ? `?${qs}` : ""}`,
    );
    if (
      res.error &&
      res.error.kind === "http" &&
      (res.error.status === 404 || res.error.status === 501)
    ) {
      return { data: { items: [] } };
    }
    return res;
  },

  /**
   * Frontend-skip: only 404 (prefs not seeded / route absent) and 501
   * (surface not implemented) are treated as feature-absent and resolve
   * with a default ("off") payload. 500 and every other failure
   * propagates — an outage must not render as a healthy default
   * (audit §4.1).
   */
  async getDashboardDigestPrefs(): Promise<ApiResult<DashboardDigestPrefs>> {
    const res = await request<DashboardDigestPrefs>("/api/v1/dashboard/digest");
    if (
      res.error &&
      res.error.kind === "http" &&
      (res.error.status === 404 || res.error.status === 501)
    ) {
      return {
        data: {
          userId: "",
          tenantId: "",
          frequency: "off",
          lastSentAt: null,
          updatedAt: "",
        },
      };
    }
    return res;
  },

  putDashboardDigestPrefs(input: {
    frequency: "off" | "daily" | "weekly";
  }): Promise<ApiResult<{ ok?: boolean; frequency?: string }>> {
    return request<{ ok?: boolean; frequency?: string }>(
      "/api/v1/dashboard/digest",
      { method: "PUT", body: JSON.stringify(input) },
    );
  },

  /**
   * Frontend-skip: only 404 (row not seeded / route absent) and 501 are
   * treated as feature-absent — the Dashboard renders its default order
   * for the empty payload. 500 and every other failure propagates
   * (audit §4.1: outages must not look like "no layout saved").
   */
  async getDashboardLayout(): Promise<ApiResult<DashboardLayoutResponse>> {
    const res = await request<DashboardLayoutResponse>(
      "/api/v1/dashboard/layout",
    );
    if (
      res.error &&
      res.error.kind === "http" &&
      (res.error.status === 404 || res.error.status === 501)
    ) {
      return {
        data: { userId: "", tenantId: "", order: [], updatedAt: "" },
      };
    }
    return res;
  },

  putDashboardLayout(input: {
    order: string[];
  }): Promise<ApiResult<{ ok?: boolean }>> {
    return request<{ ok?: boolean }>("/api/v1/dashboard/layout", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },

  getDashboardBenchmarks(): Promise<ApiResult<DashboardBenchmarksResponse>> {
    return request<DashboardBenchmarksResponse>("/api/v1/dashboard/benchmarks");
  },

  getDashboardStats(
    opts: {
      range?: DashboardStatsContract.DashboardRange;
      compare?: boolean;
      sparklines?: boolean;
    } = {},
  ): Promise<ApiResult<DashboardStatsContract.DashboardStatsResponse>> {
    const params = new URLSearchParams();
    if (opts.range) params.set("range", opts.range);
    if (opts.compare === false) params.set("compare", "false");
    if (opts.sparklines === false) params.set("sparklines", "false");
    const qs = params.toString();
    return request<DashboardStatsContract.DashboardStatsResponse>(
      `/api/v1/dashboard/stats${qs ? `?${qs}` : ""}`,
    );
  },
  listCampaigns(
    opts: { page?: number; perPage?: number } = {},
    reqOpts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<CampaignsResponse>> {
    const params = new URLSearchParams();
    if (opts.page) params.set("page", String(opts.page));
    if (opts.perPage) params.set("per_page", String(opts.perPage));
    const qs = params.toString();
    return request<CampaignsResponse>(
      `/api/v1/campaigns${qs ? `?${qs}` : ""}`,
      {},
      reqOpts,
    );
  },
  countCampaigns(
    reqOpts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<CampaignCountResponse>> {
    return request<CampaignCountResponse>(
      "/api/v1/campaigns/count",
      {},
      reqOpts,
    );
  },
  createCampaign(input: {
    name: string;
    subject: string;
    from_email: string;
    body?: string;
    preview_text?: string;
  }): Promise<ApiResult<Campaign>> {
    // The backend CreateInput has no `body` or `from_email` field: the body
    // must be `body_html`, and from_email lives in delivery_settings (what
    // the send path reads). Posting the old shape silently discarded the
    // typed body + the required From address (D06#2). CreateInput also has
    // no `status`: the server assigns draft state on creation and accepts
    // status only through the update contract.
    const fromEmail = input.from_email.trim();
    return request<Campaign>("/api/v1/campaigns", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        subject: input.subject,
        body_html: input.body ?? "",
        ...(input.preview_text ? { preview_text: input.preview_text } : {}),
        ...(fromEmail ? { delivery_settings: { from_email: fromEmail } } : {}),
      }),
    });
  },
  /** Tags feature 12/12: patch a campaign's audience-typed targets.
   *  `target_tag_ids` is capped at 5 by the server (Mailchimp parity).
   *  Pass an empty array to clear; pass null/undefined to leave unchanged. */
  updateCampaignAudience(
    id: string,
    input: { segment_id?: string; target_tag_ids?: string[] },
  ): Promise<ApiResult<Campaign>> {
    return request<Campaign>(`/api/v1/campaigns/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
  listSequences(
    reqOpts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<SequencesResponse>> {
    return request<SequencesResponse>("/api/v1/voice/sequences", {}, reqOpts);
  },
  /**
   * One round-trip per tenant for the whole onboarding checklist.
   * Drives the home-page `<OnboardingChecklist />` and replaces the
   * 5 parallel list-endpoint calls the desktop used previously.
   *
   * Server fans out to ~10 EXISTS probes in a single transaction
   * (see apps/api/internal/onboarding_progress). Older API versions
   * that don't ship this route are handled in
   * `useOnboardingProgress` via a graceful 404 fallback.
   */
  getOnboardingProgress(): Promise<ApiResult<OnboardingProgressResponse>> {
    return request<OnboardingProgressResponse>("/api/v1/onboarding-progress");
  },
  createSequence(input: {
    name: string;
    description?: string;
    status?: "draft" | "active" | "paused" | "archived";
    steps?: SequenceStoredStep[];
  }): Promise<ApiResult<Sequence>> {
    return request<Sequence>("/api/v1/voice/sequences", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        description: input.description ?? "",
        status: input.status ?? "draft",
        steps: input.steps ?? [],
      }),
    });
  },
  /**
   * POST /api/v1/voice/sequences/draft — LLM-backed whole-sequence
   * draft from a free-form brief. Returns `{name, steps}` (steps carry
   * subject/body/delay_hours/position) WITHOUT persisting anything —
   * pipe the result into createSequence once the operator accepts it.
   *
   * Uses LLM_REQUEST_OPTS (60s timeout, single attempt): an expensive
   * generation is never auto-retried.
   */
  draftSequence(input: {
    brief: string;
    step_count?: number;
    tone?: string;
  }): Promise<ApiResult<SequenceDraftResponse>> {
    return request<SequenceDraftResponse>(
      "/api/v1/voice/sequences/draft",
      { method: "POST", body: JSON.stringify(input) },
      LLM_REQUEST_OPTS,
    );
  },
  createAutomationJourney(
    input: AutomationJourneyInput,
  ): Promise<ApiResult<AutomationJourney>> {
    return request<AutomationJourney>("/api/v1/mailchimp-compat/automations", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  // The four Mailchimp parity endpoints below are mounted under an API-key
  // scope on the server (apps/api/internal/mailchimpv3/handlers.go). They
  // now perform the real GET (audit §4.3): a deployment where the surface
  // is absent/unauthorised returns 404, which the dashboard card treats as
  // feature-absent (hidden) — NOT as a healthy empty snapshot.
  getMailchimpCampaignPlanner(): Promise<ApiResult<Record<string, unknown>>> {
    return request<Record<string, unknown>>(
      "/api/mailchimp/3.0/campaign-manager/calendar",
    );
  },
  getMailchimpAudienceInsights(): Promise<ApiResult<Record<string, unknown>>> {
    return request<Record<string, unknown>>(
      "/api/mailchimp/3.0/audience/insights",
    );
  },
  getMailchimpContentStudio(): Promise<ApiResult<Record<string, unknown>>> {
    return request<Record<string, unknown>>(
      "/api/mailchimp/3.0/content-studio",
    );
  },
  getMailchimpMultiChannelReadiness(): Promise<
    ApiResult<Record<string, unknown>>
  > {
    return request<Record<string, unknown>>(
      "/api/mailchimp/3.0/growth/channels",
    );
  },

  /* ---------- forms ------------------------------------------------- */
  listForms(
    reqOpts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<FormSummary[]>> {
    return request<FormSummary[]>("/api/v1/forms", {}, reqOpts);
  },
  getForm(id: string): Promise<ApiResult<FormDetail>> {
    return request<FormDetail>(`/api/v1/forms/${encodeURIComponent(id)}`);
  },
  /** Server-authored embed/share contract. The API owns the configured
   *  public forms host; desktop callers must not reconstruct it from the API
   *  origin. This endpoint is admin-scoped. */
  getFormEmbed(
    id: string,
    flavor: FormEmbedFlavor,
    reqOpts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<FormEmbedSnippetResponse>> {
    return request<FormEmbedSnippetResponse>(
      `/api/v1/forms/${encodeURIComponent(id)}/embed/${encodeURIComponent(flavor)}`,
      {},
      reqOpts,
    );
  },
  createForm(
    input: {
      name: string;
      slug: string;
      optInMode: FormOptInMode;
      successMessage?: string;
      successRedirectUrl?: string;
    },
    reqOpts: RequestOpts = {},
  ): Promise<QueueableApiResult<FormDetail>> {
    return queueableRequest<FormDetail>(
      "/api/v1/forms",
      {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          slug: input.slug,
          optInMode: input.optInMode,
          successMessage: input.successMessage ?? "",
          successRedirectUrl: input.successRedirectUrl ?? "",
        }),
      },
      reqOpts,
    );
  },
  updateForm(
    id: string,
    patch: FormUpdateInput,
    options: FormUpdateOptions = {},
  ): Promise<QueueableApiResult<FormDetail>> {
    if (
      options.expectedVersion !== undefined &&
      !isStrongFormEntityTag(options.expectedVersion)
    ) {
      return Promise.resolve({
        error: {
          kind: "invalid_config",
          code: "invalid_form_version",
          message:
            "A confirmed strong form version is required before this update can be sent.",
        },
        retryability: "not-retryable",
        preservedDraft: patch,
      });
    }
    return queueableRequest<FormDetail>(
      `/api/v1/forms/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: options.expectedVersion
          ? { "If-Match": options.expectedVersion }
          : undefined,
        body: JSON.stringify(patch),
      },
      { requireOnline: options.requireOnline },
    );
  },
  deleteForm(
    id: string,
    options: FormDeleteOptions = {},
  ): Promise<ApiResult<{ ok: boolean }>> {
    if (
      options.expectedVersion !== undefined &&
      !isStrongFormEntityTag(options.expectedVersion)
    ) {
      return Promise.resolve({
        error: {
          kind: "invalid_config",
          code: "invalid_form_version",
          message:
            "A confirmed strong form version is required before this deletion can be sent.",
        },
        retryability: "not-retryable",
      });
    }
    return request<{ ok: boolean }>(
      `/api/v1/forms/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: options.expectedVersion
          ? { "If-Match": options.expectedVersion }
          : undefined,
      },
      { requireOnline: true },
    );
  },
  listFormSubmissions(id: string): Promise<ApiResult<FormSubmission[]>> {
    return request<FormSubmission[]>(
      `/api/v1/forms/${encodeURIComponent(id)}/submissions`,
    );
  },
  /** GET /api/v1/forms/{id}/analytics?days= — daily hosted-page visits
   *  + total for the form detail sparkline. */
  getFormAnalytics(
    id: string,
    opts: { days?: number } = {},
  ): Promise<ApiResult<FormAnalyticsResponse>> {
    const params = new URLSearchParams();
    if (opts.days) params.set("days", String(opts.days));
    const qs = params.toString();
    return request<FormAnalyticsResponse>(
      `/api/v1/forms/${encodeURIComponent(id)}/analytics${qs ? `?${qs}` : ""}`,
    );
  },

  /* ---------- campaign templates ----------------------------------- */
  listCampaignTemplates(
    opts: {
      query?: string;
      goal?: string;
      source?: "all" | "platform" | "team" | "mine";
      favorited?: boolean;
      archived?: "active" | "archived" | "all";
    } = {},
    reqOpts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<CampaignTemplateListResponse>> {
    // v2 (migration 0187): the backend accepts query / goal / source /
    // favorited filters. All optional; missing params collapse to "no
    // filter" server-side so the legacy zero-arg call still works.
    const params = new URLSearchParams();
    if (opts.query) params.set("query", opts.query);
    if (opts.goal) params.set("goal", opts.goal);
    if (opts.source && opts.source !== "all") params.set("source", opts.source);
    if (opts.favorited) params.set("favorited", "1");
    if (opts.archived && opts.archived !== "active") {
      params.set("archived", opts.archived);
    }
    const qs = params.toString();
    return request<CampaignTemplateListResponse>(
      `/api/v1/campaign-templates${qs ? `?${qs}` : ""}`,
      {},
      reqOpts,
    );
  },
  /** GET /api/v1/campaign-templates/search — compact visual catalog page. */
  searchCampaignTemplates(
    opts: {
      query?: string;
      goal?: string;
      category?: string;
      source?: "all" | "platform" | "team" | "mine" | string;
      provider?: string;
      industry?: string;
      style?: string;
      layout?: string;
      kind?: "editable" | "reference";
      tags?: string[];
      featured?: boolean;
      favorited?: boolean;
      archived?: "active" | "archived" | "all";
      sort?: "recommended" | "name" | "most_used";
      page?: number;
      per_page?: number;
    } = {},
    reqOpts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<CampaignTemplateSearchResponse>> {
    const params = new URLSearchParams();
    if (opts.query) params.set("query", opts.query);
    if (opts.goal) params.set("goal", opts.goal);
    if (opts.category) params.set("category", opts.category);
    if (opts.source && opts.source !== "all") params.set("source", opts.source);
    if (opts.provider) params.set("provider", opts.provider);
    if (opts.industry) params.set("industry", opts.industry);
    if (opts.style) params.set("style", opts.style);
    if (opts.layout) params.set("layout", opts.layout);
    if (opts.kind) params.set("kind", opts.kind);
    if (opts.tags?.length) params.set("tags", opts.tags.join(","));
    if (opts.featured) params.set("featured", "1");
    if (opts.favorited) params.set("favorited", "1");
    if (opts.archived && opts.archived !== "active") {
      params.set("archived", opts.archived);
    }
    if (opts.sort && opts.sort !== "recommended") {
      params.set("sort", opts.sort);
    }
    if (opts.page) params.set("page", String(opts.page));
    if (opts.per_page) params.set("per_page", String(opts.per_page));
    const query = params.toString();
    return request<CampaignTemplateSearchResponse>(
      `/api/v1/campaign-templates/search${query ? `?${query}` : ""}`,
      {},
      reqOpts,
    );
  },
  getCampaignTemplate(id: string): Promise<ApiResult<CampaignTemplate>> {
    return request<CampaignTemplate>(
      `/api/v1/campaign-templates/${encodeURIComponent(id)}`,
    );
  },
  createCampaignTemplate(
    input: {
      slug: string;
      name: string;
      subject: string;
      preview_text?: string;
      body_html?: string;
      body_mjml?: string;
      category?: string;
      kind?: string;
      description?: string;
      tags?: string[];
      goal?: TemplateGoal;
      variables?: Array<Record<string, unknown>>;
    },
    reqOpts: RequestOpts = {},
  ): Promise<QueueableApiResult<CampaignTemplate>> {
    // The Go handler accepts: slug, name, description, category, subject,
    // preview_text, body_html, body_mjml, variables, tags. `kind` is not
    // a first-class column today, so the UI stashes it as a `kind:<v>`
    // tag — survives a round-trip without any backend changes.
    const tags = [...(input.tags ?? [])];
    if (input.kind && !tags.some((t) => t.startsWith("kind:"))) {
      tags.push(`kind:${input.kind}`);
    }
    return queueableRequest<CampaignTemplate>(
      "/api/v1/campaign-templates",
      {
        method: "POST",
        body: JSON.stringify({
          slug: input.slug,
          name: input.name,
          subject: input.subject,
          preview_text: input.preview_text ?? "",
          body_html: input.body_html ?? "",
          body_mjml: input.body_mjml ?? "",
          category: input.category ?? "",
          description: input.description ?? "",
          tags,
          goal: input.goal ?? "",
          variables: input.variables ?? [],
        }),
      },
      reqOpts,
    );
  },
  updateCampaignTemplate(
    id: string,
    input: Partial<{
      name: string;
      subject: string;
      preview_text: string;
      body_html: string;
      body_mjml: string;
      category: string;
      description: string;
      tags: string[];
      variables: Array<Record<string, unknown>>;
      goal: TemplateGoal | "";
    }>,
    options: { expectedVersion: string },
  ): Promise<QueueableApiResult<CampaignTemplate>> {
    const expectedVersion = options?.expectedVersion;
    if (!isStrongCampaignTemplateEntityTag(expectedVersion)) {
      return Promise.resolve({
        error: {
          kind: "invalid_config",
          code: "campaign_template_etag_required",
          message:
            "Reload this template to obtain its current strong version before saving.",
        },
        retryability: "not-retryable",
        preservedDraft: input,
      });
    }
    return queueableRequest<CampaignTemplate>(
      `/api/v1/campaign-templates/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "If-Match": expectedVersion },
        body: JSON.stringify(input),
      },
    );
  },
  archiveCampaignTemplate(
    id: string,
    expectedVersion: string,
  ): Promise<ApiResult<CampaignTemplate>> {
    if (!isStrongCampaignTemplateEntityTag(expectedVersion)) {
      return Promise.resolve({
        error: {
          kind: "invalid_config",
          code: "campaign_template_etag_required",
          message:
            "Reload this template to obtain its current strong version before archiving.",
        },
        retryability: "not-retryable",
      });
    }
    return request<CampaignTemplate>(
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/archive`,
      {
        method: "PATCH",
        headers: { "If-Match": expectedVersion },
      },
      { requireOnline: true, maxAttempts: 1 },
    );
  },
  restoreCampaignTemplate(
    id: string,
    expectedVersion: string,
  ): Promise<ApiResult<CampaignTemplate>> {
    if (!isStrongCampaignTemplateEntityTag(expectedVersion)) {
      return Promise.resolve({
        error: {
          kind: "invalid_config",
          code: "campaign_template_etag_required",
          message:
            "Reload this template to obtain its current strong version before restoring.",
        },
        retryability: "not-retryable",
      });
    }
    return request<CampaignTemplate>(
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/restore`,
      {
        method: "PATCH",
        headers: { "If-Match": expectedVersion },
      },
      { requireOnline: true, maxAttempts: 1 },
    );
  },
  /**
   * Deprecated compatibility lane. DELETE is server-side safe archive and
   * still requires the exact current entity tag.
   */
  deleteCampaignTemplate(
    id: string,
    expectedVersion: string,
  ): Promise<ApiResult<CampaignTemplate>> {
    if (!isStrongCampaignTemplateEntityTag(expectedVersion)) {
      return Promise.resolve({
        error: {
          kind: "invalid_config",
          code: "campaign_template_etag_required",
          message:
            "Reload this template to obtain its current strong version before archiving.",
        },
        retryability: "not-retryable",
      });
    }
    return request<CampaignTemplate>(
      `/api/v1/campaign-templates/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: { "If-Match": expectedVersion },
      },
      { requireOnline: true, maxAttempts: 1 },
    );
  },
  listCampaignTemplateRevisions(
    id: string,
    opts: { page?: number; per_page?: number } = {},
  ): Promise<ApiResult<CampaignTemplateRevisionPage>> {
    const params = new URLSearchParams();
    if (opts.page) params.set("page", String(opts.page));
    if (opts.per_page) params.set("per_page", String(opts.per_page));
    const query = params.toString();
    return request<CampaignTemplateRevisionPage>(
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/revisions${query ? `?${query}` : ""}`,
    );
  },
  getCampaignTemplateRevision(
    id: string,
    version: number,
  ): Promise<ApiResult<CampaignTemplateRevision>> {
    return request<CampaignTemplateRevision>(
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/revisions/${encodeURIComponent(String(version))}`,
    );
  },
  /** GET /api/v1/campaign-templates/stats — dashboard headline tiles. */
  getCampaignTemplateStats(): Promise<ApiResult<TemplateStats>> {
    return request<TemplateStats>("/api/v1/campaign-templates/stats");
  },
  /** GET /api/v1/campaign-templates/goals — per-goal counts. */
  listCampaignTemplateGoals(): Promise<ApiResult<TemplateGoalCount[]>> {
    return request<TemplateGoalCount[]>("/api/v1/campaign-templates/goals");
  },
  /** POST /api/v1/campaign-templates/{id}/clone — server-side duplicate. */
  cloneCampaignTemplate(
    id: string,
    input: { name?: string; slug?: string } = {},
  ): Promise<ApiResult<CampaignTemplate>> {
    return request<CampaignTemplate>(
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/clone`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  createCampaignFromTemplate(
    input: CampaignFromTemplateInput,
  ): Promise<ApiResult<Campaign>> {
    return request<Campaign>("/api/v1/campaigns/from-template", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  /** POST /api/v1/campaign-templates/{id}/use — usage tracker. */
  recordCampaignTemplateUse(id: string): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/use`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },
  /** POST /api/v1/campaign-templates/{id}/favorite — per-user starring. */
  favoriteCampaignTemplate(
    id: string,
  ): Promise<ApiResult<{ ok: boolean; favorited: boolean }>> {
    return request<{ ok: boolean; favorited: boolean }>(
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/favorite`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },
  /** POST /api/v1/campaign-templates/{id}/unfavorite */
  unfavoriteCampaignTemplate(
    id: string,
  ): Promise<ApiResult<{ ok: boolean; favorited: boolean }>> {
    return request<{ ok: boolean; favorited: boolean }>(
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/unfavorite`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },
  /**
   * POST /api/v1/campaigns/{id}/schedule — set, move, or clear a campaign's
   * send time.
   *
   * PATCH /api/v1/campaigns/{id} refuses any body carrying `scheduled_at` with
   * 422 `campaign_dispatch_state_owned` and directs the caller to a lifecycle
   * endpoint. That endpoint did not exist until now, so both desktop schedule
   * writes — the calendar drag and the schedule modal — failed on every attempt.
   *
   * Pass `null` to unschedule; the campaign returns to draft.
   */
  scheduleCampaign(
    campaignId: string | number,
    scheduledAt: string | null,
  ): Promise<ApiResult<Campaign>> {
    return request<Campaign>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/schedule`,
      { method: "POST", body: JSON.stringify({ scheduled_at: scheduledAt }) },
    );
  },
  /**
   * POST /api/v1/campaigns/{id}/save-as-template — snapshot a campaign
   * as a reusable template.
   */
  saveCampaignAsTemplate(
    campaignId: string | number,
    input: {
      slug: string;
      name?: string;
      description?: string;
      category?: string;
      tags?: string[];
    },
  ): Promise<ApiResult<CampaignTemplate>> {
    return request<CampaignTemplate>(
      `/api/v1/campaigns/${encodeURIComponent(String(campaignId))}/save-as-template`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  /**
   * Subscriber growth time-series (used by the Analytics page).
   */
  getSubscriberTimeseries(
    range: "7d" | "30d" | "90d",
  ): Promise<ApiResult<SubscriberTimeseriesResponse>> {
    const qs = new URLSearchParams({ range });
    return request<SubscriberTimeseriesResponse>(
      `/api/v1/analytics/subscribers/timeseries?${qs.toString()}`,
    );
  },
  /**
   * GET /api/v1/analytics/timeseries?group_by=&metric=&days= — grouped
   * engagement time-series for the Analytics page (one series per
   * campaign or sending domain). `days` is server-bounded to 1..90.
   * Unsupported dimensions 400 with code `unsupported_dimension`
   * (e.g. group_by=list is not implemented yet).
   */
  getAnalyticsTimeseries(opts: {
    groupBy: AnalyticsTimeseriesGroupBy;
    metric: AnalyticsTimeseriesMetric;
    days: number;
  }): Promise<ApiResult<AnalyticsTimeseriesResponse>> {
    const params = new URLSearchParams({
      group_by: opts.groupBy,
      metric: opts.metric,
      days: String(opts.days),
    });
    return request<AnalyticsTimeseriesResponse>(
      `/api/v1/analytics/timeseries?${params.toString()}`,
    );
  },
  /** GET /api/v1/campaigns/{id}/report */
  getCampaignReport(id: string | number): Promise<ApiResult<CampaignReport>> {
    return request<CampaignReport>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/report`,
    );
  },
  /**
   * G1 (campaigns 2026): hourly engagement time-series (opens/clicks/
   * unsubs), zero-filled across the campaign's life. Powers the per-KPI
   * sparklines + the stacked area chart in the report tab.
   */
  getCampaignTimeseries(
    id: string | number,
  ): Promise<ApiResult<CampaignTimeseries>> {
    return request<CampaignTimeseries>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/timeseries`,
    );
  },
  /**
   * G15 (campaigns 2026): conversion goal results — count / rate /
   * attributed revenue over the campaign's configured event + window.
   */
  getCampaignGoalResults(
    id: string | number,
  ): Promise<ApiResult<CampaignGoalResults>> {
    return request<CampaignGoalResults>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/goal-results`,
    );
  },
  /** G19 follow-up: per-locale engagement breakdown for the campaign. */
  getCampaignLocaleReport(
    id: string | number,
  ): Promise<
    ApiResult<{ campaign_id: string; locales: CampaignLocaleStat[] }>
  > {
    return request(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/locale-report`,
    );
  },

  /**
   * G18 (campaigns 2026): per-campaign hourly anomaly detection —
   * z-score spikes/drops in opens/clicks/unsubs across the send.
   */
  getCampaignAnomalies(
    id: string | number,
  ): Promise<ApiResult<CampaignAnomaliesResult>> {
    return request<CampaignAnomaliesResult>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/anomalies`,
    );
  },
  /** GET /api/v1/voice/sequences/{id}/funnel */
  getSequenceFunnel(id: string | number): Promise<ApiResult<SequenceFunnel>> {
    return request<SequenceFunnel>(
      `/api/v1/voice/sequences/${encodeURIComponent(String(id))}/funnel`,
    );
  },
  /**
   * GET /api/v1/voice/sequences/{id}/participants?status=&sort=&page=&per_page=
   *
   * Lists the subscribers currently enrolled in this sequence (active),
   * plus completed, goal-completed, and exited ones when requested. Mirrors Customer.io's
   * "Campaign subscribers" tab, Klaviyo's "Flow subscribers", and
   * Iterable's "Journey participants" surfaces — the canonical
   * "who is in step N right now" debugging view.
   *
   * Status semantics (drawer filters):
   *   - active   → currently waiting for the next step
   *   - completed_goal → met an open/click sequence goal
   *   - exited   → completed, removed by tag, or hit an exit node
   *   - all      → no filter
   *
   * Returns `{items, total, page, per_page}`. A 503 means the durable
   * Postgres projection is temporarily unavailable and should render a retry;
   * 404 alone means an older gateway does not expose the contract. Never
   * synthesize fixture data.
   */
  listSequenceParticipants(
    id: string | number,
    opts: {
      status?: SequenceParticipantStatus | "all";
      sort?: SequenceParticipantSort;
      page?: number;
      perPage?: number;
    } = {},
  ): Promise<ApiResult<SequenceParticipantsResponse>> {
    const params = new URLSearchParams();
    if (opts.status && opts.status !== "all") params.set("status", opts.status);
    if (opts.sort) params.set("sort", opts.sort);
    if (opts.page) params.set("page", String(opts.page));
    if (opts.perPage) params.set("per_page", String(opts.perPage));
    const qs = params.toString();
    return request<SequenceParticipantsResponse>(
      `/api/v1/voice/sequences/${encodeURIComponent(String(id))}/participants${qs ? `?${qs}` : ""}`,
    );
  },

  /* ---------- extended analytics (per-campaign + cross-campaign) ----- */

  /** GET /api/v1/campaigns/{id}/link-report */
  getCampaignLinkReport(id: string | number): Promise<ApiResult<LinkRow[]>> {
    return request<LinkRow[]>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/link-report`,
    );
  },
  /** GET /api/v1/campaigns/{id}/geography */
  getCampaignGeography(
    id: string | number,
  ): Promise<ApiResult<GeographyRow[]>> {
    return request<GeographyRow[]>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/geography`,
    );
  },
  /** GET /api/v1/campaigns/{id}/devices */
  getCampaignDevices(id: string | number): Promise<ApiResult<DeviceRow[]>> {
    return request<DeviceRow[]>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/devices`,
    );
  },
  /** GET /api/v1/campaigns/{id}/bounces */
  getCampaignBounces(id: string | number): Promise<ApiResult<BounceCounts>> {
    return request<BounceCounts>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/bounces`,
    );
  },
  /** GET /api/v1/campaigns/{id}/revenue */
  getCampaignRevenue(id: string | number): Promise<ApiResult<RevenueReport>> {
    return request<RevenueReport>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/revenue`,
    );
  },
  /** GET /api/v1/campaigns/{id}/engagement — Surfacing Analytics (#3). */
  getCampaignEngagement(
    id: string | number,
  ): Promise<ApiResult<EngagementPanel>> {
    return request<EngagementPanel>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/engagement`,
    );
  },
  /** GET /api/v1/campaigns/{id}/benchmark */
  async getCampaignBenchmark(
    id: string | number,
  ): Promise<ApiResult<CampaignBenchmarkResponse>> {
    const response = await request<CampaignBenchmarkResponse>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/benchmark`,
    );
    return validateCampaignBenchmarkResponse(String(id), response);
  },
  /** GET /api/v1/analytics/campaigns/compare?ids=a,b,c */
  getCampaignCompare(
    ids: (string | number)[],
  ): Promise<ApiResult<CompareRow[]>> {
    const qs = new URLSearchParams({ ids: ids.map(String).join(",") });
    return request<CompareRow[]>(
      `/api/v1/analytics/campaigns/compare?${qs.toString()}`,
    );
  },
  /** GET /api/v1/analytics/cohorts
   *
   * Backend today only accepts bucket="month" and metric in
   * {open_rate, click_rate, retention} — see analytics/service.go.
   * The wider unions here exist so the UI dropdown can hold all five
   * conceptual metrics for hash round-tripping; callers should gate
   * unsupported choices in the picker rather than fire failing requests.
   */
  getCohorts(
    opts: {
      bucket?: CohortBucket;
      metric?: CohortMetric;
      weeks?: number;
    } = {},
  ): Promise<ApiResult<CohortRow[]>> {
    const params = new URLSearchParams();
    if (opts.bucket) params.set("bucket", opts.bucket);
    if (opts.metric) params.set("metric", opts.metric);
    if (opts.weeks) params.set("weeks", String(opts.weeks));
    const qs = params.toString();
    return request<CohortRow[]>(
      `/api/v1/analytics/cohorts${qs ? `?${qs}` : ""}`,
    );
  },
  /** GET /api/v1/replies/summary?days=30 */
  getRepliesSummary(days: number = 30): Promise<ApiResult<RepliesSummary>> {
    const qs = new URLSearchParams({ days: String(days) });
    return request<RepliesSummary>(`/api/v1/replies/summary?${qs.toString()}`);
  },
  /** GET /api/v1/replies/timeseries?days=30 */
  getRepliesTimeseries(
    days: number = 30,
  ): Promise<ApiResult<ReplyTimeseriesResponse>> {
    const qs = new URLSearchParams({ days: String(days) });
    return request<ReplyTimeseriesResponse>(
      `/api/v1/replies/timeseries?${qs.toString()}`,
    );
  },
  /** GET /api/v1/replies/top-senders */
  getRepliesTopSenders(
    opts: { days?: number; limit?: number } = {},
  ): Promise<ApiResult<ReplyTopSendersResponse>> {
    const params = new URLSearchParams();
    if (opts.days) params.set("days", String(opts.days));
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request<ReplyTopSendersResponse>(
      `/api/v1/replies/top-senders${qs ? `?${qs}` : ""}`,
    );
  },

  /* ---------- approvals -------------------------------------------- */

  /**
   * GET /api/v1/approvals — pending review queue. By default returns only
   * `status=pending` rows; pass `includeResolved` to fetch every row.
   *
   * The Go server replies with `{approvals, items}` (same data on both
   * keys). We tolerate any of `approvals|items|data|results|<bare array>`.
   */
  /** G20: read the ordered approval chain for a resource type. */
  getApprovalChain(
    resourceType: string,
  ): Promise<ApiResult<{ resource_type: string; steps: ApprovalChainStep[] }>> {
    return request(
      `/api/v1/approvals/chain?resource_type=${encodeURIComponent(resourceType)}`,
    );
  },
  /** G20 (admin): define the ordered roles for a resource type's chain. */
  setApprovalChain(
    resourceType: string,
    roles: string[],
  ): Promise<ApiResult<{ resource_type: string; steps: ApprovalChainStep[] }>> {
    return request("/api/v1/approvals/chain", {
      method: "PUT",
      body: JSON.stringify({ resource_type: resourceType, roles }),
    });
  },
  /** G20: per-approval chain progress. */
  getApprovalChainProgress(
    approvalId: string,
  ): Promise<ApiResult<ApprovalChainProgress>> {
    return request(`/api/v1/approvals/${encodeURIComponent(approvalId)}/chain`);
  },
  /** G20: decide the current pending stage of an approval's chain. */
  decideApprovalChainStage(
    approvalId: string,
    input: { resource_type: string; decision: "approve" | "reject" },
  ): Promise<ApiResult<ApprovalChainProgress>> {
    return request(
      `/api/v1/approvals/${encodeURIComponent(approvalId)}/chain/decide`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },

  listApprovals(
    opts: { includeResolved?: boolean; limit?: number } = {},
  ): Promise<ApiResult<ApprovalListResponse>> {
    const params = new URLSearchParams();
    if (!opts.includeResolved) params.set("status", "pending");
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request<ApprovalListResponse>(
      `/api/v1/approvals${qs ? `?${qs}` : ""}`,
    );
  },

  /**
   * GET /api/v1/approvals/{id} — single approval fetch. Used by the
   * detail slideover to refresh the row state on open (the list
   * snapshot can be stale if a teammate decided the approval between
   * list load and slideover open).
   */
  getApproval(id: string): Promise<ApiResult<ApprovalRow>> {
    return request<ApprovalRow>(`/api/v1/approvals/${encodeURIComponent(id)}`);
  },

  /**
   * POST /api/v1/approvals/{id}/decision — finalises a pending approval.
   *
   * The Go handler reads the JSON field `notes`. The public spec describes
   * it as `reason`; we send BOTH so the request is robust to either side
   * being canonical (Go's json decoder ignores unknown fields).
   */
  decideApproval(
    id: string,
    decision: "approve" | "reject",
    reason?: string,
  ): Promise<ApiResult<ApprovalRow>> {
    return request<ApprovalRow>(
      `/api/v1/approvals/${encodeURIComponent(id)}/decision`,
      {
        method: "POST",
        body: JSON.stringify({
          decision,
          notes: reason ?? "",
          reason: reason ?? "",
        }),
      },
    );
  },

  /* ---------- mcp guide -------------------------------------------- */

  /**
   * GET /api/v1/mcp/executions — best-effort api_key_calls telemetry. The
   * default filter is a caller-forgeable npm-proxy user-agent prefix; `all`
   * widens to other recorded API-key traffic. Neither mode is a complete or
   * verified MCP-origin audit trail. Cursor pagination uses `before_id`.
   */
  listMCPExecutions(
    opts: {
      include?: "mcp" | "all";
      tool?: string;
      apiKeyId?: string;
      since?: string; // RFC3339
      until?: string;
      limit?: number;
      beforeId?: number;
    } = {},
  ): Promise<ApiResult<MCPExecutionsResponse>> {
    const params = new URLSearchParams();
    if (opts.include === "all") params.set("include", "all");
    if (opts.tool) params.set("tool", opts.tool);
    if (opts.apiKeyId) params.set("api_key_id", opts.apiKeyId);
    if (opts.since) params.set("since", opts.since);
    if (opts.until) params.set("until", opts.until);
    if (opts.limit && opts.limit > 0) params.set("limit", String(opts.limit));
    if (opts.beforeId && opts.beforeId > 0) {
      params.set("before_id", String(opts.beforeId));
    }
    const qs = params.toString();
    return request<MCPExecutionsResponse>(
      `/api/v1/mcp/executions${qs ? `?${qs}` : ""}`,
    );
  },

  /**
   * GET /api/v1/mcp/stats — aggregated stats over a rolling window.
   * window accepts the same shorthand the server parses ("24h",
   * "7d", "30d"); falls back to 7d when omitted.
   */
  getMCPStats(
    opts: {
      include?: "mcp" | "all";
      window?: string;
    } = {},
  ): Promise<ApiResult<MCPStats>> {
    const params = new URLSearchParams();
    if (opts.include === "all") params.set("include", "all");
    if (opts.window) params.set("window", opts.window);
    const qs = params.toString();
    return request<MCPStats>(`/api/v1/mcp/stats${qs ? `?${qs}` : ""}`);
  },

  /**
   * GET /api/v1/mcp/trend — hourly call buckets across the window.
   * Empty hours are explicit in the response so the dashboard
   * sparkline doesn't need to gap-fill client-side.
   */
  getMCPTrend(
    opts: {
      include?: "mcp" | "all";
      window?: string;
    } = {},
  ): Promise<ApiResult<MCPTrendResponse>> {
    const params = new URLSearchParams();
    if (opts.include === "all") params.set("include", "all");
    if (opts.window) params.set("window", opts.window);
    const qs = params.toString();
    return request<MCPTrendResponse>(`/api/v1/mcp/trend${qs ? `?${qs}` : ""}`);
  },

  /**
   * GET /api/v1/mcp/catalog — server-build-bundled candidate catalogue.
   * This response is private/no-store and does not establish parity with the
   * published npm artifact, a deployed transport, or executable authority.
   */
  getMCPCatalog(): Promise<ApiResult<MCPCatalogEntry[]>> {
    return request<MCPCatalogEntry[]>("/api/v1/mcp/catalog");
  },

  /**
   * GET /api/v1/mcp/quotas — per-tool daily quotas + today's usage.
   * Empty list when no quotas configured (unlimited everywhere).
   */
  listMCPQuotas(): Promise<ApiResult<MCPQuotaResponse>> {
    return request<MCPQuotaResponse>("/api/v1/mcp/quotas");
  },

  /* ---------- API keys (used by the Agent tab and Settings) ------- */

  /** GET /api/v1/api-keys — list API keys (no plaintext). */
  listApiKeys(): Promise<ApiResult<ApiKeysListResponse>> {
    return request<ApiKeysListResponse>("/api/v1/api-keys");
  },
  /**
   * POST /api/v1/api-keys — mint a new API key.
   * Plaintext is present in the creation response and its 24h idempotent
   * replay; the ordinary key list never returns it.
   */
  createApiKey(input: {
    label: string;
    scopes: string[];
    sandbox_only?: boolean;
    allowed_ips?: string[];
  }): Promise<ApiResult<CreateApiKeyResponse>> {
    return request<CreateApiKeyResponse>("/api/v1/api-keys", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  /** POST /api/v1/api-keys/{id}/rotate — revoke + mint, returns new plaintext. */
  rotateApiKey(id: string): Promise<ApiResult<CreateApiKeyResponse>> {
    return request<CreateApiKeyResponse>(
      `/api/v1/api-keys/${encodeURIComponent(id)}/rotate`,
      { method: "POST", body: "{}" },
    );
  },
  /** DELETE /api/v1/api-keys/{id} — revoke. */
  deleteApiKey(id: string): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/api-keys/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },

  /* ---------- approvals: delegation + escalation policy ---------- */

  listApprovalDelegations(): Promise<
    ApiResult<{ delegations: ApprovalDelegation[] }>
  > {
    return request<{ delegations: ApprovalDelegation[] }>(
      "/api/v1/approvals/delegations",
    );
  },

  createApprovalDelegation(body: {
    fromUserId: string;
    toUserId: string;
    startsAt: string;
    endsAt?: string;
    reason?: string;
  }): Promise<ApiResult<ApprovalDelegation>> {
    return request<ApprovalDelegation>("/api/v1/approvals/delegations", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  revokeApprovalDelegation(id: string): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/approvals/delegations/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },

  getApprovalEscalationPolicy(): Promise<ApiResult<ApprovalEscalationPolicy>> {
    return request<ApprovalEscalationPolicy>(
      "/api/v1/approvals/escalation-policy",
    );
  },

  upsertApprovalEscalationPolicy(body: {
    escalateAfterHours?: number | null;
    notifyOwners: boolean;
  }): Promise<ApiResult<ApprovalEscalationPolicy>> {
    return request<ApprovalEscalationPolicy>(
      "/api/v1/approvals/escalation-policy",
      { method: "PUT", body: JSON.stringify(body) },
    );
  },

  /* ---------- webhook playground ---------------------------------- */

  /**
   * GET /api/v1/outbound-webhooks/playground/events — catalog of every
   * event type the operator can fire with a sample payload per event.
   */
  async listWebhookPlaygroundEvents(): Promise<
    ApiResult<WebhookPlaygroundEventCatalogResponse>
  > {
    return decodeWebhookPlaygroundEventCatalogResult(
      await request<unknown>("/api/v1/outbound-webhooks/playground/events"),
    );
  },

  /**
   * POST /api/v1/outbound-webhooks/{id}/playground/fire — fire a chosen
   * event with custom payload at this webhook. Returns full request
   * envelope + upstream response for the operator to verify their
   * handler.
   */
  async fireWebhookPlayground(
    id: string,
    body: {
      fire_id: string;
      event_type: string;
      expected_webhook_config_version: number;
      /** Exact JSON object text from the editor/recovery checkpoint. */
      payloadJSON?: string;
    },
    options: {
      idempotencyKey: string;
      signal?: AbortSignal;
    },
  ): Promise<ApiResult<WebhookPlaygroundFireResponse>> {
    const requestMetadata = JSON.stringify({
      fire_id: body.fire_id,
      event_type: body.event_type,
      expected_webhook_config_version: body.expected_webhook_config_version,
    });
    let requestBody = requestMetadata;
    if (body.payloadJSON !== undefined) {
      let payload: unknown;
      try {
        payload = JSON.parse(body.payloadJSON);
      } catch {
        return {
          error: {
            kind: "invalid_config",
            code: "invalid_webhook_playground_payload",
            message: "Webhook playground payloadJSON must be valid JSON.",
          },
          retryability: "not-retryable",
        };
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return {
          error: {
            kind: "invalid_config",
            code: "invalid_webhook_playground_payload",
            message:
              "Webhook playground payloadJSON must contain a JSON object.",
          },
          retryability: "not-retryable",
        };
      }
      // Embed the already-validated object text verbatim. JSON.parse above is
      // only a shape check; re-stringifying would round integers above 2^53 and
      // make a crash-recovery replay differ from the operator's exact request.
      requestBody = `${requestMetadata.slice(0, -1)},"payload":${body.payloadJSON}}`;
    }
    return decodeWebhookPlaygroundFireResult(
      await request<unknown>(
        `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/playground/fire`,
        { method: "POST", body: requestBody },
        {
          // A playground fire performs a real receiver-side effect. Never
          // admit it to the offline outbox and never re-fire it automatically
          // after an ambiguous transport or upstream failure.
          requireOnline: true,
          maxAttempts: 1,
          // The API's receiver client has a 10s deadline and then durably
          // completes its encrypted receipt. Keep the desktop deadline beyond
          // both phases so healthy slow handlers do not become needless
          // ambiguous outcomes; the UI still exposes explicit cancellation.
          timeoutMs: 20_000,
          idempotencyKey: options.idempotencyKey,
          signal: options.signal,
        },
      ),
      body.fire_id,
    );
  },

  /**
   * GET /api/v1/outbound-webhooks/playground/fires/{fire_id} — reconcile a
   * caller-retained logical fire without contacting the receiver.
   */
  async getWebhookPlaygroundFire(
    fireId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<WebhookPlaygroundFireReceipt>> {
    return decodeWebhookPlaygroundFireReceiptResult(
      await request<unknown>(
        `/api/v1/outbound-webhooks/playground/fires/${encodeURIComponent(fireId)}`,
        undefined,
        {
          requireOnline: true,
          maxAttempts: 1,
          signal: options.signal,
        },
      ),
      fireId,
    );
  },

  /** PUT /api/v1/mcp/quotas — upsert one tool's daily cap + cost. */
  upsertMCPQuota(q: MCPToolQuota): Promise<ApiResult<MCPToolQuota>> {
    return request<MCPToolQuota>("/api/v1/mcp/quotas", {
      method: "PUT",
      body: JSON.stringify(q),
    });
  },

  /** DELETE /api/v1/mcp/quotas/{tool} — remove quota (back to unlimited). */
  deleteMCPQuota(toolName: string): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/mcp/quotas/${encodeURIComponent(toolName)}`,
      { method: "DELETE" },
    );
  },

  /**
   * Legacy CSV endpoint URL builder. The server currently release-holds this
   * transport with a stable 503; no production UI should expose it.
   */
  buildMCPCsvUrl(
    opts: {
      include?: "mcp" | "all";
      tool?: string;
      apiKeyId?: string;
      since?: string;
      until?: string;
    } = {},
  ): string {
    const params = new URLSearchParams();
    if (opts.include === "all") params.set("include", "all");
    if (opts.tool) params.set("tool", opts.tool);
    if (opts.apiKeyId) params.set("api_key_id", opts.apiKeyId);
    if (opts.since) params.set("since", opts.since);
    if (opts.until) params.set("until", opts.until);
    const qs = params.toString();
    return `/api/v1/mcp/executions.csv${qs ? `?${qs}` : ""}`;
  },

  ...subscriberDataOperationsMethods,

  ...campaignSequenceOperationsMethods,

  /* ---------- Moosewave AI (chat / free-form generate) --------------- */

  /**
   * POST /api/v1/voice/generate — free-form prompt → AI draft.
   *
   * The gateway proxies this to the voice service chat handler. A 503
   * means the voice service started without a configured chat-capable LLM.
   *
   * Request shape: `{prompt, kind, contextRefs?}`.
   *   - `kind` narrows the response style and downstream UI affordances
   *     (campaign_draft → "Use as draft" button, subject_line → suggestion list).
   *   - `contextRefs` is an opaque list of `{type, id}` references to existing
   *     resources (campaigns, sequences, segments) the AI may inspect.
   *
   * Response shape: `{text, draft?}`.
   *   - `text` is markdown-friendly chat content for the assistant bubble.
   *   - `draft`, when present, is a parsed campaign skeleton ready to hand
   *     off to the New Campaign modal.
   */
  aiGenerate(input: {
    prompt: string;
    kind: AIGenerateKind;
    contextRefs?: AIContextRef[];
    /** Pre-resolved workspace context (campaign body, subscriber list, etc).
     *  The server reads this verbatim into the LLM system prompt — keep
     *  it under ~6k tokens to avoid hitting Gemini's input cap. */
    contextText?: string;
  }): Promise<ApiResult<AIGenerateResponse>> {
    return request<AIGenerateResponse>(
      "/api/v1/voice/generate",
      {
        method: "POST",
        body: JSON.stringify({
          prompt: input.prompt,
          kind: input.kind,
          context_refs: (input.contextRefs ?? []).map((ref) => ({
            kind: ref.type,
            id: ref.id,
          })),
          context_text: input.contextText ?? "",
        }),
      },
      LLM_REQUEST_OPTS,
    );
  },

  /* ---------- Unified pre-send verdict (AI Compose v2) --------------- */

  /**
   * POST /api/v1/presend/verdict — fans out to EQ Score + voice drift
   * + placement predictor in parallel and returns ONE verdict the
   * editor banner gates on. See apps/api/internal/presend.
   */
  presendVerdict(input: {
    subject: string;
    html: string;
    text?: string;
    from: string;
    voice_profile_id?: string;
    campaign_id?: string;
    content_revision_id?: string;
    source_hash?: string;
  }): Promise<ApiResult<PresendVerdictResponse>> {
    return request<PresendVerdictResponse>(
      "/api/v1/presend/verdict",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      LLM_REQUEST_OPTS,
    );
  },

  /* ---------- Voice drift (pre-send check) --------------- */

  /**
   * POST /api/v1/voice/drift — pre-send voice-fidelity check.
   *
   * Given a draft body + the tenant's voice profile id, returns a
   * 0..100 fidelity score and a severity (ok | warn | critical). The
   * desktop editor calls this from the pre-send confirmation flow so
   * the operator can choose to revise instead of sending an
   * off-brand draft.
   *
   * The drift handler runs heuristic-only when the deliverability
   * service has no embedding client configured — still useful, just
   * coarser. A 503 means the voice service hasn't been started; treat
   * as "skip check, allow send."
   */
  voiceDriftCheck(input: {
    html: string;
    text?: string;
    profileId?: string;
  }): Promise<ApiResult<VoiceDriftResponse>> {
    return request<VoiceDriftResponse>(
      "/api/v1/voice/drift",
      {
        method: "POST",
        body: JSON.stringify({
          html: input.html,
          text: input.text ?? "",
          profile_id: input.profileId ?? "",
        }),
      },
      LLM_REQUEST_OPTS,
    );
  },

  /* ---------- AI compose (broadcast + variants) -------------------- */

  /** POST /api/v1/ai/compose/broadcast — one-shot brief → draft + N variants. */
  aiComposeBroadcast(input: {
    brief: string;
    variant_count?: number;
    tone?: string;
    audience?: string;
  }): Promise<ApiResult<AIComposeBroadcastResponse>> {
    return request<AIComposeBroadcastResponse>(
      "/api/v1/ai/compose/broadcast",
      { method: "POST", body: JSON.stringify(input) },
      LLM_REQUEST_OPTS,
    );
  },

  /** POST /api/v1/ai/compose/variants — N more subject variants for an existing body. */
  aiComposeVariants(input: {
    subject: string;
    body: string;
    variant_count?: number;
  }): Promise<ApiResult<AIComposeVariantsResponse>> {
    return request<AIComposeVariantsResponse>(
      "/api/v1/ai/compose/variants",
      { method: "POST", body: JSON.stringify(input) },
      LLM_REQUEST_OPTS,
    );
  },

  /* ---------- Subject Lab (G11) ----------------------------------- */

  /**
   * POST /api/v1/subject-lab/variants — axis-conditioned subject variant
   * generation. Wraps the existing aicompose service with an axis
   * (length / emoji / question / personalization) so variants
   * actually vary along the requested dimension rather than producing
   * 5 paraphrases of the same shape.
   */
  generateSubjectLabVariants(input: {
    seed_subject: string;
    axis: "length" | "emoji" | "question" | "personalization";
    count?: number;
    body_excerpt?: string;
    voice_profile_id?: string;
  }): Promise<ApiResult<SubjectLabVariantsResponse>> {
    return request<SubjectLabVariantsResponse>(
      "/api/v1/subject-lab/variants",
      { method: "POST", body: JSON.stringify(input) },
      LLM_REQUEST_OPTS,
    );
  },

  /**
   * POST /api/v1/subject-lab/score — score 1..16 subjects against the
   * tenant's last-180d corpus. Each subject is bucketed by its
   * attributes (length / question / all-caps / emoji / personalization);
   * predicted_open is the matched bucket's mean open rate and ci_low/
   * ci_high are a two-sided Wilson-90% interval over pooled opens/sent.
   * Buckets with matched_n<5 fall back to baseline ±15% and carry
   * low_confidence=true (the Lab table renders them muted);
   * below_baseline=true when the whole interval sits under baseline.
   */
  scoreSubjectVariants(input: {
    subjects: string[];
  }): Promise<ApiResult<SubjectLabScoreResponse>> {
    return request<SubjectLabScoreResponse>("/api/v1/subject-lab/score", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  /* ---------- AI Subject-Line Assistant (sto-ai-copywriter) -------- */

  /**
   * POST /api/v1/ai/subject-lines/generate — Klaviyo-style brief
   * assistant. Takes a free-form prompt ("announce black friday sale"),
   * optional tone, and optional target_audience, returns N candidates
   * (default 3, bounded [1,5]). The desktop renders these in the
   * compose form's AI-assist drawer; the operator picks one for the
   * primary subject or auto-populates A/B variants from the full set.
   *
   * Returns fallback=true when the LLM produced fewer distinct
   * candidates than requested and we backfilled with brief-derived
   * placeholders — the desktop renders a small "review before sending"
   * hint when this is set.
   */
  aiSubjectLinesGenerate(input: {
    prompt: string;
    tone?: string;
    target_audience?: string;
    variant_count?: number;
  }): Promise<ApiResult<AISubjectLinesGenerateResponse>> {
    return request<AISubjectLinesGenerateResponse>(
      "/api/v1/ai/subject-lines/generate",
      { method: "POST", body: JSON.stringify(input) },
      LLM_REQUEST_OPTS,
    );
  },

  /**
   * GET /api/v1/ai/subject-lines/top-performers — tenant's highest
   * open-rate sent campaigns within the window (default 90d). The
   * compose form renders these in an "examples" panel so the operator
   * can borrow patterns that worked on their own list. Filters out
   * campaigns with < min_recipients (default 20) recipients to avoid
   * surfacing tiny test sends with misleading 100% rates.
   */
  aiSubjectLinesTopPerformers(input?: {
    days?: number;
    limit?: number;
    min_recipients?: number;
  }): Promise<ApiResult<AISubjectLinesTopPerformersResponse>> {
    const params = new URLSearchParams();
    if (input?.days) params.set("days", String(input.days));
    if (input?.limit) params.set("limit", String(input.limit));
    if (input?.min_recipients)
      params.set("min_recipients", String(input.min_recipients));
    const qs = params.toString();
    return request<AISubjectLinesTopPerformersResponse>(
      `/api/v1/ai/subject-lines/top-performers${qs ? `?${qs}` : ""}`,
    );
  },

  /* ---------- Voice profile + sources + templates ------------------ */

  /** GET /api/v1/voice/profile — current tenant voice profile. */
  getVoiceProfile(): Promise<ApiResult<VoiceProfile>> {
    return request<VoiceProfile>("/api/v1/voice/profile");
  },

  /**
   * G10 (campaigns 2026): operator-authored brand voice profile.
   * Distinct from the corpus-extracted /voice/profile — these are
   * the descriptors / writing rules / sample snippets the AI compose
   * endpoints will condition on once the binding refactor lands.
   */
  getBrandVoiceProfile(): Promise<ApiResult<BrandVoiceProfile>> {
    return request<BrandVoiceProfile>("/api/v1/voice/brand-profile");
  },

  /** PUT /api/v1/voice/brand-profile — upsert the active profile. */
  putBrandVoiceProfile(input: {
    descriptors: string[];
    writing_rules: string[];
    sample_snippets: string[];
  }): Promise<ApiResult<BrandVoiceProfile>> {
    return request<BrandVoiceProfile>("/api/v1/voice/brand-profile", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  /** GET /api/v1/voice/sources — voice ingest sources (URLs, files). */
  listVoiceSources(): Promise<ApiResult<VoiceSourcesResponse>> {
    return request<VoiceSourcesResponse>("/api/v1/voice/sources");
  },
  /** POST /api/v1/voice/sources — create a new ingest source. */
  createVoiceSource(input: {
    kind: string;
    url?: string;
    label?: string;
  }): Promise<ApiResult<VoiceSource>> {
    // The voice service expects { type: <SourceType>, params: {...} }
    // (SourceRecord shape) — NOT {kind,url}, and it has no "url" source
    // type. A pasted URL maps to the blog_rss ingester, whose IngestParams
    // has no json tags so the key is the Go field name `FeedURL` (GAP-2#2).
    const body = input.url
      ? { type: "blog_rss", params: { FeedURL: input.url } }
      : { type: input.kind, params: {} };
    return request<VoiceSource>("/api/v1/voice/sources", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
  /** POST /api/v1/voice/sources/{id}/ingest — kick off ingestion. */
  ingestVoiceSource(id: string): Promise<ApiResult<{ job_id?: string }>> {
    return request<{ job_id?: string }>(
      `/api/v1/voice/sources/${encodeURIComponent(id)}/ingest`,
      { method: "POST", body: "{}" },
    );
  },
  /** DELETE /api/v1/voice/sources/{id} */
  deleteVoiceSource(id: string): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/voice/sources/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
  /** POST /api/v1/voice/profile/build — recompute profile from sources. */
  buildVoiceProfile(): Promise<ApiResult<{ ok: boolean; job_id?: string }>> {
    return request<{ ok: boolean; job_id?: string }>(
      "/api/v1/voice/profile/build",
      { method: "POST", body: "{}" },
    );
  },
  /** GET /api/v1/voice/templates — reusable prompt templates. */
  getVoiceTemplates(): Promise<ApiResult<VoiceTemplatesResponse>> {
    return request<VoiceTemplatesResponse>("/api/v1/voice/templates");
  },

  /* =====================================================================
   * Phase-10 email preview — added by the Preview agent.
   * Endpoint: POST /api/v1/email-preview/render
   * Backend:  apps/api/internal/emailpreview/handlers.go
   *
   * NOTE FOR OTHER AGENTS: keep additions in this clearly-marked block
   * so we don't conflict on the same lines.
   * =================================================================== */
  renderEmailPreview(
    input: EmailPreviewRequest,
  ): Promise<ApiResult<EmailPreviewResponse>> {
    return request<EmailPreviewResponse>(
      "/api/v1/email-preview/render",
      {
        method: "POST",
        body: JSON.stringify({
          mjml: input.mjml,
          vars: input.vars ?? {},
        }),
      },
      LLM_REQUEST_OPTS,
    );
  },

  /**
   * G8 (campaigns 2026): cross-client inbox preview. POST /api/v1/render
   * fans the body out across the 10-environment CSS-emulation matrix
   * (Gmail web/iOS, Apple Mail, Outlook, Yahoo, dark mode…) and returns
   * a screenshot URL + per-env issues for each. Distinct from
   * renderEmailPreview (single body→HTML render); this is the
   * across-clients tab. read:reports scoped.
   */
  renderAcrossClients(input: {
    html: string;
    environments?: string[];
  }): Promise<ApiResult<CrossClientRenderResponse>> {
    return request<CrossClientRenderResponse>(
      "/api/v1/render",
      {
        method: "POST",
        body: JSON.stringify({
          html: input.html,
          ...(input.environments ? { environments: input.environments } : {}),
        }),
      },
      LLM_REQUEST_OPTS,
    );
  },

  /* =====================================================================
   * Migrations — added by the Migrations wizard agent.
   *
   * The Moosewave API gateway proxies these to services/migration. Routes
   * are mounted at `/api/v1/migrations` and shape-mirror the upstream
   * `/v1/migrations` chi router defined in
   *   services/migration/internal/handlers/migration.go::Mount
   *
   * Live endpoints (verified):
   *   GET  /api/v1/migrations                           — list jobs
   *   GET  /api/v1/migrations/sources                   — adapter caps
   *   POST /api/v1/migrations/{source}/credentials      — create job (api_key)
   *   PUT  /api/v1/migrations/{source}/uploads/{id}     — resumable CSV chunk
   *   POST /api/v1/migrations/{source}/uploads/{id}/complete — create CSV job
   *   POST /api/v1/migrations/{source}/oauth/start      — kick off OAuth
   *   POST /api/v1/migrations/{source}/discover         — pre-flight count
   *   POST /api/v1/migrations/{source}/dry-run          — verification only
   *   POST /api/v1/migrations/{source}/commit           — full import
   *   GET  /api/v1/migrations/{job_id}                  — job status
   *   POST /api/v1/migrations/{job_id}/source-session   — same-job reconnect
   *   GET  /api/v1/migrations/{job_id}/verification     — final report
   *   POST /api/v1/migrations/{job_id}/rollback         — undo (≤7d)
   *
   * NB: there is NO `POST /api/v1/migrations` create endpoint — the job
   * is created implicitly by `/credentials` or the OAuth callback. The
   * UI takes care of stitching this into a "create → preview → run"
   * three-call flow.
   * =================================================================== */

  /** GET /api/v1/migrations — list all jobs for the tenant. */
  listMigrations(): Promise<ApiResult<MigrationJob[]>> {
    return request<MigrationJob[]>("/api/v1/migrations");
  },

  /** GET /api/v1/migrations/sources — registered adapter capabilities. */
  async listMigrationSources(): Promise<
    ApiResult<MigrationSourceCapability[]>
  > {
    const result = await request<unknown>("/api/v1/migrations/sources");
    if (result.error) return result;
    return parseMigrationSourceCapabilities(result.data);
  },

  /** GET /api/v1/migrations/{job_id} — current status + progress. */
  getMigration(jobId: string): Promise<ApiResult<MigrationJob>> {
    return request<MigrationJob>(
      `/api/v1/migrations/${encodeURIComponent(jobId)}`,
      { cache: "no-store" },
      { requireOnline: true },
    );
  },

  /**
   * POST /api/v1/migrations/{job_id}/source-session — replace only the
   * encrypted source session attached to this existing job. The service
   * verifies the original provider account/workspace/publication binding.
   */
  refreshMigrationSourceSession(
    jobId: string,
    input: MigrationCreateInput,
  ): Promise<ApiResult<MigrationJob>> {
    return request<MigrationJob>(
      `/api/v1/migrations/${encodeURIComponent(jobId)}/source-session`,
      {
        method: "POST",
        body: JSON.stringify({
          api_key: input.apiKey ?? "",
          account_id: input.accountId ?? "",
          extra: input.extra ?? {},
        }),
      },
      {
        requireOnline: true,
        // A credential refresh is explicitly re-submitted by the operator;
        // do not replay it implicitly across an ambiguous transport failure.
        maxAttempts: 1,
      },
    );
  },

  /**
   * POST /api/v1/migrations/{source}/credentials — creates a job in the
   * `awaiting_confirmation` state. Returns `{job_id, account_id}`.
   *
   * Used for credential-backed adapters (ActiveCampaign, HubSpot, ConvertKit,
   * Beehiiv, Brevo, MailerLite, and source-specific tokens). OAuth and
   * file-backed sources use their dedicated flows; file uploads call
   * `uploadMigrationFile`, which streams chunks and calls `/complete`.
   */
  createMigration(
    source: MigrationSource,
    input: MigrationCreateInput,
  ): Promise<ApiResult<MigrationCreateResponse>> {
    return request<MigrationCreateResponse>(
      `/api/v1/migrations/${encodeURIComponent(source)}/credentials`,
      {
        method: "POST",
        body: JSON.stringify({
          api_key: input.apiKey ?? "",
          account_id: input.accountId ?? "",
          extra: input.extra ?? {},
        }),
      },
    );
  },

  /** Run the source inventory before the dry-run. Mailchimp returns the
   * audiences that the operator must explicitly scope. */
  async discoverMigration(
    source: MigrationSource,
    jobId: string,
    selectedAudienceIds?: string[],
  ): Promise<ApiResult<MigrationDiscoveryReport>> {
    const result = await request<unknown>(
      `/api/v1/migrations/${encodeURIComponent(source)}/discover`,
      {
        method: "POST",
        body: JSON.stringify({
          job_id: jobId,
          ...(selectedAudienceIds
            ? { selected_audience_ids: selectedAudienceIds }
            : {}),
        }),
      },
    );
    if (result.error) return result;
    return parseMigrationDiscoveryReport(result.data, { source, jobId });
  },

  async uploadMigrationFile(
    source: MigrationSource,
    file: File,
    onProgress?: (progress: MigrationUploadProgress) => void,
  ): Promise<ApiResult<MigrationCreateResponse>> {
    const identityGeneration = captureApiIdentityGeneration();
    if (identityGeneration === null) {
      return apiIdentityTransitionError("identity_transition");
    }
    const uploadOwnerIdentity = getOfflineIdentity();
    const ledgerScope = await migrationUploadLedgerScope(source, file);
    const ledger = await readMigrationUploadLedger(ledgerScope);
    let uploadId = ledger?.uploadId ?? newMigrationUploadID();
    const filename = safeMigrationUploadFilename(file.name);

    if (
      !apiIdentityGenerationIsCurrent(identityGeneration) ||
      uploadOwnerIdentity !== getOfflineIdentity() ||
      !migrationUploadScopeIsCurrent(ledgerScope)
    ) {
      return migrationUploadIdentityChanged();
    }

    // A local ledger is only a hint. Containers can restart or clean their
    // upload volume between attempts, so reconcile it with the server before
    // sending a non-zero Content-Range. If the server lost the upload, restart
    // at byte zero; if the ID now describes a different-sized file, choose a
    // fresh ID rather than colliding with its immutable metadata.
    const reconciled = await reconcileMigrationUpload({
      source,
      uploadId,
      fileSize: file.size,
      hasLocalLedger: Boolean(ledger),
      request,
      newUploadId: newMigrationUploadID,
    });
    if (reconciled.error) return reconciled;
    if (!apiIdentityGenerationIsCurrent(identityGeneration))
      return apiIdentityTransitionError("identity_changed");
    uploadId = reconciled.data.uploadId;
    let offset = reconciled.data.offset;
    await writeMigrationUploadLedger(ledgerScope, uploadId, offset);
    if (!apiIdentityGenerationIsCurrent(identityGeneration))
      return apiIdentityTransitionError("identity_changed");
    if (offset > 0) {
      onProgress?.({
        uploadId,
        uploadedBytes: offset,
        totalBytes: file.size,
      });
    }
    try {
      while (offset < file.size) {
        if (
          uploadOwnerIdentity !== getOfflineIdentity() ||
          !migrationUploadScopeIsCurrent(ledgerScope)
        ) {
          return migrationUploadIdentityChanged();
        }
        const end =
          Math.min(offset + MIGRATION_UPLOAD_CHUNK_SIZE, file.size) - 1;
        const chunk = file.slice(offset, end + 1);
        const params = new URLSearchParams({ filename });
        const headers: Record<string, string> = {
          Accept: "application/json",
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes ${offset}-${end}/${file.size}`,
          // This is a state-changing PUT; in cookie-auth mode the Origin CSRF
          // gate rejects it unless X-Postwave-Client marks us as a trusted
          // native client (same as every other request site).
          ...NATIVE_CLIENT_HEADERS,
        };
        const key = normalizeApiKey(getApiKey());
        if (key) headers.Authorization = `Bearer ${key}`;
        // Per-chunk policy (audit §4.3 B3): 60s timeout (the global 5s
        // cap made uploads on slow uplinks unable to ever finish) and
        // up to 2 retries with jittered backoff. Chunk PUTs are
        // idempotent by construction — Content-Range + the server's
        // `received` ack make a replayed chunk a harmless overwrite —
        // so transport retries are explicitly enabled.
        const { res, err } = await httpFetch(
          apiUrl(
            `/api/v1/migrations/${encodeURIComponent(
              source,
            )}/uploads/${encodeURIComponent(uploadId)}?${params.toString()}`,
          ),
          {
            method: "PUT",
            body: chunk,
            headers,
            mode: "cors",
            credentials: "include",
            cache: "no-store",
          },
          {
            timeoutMs: 60_000,
            maxAttempts: 3,
            retryOnTransport: () => true,
            signal: apiIdentitySignal(null),
          },
        );
        if (!apiIdentityGenerationIsCurrent(identityGeneration))
          return apiIdentityTransitionError("identity_changed");
        if (!res) {
          return { error: transportError(err) };
        }
        if (!res.ok) {
          const error = await errorFromResponse(res);
          if (!apiIdentityGenerationIsCurrent(identityGeneration))
            return apiIdentityTransitionError("identity_changed");
          return { error };
        }
        const text = await readTextLimited(res, MAX_API_RESPONSE_TEXT_BYTES);
        if (!apiIdentityGenerationIsCurrent(identityGeneration))
          return apiIdentityTransitionError("identity_changed");
        const ack = text ? safeJson(text) : undefined;
        const received =
          ack &&
          typeof ack === "object" &&
          "received" in ack &&
          typeof (ack as { received?: unknown }).received === "number" &&
          Number.isFinite((ack as { received?: number }).received)
            ? (ack as { received: number }).received
            : undefined;
        const ackError = migrationUploadAckError(received, file.size);
        if (ackError) return ackError;
        // Respect the server's acked byte count (audit §4.3 B2): when
        // `received` is present the next offset IS `received`, even if
        // that's short of what we just sent — the gap is re-sent on the
        // next loop iteration. The old code clamped UPWARDS
        // (max(received, end+1)) and silently skipped past bytes the
        // server never acknowledged, corrupting the uploaded CSV.
        const nextOffset = received ?? end + 1;
        if (nextOffset <= offset) {
          // Server acked no forward progress — error out honestly
          // instead of looping forever re-sending the same chunk.
          return {
            error: {
              kind: "http",
              status: res.status,
              code: "upload_stalled",
              message: `Upload made no progress: server acknowledged ${received ?? 0} bytes at offset ${offset}.`,
            },
          };
        }
        offset = nextOffset;
        await writeMigrationUploadLedger(ledgerScope, uploadId, offset);
        if (!apiIdentityGenerationIsCurrent(identityGeneration))
          return apiIdentityTransitionError("identity_changed");
        onProgress?.({
          uploadId,
          uploadedBytes: offset,
          totalBytes: file.size,
        });
      }
      if (
        uploadOwnerIdentity !== getOfflineIdentity() ||
        !migrationUploadScopeIsCurrent(ledgerScope)
      ) {
        return migrationUploadIdentityChanged();
      }
      const done = await request<MigrationCreateResponse>(
        `/api/v1/migrations/${encodeURIComponent(
          source,
        )}/uploads/${encodeURIComponent(uploadId)}/complete`,
        { method: "POST", body: JSON.stringify({}) },
      );
      if (!done.error) await clearMigrationUploadLedger(ledgerScope);
      if (!apiIdentityGenerationIsCurrent(identityGeneration))
        return apiIdentityTransitionError("identity_changed");
      return done;
    } catch (err) {
      if (!apiIdentityGenerationIsCurrent(identityGeneration))
        return apiIdentityTransitionError("identity_changed");
      return { error: transportError(err) };
    }
  },

  /**
   * POST /api/v1/migrations/{source}/dry-run — kicks off Discover + dry-run.
   * Returns 202 Accepted with `{job_id}`. Poll `getMigration` until the
   * job has a `verification_report`.
   *
   * Note the API takes the SOURCE in the path, not the job id — but the
   * job id MUST be in the body so the upstream can correlate sessions.
   */
  async previewMigration(
    source: MigrationSource,
    jobId: string,
    selectedAudienceIds?: string[],
  ): Promise<ApiResult<MigrationDryRunAcknowledgement>> {
    if (source === "mailchimp" && (selectedAudienceIds?.length ?? 0) === 0) {
      return {
        error: {
          kind: "parse",
          code: "audience_scope_required",
          message:
            "Mailchimp dry-run requires at least one explicit audience selection.",
        },
      };
    }
    const result = await request<unknown>(
      `/api/v1/migrations/${encodeURIComponent(source)}/dry-run`,
      {
        method: "POST",
        body: JSON.stringify({
          job_id: jobId,
          ...(selectedAudienceIds
            ? { selected_audience_ids: selectedAudienceIds }
            : {}),
        }),
      },
    );
    if (result.error) return result;
    return parseMigrationDryRunAcknowledgement(result.data, jobId);
  },

  /**
   * POST /api/v1/migrations/{source}/commit — runs the full migration.
   * Returns 202 Accepted; poll `getMigration` for terminal status.
   */
  runMigration(
    source: MigrationSource,
    jobId: string,
    selectedAudienceIds?: string[],
  ): Promise<ApiResult<{ job_id: string }>> {
    if (source === "mailchimp" && (selectedAudienceIds?.length ?? 0) === 0) {
      return Promise.resolve({
        error: {
          kind: "parse",
          code: "audience_scope_required",
          message:
            "Mailchimp commit requires at least one explicit audience selection.",
        },
      });
    }
    return request<{ job_id: string }>(
      `/api/v1/migrations/${encodeURIComponent(source)}/commit`,
      {
        method: "POST",
        body: JSON.stringify({
          job_id: jobId,
          ...(selectedAudienceIds
            ? { selected_audience_ids: selectedAudienceIds }
            : {}),
        }),
      },
    );
  },

  /**
   * GET /api/v1/migrations/{job_id}/verification — final dry-run / import
   * audit report. Available once the job leaves `discovering`.
   */
  getMigrationVerification(
    jobId: string,
  ): Promise<ApiResult<MigrationVerificationReport>> {
    return request<MigrationVerificationReport>(
      `/api/v1/migrations/${encodeURIComponent(jobId)}/verification`,
    );
  },

  /**
   * POST /api/v1/migrations/{job_id}/rollback — undo a completed job.
   * Server enforces the 7-day window; we mirror it in the UI to avoid
   * showing an action that will 4xx.
   */
  rollbackMigration(jobId: string): Promise<ApiResult<{ ok?: boolean }>> {
    return request<{ ok?: boolean }>(
      `/api/v1/migrations/${encodeURIComponent(jobId)}/rollback`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },

  /**
   * POST /api/v1/migrations/{job_id}/resume — restart a CANCELLED job
   * from its last checkpoint. 202 `{job_id, status}` on accept; 409
   * when the job isn't in the cancelled state (running/completed jobs
   * cannot be resumed).
   */
  resumeMigration(
    jobId: string,
  ): Promise<ApiResult<{ job_id: string; status: string }>> {
    return request<{ job_id: string; status: string }>(
      `/api/v1/migrations/${encodeURIComponent(jobId)}/resume`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },

  ...consentPrivacyOperationsMethods,
};

/* ---------- Moosewave AI types --------------------------------------- */

/**
 * Narrows the assistant's response style. Maps 1:1 onto chat-pane
 * affordances:
 *   - campaign_draft → assistant bubble shows a "Use as draft" CTA.
 *   - subject_line   → response is a short list of options.
 *   - summary        → multi-paragraph rollup with no draft.
 *   - free_form      → pass-through; no special UI.
 */
export type AIGenerateKind =
  | "campaign_draft"
  | "subject_line"
  | "summary"
  | "free_form";

/**
 * Opaque pointer to a Moosewave resource the AI may reference. The voice
 * service is expected to look these up via its existing tenant-scoped
 * stores (campaigns, sequences, segments).
 */
export interface AIContextRef {
  type: "campaign" | "sequence" | "segment" | "subscriber" | string;
  id: string;
}

/**
 * Optional structured draft the AI returns when `kind === "campaign_draft"`.
 * Mirrors the shape consumed by `template-handoff.setPendingCampaignDraft`.
 */
export interface AIGenerateDraft {
  name?: string;
  subject?: string;
  body?: string;
  preview_text?: string;
}

/**
 * Envelope for `POST /api/v1/voice/generate`. `text` is always populated;
 * `draft` is only populated for `kind === "campaign_draft"` (and even then
 * may be absent — heuristics in the UI extract a subject + body from the
 * raw text as a fallback).
 */
export interface AIGenerateResponse {
  text: string;
  draft?: AIGenerateDraft;
}

/** Mirrors apps/api/internal/aicompose.ComposeBroadcastOutput. */
export interface AIComposeBroadcastResponse {
  primary: {
    name: string;
    subject: string;
    body: string;
    preview_text?: string;
  };
  subject_variants: string[];
  generated_at?: string;
}

/** Mirrors apps/api/internal/aicompose.ComposeVariantsOutput. */
export interface AIComposeVariantsResponse {
  subject_variants: string[];
  generated_at?: string;
}

/** G11: subject-lab/variants payload. */
export interface SubjectLabVariantsResponse {
  variants: string[];
  axis: "length" | "emoji" | "question" | "personalization";
  generated_at: string;
}

/** G11: one scored variant from subject-lab/score. */
export interface SubjectLabScoredVariant {
  text: string;
  axis: string;
  predicted_open: number;
  ci_low: number;
  ci_high: number;
  matched_n: number;
  low_confidence: boolean;
  below_baseline: boolean;
}

/** G11: subject-lab/score payload. */
export interface SubjectLabScoreResponse {
  baseline_open: number;
  window_days: number;
  variants: SubjectLabScoredVariant[];
}

/**
 * sto-ai-copywriter-subject-lines: Klaviyo-style assistant response.
 * Mirrors apps/api/internal/ai_subject_lines.GenerateOutput.
 */
export interface AISubjectLinesGenerateResponse {
  candidates: string[];
  generated_at: string;
  /** True when the LLM produced fewer distinct subjects than requested
   *  and the API backfilled with brief-derived placeholders. */
  fallback?: boolean;
}

/** One row of the top-performers panel. */
export interface AISubjectLinesTopPerformer {
  campaign_id: string;
  name: string;
  subject: string;
  sent_at: string;
  recipients: number;
  opens: number;
  clicks: number;
  open_rate: number;
  click_rate: number;
}

/**
 * sto-ai-copywriter-subject-lines: top-performers response.
 * Mirrors apps/api/internal/ai_subject_lines.TopPerformersOutput.
 */
export interface AISubjectLinesTopPerformersResponse {
  window_days: number;
  min_recipients: number;
  top: AISubjectLinesTopPerformer[];
}

/**
 * Voice profile. The upstream voice service shapes this with optional
 * fields — defensively typed with everything optional so a partial
 * payload still renders.
 */
export interface VoiceProfile {
  id?: string;
  tenant_id?: string;
  status?: string;
  description?: string;
  built_at?: string;
  /** Sample sentences extracted from sources. */
  samples?: string[];
  /** Stylistic axes the upstream sets when it can. */
  axes?: Record<string, number>;
  /** Catch-all for any extra keys we don't model yet. */
  [extra: string]: unknown;
}

/**
 * G10 (campaigns 2026): operator-authored brand voice profile.
 * One active row per tenant; AI compose endpoints will condition on it
 * once the binding refactor lands. extracted_at is non-null when the
 * row was seeded by the (G10 follow-up) /extract endpoint rather than
 * authored by hand.
 */
export interface BrandVoiceProfile {
  id: string;
  descriptors: string[];
  writing_rules: string[];
  sample_snippets: string[];
  is_active: boolean;
  extracted_at?: string;
  created_at: string;
  updated_at: string;
}

export interface VoiceSource {
  id: string;
  kind?: string;
  url?: string;
  label?: string;
  status?: string;
  bytes_ingested?: number;
  ingested_at?: string;
  created_at?: string;
  [extra: string]: unknown;
}

export interface VoiceSourcesResponse {
  sources?: VoiceSource[];
  items?: VoiceSource[];
  data?: VoiceSource[];
  [extra: string]: unknown;
}

export interface VoiceTemplate {
  id: string;
  slug?: string;
  label?: string;
  description?: string;
  body?: string;
  kind?: string;
  [extra: string]: unknown;
}

export interface VoiceTemplatesResponse {
  templates?: VoiceTemplate[];
  items?: VoiceTemplate[];
  data?: VoiceTemplate[];
  [extra: string]: unknown;
}

/**
 * Envelope for `POST /api/v1/voice/drift`. Mirrors the shape returned
 * by services/voice/internal/handlers/drift.go.
 *
 *   score      0..100 fidelity score (100 = perfect match against the
 *              tenant's voice profile).
 *   severity   "ok" | "warn" | "critical" — UI gating signal.
 *   reason     short human-readable explanation of the score.
 *   components per-axis breakdown (embedding similarity, vocab overlap,
 *              structural match, stylistic distance). Useful for the
 *              "what to fix" hint.
 */
/* ---------- Unified pre-send verdict types ---------- */

export interface PresendComponent {
  name: "eq_score" | "voice_drift" | "placement" | "campaign_assurance";
  status: "ok" | "warn" | "critical" | "error" | "skipped";
  score?: number;
  message?: string;
  error?: string;
}

export interface PresendCampaignAssuranceEvaluation {
  policy_version: string;
  campaign_id: string;
  run_id?: string;
  content_revision_id: string;
  send_plan_id?: string;
  source_hash: string;
  plan_hash?: string;
  artifact_set_hash?: string;
  coverage_manifest_hash?: string;
  status:
    | "ok"
    | "warn"
    | "critical"
    | "pending"
    | "stale"
    | "unavailable"
    | "error";
  reason_code: string;
  gate_decision?: "pass" | "warn" | "block" | "overridden";
  authorized: boolean;
  run_attempt?: number;
  deterministic_blocker_count: number;
  predicted_score?: number;
  predicted_score_min?: number;
  predicted_score_max?: number;
  source_coverage: {
    required: number;
    successful: number;
    ratio: number;
    deterministic_configurations: number;
    modeled_configurations: number;
    controlled_observation_configurations: number;
  };
  override_ids?: string[];
  refreshed_at: string;
}

export interface PresendVerdictResponse {
  verdict: "ok" | "warn" | "critical" | "incomplete";
  /** True only when every required check produced a usable result. */
  complete: boolean;
  summary: string;
  components: PresendComponent[];
  campaign_assurance?: PresendCampaignAssuranceEvaluation;
  computed_at: string;
}

export interface VoiceDriftResponse {
  score: number;
  severity: "ok" | "warn" | "critical";
  reason?: string;
  components?: Record<string, number>;
  suggestions?: string[];
  /** G10: the authored brand-voice profile the score was bound to
   *  (echoed by the voice service when profileId is forwarded). */
  profile_id?: string;
  /** G10: signed delta the authored banned-term / descriptor overlay
   *  applied on top of the corpus fidelity score (negative = off-voice
   *  wording pulled it down). */
  authored_adjustment?: number;
}

/** G15: response of GET /api/v1/campaigns/{id}/goal-results. */
export interface CampaignGoalResults {
  campaign_id: string;
  goal_event: string;
  goal_window_hours: number;
  configured: boolean;
  conversion_count: number;
  recipients: number;
  conversion_rate: number;
  attributed_revenue_cents: number;
  currency?: string;
}

/* ---------- Phase 11 / Analytics shapes ------------------------------ */

/**
 * One bucket in the subscriber-growth time-series. `count` is the
 * cumulative subscriber total at end-of-day for `date` (YYYY-MM-DD).
 */
export interface SubscriberTimeseriesPoint {
  date: string;
  count: number;
}

export interface SubscriberTimeseriesResponse {
  range: "7d" | "30d" | "90d";
  points: SubscriberTimeseriesPoint[];
}

/** Mirrors apps/api/internal/analytics/analytics.go::CampaignReport. */
export interface CampaignReport {
  campaign_id: string;
  sent: number;
  delivered: number;
  opens: number;
  unique_opens: number;
  clicks: number;
  unique_clicks: number;
  bounces: number;
  complaints: number;
  unsubscribes: number;
  open_rate: number;
  click_rate: number;
  click_to_open_rate: number;
  bounce_rate: number;
  unsub_rate: number;
  top_links: { url: string; clicks: number }[];
  /**
   * G2 (campaigns 2026): bot-stripped engagement. Filters opens
   * whose User-Agent matches Apple MPP / Gmail Image Proxy /
   * link-scanner signatures, plus dedupes clicks firing <2s after
   * a same-subscriber open (scanner unfurl). All fields are 0
   * when the backend env flag POSTWAVE_HUMAN_ENGAGEMENT is off, so
   * the toggle in the slideover gates on `bot_signatures_applied
   * > 0 || human_opens > 0` to stay stable across the flag flip.
   * Optional for wire-compat with older backends.
   */
  human_opens?: number;
  human_unique_opens?: number;
  human_clicks?: number;
  human_unique_clicks?: number;
  human_open_rate?: number;
  human_click_rate?: number;
  human_click_to_open_rate?: number;
  human_top_links?: { url: string; clicks: number }[];
  bot_signatures_applied?: string[];
}

/** Mirrors apps/api/internal/analytics/analytics.go::SequenceFunnel. */
export interface SequenceFunnelStep {
  position: number;
  reached: number;
  opened: number;
  clicked: number;
  open_rate: number;
  click_rate: number;
  dropoff_pct: number;
}

export interface SequenceFunnel {
  sequence_id: string;
  steps: SequenceFunnelStep[];
}

/**
 * One subscriber currently moving through (or recently exited from) a
 * sequence. The drawer's primary unit of display — every field except
 * `email` is optional so partial backend responses still render cleanly.
 *
 * Naming mirrors the listmonk/voice convention (snake_case JSON) so the
 * frontend can pass the wire payload straight into the row component.
 */
export interface SequenceParticipant {
  /** Subscriber primary key — used for the row click → profile jump. */
  subscriber_id: string | number;
  email: string;
  /** 1-based step position the subscriber is currently waiting at. */
  current_step?: number;
  /** Optional human label for the step (e.g. "Email: Welcome to Moosewave"). */
  current_step_label?: string;
  /** RFC3339 — when the subscriber entered this sequence. */
  entered_at?: string;
  /** RFC3339 — last enrollment event (send/open/click/advance). */
  last_event_at?: string;
  /** Lifecycle status — drives the badge + filter UI. */
  status?: SequenceParticipantStatus;
}

/** Statuses the voice service actually serves (participants.go whitelist). */
export type SequenceParticipantStatus =
  | "active"
  | "completed"
  | "completed_goal"
  | "exited";

/**
 * Sort keys accepted by /participants. Server is the source of truth —
 * the drawer also sorts in-memory as a fallback so the UI stays usable
 * if the backend ignores the param.
 */
export type SequenceParticipantSort =
  | "entered_at_desc"
  | "entered_at_asc"
  | "current_step_desc"
  | "current_step_asc";

export interface SequenceParticipantsResponse {
  items: SequenceParticipant[];
  /** Total across all pages (matches the list row's `active_runs`). */
  total: number;
  page: number;
  per_page: number;
}

/**
 * True when the deployment cannot serve the participants endpoint at
 * all (404 on older gateways that don't mount the route). A 503 is a
 * retryable dependency outage and deliberately does not match. Callers render the
 * "not available in this deployment" state — never fixture data.
 */
export function isSequenceParticipantsUnavailable(
  error: ApiErr["error"] | undefined,
): boolean {
  return !!error && error.kind === "http" && error.status === 404;
}

/** One generated step in a voice-drafted sequence. */
export interface SequenceDraftStep {
  subject: string;
  body: string;
  delay_hours: number;
  /** 1-based position within the draft. */
  position: number;
}

/** Response of POST /api/v1/voice/sequences/draft. */
export interface SequenceDraftResponse {
  name: string;
  steps: SequenceDraftStep[];
}

/* ---------- Extended analytics shapes -------------------------------- */

/** Dimensions accepted by GET /api/v1/analytics/timeseries. `list` is
 *  NOT supported yet — the server 400s with `unsupported_dimension`. */
export type AnalyticsTimeseriesGroupBy = "campaign" | "domain";

/** Metrics accepted by GET /api/v1/analytics/timeseries. */
export type AnalyticsTimeseriesMetric = "opens" | "clicks" | "bounces";

export interface AnalyticsTimeseriesPoint {
  date: string;
  value: number;
}

/** One grouped series — `key` is the campaign id / domain name, `label`
 *  the display string. */
export interface AnalyticsTimeseriesSeries {
  key: string;
  label: string;
  points: AnalyticsTimeseriesPoint[];
}

export interface AnalyticsTimeseriesResponse {
  series: AnalyticsTimeseriesSeries[];
}

/** Mirrors apps/api/internal/analytics/analytics.go::LinkRow. */
export interface LinkRow {
  url: string;
  clicks: number;
  unique_clickers: number;
  ctr: number;
}

/** Mirrors apps/api/internal/analytics/analytics.go::CompareRow. */
export interface CompareRow {
  campaign_id: string;
  total_recipients: number;
  open_rate: number;
  click_rate: number;
  bounce_rate: number;
  complaint_rate: number;
  unsub_rate: number;
}

/** Mirrors apps/api/internal/analytics/analytics.go::GeographyRow. */
export interface GeographyRow {
  country: string;
  opens: number;
  clicks: number;
}

/** Mirrors apps/api/internal/analytics/analytics.go::DeviceRow. */
export interface DeviceRow {
  client: string;
  opens: number;
  clicks: number;
}

/** Mirrors apps/api/internal/analytics/analytics.go::BounceCounts. */
export interface BounceCounts {
  hard: number;
  soft: number;
  spam_trap: number;
  total: number;
}

/** Mirrors apps/api/internal/analytics/analytics.go::CohortRow. */
export interface CohortRow {
  cohort_label: string;
  cohort_size: number;
  weeks: number[];
}

/** Cohort grouping window. Backend currently honors only "month"; the
 *  wider union here lets the picker hold week/quarter for forward-compat. */
export type CohortBucket = "week" | "month" | "quarter";

/** Cohort metric variant. Backend currently honors open_rate / click_rate /
 *  retention; reply_rate and revenue are reserved for the next API rev. */
export type CohortMetric =
  | "open_rate"
  | "click_rate"
  | "retention"
  | "reply_rate"
  | "revenue";

/** Mirrors apps/api/internal/analytics/analytics.go::EngagementPanel
 *  (GET /api/v1/campaigns/{id}/engagement). Structurally identical to the
 *  EngagementPanel exported by components/analytics/EngagementPanel.tsx —
 *  TS structural typing makes them interchangeable at the prop boundary.
 *  All rates are fractions in [0,1], NOT percent. */
export interface EngagementPanel {
  campaign_id: string;
  delivered: number;
  human_unique_opens: number;
  human_open_rate: number;
  raw_open_rate: number;
  reply_count: number;
  distinct_replyers: number;
  reply_rate: number;
  open_decoupled_conversions: number;
  total_attributed_conversions: number;
  bot_signatures_applied: string[];
  ai_surfacing_score: number;
  ai_surfacing_basis: string[];
  ai_surfacing_confidence_level: "low" | "ok";
  ai_surfacing_sample_opens: number;
}

/** Mirrors apps/api/internal/analytics/analytics.go::RevenueReport. */
export interface RevenueReport {
  attributed_revenue_cents: number;
  currency: string;
  conversions: number;
  attribution_window_days: number;
  note?: string;
}

/** Mirrors apps/api/internal/campaign_benchmarks/campaign_benchmarks.go::Metric. */
export interface BenchmarkMetric {
  name: string;
  value: number;
  baseline: number;
  delta: number;
  delta_pct: number | null;
  percentile: number | null;
  verdict?: "above" | "on_par" | "below" | string;
  available: boolean;
  reason?: string;
}

export interface CampaignBenchmarkRates {
  recipients: number;
  open_rate: number;
  click_rate: number;
  bounce_rate: number;
  complaint_rate: number;
  unsubscribe_rate: number;
}

/** Producer envelope returned by campaign_benchmarks.Handler. */
export interface CampaignBenchmarkResponse {
  campaign_id: string;
  baseline_days: number;
  baseline_from: string;
  baseline_to: string;
  as_of: string;
  timezone: string;
  baseline_selection: string;
  baseline_sample_size: number;
  minimum_sample_size: number;
  baseline_available: boolean;
  baseline_unavailable_reason?: string;
  this: CampaignBenchmarkRates;
  tenant_baseline: CampaignBenchmarkRates;
  metrics: BenchmarkMetric[];
}

export function validateCampaignBenchmarkResponse(
  expectedCampaignId: string,
  response: ApiResult<CampaignBenchmarkResponse>,
): ApiResult<CampaignBenchmarkResponse> {
  if (response.error) return response;
  const value = response.data;
  const finite = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isFinite(candidate);
  const fraction = (candidate: unknown): candidate is number =>
    finite(candidate) && candidate >= 0 && candidate <= 1;
  const validIsoTimestamp = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    Number.isFinite(Date.parse(candidate));
  const validRates = (
    candidate: unknown,
  ): candidate is CampaignBenchmarkRates => {
    if (!candidate || typeof candidate !== "object") return false;
    const rates = candidate as Partial<CampaignBenchmarkRates>;
    return (
      finite(rates.recipients) &&
      Number.isInteger(rates.recipients) &&
      rates.recipients >= 0 &&
      fraction(rates.open_rate) &&
      fraction(rates.click_rate) &&
      fraction(rates.bounce_rate) &&
      fraction(rates.complaint_rate) &&
      fraction(rates.unsubscribe_rate)
    );
  };
  const validMetric = (candidate: unknown): candidate is BenchmarkMetric => {
    if (!candidate || typeof candidate !== "object") return false;
    const metric = candidate as Partial<BenchmarkMetric>;
    return (
      typeof metric.name === "string" &&
      metric.name.length > 0 &&
      fraction(metric.value) &&
      fraction(metric.baseline) &&
      finite(metric.delta) &&
      (metric.delta_pct === null || finite(metric.delta_pct)) &&
      (metric.percentile === null ||
        (typeof metric.percentile === "number" &&
          Number.isInteger(metric.percentile) &&
          metric.percentile >= 0 &&
          metric.percentile <= 100)) &&
      typeof metric.available === "boolean" &&
      (metric.verdict === undefined ||
        (typeof metric.verdict === "string" && metric.verdict.length > 0)) &&
      (metric.reason === undefined || typeof metric.reason === "string") &&
      (metric.available
        ? typeof metric.verdict === "string"
        : Boolean(metric.reason?.trim()))
    );
  };
  if (
    !value ||
    String(value.campaign_id).trim().toLowerCase() !==
      expectedCampaignId.trim().toLowerCase() ||
    !Number.isInteger(value.baseline_days) ||
    value.baseline_days <= 0 ||
    !validIsoTimestamp(value.baseline_from) ||
    !validIsoTimestamp(value.baseline_to) ||
    !validIsoTimestamp(value.as_of) ||
    Date.parse(value.baseline_from) > Date.parse(value.baseline_to) ||
    Date.parse(value.baseline_to) > Date.parse(value.as_of) ||
    typeof value.timezone !== "string" ||
    value.timezone.length === 0 ||
    typeof value.baseline_selection !== "string" ||
    value.baseline_selection.length === 0 ||
    !Number.isInteger(value.baseline_sample_size) ||
    value.baseline_sample_size < 0 ||
    !Number.isInteger(value.minimum_sample_size) ||
    value.minimum_sample_size <= 0 ||
    typeof value.baseline_available !== "boolean" ||
    value.baseline_available !==
      value.baseline_sample_size >= value.minimum_sample_size ||
    (value.baseline_unavailable_reason !== undefined &&
      typeof value.baseline_unavailable_reason !== "string") ||
    (!value.baseline_available && !value.baseline_unavailable_reason?.trim()) ||
    !validRates(value.this) ||
    !validRates(value.tenant_baseline) ||
    !Array.isArray(value.metrics) ||
    !value.metrics.every(validMetric) ||
    value.metrics.some(
      (metric) => metric.available !== value.baseline_available,
    )
  ) {
    return {
      error: {
        kind: "parse",
        code: "invalid_campaign_benchmark_response",
        message:
          "The campaign benchmark service returned an invalid envelope. No unverified benchmark verdicts were shown; retry the request.",
      },
      retryability: "manual",
    };
  }
  return response;
}

export interface RepliesSummary {
  window_days: number;
  total: number;
  matched: number;
  unmatched: number;
  top_campaigns: { campaign_id: string; replies: number }[];
}

export interface ReplyTimeseriesPoint {
  date: string;
  replies: number;
}

export interface ReplyTimeseriesResponse {
  window_days: number;
  points: ReplyTimeseriesPoint[];
}

export interface ReplyTopSender {
  recipient_email: string;
  replies: number;
  last_at: string;
}

export interface ReplyTopSendersResponse {
  window_days: number;
  senders: ReplyTopSender[];
}

/* ---------- campaign templates types -------------------------------- */

/**
 * CampaignTemplate — mirrors the `Template` struct in
 * apps/api/internal/campaigntemplates/campaigntemplates.go.
 *
 * `kind` ("regular" / "automation" / "broadcast") is not a column on
 * the API today; the UI keeps it as an optional client field and
 * encodes it as a `kind:<v>` tag when persisting.
 */
export interface CampaignTemplate {
  id: string;
  tenant_id?: string;
  slug: string;
  name: string;
  description?: string;
  category?: string;
  subject: string;
  preview_text?: string;
  body_html?: string;
  body_mjml?: string;
  variables?: Array<Record<string, unknown>>;
  tags?: string[];
  kind?: string;
  created_at?: string;
  updated_at?: string;
  /**
   * v2 fields (migration 0187). Optional so legacy mocks still
   * type-check.
   */
  goal?: TemplateGoal | "";
  is_featured?: boolean;
  usage_count?: number;
  last_used_at?: string;
  is_favorited?: boolean;
  template_kind?: "editable" | "reference";
  source_provider?: string;
  source_external_id?: string;
  source_url?: string;
  source_brand?: string;
  thumbnail_url?: string;
  preview_assets?: CampaignTemplatePreviewAsset[];
  source_captured_at?: string;
  source_license_status?: string;
  source_metadata?: Record<string, unknown>;
  industry?: string;
  style?: string;
  layout?: string;
  design_metadata?: Record<string, unknown>;
  review_status?: "pending" | "approved" | "rejected";
  quality_score?: number;
  content_hash?: string;
  imported_at?: string;
  reference_template_ids?: string[];
  generation_metadata?: Record<string, unknown>;
  version?: number;
  etag?: string;
  archived_at?: string;
  capabilities?: CampaignTemplateCapabilities;
  recommended_action?: string;
  warnings?: CampaignTemplateWarning[];
}

export interface CampaignTemplatePreviewAsset {
  variant: "desktop" | "mobile" | "card";
  url: string;
  mime_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width: number;
  height: number;
  size_bytes: number;
  status: "ready" | "source_missing";
}

export interface CampaignTemplateCapabilities {
  can_preview: boolean;
  can_favorite: boolean;
  can_adapt: boolean;
  can_use_directly: boolean;
  can_create_campaign: boolean;
  can_edit_directly: boolean;
  can_clone: boolean;
  can_delete: boolean;
  can_archive: boolean;
  can_restore: boolean;
  has_source_html: boolean;
  has_source_mjml: boolean;
  has_desktop_preview: boolean;
  has_mobile_preview: boolean;
}

export interface CampaignTemplateWarning {
  code: string;
  message: string;
  recommended_action?: string;
}

/** Goal taxonomy enforced by the backend CHECK constraint. */
export type TemplateGoal =
  | "welcome"
  | "newsletter"
  | "announcement"
  | "promotional"
  | "re_engagement"
  | "transactional"
  | "automation";

/** Mirrors apps/api/internal/campaigntemplates/extras.go::Stats. */
export interface TemplateStats {
  total: number;
  mine: number;
  featured: number;
  favorites: number;
  used_last_30d: number;
  top_template_id?: string;
  top_template_name?: string;
  top_usage_count?: number;
  last_used_at?: string;
}

/** Mirrors apps/api/internal/campaigntemplates/extras.go::GoalCount. */
export interface TemplateGoalCount {
  goal: TemplateGoal | "";
  count: number;
}

export type CampaignTemplateListResponse = CampaignTemplate[];

export interface CampaignTemplateFacetValue {
  value: string;
  count: number;
}

export interface CampaignTemplateSearchResponse {
  items: CampaignTemplate[];
  page: number;
  per_page: number;
  total: number;
  next_cursor?: string;
  facets: {
    goals: CampaignTemplateFacetValue[];
    categories: CampaignTemplateFacetValue[];
    providers: CampaignTemplateFacetValue[];
    industries: CampaignTemplateFacetValue[];
    styles: CampaignTemplateFacetValue[];
    layouts: CampaignTemplateFacetValue[];
  };
}

export interface CampaignTemplateRevisionSummary {
  version: number;
  etag: string;
  transition: string;
  name: string;
  subject: string;
  archived_at?: string;
  snapshot_time: string;
}

export interface CampaignTemplateRevisionPage {
  items: CampaignTemplateRevisionSummary[];
  page: number;
  per_page: number;
  total: number;
}

export interface CampaignTemplateRevision {
  version: number;
  etag: string;
  transition: string;
  snapshot_time: string;
  snapshot: CampaignTemplate;
}

export interface CampaignFromTemplateInput {
  template_id: string;
  name?: string;
  subject?: string;
  preview_text?: string;
  variables?: Record<string, unknown>;
  content?: Record<string, unknown>;
  brand?: Record<string, unknown>;
  segment_id?: string;
  list_id?: string | number;
}

export function isStrongCampaignTemplateEntityTag(
  value: string | null | undefined,
): value is string {
  return Boolean(
    value && /^"campaign-template:[^"\\\s,]+:v[1-9]\d*"$/.test(value.trim()),
  );
}

/* ---------- forms types ---------------------------------------------- */

export type FormOptInMode = "single" | "double";
export type FormStatus = "draft" | "published" | "archived";
export type FormEmbedFlavor =
  | "script"
  | "iframe"
  | "react"
  | "wordpress"
  | "inline";
export type FormSubmissionStatus =
  | "pending"
  | "confirmed"
  | "unsubscribed"
  | string;

export interface FormDetail {
  id: string;
  tenantId?: string;
  slug: string;
  name: string;
  optInMode: FormOptInMode;
  structure?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  status: FormStatus;
  createdAt?: string;
  updatedAt?: string;
}

/** GET /api/v1/forms/{id}/embed/{flavor}. All URL fields are authored by
 *  the server from FORMS_PUBLIC_HOST and are intentionally snake_case to
 *  mirror the wire response. */
export interface FormEmbedSnippetResponse {
  flavor: FormEmbedFlavor;
  snippet: string;
  language: string;
  instructions: string;
  public_host: string;
  public_url: string;
}

export interface FormSummary extends FormDetail {
  submissions30d: number;
  conversionRate: number; // 0..100
  /** Hosted-page render events in the trailing 30 days. These are not
   *  deduplicated visitors and exclude embed-only submissions. Optional —
   *  older API builds don't compute the counter. */
  visits30d?: number;
}

/** One day of hosted-form visits — GET /api/v1/forms/{id}/analytics. */
export interface FormVisitPoint {
  date: string;
  count: number;
}

/** Response of GET /api/v1/forms/{id}/analytics?days=. */
export interface FormAnalyticsResponse {
  form_id: string;
  days: number;
  visits: FormVisitPoint[];
  visits_total: number;
}

export interface FormSubmission {
  id: string;
  formId?: string;
  email: string;
  customFields?: Record<string, string>;
  status: FormSubmissionStatus;
  ip?: string | null;
  userAgent?: string | null;
  submittedAt: string;
  confirmedAt?: string | null;
}

export interface FormUpdateInput {
  name?: string;
  slug?: string;
  optInMode?: FormOptInMode;
  structure?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  status?: FormStatus;
}

export interface FormUpdateOptions {
  /** Strong ETag returned by GET/PATCH; echoed as If-Match. */
  expectedVersion?: string;
  /** Refuse offline queue admission for reconciliation-sensitive edits. */
  requireOnline?: boolean;
}

export interface FormDeleteOptions {
  /** Strong ETag returned by GET/PATCH; echoed as If-Match. */
  expectedVersion?: string;
}

/* =====================================================================
 * Phase-10 email preview types — added by the Preview agent.
 *
 * NOTE FOR OTHER AGENTS: keep additions in this clearly-marked block so
 * we don't conflict on the same lines. The AI panel agent's types live
 * above (search for "Moosewave AI types").
 * ===================================================================== */

/** G1: one hour of campaign engagement. */
export interface CampaignHourBucket {
  hour: string;
  opens: number;
  clicks: number;
  unsubs: number;
}

/** G1: response of GET /api/v1/campaigns/{id}/timeseries. */
export interface CampaignTimeseries {
  campaign_id: string;
  buckets: CampaignHourBucket[];
}

/** G20: one ordered stage of an approval chain. */
export interface ApprovalChainStep {
  position: number;
  role: string;
}

/** G20: per-approval chain progress. */
export interface ApprovalChainProgress {
  approval_id: string;
  stages: {
    position: number;
    role: string;
    status: "pending" | "approved" | "rejected";
    decided_by_user_id?: string;
  }[];
  state: "pending" | "approved" | "rejected";
  current_position: number;
}

/** G19 follow-up: one locale's engagement row. */
export interface CampaignLocaleStat {
  locale: string;
  sent: number;
  opens: number;
  clicks: number;
}

/** G18: one flagged anomalous hour. */
export interface CampaignAnomaly {
  hour: string;
  metric: string;
  value: number;
  mean: number;
  z_score: number;
  direction: "spike" | "drop";
}

/** G18: response of GET /api/v1/campaigns/{id}/anomalies. */
export interface CampaignAnomaliesResult {
  campaign_id: string;
  anomalies: CampaignAnomaly[];
}

/** G8: one rendered environment from POST /api/v1/render. */
export interface CrossClientRender {
  environment: {
    name: string;
    viewport_width: number;
    viewport_height: number;
    user_agent: string;
    dark_mode: boolean;
  };
  image_url: string;
  width: number;
  height: number;
  issues: string[];
}

/** G8: response of POST /api/v1/render (cross-client preview matrix). */
export interface CrossClientRenderResponse {
  renders: CrossClientRender[];
  cache_hit: boolean;
}

/** Body of POST /api/v1/email-preview/render. */
export interface EmailPreviewRequest {
  /**
   * The email body. Real MJML is ideal — when the API host has the
   * `mjml` CLI installed it will render with full fidelity. Plain HTML
   * also works: the backend's stub renderer falls back to passing the
   * input through, and we still get per-client approximations downstream.
   */
  mjml: string;
  /** Optional `{{name}}`-style variable substitutions. */
  vars?: Record<string, string>;
}

/**
 * Response shape — keys mirror the JSON tags in
 * apps/api/internal/emailpreview/handlers.go::renderResponse.
 */
export interface EmailPreviewResponse {
  previews: {
    gmail: string;
    outlook: string;
    apple: string;
    dark: string;
  };
  warnings: string[];
  /** Which renderer produced the previews: the in-process engine, the
   *  mjml CLI, or the passthrough fallback. Absent on older servers. */
  renderer?: "engine" | "mjml" | "fallback";
  /** Renderer-level caveat (e.g. "mjml unavailable, used fallback"). */
  warning?: string;
}

/* =====================================================================
 * Migration types — added by the Migrations wizard agent.
 *
 * Source of truth: `packages/migrate/canonical/types.go`. We mirror the
 * JSON tags exactly. Every field is optional in TypeScript because the
 * upstream service streams progress incrementally — early polls land
 * with mostly-empty job rows.
 * =================================================================== */

/** Mirrors `canonical.MigrationStatus`. */
export type MigrationStatus =
  | "pending"
  | "authenticating"
  | "discovering"
  | "dry_run"
  | "awaiting_confirmation"
  | "importing"
  | "rolling_back"
  | "completed"
  | "failed"
  | "rolled_back";

export interface MigrationProgress {
  subscribers_total?: number;
  subscribers_done?: number;
  segments_total?: number;
  segments_done?: number;
  automations_total?: number;
  automations_done?: number;
  paid_subs_total?: number;
  paid_subs_done?: number;
  archive_total?: number;
  archive_done?: number;
  templates_total?: number;
  templates_done?: number;
  source_archive_total?: number;
  source_archive_done?: number;
}

export interface MigrationJob {
  id: string;
  tenant_id?: string;
  source: MigrationSource;
  status: MigrationStatus;
  progress?: MigrationProgress;
  cursor?: Record<string, string | null>;
  started_at?: string;
  completed_at?: string | null;
  rollback_until?: string | null;
  source_session_expires_at?: string | null;
  selected_audience_ids?: string[];
  verification_report?: MigrationVerificationReport | null;
  error?: string | null;
  // The store may attach extra fields; tolerate them.
  [extra: string]: unknown;
}

export interface MigrationCustomFieldMapping {
  source: string;
  canonical: string;
  type: string;
}

export interface MigrationSegmentWarning {
  name: string;
  warning: string;
}

export interface MigrationAutomationUnsupported {
  name: string;
  reason: string;
}

export interface MigrationResourceWarning {
  resource: string;
  source_id?: string;
  name?: string;
  warning: string;
}

export interface MigrationResourceCompleteness {
  resource: string;
  label: string;
  source_total: number;
  imported: number;
  supported: boolean;
  /** "imported_runtime" | "partial_runtime" | "preserved_for_rebuild" | "manual_rebuild_required" | "not_supported" | "not_detected" */
  status: string;
  notes?: string[];
}

/**
 * Used both as a dry-run preview report and as the post-import audit.
 * Aliased in the wizard as `MigrationPreview` for readability.
 */
export interface MigrationVerificationReport {
  subscribers_imported?: number;
  suppression_list_size?: number;
  custom_fields_mapped?: MigrationCustomFieldMapping[];
  custom_fields_unmapped?: string[];
  segments_translated?: number;
  segments_with_warnings?: MigrationSegmentWarning[];
  automations_translated?: number;
  automations_unsupported?: MigrationAutomationUnsupported[];
  paid_subs_imported?: number;
  premium_memberships_observed?: number;
  archive_imported?: number;
  discovery_warnings?: string[];
  campaign_archive_warnings?: MigrationResourceWarning[];
  template_warnings?: MigrationResourceWarning[];
  resource_completeness?: MigrationResourceCompleteness[];
  source_archive_imported?: number;
  source_archive_warnings?: MigrationResourceWarning[];
  data_loss_estimate_pct?: number;
  /**
   * Consent provenance preserved through the import. consent_known counts
   * subscribers whose opt-in source/timestamp came across; consent_unknown
   * those imported without it (honestly flagged, not assumed consented).
   */
  consent_known?: number;
  consent_unknown?: number;
  duplicate_subscribers_merged?: number;
  subscriber_merge_conflicts?: Array<{
    email: string;
    source_ids?: string[];
    tags?: string[];
    conflict_fields?: string[];
  }>;
  templates_imported?: number;
  source_archive_by_resource?: Record<string, number>;
}

/** Convenience alias used by the wizard. */
export type MigrationPreview = MigrationVerificationReport;

/** Body shape for `createMigration`. */
export interface MigrationCreateInput {
  apiKey?: string;
  accountId?: string;
  extra?: Record<string, string>;
}

/** Response from `POST /api/v1/migrations/{source}/credentials`. */
export interface MigrationCreateResponse {
  job_id: string;
  account_id?: string;
}

export interface MigrationUploadProgress {
  uploadId: string;
  uploadedBytes: number;
  totalBytes: number;
}

/* =====================================================================
 * Send-Time Optimization + Assets — added by the SendTime/Assets agent.
 *
 * Two unrelated surfaces, grouped here so we own a single contiguous
 * append block and don't conflict with the other agents writing into
 * this file.
 *
 *   - Send-Time-Opt — backend `apps/api/internal/send_time_opt`
 *       GET  /api/v1/subscribers/{id}/best-send-time
 *       POST /api/v1/campaigns/{id}/schedule-by-best-time
 *
 *   - Assets — backend `apps/api/internal/assets`
 *       GET    /api/v1/assets?limit=&before=
 *       POST   /api/v1/assets   (JSON {filename, mime, content_base64})
 *       DELETE /api/v1/assets/{id}
 *
 * This method bag is folded into the canonical facade at its single explicit
 * construction point. Pages may import `apiSendTimeAssets` or `api`; both
 * names intentionally reference that same final composition.
 *
 * NOTE FOR OTHER AGENTS: keep additions in this clearly-marked block so
 * we don't conflict on the same lines.
 * =================================================================== */

/* ---------- Send-Time-Opt types ------------------------------------- */

/**
 * Default cold-start threshold mirrored from
 * `apps/api/internal/send_time_opt/send_time_opt.go` (`const MinOpens`).
 * Surfaces that render the "we need ~N opens before we can compute a
 * recommendation" copy should prefer the server-supplied `min_opens`
 * field on the 404 envelope and fall back to this constant only when
 * the server didn't ship a value (older deployments). Keeping this in
 * sync with the Go const is enforced by `sto-cold-start-copy-matches-backend`.
 */
export const STO_MIN_OPENS_DEFAULT = 5;

/**
 * Mirrors `send_time_opt.BestHour` in apps/api/internal/send_time_opt/
 * send_time_opt.go. The Go server emits a flat object with these fields
 * (or 404s when the subscriber is below `MinOpens`).
 *
 *   - `best_hour_utc` is hour-of-week 0..167 (Sun 00:00 UTC = 0).
 *     Some specs label this `best_hour_local`; the server is canonical
 *     so we expose the UTC field and tolerate the alias defensively.
 *   - `sample_size` is currently not persisted with the cache and may be 0
 *     even when a recommendation exists. The detailed pattern endpoint is
 *     authoritative for a visible weighted-event sample.
 *   - `computed_at` is the moment the row was last refreshed.
 */
export interface BestSendTime {
  email?: string;
  best_hour_utc: number;
  computed_at: string;
  sample_size: number;
  // Defensive — older specs may carry these aliases instead.
  best_hour_local?: number;
  confidence?: number;
}

/** Strategy passed to the schedule-by-best-time endpoint. */
export type SendTimeStrategy = "per_recipient" | "modal_hour";

/** Response envelope for POST /api/v1/campaigns/{id}/schedule-by-best-time. */
export interface ScheduleByBestTimeResponse {
  campaign_id: string;
  scheduled: number;
  within_days?: number;
  tenant_mean?: number;
  strategy?: SendTimeStrategy;
  reference_at?: string;
  /**
   * True only after the CampaignsRescheduler durably writes the recipient
   * timestamps. Callers must treat false or absence as an unconfirmed
   * activation.
   */
  persisted?: boolean;
  truncated?: boolean;
  hard_cap?: number;
  [extra: string]: unknown;
}

/**
 * One bucket of the per-hour histogram returned by the
 * `/schedule-by-best-time/preview` endpoint. `hour` is 0..23 UTC,
 * `count` is the number of recipients whose computed send_at falls in
 * that hour. The server always returns 24 buckets in ascending order
 * — empty hours have count=0 — so callers can map directly to a fixed
 * 24-column chart with no padding logic.
 *
 * sto-recipient-distribution-preview (P1).
 */
export interface SendTimeDistributionBucket {
  hour: number;
  count: number;
}

/**
 * Response envelope for the dry-run preview that backs the inline
 * histogram on the SendTime page. Same shape as
 * `ScheduleByBestTimeResponse` for the fields they share, plus:
 *
 *   - `distribution` — fixed-length 24-element histogram.
 *   - `max_per_minute` — busiest-minute recipient count. Surfaces
 *     over-burst risk (e.g. "20k land at 9:00:00") that the operator
 *     would otherwise discover post-send when the SMTP pool throttles.
 *   - `max_per_day` / `peak_day_utc` — peak-day count + which UTC day,
 *     used for the warmup-cap comparison.
 *   - `tier_cap_today` — tenant warmup-day cap; -1 means no cap, 0
 *     means the warmup reader was unwired on the server.
 *   - `warmup_cap_breach` — true iff max_per_day > tier_cap_today and
 *     tier_cap_today > 0. Surfaced as a red inline banner above the
 *     Schedule button so the operator can split the campaign or wait.
 *
 * sto-recipient-distribution-preview (P1).
 */
export interface SchedulePreviewResponse {
  campaign_id: string;
  scheduled: number;
  within_days: number;
  tenant_mean: number;
  truncated: boolean;
  hard_cap: number;
  strategy: SendTimeStrategy;
  reference_at: string;
  distribution: SendTimeDistributionBucket[];
  max_per_minute: number;
  max_per_day: number;
  peak_day_utc: string;
  tier_cap_today: number;
  warmup_cap_breach: boolean;
  counted_at: string;
}

/* ---------- Assets types -------------------------------------------- */

/**
 * Mirrors the Go `assets.Asset` struct in apps/api/internal/assets/repo.go.
 * Keys are camelCase because the Go json tags use camelCase. Filename and
 * mime are required server-side; size/dimensions and url come back populated
 * after the storage write.
 *
 * Refined Library (PR 1): altText, referencesCount, lastUsedAt added.
 * altText defaults to "" on existing rows; referencesCount defaults to 0.
 */
export interface Asset {
  id: string;
  tenantId: string;
  filename: string;
  mime: string;
  bytes: number;
  width?: number;
  height?: number;
  url: string;
  createdAt: string;
  updatedAt: string;
  /** Positive compare-and-swap revision required by every mutation. */
  version: number;
  altText?: string;
  referencesCount?: number;
  lastUsedAt?: string | null;
  /** Workstream 4 (Mailchimp parity polish): tag set. May be undefined
   *  when the asset list fetch did not join the tags table (e.g. the
   *  legacy /api/v1/assets call) — call api.getAssetTags(id) to fetch. */
  tags?: string[];
  /** Mailchimp-parity follow-up: the folder this asset is filed under.
   *  `null` or `undefined` means the asset is in the Uncategorised
   *  bucket. The server returns JSON null for unfiled assets; legacy
   *  cached responses may omit the field entirely. */
  folderId?: string | null;
  // Tolerate any extra fields the server attaches (deletedAt, etc).
  [extra: string]: unknown;
}

/** Mailchimp-parity follow-up: an asset folder. Folders are flat (no
 *  nesting), per-tenant, named, and carry a derived count of the live
 *  assets inside them so the chip-row can render `Spring (12)`. */
export interface AssetFolder {
  id: string;
  tenantId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Live asset count (deleted_at IS NULL). 0 for an empty folder. */
  assetCount: number;
}

/** A single live draft / template / form referencing an asset. */
export interface AssetReferrer {
  kind: "campaign" | "template" | "form";
  id: string;
  name: string;
}

/** Smart-filter chip counts returned alongside list responses. */
export interface AssetCounts {
  all: number;
  recent: number;
  inUse: number;
  unused: number;
  large: number;
}

/**
 * GET /api/v1/assets envelope. The Go handler returns
 * `{items, counts, nextCursor}`;
 * we also tolerate the legacy `data` / `results` shapes for forward compat
 * with older mocks/snapshots.
 */
export interface AssetsResponse {
  items?: Asset[];
  counts?: AssetCounts;
  /** Last returned asset UUID when a server-side probe found another page. */
  nextCursor?: string | null;
  data?: Asset[];
  results?: Asset[];
}

/** Body for POST /api/v1/assets. */
export interface AssetUploadInput {
  filename: string;
  mime: string;
  /** Raw base64 — NO `data:image/…;base64,` prefix. */
  content_base64: string;
}

/** Refined Library list-query options. */
export type AssetSort = "newest" | "oldest" | "largest" | "name" | "most-used";
export type AssetFilter = "all" | "recent" | "in-use" | "unused" | "large";

/** Workstream 4 (Mailchimp parity polish): per-tag count for the
 *  asset library toolbar chip-row. */
export interface AssetTagCount {
  tag: string;
  count: number;
}

/** Workstream 4: saved (reusable) block — Mailchimp parity. */
export interface SavedBlock {
  id: string;
  tenant_id?: string;
  name: string;
  kind: "block" | "snippet" | "section";
  body_html: string;
  body_json: unknown;
  created_at: string;
  updated_at: string;
  version: number;
}

/** Workstream 4: parsed template region (from {{region:name}} tags). */
export interface TemplateRegion {
  name: string;
  default_html: string;
  position: number;
  length: number;
}

/** Workstream 4: compose-time product recommendation entry. */
export interface ProductRecommendation {
  product_id: string;
  title: string;
  url?: string;
  image_url?: string;
  price_cents: number;
  currency: string;
  score: number;
  reason: string;
}

/** Workstream 4: tenant export retention policy. */
export interface ExportRetentionPolicy {
  retention_days: number;
  max_per_tenant: number;
  current_storage_bytes: number;
  updated_at?: string;
}

/* ---------- Refined Dashboard PR 3 / 4 types -------------------- */

export interface DashboardAnomalyRow {
  id: string;
  tenantId: string;
  metric: string;
  dayBucket: string;
  value: number;
  mean: number;
  zScore: number;
  rangeUsed: string;
  detectedAt: string;
}

export interface DashboardDigestPrefs {
  userId: string;
  tenantId: string;
  frequency: "off" | "daily" | "weekly";
  lastSentAt?: string | null;
  updatedAt: string;
}

export interface DashboardLayoutResponse {
  userId: string;
  tenantId: string;
  order: string[];
  updatedAt: string;
}

export interface DashboardBenchmarkRow {
  metric: string;
  average: number;
  source: string;
}

export interface DashboardBenchmarksResponse {
  rows: DashboardBenchmarkRow[];
  note: string;
}

/* ---------- methods (attached to `api`) ----------------------------- */

const sendTimeAssetsMethods = {
  /**
   * GET /api/v1/subscribers/{id}/best-send-time — returns the cached
   * recommendation or a 404 envelope when the subscriber is below the
   * `MinOpens` threshold. Callers MUST handle the 404 gracefully.
   */
  getBestSendTime(id: string | number): Promise<ApiResult<BestSendTime>> {
    return request<BestSendTime>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/best-send-time`,
    );
  },

  /**
   * POST /api/v1/campaigns/{id}/schedule-by-best-time — re-targets the
   * campaign so each recipient receives it at their personal best hour
   * (per_recipient) or at the audience's modal hour (modal_hour).
   *
   * The Go handler consumes strategy, reference_at, and within_days. Callers
   * must still require a matching dry-run/review flow before activating it.
   */
  scheduleCampaignByBestTime(
    id: string | number,
    input: {
      strategy: SendTimeStrategy;
      reference_at?: string;
      within_days?: number;
    },
  ): Promise<ApiResult<ScheduleByBestTimeResponse>> {
    return request<ScheduleByBestTimeResponse>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/schedule-by-best-time`,
      {
        method: "POST",
        body: JSON.stringify({
          strategy: input.strategy,
          reference_at: input.reference_at ?? "",
          within_days:
            typeof input.within_days === "number" ? input.within_days : 7,
        }),
      },
    );
  },

  /**
   * POST /api/v1/campaigns/{id}/schedule-by-best-time/preview — dry-run
   * preview of the same schedule the commit endpoint would produce.
   * Never writes to campaign_recipient_send_at; safe to fire on form
   * change. Returns aggregate per-hour and warmup-cap signals without
   * exposing recipient email samples.
   *
   * Scope: write:campaigns. Although the handler is read-only, the preview
   * reveals a campaign's audience plan and is paired with a privileged
   * scheduling mutation.
   *
   * sto-recipient-distribution-preview (P1).
   */
  previewScheduleByBestTime(
    id: string | number,
    input: {
      strategy: SendTimeStrategy;
      reference_at?: string;
      within_days?: number;
    },
  ): Promise<ApiResult<SchedulePreviewResponse>> {
    return request<SchedulePreviewResponse>(
      `/api/v1/campaigns/${encodeURIComponent(String(id))}/schedule-by-best-time/preview`,
      {
        method: "POST",
        body: JSON.stringify({
          strategy: input.strategy,
          reference_at: input.reference_at ?? "",
          within_days:
            typeof input.within_days === "number" ? input.within_days : 7,
        }),
      },
    );
  },

  /**
   * GET /api/v1/assets — paginated image library with smart-filter chips.
   *
   * `q` is a case-insensitive substring match on filename. `sort` defaults
   * to "newest". `filter` defaults to "all" (which is sent as no param).
   * The server returns `{items, counts}` — counts describe the whole
   * tenant asset set so chip totals stay stable across pagination.
   */
  listAssets(
    opts: {
      limit?: number;
      before?: string;
      q?: string;
      sort?: AssetSort;
      filter?: AssetFilter;
      /** Workstream 4: when set, restricts to assets with this tag. */
      tag?: string;
      /** Mailchimp-parity follow-up: folder filter.
       *  - Omit / empty string: no folder scoping (every asset).
       *  - "root": only assets in the Uncategorised bucket.
       *  - "<uuid>": only assets in that folder. */
      folder_id?: string;
    } = {},
  ): Promise<ApiResult<AssetsResponse>> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.before) params.set("before", opts.before);
    if (opts.q) params.set("q", opts.q);
    if (opts.sort) params.set("sort", opts.sort);
    if (opts.filter && opts.filter !== "all") params.set("filter", opts.filter);
    if (opts.tag) params.set("tag", opts.tag);
    if (opts.folder_id) params.set("folder_id", opts.folder_id);
    const qs = params.toString();
    return request<AssetsResponse>(`/api/v1/assets${qs ? `?${qs}` : ""}`);
  },

  /**
   * GET /api/v1/assets/{id} — single asset plus a freshly-computed usage
   * list (so the response is authoritative at the moment of the read).
   */
  getAsset(
    id: string,
  ): Promise<ApiResult<{ asset: Asset; usage: AssetReferrer[] }>> {
    return request<{ asset: Asset; usage: AssetReferrer[] }>(
      `/api/v1/assets/${encodeURIComponent(id)}`,
    );
  },

  /** GET /api/v1/assets/{id}/usage — live referrer list only. */
  getAssetUsage(id: string): Promise<ApiResult<{ usage: AssetReferrer[] }>> {
    return request<{ usage: AssetReferrer[] }>(
      `/api/v1/assets/${encodeURIComponent(id)}/usage`,
    );
  },

  /**
   * PATCH /api/v1/assets/{id} — edits alt_text. The server rejects any
   * other field (returns 400 with code "unknown_field") and caps alt
   * text at 1024 chars.
   */
  patchAsset(
    id: string,
    input: { alt_text: string; expected_version: number },
  ): Promise<ApiResult<Asset>> {
    return request<Asset>(`/api/v1/assets/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },

  /**
   * POST /api/v1/assets — upload a single image. Body is JSON with the
   * file already base64-encoded (no `data:` prefix). The server caps at
   * 10 MiB and rejects non-image MIME types.
   */
  uploadAsset(input: AssetUploadInput): Promise<ApiResult<Asset>> {
    return request<Asset>("/api/v1/assets", {
      method: "POST",
      body: JSON.stringify({
        filename: input.filename,
        mime: input.mime,
        content_base64: input.content_base64,
        expected_version: 0,
      }),
    });
  },

  /**
   * DELETE /api/v1/assets/{id} — soft-delete an image.
   *
   * Refined Library (PR 1): when the asset is referenced by live drafts
   * and `force` is not set, the server returns 409 with an `error` envelope
   * containing `code: "has_references"`, `count`, and `usage: AssetReferrer[]`.
   * The UI then surfaces a confirm-anyway flow that re-issues the call
   * with `{ force: true }`.
   */
  deleteAsset(
    id: string,
    opts: { expectedVersion: number; force?: boolean },
  ): Promise<
    ApiResult<{
      ok?: boolean;
      id?: string;
      version?: number;
      error?: { code: string; count?: number; usage?: AssetReferrer[] };
    }>
  > {
    return request<{
      ok?: boolean;
      id?: string;
      version?: number;
      error?: { code: string; count?: number; usage?: AssetReferrer[] };
    }>(`/api/v1/assets/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({
        expected_version: opts.expectedVersion,
        force: opts.force === true,
      }),
    });
  },

  /* ---------- Send-time: audience + per-subscriber heatmap -------- */

  /**
   * GET /api/v1/send-time-opt/heatmap — audience-wide 7×24 open
   * heatmap (day-of-week × hour-of-day), normalised to per-cell fractions.
   * Exactly one usable segment or campaign scope is required by the server;
   * callers must not issue a no-parameter request.
   */
  getSegmentHeatmap(
    opts: {
      segmentId?: string | null;
      campaignId?: string | number | null;
    } = {},
  ): Promise<ApiResult<SegmentHeatmapResponse>> {
    const params = new URLSearchParams();
    if (opts.segmentId) params.set("segment_id", String(opts.segmentId));
    if (opts.campaignId != null && opts.campaignId !== "") {
      params.set("campaign_id", String(opts.campaignId));
    }
    const qs = params.toString();
    return request<SegmentHeatmapResponse>(
      `/api/v1/send-time-opt/heatmap${qs ? `?${qs}` : ""}`,
    );
  },

  /**
   * GET /api/v1/subscribers/{id}/open-pattern — per-subscriber 7×24
   * open heatmap. Same shape as the segment heatmap but bounded to
   * one subscriber's trailing 180-day history (up to 2,000 weighted opens,
   * clicks, or replies).
   */
  getSubscriberOpenPattern(
    id: string | number,
  ): Promise<ApiResult<SubscriberOpenPattern>> {
    return request<SubscriberOpenPattern>(
      `/api/v1/subscribers/${encodeURIComponent(String(id))}/open-pattern`,
    );
  },

  /* ---------- Workstream 4 (Mailchimp parity polish) ----------- */

  /** GET /api/v1/assets/tags — tenant-wide chip-row data. */
  listAssetTags(): Promise<ApiResult<{ tags: AssetTagCount[] }>> {
    return request<{ tags: AssetTagCount[] }>(`/api/v1/assets/tags`);
  },
  /** GET /api/v1/assets/{id}/tags — per-asset tag list. */
  getAssetTags(
    id: string,
  ): Promise<ApiResult<{ tags: string[]; version: number }>> {
    return request<{ tags: string[]; version: number }>(
      `/api/v1/assets/${encodeURIComponent(id)}/tags`,
    );
  },
  /** POST /api/v1/assets/{id}/tags — add tag(s). Idempotent. */
  addAssetTag(
    id: string,
    body: { tag?: string; tags?: string[]; expected_version: number },
  ): Promise<ApiResult<{ tags: string[]; version: number }>> {
    return request<{ tags: string[]; version: number }>(
      `/api/v1/assets/${encodeURIComponent(id)}/tags`,
      { method: "POST", body: JSON.stringify(body) },
    );
  },
  /** DELETE /api/v1/assets/{id}/tags/{tag} — remove one tag. */
  removeAssetTag(
    id: string,
    tag: string,
    expectedVersion: number,
  ): Promise<ApiResult<{ ok: boolean; id: string; version: number }>> {
    return request<{ ok: boolean; id: string; version: number }>(
      `/api/v1/assets/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ expected_version: expectedVersion }),
      },
    );
  },

  /* ---------- Mailchimp-parity follow-up: asset folders -------- */

  /** GET /api/v1/assets/folders — tenant-wide folder chip-row data.
   *  Each folder carries its live asset count so the chip can render
   *  the trailing count badge (matching the tag chip-row). */
  listAssetFolders(): Promise<ApiResult<{ folders: AssetFolder[] }>> {
    return request<{ folders: AssetFolder[] }>(`/api/v1/assets/folders`);
  },
  /** POST /api/v1/assets/folders — create a folder. The server rejects
   *  empty names (400) and duplicate names per-tenant (409). */
  createAssetFolder(name: string): Promise<ApiResult<AssetFolder>> {
    return request<AssetFolder>(`/api/v1/assets/folders`, {
      method: "POST",
      body: JSON.stringify({ name, expected_version: 0 }),
    });
  },
  /** PATCH /api/v1/assets/folders/{id} — rename a folder. */
  renameAssetFolder(
    id: string,
    name: string,
    expectedVersion: number,
  ): Promise<ApiResult<AssetFolder>> {
    return request<AssetFolder>(
      `/api/v1/assets/folders/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name, expected_version: expectedVersion }),
      },
    );
  },
  /** DELETE /api/v1/assets/folders/{id} — remove a folder. Contained
   *  assets are NOT deleted; they fall back to the Uncategorised
   *  bucket (folder_id = NULL). */
  deleteAssetFolder(
    id: string,
    expectedVersion: number,
  ): Promise<ApiResult<{ ok: boolean; id: string; version: number }>> {
    return request<{ ok: boolean; id: string; version: number }>(
      `/api/v1/assets/folders/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ expected_version: expectedVersion }),
      },
    );
  },
  /** PATCH /api/v1/assets/{id}/folder — reassign an asset. Pass `null`
   *  to move the asset back to the Uncategorised bucket. */
  moveAssetToFolder(
    id: string,
    folderId: string | null,
    expectedVersion: number,
  ): Promise<
    ApiResult<{
      ok: boolean;
      id: string;
      version: number;
      folderId: string | null;
    }>
  > {
    return request<{
      ok: boolean;
      id: string;
      version: number;
      folderId: string | null;
    }>(`/api/v1/assets/${encodeURIComponent(id)}/folder`, {
      method: "PATCH",
      body: JSON.stringify({
        folder_id: folderId,
        expected_version: expectedVersion,
      }),
    });
  },

  /**
   * GET /api/v1/blocks/saved — saved-block library.
   * Missing and unimplemented endpoints remain explicit errors. Treating a
   * 404/501 as an empty collection would falsely tell operators that a real
   * library had been verified and happened to contain no blocks.
   */
  listSavedBlocks(
    opts: {
      kind?: SavedBlock["kind"];
      limit?: number;
      q?: string;
      before?: string;
    } = {},
    reqOpts: { signal?: AbortSignal } = {},
  ): Promise<
    ApiResult<{ items: SavedBlock[]; total: number; next_cursor?: string }>
  > {
    const params = new URLSearchParams();
    if (opts.kind) params.set("kind", opts.kind);
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.q) params.set("q", opts.q);
    if (opts.before) params.set("before", opts.before);
    const qs = params.toString();
    return request<{
      items: SavedBlock[];
      total: number;
      next_cursor?: string;
    }>(`/api/v1/blocks/saved${qs ? `?${qs}` : ""}`, {}, reqOpts);
  },
  /** POST /api/v1/blocks/saved — create a saved block. */
  createSavedBlock(
    body: Partial<
      Pick<SavedBlock, "name" | "kind" | "body_html" | "body_json">
    >,
  ): Promise<ApiResult<SavedBlock>> {
    return request<SavedBlock>(`/api/v1/blocks/saved`, {
      method: "POST",
      body: JSON.stringify({ ...body, expected_version: 0 }),
    });
  },
  /** PATCH /api/v1/blocks/saved/{id} — partial update. */
  patchSavedBlock(
    id: string,
    expectedVersion: number,
    body: Partial<
      Pick<SavedBlock, "name" | "kind" | "body_html" | "body_json">
    >,
  ): Promise<ApiResult<SavedBlock>> {
    return request<SavedBlock>(
      `/api/v1/blocks/saved/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ ...body, expected_version: expectedVersion }),
      },
    );
  },
  /** DELETE /api/v1/blocks/saved/{id} — remove a saved block. */
  getSavedBlock(id: string): Promise<ApiResult<SavedBlock>> {
    return request<SavedBlock>(
      `/api/v1/blocks/saved/${encodeURIComponent(id)}`,
    );
  },
  /** DELETE /api/v1/blocks/saved/{id} — exact-version removal. */
  deleteSavedBlock(
    id: string,
    expectedVersion: number,
  ): Promise<ApiResult<{ ok: boolean; id: string; version: number }>> {
    return request<{ ok: boolean; id: string; version: number }>(
      `/api/v1/blocks/saved/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ expected_version: expectedVersion }),
      },
    );
  },

  /** GET /api/v1/campaign-templates/{id}/regions — parsed region list. */
  getTemplateRegions(
    id: string,
  ): Promise<ApiResult<{ regions: TemplateRegion[]; count: number }>> {
    return request<{ regions: TemplateRegion[]; count: number }>(
      `/api/v1/campaign-templates/${encodeURIComponent(id)}/regions`,
    );
  },

  /** GET /api/v1/commerce/recommendations — anchor-subscriber preview. */
  getProductRecommendations(
    opts: {
      subscriberId?: string;
      limit?: number;
    } = {},
  ): Promise<
    ApiResult<{
      items: ProductRecommendation[];
      anchor: string;
      deterministic: boolean;
    }>
  > {
    const params = new URLSearchParams();
    if (opts.subscriberId) params.set("subscriber_id", opts.subscriberId);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request<{
      items: ProductRecommendation[];
      anchor: string;
      deterministic: boolean;
    }>(`/api/v1/commerce/recommendations${qs ? `?${qs}` : ""}`);
  },

  /** GET /api/v1/exports/retention-policy — current policy + storage. */
  getExportRetentionPolicy(): Promise<ApiResult<ExportRetentionPolicy>> {
    return request<ExportRetentionPolicy>(`/api/v1/exports/retention-policy`);
  },
  /** PATCH /api/v1/exports/retention-policy — update policy. */
  patchExportRetentionPolicy(body: {
    retention_days?: number;
    max_per_tenant?: number;
  }): Promise<ApiResult<ExportRetentionPolicy>> {
    return request<ExportRetentionPolicy>(`/api/v1/exports/retention-policy`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },

  /**
   * GET /api/v1/send-time-opt — segment-level modal-hour recommendation
   * with confidence score. Mirrored here so `apiSendTimeAssets` exposes
   * it on its typed surface alongside the heatmap.
   */
  getSegmentBestSendTime(
    opts: {
      segmentId?: string | null;
      campaignId?: string | number | null;
    } = {},
  ): Promise<ApiResult<SegmentBestSendTime>> {
    const params = new URLSearchParams();
    if (opts.segmentId) params.set("segment_id", String(opts.segmentId));
    if (opts.campaignId != null && opts.campaignId !== "") {
      params.set("campaign_id", String(opts.campaignId));
    }
    const qs = params.toString();
    return request<SegmentBestSendTime>(
      `/api/v1/send-time-opt${qs ? `?${qs}` : ""}`,
    );
  },
};

/* =====================================================================
 * X1+X2+X3: suppressions + sending-settings — added by this agent
 *
 * NOTE FOR OTHER AGENTS: keep additions in this clearly-marked block so
 * we don't conflict on the same lines.
 *
 * Backend source of truth:
 *   - apps/api/internal/suppressions/suppressions.go
 *   - apps/api/internal/sendingsettings/sendingsettings.go
 *
 * Live endpoints (verified against the Go handlers):
 *   GET    /api/v1/suppressions       — paginated list
 *   POST   /api/v1/suppressions       — add one (returns Suppression)
 *   POST   /api/v1/suppressions/bulk  — add many (returns BulkResult)
 *   DELETE /api/v1/suppressions/{id}  — un-suppress (admin only)
 *   GET  /api/v1/settings/sending    — read tenant row
 *   PUT  /api/v1/settings/sending    — upsert tenant row
 *
 * Older self-hosted API builds may still lack list/delete; callers keep
 * graceful fallbacks for that compatibility window.
 *
 * Speculative endpoint:
 *   DELETE /api/v1/settings/sending   — clear (we fall back to PUT nulls)
 * =================================================================== */

/** Mirrors `suppressions.Suppression`. */
export interface SuppressionRow {
  id: string;
  email: string;
  /** "hard_bounce" | "complaint" | "manual" | "unsubscribe" | "spam_trap" | ... */
  reason?: string;
  created_at?: string;
}

/** Defensive list envelope — server may return `items` / `data` / a bare array. */
export interface SuppressionListResponse {
  items?: SuppressionRow[];
  data?: SuppressionRow[];
  results?: SuppressionRow[];
  total?: number;
}

/**
 * Mirrors `suppressions.BulkResult` JSON tags. The handler today returns
 * `{imported, skipped, errors}` — we accept `added` as an alias because
 * the public spec uses that name and we do not want a rename to break the
 * desktop.
 */
export interface SuppressionBulkResult {
  imported?: number;
  added?: number;
  skipped: number;
  errors: string[];
}

/**
 * Mirrors `suppressions.importResponse` JSON tags
 * (apps/api/internal/suppressions/import_export.go).
 *
 * Returned by `POST /api/v1/suppressions/import`. `bad_rows` carries
 * the first 10 parse failures so the operator can copy them out and
 * inspect what the server rejected.
 */
export interface SuppressionImportResult {
  inserted: number;
  existing: number;
  skipped: number;
  errors: number;
  bad_rows?: string[];
  bytes_read: number;
}

/** Mirrors `sendingsettings.Settings` JSON tags. */
export interface SendingSettings {
  tenant_id?: string;
  /** Null / undefined => no rate limit. Backend column is per-HOUR. */
  max_sends_per_hour?: number | null;
  /** "HH:MM" — empty string clears the value. */
  quiet_hours_start?: string;
  quiet_hours_end?: string;
  /** IANA name (e.g. "America/New_York"). Empty string clears. */
  quiet_hours_tz?: string;
  /**
   * True means quiet hours are evaluated in each subscriber's timezone
   * when subscribers.timezone is present; false uses workspace timezone.
   */
  quiet_hours_per_recipient?: boolean;
  /**
   * Legacy, non-canonical fallback projection. The desktop discloses and
   * preserves it but does not offer an editor for it.
   */
  fallback_hour_utc?: number | null;
  /** Assigned sending IP pool. Absent when the tenant rides the shared
   *  default pool on an older API build. */
  ip_pool?: { name: string; dedicated: boolean };
  updated_by_user_id?: string | null;
  updated_at?: string | null;
}

/** Body shape for `putSendingSettings`. Mirrors the Go `putInput`. */
export interface SendingSettingsInput {
  max_sends_per_hour: number | null;
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_tz: string;
  quiet_hours_per_recipient: boolean;
  /** Empty string asserts that no prior row exists; omission is legacy LWW. */
  expected_updated_at?: string;
}

/**
 * Sending-status snapshot. Returned by `sendingSettingsApi.status()` —
 * combines configured policy, any qualified rate-limit counter evidence,
 * and the quiet-hours computation in one round-trip. Counter fields are
 * absent when the active limiter has no authoritative inspection contract.
 */
export interface SendingStatus {
  /** Exact workspace owner of this operational receipt. */
  tenant_id?: string;
  max_sends_per_hour?: number | null;
  quiet_hours_start?: string;
  quiet_hours_end?: string;
  quiet_hours_tz?: string;
  quiet_hours_per_recipient?: boolean;
  /** How many sends have been counted in the current 1-hour window. */
  bucket_count?: number | null;
  /** Wall-clock start of the current window. */
  window_start?: string | null;
  /** When the bucket counter resets to zero. */
  window_resets_at?: string | null;
  /**
   * Computed `is "now" inside the configured quiet-hours window?`.
   * Null when quiet hours aren't configured.
   */
  in_quiet_hours?: boolean | null;
  /** When the quiet-hours state will next flip (start or end). */
  quiet_changes_at?: string | null;
  /** True only when bucket_count represents the active shared limiter. */
  counter_authoritative?: boolean;
  counter_source?: string | null;
  counter_scope?: "shared" | "process" | "unavailable";
  /** State of the distributed authority used for send-time cap admission. */
  cap_coordination_state?: "ready" | "conservatively_fenced" | "unavailable";
  /** True only for an explicit ready state in the shared authority. */
  cap_coordination_ready?: boolean;
  /** Explicit capped value; null/absent represents a ready uncapped policy. */
  cap_coordination_cap?: number | null;
  /** True only when the shared capped/uncapped value equals this settings row. */
  cap_coordination_matches_settings?: boolean;
  /** Start of an active conservative mutation fence, when present. */
  cap_coordination_fence_started_at?: string | null;
}

/* ---------- methods ------------------------------------------------- */

const suppressionsApiCore = {
  /**
   * GET /api/v1/suppressions — paginated list with optional filters.
   */
  list(
    opts: {
      reason?: string;
      email?: string;
      page?: number;
      perPage?: number;
    } = {},
  ): Promise<ApiResult<SuppressionListResponse>> {
    const params = new URLSearchParams();
    if (opts.reason) params.set("reason", opts.reason);
    if (opts.email) params.set("email", opts.email);
    if (opts.page) params.set("page", String(opts.page));
    if (opts.perPage) params.set("per_page", String(opts.perPage));
    const qs = params.toString();
    return request<SuppressionListResponse>(
      `/api/v1/suppressions${qs ? `?${qs}` : ""}`,
    );
  },

  /** POST /api/v1/suppressions — single add. */
  add(input: {
    email: string;
    reason: string;
  }): Promise<ApiResult<SuppressionRow>> {
    return request<SuppressionRow>("/api/v1/suppressions", {
      method: "POST",
      body: JSON.stringify({ email: input.email, reason: input.reason }),
    });
  },

  /**
   * POST /api/v1/suppressions/bulk — many at once.
   *
   * The Go handler reads `{emails: string[], reason}` (single reason for
   * the whole batch). The public spec uses `{entries: [{email, reason}]}`
   * — we send BOTH so either side may be canonical (Go's json decoder
   * ignores unknown fields).
   *
   * Mixed-reason batches are GROUPED BY REASON and sent as one legacy
   * request per group (audit §4.3 L9): the old "dominant reason"
   * collapse silently rewrote minority reasons — a compliance-relevant
   * field — to whatever the majority happened to be. Per-group results
   * are merged; the first error (if any) is returned after all groups
   * have been attempted.
   */
  async bulkAdd(
    entries: Array<{ email: string; reason: string }>,
  ): Promise<ApiResult<SuppressionBulkResult>> {
    const groups = new Map<string, Array<{ email: string; reason: string }>>();
    for (const e of entries) {
      const reason = e.reason || "manual";
      const list = groups.get(reason);
      if (list) list.push(e);
      else groups.set(reason, [e]);
    }
    let added = 0;
    let imported: number | undefined;
    let skipped = 0;
    const errors: string[] = [];
    let anySucceeded = false;
    let firstError: ApiErr["error"] | null = null;
    for (const [reason, group] of groups) {
      const res = await request<SuppressionBulkResult>(
        "/api/v1/suppressions/bulk",
        {
          method: "POST",
          body: JSON.stringify({
            emails: group.map((e) => e.email),
            reason,
            entries: group,
          }),
        },
      );
      if (res.error) {
        if (!firstError) firstError = res.error;
        errors.push(
          `${reason} (${group.length} entr${group.length === 1 ? "y" : "ies"}): ${res.error.message}`,
        );
        continue;
      }
      anySucceeded = true;
      added += res.data?.added ?? 0;
      if (typeof res.data?.imported === "number") {
        imported = (imported ?? 0) + res.data.imported;
      }
      skipped += res.data?.skipped ?? 0;
      errors.push(...(res.data?.errors ?? []));
    }
    if (firstError && !anySucceeded) {
      return { error: firstError };
    }
    return {
      data: {
        added,
        ...(imported !== undefined ? { imported } : {}),
        skipped,
        errors,
      },
    };
  },

  /**
   * DELETE /api/v1/suppressions/{id} — un-suppress.
   */
  remove(id: string): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/suppressions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },

  /**
   * POST /api/v1/suppressions/import — multipart CSV upload.
   *
   * The Go handler accepts a `file` part (the CSV) and an optional
   * `default_reason` text field. Up to 25 MB. We build a FormData
   * here so the browser sets the multipart boundary correctly.
   */
  async importCsv(input: {
    file: File;
    defaultReason?: string;
  }): Promise<ApiResult<SuppressionImportResult>> {
    const form = new FormData();
    form.append("file", input.file);
    if (input.defaultReason) {
      form.append("default_reason", input.defaultReason);
    }
    // request() sets Content-Type to JSON by default; for multipart we
    // must let the browser pick the boundary. Pass `body` directly and
    // signal `multipart: true` so the helper skips JSON-stringification.
    return request<SuppressionImportResult>("/api/v1/suppressions/import", {
      method: "POST",
      body: form,
    });
  },

  /**
   * GET /api/v1/suppressions/export — direct download URL. Returned as
   * a string (not an ApiResult) so callers can drop it into an `<a
   * href>` and let the browser stream the response.
   */
  exportCsvUrl(opts: { reason?: string; ids?: string[] } = {}): string {
    const params = new URLSearchParams();
    if (opts.reason && opts.reason !== "all") {
      params.set("reason", opts.reason);
    }
    if (opts.ids && opts.ids.length > 0) {
      params.set("ids", opts.ids.join(","));
    }
    const qs = params.toString();
    return apiUrl(`/api/v1/suppressions/export${qs ? `?${qs}` : ""}`);
  },
};

async function putSendingSettingsOnce(
  input: SendingSettingsInput,
): Promise<ApiResult<SendingSettings>> {
  const result = await request<SendingSettings>(
    "/api/v1/settings/sending",
    {
      method: "PUT",
      body: JSON.stringify(input),
      // A followed 307/308 would replay the body beneath our one-attempt
      // retry budget. Native brokers already refuse redirects; make the
      // browser transport fail into reconciliation too.
      redirect: "error",
    },
    {
      requireOnline: true,
      maxAttempts: 1,
      idempotencyKey: null,
      allowStepUpRetry: false,
    },
  );
  if (result.error) {
    if (
      (result.error.status ?? 0) >= 400 &&
      result.responseMetadata?.sendingCapOutcome === "not-committed"
    ) {
      return result;
    }
    // An HTTP failure without exact not-committed proof may have been
    // generated or rewritten by a proxy after the upstream applied the PUT.
    // Convert it to the controller's reconciliation path instead of enabling
    // a manual repeat on the apparent 4xx status.
    if ((result.error.status ?? 0) > 0) {
      return {
        error: {
          kind: "parse",
          status: result.error.status,
          code: "sending_settings_mutation_unproven",
          message:
            "The server did not provide exact not-committed proof. Refresh authoritative settings and cap status before retrying.",
          requestId: result.error.requestId,
        },
        preservedDraft: input,
        ...(result.responseMetadata
          ? { responseMetadata: result.responseMetadata }
          : {}),
      };
    }
    return result;
  }
  if (
    result.responseMetadata?.status !== 200 ||
    result.responseMetadata.sendingCapOutcome !== "committed" ||
    !isFreshSendingSettingsMutationRevision(
      result.data?.updated_at,
      input.expected_updated_at,
    )
  ) {
    return {
      error: {
        kind: "parse",
        code: "sending_settings_mutation_unproven",
        message:
          "The server did not provide an exact committed sending-settings receipt with a fresh revision. Refresh authoritative settings and cap status before retrying.",
      },
      preservedDraft: input,
      ...(result.responseMetadata
        ? { responseMetadata: result.responseMetadata }
        : {}),
    };
  }
  return result;
}

function isFreshSendingSettingsMutationRevision(
  value: unknown,
  expected: string | undefined,
): value is string {
  if (typeof value !== "string" || value.startsWith("0001-01-01")) {
    return false;
  }
  const candidateNanos = rfc3339EpochNanoseconds(value);
  if (candidateNanos === null) return false;
  if (expected === undefined || expected === "") return true;
  const expectedNanos = rfc3339EpochNanoseconds(expected);
  return expectedNanos !== null && candidateNanos > expectedNanos;
}

export const sendingSettingsApi = {
  /**
   * GET /api/v1/settings/sending — single tenant row.
   *
   * The Go handler always returns 200; an unconfigured tenant comes back
   * as `{tenant_id, ...}` with the time/limit fields empty. We treat
   * "all fields empty" as "never configured" in the UI.
   */
  get(): Promise<ApiResult<SendingSettings>> {
    return request<SendingSettings>("/api/v1/settings/sending");
  },

  /** PUT /api/v1/settings/sending — full upsert. */
  put(input: SendingSettingsInput): Promise<ApiResult<SendingSettings>> {
    return putSendingSettingsOnce(input);
  },

  /**
   * "Clear" sending settings.
   *
   * The spec proposes DELETE /api/v1/settings/sending but the Go handler
   * does not mount it today. We emulate the clear by PUTting nulls/empties
   * — the upsert clears only this route's cap + quiet-hours scope. The server
   * preserves omitted legacy fallback fields.
   */
  clear(
    expectedUpdatedAt?: string | null,
  ): Promise<ApiResult<SendingSettings>> {
    const body: SendingSettingsInput = {
      max_sends_per_hour: null,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "",
      quiet_hours_per_recipient: true,
      ...(expectedUpdatedAt !== undefined
        ? { expected_updated_at: expectedUpdatedAt ?? "" }
        : {}),
    };
    return putSendingSettingsOnce(body);
  },

  /**
   * GET /api/v1/settings/sending/status — policy-aligned quiet-hours state and
   * counter evidence only when the server can qualify it. Cheap read (no
   * writes); safe to poll from the UI on a short interval.
   */
  status(): Promise<ApiResult<SendingStatus>> {
    return request<SendingStatus>("/api/v1/settings/sending/status");
  },
};

/**
 * Mirrors `customfields.Limits` JSON tags (SUB-015 — custom-field soft
 * limits + governance). Resolved per-tenant caps plus live usage counts
 * rendered as "used/max" bars by the Settings governance card.
 */
export interface CustomFieldLimits {
  /** Cap on the total number of custom fields the tenant may define. */
  max_custom_fields: number;
  /** Cap on how many of those fields may be marked searchable. */
  max_searchable_fields: number;
  /** Current count of defined custom fields. */
  used_custom_fields: number;
  /** Current count of searchable custom fields. */
  used_searchable_fields: number;
}

/**
 * Mirrors `customfields.UpdateLimitsInput` JSON tags. At least one cap
 * must be supplied; an omitted (undefined) cap is left unchanged. Both
 * must be non-negative — the handler returns 400 otherwise.
 */
export interface CustomFieldLimitsUpdateInput {
  max_custom_fields?: number;
  max_searchable_fields?: number;
}

export const customFieldSettingsApi = {
  /**
   * GET /api/v1/settings/custom-fields — resolved soft-limit caps + live
   * usage. Subscriber-read scoped; always 200 for a configured tenant.
   */
  get(): Promise<ApiResult<CustomFieldLimits>> {
    return request<CustomFieldLimits>("/api/v1/settings/custom-fields");
  },

  /**
   * PUT /api/v1/settings/custom-fields — admin-scoped override of the
   * per-tenant caps. Omitted caps stay unchanged; the handler returns the
   * refreshed limits + usage.
   */
  update(
    input: CustomFieldLimitsUpdateInput,
  ): Promise<ApiResult<CustomFieldLimits>> {
    return request<CustomFieldLimits>("/api/v1/settings/custom-fields", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
};

/**
 * SUB-072 — AI gateway / privacy firewall config. One field-sensitivity
 * flag (does this subscriber field get tokenized before a model call?).
 * Mirrors `pii_gateway.FieldSensitivity` JSON tags
 * (apps/api/internal/pii_gateway/sanitizer.go). `built_in` marks the
 * identifier pseudo-fields (email, phone) that are always sensitive and
 * cannot be toggled off; custom fields default OFF until flagged.
 */
export interface PIIFieldSensitivity {
  field_name: string;
  sensitive: boolean;
  built_in: boolean;
}

/**
 * SUB-072 — GET /api/v1/settings/pii-config response. `built_in_fields`
 * is the always-sensitive identifier set (email, phone); `fields` is the
 * tenant's persisted per-field flags (built-ins included, with built_in:true).
 */
export interface PIIConfigResponse {
  built_in_fields: string[];
  fields: PIIFieldSensitivity[];
}

/**
 * SUB-072 — one field-sensitivity flag in the PATCH
 * /api/v1/settings/pii-config batch. Mirrors `pii_gateway.UpdateFieldInput`;
 * `sensitive` is a tri-state on the wire (omit = leave unchanged), but the
 * UI always sends an explicit boolean.
 */
export interface PIIConfigUpdateField {
  field_name: string;
  sensitive: boolean;
}

/** SUB-072 — PATCH /api/v1/settings/pii-config body: a batch of flags. */
export interface PIIConfigUpdateInput {
  fields: PIIConfigUpdateField[];
}

export const piiConfigApi = {
  /**
   * GET /api/v1/settings/pii-config — the per-field PII-sensitivity flags
   * (which subscriber fields are tokenized before a model call). Subscriber-
   * read scoped. 503 with code "pii_gateway_unconfigured" when the gateway
   * isn't wired on the deployment — callers should hide the surface.
   */
  get(): Promise<ApiResult<PIIConfigResponse>> {
    return request<PIIConfigResponse>("/api/v1/settings/pii-config");
  },

  /**
   * PATCH /api/v1/settings/pii-config — admin-scoped batch upsert of
   * field-sensitivity flags. Returns the refreshed config (built-ins
   * included). Each entry flips one (tenant, field) flag.
   */
  update(input: PIIConfigUpdateInput): Promise<ApiResult<PIIConfigResponse>> {
    return request<PIIConfigResponse>("/api/v1/settings/pii-config", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
};

/**
 * SUB-021 — per-workspace auto-merge confidence threshold. Mirrors
 * `dedupeinfo.Settings` JSON tags (apps/api/internal/dedupeinfo/types.go).
 * `merge_confidence_threshold` is the minimum confidence a duplicate pair
 * must carry to be surfaced (and auto-merged) in the DuplicatesModal; it is
 * in [0,1]. When a workspace has never persisted a value the server returns
 * the historic default (0.95). The DuplicatesModal slider exposes the
 * narrower 0.80–1.00 operator band.
 */
export interface DeduplicationSettings {
  merge_confidence_threshold: number;
}

/** Mirrors `dedupeinfo.UpdateInput` — the PUT body. The threshold is
 * required and validated server-side to be in [0,1]. */
export interface DeduplicationSettingsUpdateInput {
  merge_confidence_threshold: number;
}

export const deduplicationSettingsApi = {
  /**
   * GET /api/v1/settings/deduplication — the workspace's persisted
   * auto-merge confidence threshold. Subscriber-read scoped. Returns the
   * historic default (0.95) for a workspace that has never set one.
   */
  get(): Promise<ApiResult<DeduplicationSettings>> {
    return request<DeduplicationSettings>("/api/v1/settings/deduplication");
  },

  /**
   * PUT /api/v1/settings/deduplication — admin-scoped upsert of the
   * per-workspace threshold. Returns the refreshed settings.
   */
  update(
    input: DeduplicationSettingsUpdateInput,
  ): Promise<ApiResult<DeduplicationSettings>> {
    return request<DeduplicationSettings>("/api/v1/settings/deduplication", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
};

/**
 * SUB-018 — per-tenant identifier normalization policy. Mirrors
 * `subscribers.IdentifierTransformConfig` JSON tags
 * (apps/api/internal/subscribers/types.go). Every optional transform
 * defaults OFF; an unconfigured tenant keeps the historic lowercase-only
 * behaviour. `phone_default_region` is an ISO 3166-1 alpha-2 region used
 * to interpret national-format phone numbers; empty means "no default
 * region" (only already-international "+…" numbers get formatted).
 */
export interface IdentifierTransformConfig {
  email_normalize_dots: boolean;
  email_normalize_plus: boolean;
  phone_e164_format: boolean;
  phone_default_region: string;
}

/**
 * PATCH body for /api/v1/settings/identifier-transforms. Mirrors
 * `subscribers.UpdateIdentifierTransformInput` — every field is optional
 * so a tenant can flip a single transform without re-sending the whole
 * config. Omitted fields keep their current server value.
 */
export interface IdentifierTransformUpdateInput {
  email_normalize_dots?: boolean;
  email_normalize_plus?: boolean;
  phone_e164_format?: boolean;
  phone_default_region?: string;
}

/** One phone field's before/after in a transform preview. Mirrors
 * `subscribers.PhonePreview`. */
export interface IdentifierTransformPhonePreview {
  key: string;
  input: string;
  output: string;
  changed: boolean;
}

/** Result of POST /api/v1/subscribers/preview-transforms. Mirrors
 * `subscribers.PreviewTransformResult` — the before/after the *currently
 * configured* (or `overrides`-supplied) transforms would apply, without
 * writing anything. */
export interface IdentifierTransformPreviewResult {
  config: IdentifierTransformConfig;
  email_input: string;
  email_output: string;
  email_changed: boolean;
  phones: IdentifierTransformPhonePreview[];
}

/** Body for POST /api/v1/subscribers/preview-transforms. `overrides`, when
 * present, previews an as-yet-unsaved config instead of the stored one. */
export interface IdentifierTransformPreviewInput {
  email?: string;
  merge_fields?: Record<string, unknown>;
  custom_fields?: Record<string, unknown>;
  overrides?: IdentifierTransformConfig;
}

/**
 * Known ISO 3166-1 alpha-2 regions the backend can resolve to an E.164
 * calling code (mirrors `subscribers.regionCallingCodes`). Used to populate
 * the phone-default-region picker so an operator can only pick a region the
 * server will actually accept (the PATCH 400s on an unknown region).
 */
export const IDENTIFIER_TRANSFORM_PHONE_REGIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "", label: "None (international numbers only)" },
  { value: "US", label: "United States (+1)" },
  { value: "CA", label: "Canada (+1)" },
  { value: "GB", label: "United Kingdom (+44)" },
  { value: "IE", label: "Ireland (+353)" },
  { value: "AU", label: "Australia (+61)" },
  { value: "NZ", label: "New Zealand (+64)" },
  { value: "DE", label: "Germany (+49)" },
  { value: "FR", label: "France (+33)" },
  { value: "ES", label: "Spain (+34)" },
  { value: "IT", label: "Italy (+39)" },
  { value: "NL", label: "Netherlands (+31)" },
  { value: "SE", label: "Sweden (+46)" },
  { value: "NO", label: "Norway (+47)" },
  { value: "DK", label: "Denmark (+45)" },
  { value: "FI", label: "Finland (+358)" },
  { value: "IN", label: "India (+91)" },
  { value: "SG", label: "Singapore (+65)" },
  { value: "JP", label: "Japan (+81)" },
  { value: "BR", label: "Brazil (+55)" },
  { value: "MX", label: "Mexico (+52)" },
  { value: "ZA", label: "South Africa (+27)" },
  { value: "AE", label: "United Arab Emirates (+971)" },
  { value: "CH", label: "Switzerland (+41)" },
  { value: "AT", label: "Austria (+43)" },
  { value: "BE", label: "Belgium (+32)" },
  { value: "PT", label: "Portugal (+351)" },
  { value: "PL", label: "Poland (+48)" },
  { value: "CZ", label: "Czechia (+420)" },
];

/**
 * SUB-018 — per-tenant identifier-transform settings + dry-run preview.
 *
 *   GET   /api/v1/settings/identifier-transforms   read the config (read scope)
 *   PATCH /api/v1/settings/identifier-transforms   set the config (admin scope)
 *   POST  /api/v1/subscribers/preview-transforms   dry-run a sample (read scope)
 */
export const identifierTransformsApi = {
  get(): Promise<ApiResult<IdentifierTransformConfig>> {
    return request<IdentifierTransformConfig>(
      "/api/v1/settings/identifier-transforms",
    );
  },
  /** Omitted fields keep their current value; the handler returns the
   * resolved config. Admin-scoped. */
  update(
    input: IdentifierTransformUpdateInput,
  ): Promise<ApiResult<IdentifierTransformConfig>> {
    return request<IdentifierTransformConfig>(
      "/api/v1/settings/identifier-transforms",
      { method: "PATCH", body: JSON.stringify(input) },
    );
  },
  /** Dry-run: shows what the configured (or `overrides`) transforms would do
   * to a sample identifier without writing. */
  preview(
    input: IdentifierTransformPreviewInput,
  ): Promise<ApiResult<IdentifierTransformPreviewResult>> {
    return request<IdentifierTransformPreviewResult>(
      "/api/v1/subscribers/preview-transforms",
      { method: "POST", body: JSON.stringify(input) },
    );
  },
};

/** Tenant-wide send-time-optimization toggle (GET/PUT). */
export interface SendTimeOptimizationSetting {
  enabled: boolean;
}

/** GET /api/v1/settings/send-time-optimization → {enabled}. */
export function getSendTimeOptimization(): Promise<
  ApiResult<SendTimeOptimizationSetting>
> {
  return request<SendTimeOptimizationSetting>(
    "/api/v1/settings/send-time-optimization",
  );
}

/** PUT /api/v1/settings/send-time-optimization — full upsert. */
export function putSendTimeOptimization(
  input: SendTimeOptimizationSetting,
): Promise<ApiResult<SendTimeOptimizationSetting>> {
  return request<SendTimeOptimizationSetting>(
    "/api/v1/settings/send-time-optimization",
    { method: "PUT", body: JSON.stringify(input) },
  );
}

/**
 * Canonical curated list of IANA timezones shared across the desktop
 * UI (Sending Settings quiet hours + Workspace profile timezone).
 *
 * Keep these in one place so the two selects can't drift in either
 * coverage or label format — previously the workspace list had 17
 * zones while Sending Settings only offered 12, with different
 * labels (raw IANA vs. "City (Region)").
 */
export const SENDING_TIMEZONES: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "Etc/UTC", label: "UTC" },
  { value: "America/Los_Angeles", label: "Los Angeles (Pacific)" },
  { value: "America/Denver", label: "Denver (Mountain)" },
  { value: "America/Chicago", label: "Chicago (Central)" },
  { value: "America/New_York", label: "New York (Eastern)" },
  { value: "America/Sao_Paulo", label: "São Paulo" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Berlin", label: "Berlin" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "Europe/Madrid", label: "Madrid" },
  { value: "Africa/Lagos", label: "Lagos" },
  { value: "Asia/Dubai", label: "Dubai" },
  { value: "Asia/Kolkata", label: "Kolkata" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Asia/Shanghai", label: "Shanghai" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Australia/Sydney", label: "Sydney" },
  { value: "Pacific/Auckland", label: "Auckland" },
];

/**
 * Reasons a row can be suppressed for. Mirrors the public spec enum and
 * the widened CHECK constraint on subscriber_suppressions (migration
 * 0512). The Add / Bulk-paste / Import-CSV dropdowns all read from this
 * list; the backend NormalizeReason() (suppressions/channel.go) maps the
 * legacy aliases ("complaint"→spam_complaint, "spam_trap"→spamtrap, …)
 * so any value here is accepted server-side.
 *
 * SUB-047 / SUB-048 added the delivery-issue taxonomy (soft_bounce,
 * list_unsub_header, spamtrap, role_account, dns_failure,
 * invalid_address) below the historical hand-set reasons.
 */
export const SUPPRESSION_REASONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "manual", label: "Manual" },
  { value: "hard_bounce", label: "Hard bounce" },
  { value: "soft_bounce", label: "Soft bounce" },
  { value: "complaint", label: "Complaint" },
  { value: "unsubscribe", label: "Unsubscribed" },
  { value: "list_unsub_header", label: "List-unsubscribe header" },
  { value: "spamtrap", label: "Spam trap" },
  { value: "role_account", label: "Role account" },
  { value: "dns_failure", label: "DNS failure" },
  { value: "invalid_address", label: "Invalid address" },
];

/* ---------- Discounts + Gift Subscriptions ---------------------- */

// Domain types and request construction live in api/monetization.ts.
// The method bag is folded into the one explicit facade composition below.
const monetizationImpl: DiscountsAndGiftsApi = createMonetizationApi(request);

/* ===== Auth UI — added by auth-ui agent ===== */
//
// Email-based auth surface (signup/login/magic-link/OAuth/password-reset/TOTP).
// All methods append `credentials: "include"` to the fetch so the
// `pw_session` cookie set by the backend is round-tripped on subsequent
// calls. The existing API-key path (`request` above) keeps its current
// shape — both auth modes coexist.
//
// Backend source-of-truth files (read these for any shape changes):
//   - apps/api/internal/auth/handlers.go        signup/login/logout/me
//   - apps/api/internal/auth/magiclink.go        magic-link/start + consume
//   - apps/api/internal/auth/password_reset.go   password-reset/start + confirm
//   - apps/api/internal/auth/oauth_handlers.go   /oauth/{provider}/start (302)
//   - apps/api/internal/auth/totp_handlers.go    enroll/verify/challenge/disable
//
// Notes for implementers:
//   * Login does NOT return 423 on TOTP-required — instead the backend
//     issues a session cookie unconditionally on password verify and
//     defers MFA to a session-scoped /totp/challenge step. Pages that
//     want a "pre-session" MFA gate should call /auth/me after login
//     and inspect the response's flags. The brief described 423 + an
//     mfa_token; the actual contract is "log in, then satisfy MFA on
//     the live session". See AuthLoginResult below.
//   * OAuth /start is a 302 redirect — there's no JSON envelope. The
//     desktop opens the URL directly in the user's browser via tauriApi.openUrl
//     and lets the browser ride the round-trip.
//   * Google is the only provider enabled for this release.
//   * Magic/reset email links carry the same signed v1 envelope used by the
//     web and mobile clients. Native desktop starts require local state; the
//     web landing page preserves the proof in a moosewave:// handoff.

/** /api/v1/auth/me success body. */
export interface AuthMeResponse {
  user_id: string;
  tenant_id: string;
  /** Durable, immutable account role from users.role. */
  email: string;
  role: string;
  auth_provider: string;
  email_verified: boolean;
  /**
   * SUB-091: the role THIS session should gate the UI on. Equals `role`
   * unless View-as-Viewer preview is active, in which case it's the
   * (down-only) preview role. useCanWrite / useCanAdmin read this.
   * Optional for forward-compat with servers that predate SUB-091.
   */
  effective_role?: string;
  /** SUB-091: true when this session has an active role_override. */
  viewer_mode?: boolean;
  /**
   * SUB-091: whether the durable role may activate the preview at all
   * (admin/owner only). The TopBar uses it to decide whether to render
   * the toggle.
   */
  can_use_viewer_mode?: boolean;
  workspace_name?: string;
  workspace_slug?: string;
  /**
   * True iff the calling user has an enrolled TOTP secret. Powers the
   * Security section's "Set up 2FA" vs "Disable 2FA" branch — pre-v2
   * the UI rendered both buttons always.
   */
  totp_enabled?: boolean;
  /** Tenant policy verdict. Optional only for compatibility with old servers. */
  mfa_required?: boolean;
  /** Current cookie-session state. Optional only for old-server compatibility. */
  mfa_satisfied?: boolean;
}

/**
 * SUB-091: PATCH /api/v1/auth/me/viewer-mode response. Echoes the
 * resulting state so the client can update its session context without a
 * follow-up /me round-trip.
 */
export interface ViewerModeResponse {
  viewer_mode: boolean;
  effective_role: string;
  /** The caller's durable role (unchanged by the toggle). */
  role: string;
}

/** /signup body. Backend requires workspace_name + workspace_slug too. */
export interface AuthSignupInput {
  email: string;
  password: string;
  workspace_name: string;
  workspace_slug: string;
}

/** /signup 201 body. */
export interface AuthSignupResponse {
  user_id: string;
  tenant_id: string;
  workspace_slug: string;
  email_verified: boolean;
}

/** /login body. workspace_id disambiguates multi-tenant emails. */
export interface AuthLoginInput {
  email: string;
  password: string;
  workspace_id?: string;
}

/**
 * Login response is a discriminated union:
 *   - { ok: true, user_id, tenant_id }       — session cookie set
 *   - { needs_workspace: true, workspaces }  — caller must re-submit with workspace_id
 */
export interface AuthLoginOk {
  ok: true;
  user_id: string;
  tenant_id: string;
}

export interface AuthLoginNeedsWorkspace {
  needs_workspace: true;
  workspaces: Array<{ tenant_id: string; email: string }>;
}

export type AuthLoginResult = AuthLoginOk | AuthLoginNeedsWorkspace;

/**
 * Public half of the RFC 8628 device grant. `device_code` is a bearer secret:
 * callers must keep the response in memory and must never render or persist it.
 */
export interface AuthDeviceSessionStartResponse {
  device_code: string;
  user_code: string;
  grant_kind: "session";
  remember: false;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** Terminal device-token response. The session itself is in pw_session. */
export interface AuthDeviceSessionTokenResponse {
  grant_kind: "session";
  session: true;
  confirmation_required: true;
  confirmation_expires_in: number;
  remember: false;
  tenant_id: string;
  email: string;
  expires_in: number;
}

/** Activates the exact provisional session bound to the memory-held code. */
export interface AuthDeviceSessionConfirmResponse {
  grant_kind: "session";
  session: true;
  confirmed: true;
  confirmation_required: false;
  remember: false;
  tenant_id: string;
  email: string;
  expires_in: number;
}

export interface AuthDeviceIdentity {
  device_label: string;
  device_type: "desktop" | "mobile" | "tablet" | "cli" | "bot" | "unknown";
  device_os?: string;
  device_client?: string;
}

/** Trusted, server-derived disclosure shown before a device grant mutates. */
export interface AuthDeviceGrantDisclosure {
  grant_kind: "session" | "api_key";
  account: {
    email: string;
    workspace_name?: string;
    workspace_slug?: string;
  };
  device: AuthDeviceIdentity;
  expires_in: number;
  remember: boolean;
  scopes?: string[];
  requires_mfa?: boolean;
  /**
   * Opaque, one-review consent proof. Present only when inspecting a session
   * grant; callers must keep it in component memory and echo it unchanged.
   */
  consent_token?: string;
  ok?: true;
}

/** /totp/enroll response (one-time payload). */
/**
 * One signed-in session. `current` marks the session making the request, which
 * the UI pins and refuses to revoke — killing your own session from a list is
 * indistinguishable from the app crashing.
 */
export interface AuthSessionInfo {
  id: string;
  issued_at: string;
  last_seen_at: string;
  expires_at: string;
  ip?: string;
  user_agent?: string;
  auth_method: string;
  current: boolean;
  // Server-derived labels, rendered verbatim rather than re-parsed: three
  // clients hand-rolling a fourth user-agent parser is how one device ends up
  // with three different names.
  device_label?: string;
  device_type?: string;
  device_os?: string;
}

/** A device allowed to SKIP MFA — a standing second-factor bypass. */
export interface AuthTrustedDevice {
  id: string;
  created_at: string;
  last_used_at?: string;
  expires_at?: string;
  device_label?: string;
  device_type?: string;
  device_os?: string;
}

/**
 * `allowed` is the workspace POLICY. When false, existing trusted devices are
 * still listed: a user must be able to see and revoke a bypass that policy has
 * since forbidden, and hiding the list would strand it.
 */
export interface AuthTrustedDevicesResponse {
  // `trusted_devices`, NOT `devices`. The server's key is
  // trustedDevicesResponse.TrustedDevices in
  // apps/api/internal/auth/device_trust_handlers.go. Guessing `devices` made
  // every card render "No trusted devices" for a user who had three standing
  // MFA bypasses — the exact failure this work existed to fix, one layer up.
  trusted_devices: AuthTrustedDevice[];
  allowed?: boolean;
}

/** A passkey that can sign in as this user. */
export interface AuthPasskeyCredential {
  id: string;
  name?: string;
  created_at: string;
  last_used_at?: string;
}

export interface AuthTotpEnrollResponse {
  otpauth_uri: string;
  recovery_codes: string[];
}

/** /oauth/{provider}/start success — actual response is a 302. */
export type AuthOAuthProvider = "google";

/** Local-storage flag indicating "we have an active session cookie". */
const LS_SESSION_USER = "postwave_session_user";

/** Persist a small "we're signed in" hint so boot can check synchronously.
 *
 * Storage selection (desktop audit MED #4): when running inside
 * Tauri, write to sessionStorage instead of localStorage. The
 * sessionStorage is per-window and wiped when the window closes,
 * which is the right scope for a "currently signed in" hint — the
 * boot-time check still works (re-opening the window initiates a
 * fresh auth flow). localStorage in Tauri lives on disk in
 * ~/Library/Application Support/com.moosewave.desktop and is
 * world-readable by any process running as the same OS user.
 *
 * Web (non-Tauri) builds keep localStorage because closing/
 * reopening the browser tab is a normal navigation pattern that
 * shouldn't log the user out. */
export function rememberSession(me: AuthMeResponse | null): void {
  const previous = getRememberedSession();
  if (
    previous?.user_id !== (me?.user_id ?? undefined) ||
    previous?.tenant_id !== (me?.tenant_id ?? undefined) ||
    previous?.role !== (me?.role ?? undefined) ||
    previous?.effective_role !==
      (me ? (me.effective_role ?? me.role) : undefined)
  ) {
    invalidateStreamTokenCache();
  }
  try {
    const store = isTauri() ? window.sessionStorage : window.localStorage;
    if (me) {
      const payload = JSON.stringify({
        user_id: me.user_id,
        tenant_id: me.tenant_id,
        role: me.role,
        effective_role: me.effective_role ?? me.role,
        auth_provider: me.auth_provider,
      });
      if (storageByteLength(payload) <= MAX_SESSION_HINT_BYTES) {
        store.setItem(LS_SESSION_USER, payload);
      }
      // Defensive: wipe any prior localStorage copy from a build
      // before this fix landed.
      if (isTauri()) {
        try {
          window.localStorage.removeItem(LS_SESSION_USER);
        } catch {
          /* ignore */
        }
      }
    } else {
      store.removeItem(LS_SESSION_USER);
      // Belt + suspenders: clear both stores on logout so a stale
      // copy from a previous build can't survive.
      try {
        window.localStorage.removeItem(LS_SESSION_USER);
      } catch {
        /* ignore */
      }
      try {
        window.sessionStorage.removeItem(LS_SESSION_USER);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  // The session hint IS the identity signal for the offline queue —
  // rescope it whenever the hint changes (sign-in, workspace switch,
  // sign-out).
  void syncOfflineIdentity();
}

/** Read the persisted session hint. NULL means no cached signal.
 *
 * Reads sessionStorage first (current Tauri location), then falls
 * back to localStorage (web + legacy desktop builds). */
export function getRememberedSession(): {
  user_id: string;
  tenant_id: string;
  role: string;
  effective_role: string;
  auth_provider: string;
} | null {
  try {
    let raw: string | null = null;
    let sourceStore: Storage | null = null;
    if (isTauri()) {
      try {
        raw = window.sessionStorage.getItem(LS_SESSION_USER);
        if (raw !== null) sourceStore = window.sessionStorage;
      } catch {
        /* ignore */
      }
    }
    if (raw === null) {
      raw = window.localStorage.getItem(LS_SESSION_USER);
      if (raw !== null) sourceStore = window.localStorage;
    }
    if (!raw) return null;
    if (storageByteLength(raw) > MAX_SESSION_HINT_BYTES) {
      // Remove the oversized value from the storage it was actually
      // read from — removing it from the wrong store left the guard
      // re-tripping on every read (audit §4.3 L11).
      try {
        sourceStore?.removeItem(LS_SESSION_USER);
      } catch {
        /* ignore */
      }
      return null;
    }
    const j = JSON.parse(raw) as Record<string, unknown>;
    const userID = boundedSessionHintString(j.user_id);
    const tenantID = boundedSessionHintString(j.tenant_id);
    if (userID && tenantID) {
      return {
        user_id: userID,
        tenant_id: tenantID,
        role: boundedSessionHintString(j.role) ?? "",
        effective_role:
          boundedSessionHintString(j.effective_role) ??
          boundedSessionHintString(j.role) ??
          "",
        auth_provider: boundedSessionHintString(j.auth_provider) ?? "unknown",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Auth-flavored `request`: includes credentials so the pw_session cookie
 * is sent + received. We DON'T copy the API-key Bearer header here on
 * purpose — these endpoints rely on cookie auth. The shared `request`
 * helper above is for API-key calls; this one is for session calls.
 */
async function authRequest<T>(
  path: string,
  init: RequestInit = {},
  callerSignal?: AbortSignal,
): Promise<ApiResult<T>> {
  const identityGeneration = captureApiIdentityGeneration();
  if (identityGeneration === null) {
    return apiIdentityTransitionError("identity_transition");
  }
  const url = apiUrl(path);
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const externalSignal = callerSignal ?? init.signal ?? null;
  const requestSignal = externalSignal
    ? AbortSignal.any([ctrl.signal, externalSignal])
    : ctrl.signal;
  // These are pure cookie-auth POSTs (login, password-reset, …) from the
  // tauri://localhost origin — exactly the case the server's Origin/CSRF
  // gate trusts only when X-Postwave-Client identifies a native client.
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...NATIVE_CLIENT_HEADERS,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.headers) {
    for (const [k, v] of Object.entries(
      init.headers as Record<string, string>,
    )) {
      headers[k] = v;
    }
  }
  try {
    const requestInit: RequestInit = {
      ...init,
      headers,
      mode: "cors",
      credentials: "include",
      signal: apiIdentitySignal(requestSignal),
      cache: "no-store",
    };
    // Packaged WebViews have a tauri:// origin, so browser CORS/SameSite
    // policy cannot safely own API cookies. Rust retains Set-Cookie and sends
    // Cookie for the configured origin without ever exposing pw_session here.
    const nativeResponse = await tauriApi.fetchWithSessionBroker(url, {
      ...requestInit,
      __postwaveTimeoutMs: TIMEOUT_MS,
    } as RequestInit);
    // In a packaged shell, falling back to WebView fetch would silently lose
    // HttpOnly Set-Cookie on the tauri:// origin. Treat an unavailable/mismatched
    // native binding as a transport failure instead of reporting a false login.
    if (isTauri() && !nativeResponse) {
      throw new Error(
        "Native session transport is unavailable for this API origin.",
      );
    }
    const res = nativeResponse ?? (await fetch(url, requestInit));
    if (!apiIdentityGenerationIsCurrent(identityGeneration))
      return apiIdentityTransitionError("identity_changed");
    // Any HTTP response (incl. the expected 401 on a cold-boot /me
    // probe) proves the link is alive — feed the online-manager.
    noteRequestSuccess();
    observeContextEpoch(res.headers.get(CONTEXT_EPOCH_HEADER));
    if (res.status === 204) {
      return { data: undefined as unknown as T };
    }
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      let code: string | undefined;
      try {
        const text = await readTextLimited(res, MAX_API_RESPONSE_TEXT_BYTES);
        if (!apiIdentityGenerationIsCurrent(identityGeneration)) {
          return apiIdentityTransitionError("identity_changed");
        }
        if (text) {
          try {
            const j = JSON.parse(text) as {
              error?: { code?: string; message?: string };
              message?: string;
            };
            if (j && typeof j === "object") {
              message = j.error?.message || j.message || message;
              code = j.error?.code;
            }
          } catch {
            message = text.slice(0, 200);
          }
        }
      } catch {
        /* ignore */
      }
      // Stuff the error code into the message-status object so callers
      // can branch on `weak_password` / `invalid_credentials` etc.
      // kind:"http" + status let downstream classification (W3's
      // detectSession) distinguish a server verdict from a transport
      // failure (audit §4.3 L6).
      return {
        error: {
          kind: "http",
          message: code ? `${code}: ${message}` : message,
          status: res.status,
          ...(code ? { code } : {}),
        },
      };
    }
    // Some endpoints (logout, totp/disable) return 204 — handled above.
    // Others return JSON.
    const text = await readTextLimited(res, MAX_API_RESPONSE_TEXT_BYTES);
    if (!apiIdentityGenerationIsCurrent(identityGeneration)) {
      return apiIdentityTransitionError("identity_changed");
    }
    if (!text) return { data: undefined as unknown as T };
    try {
      return { data: JSON.parse(text) as T };
    } catch {
      return {
        error: {
          kind: "parse",
          message: "API returned invalid JSON. Please refresh and try again.",
        },
      };
    }
  } catch (err) {
    if (!apiIdentityGenerationIsCurrent(identityGeneration)) {
      return apiIdentityTransitionError("identity_changed");
    }
    if (err instanceof ApiBodyTooLargeError) {
      return {
        error: {
          kind: "parse",
          code: "response_too_large",
          message: "API response was too large. Please refresh and try again.",
        },
      };
    }
    // A user leaving the device-login screen intentionally aborts its public
    // poll. That is terminal for the flow, but it is not evidence that the API
    // is offline and must not perturb the global connectivity indicator.
    if (externalSignal?.aborted) {
      return {
        error: {
          kind: "network",
          code: "aborted",
          message: "Request was cancelled.",
        },
        retryability: "not-retryable",
      };
    }
    // Transport-level failure — distinguish timeout from network so
    // "invalid credentials" can never be confused with "server
    // unreachable" downstream (audit §4.3 L6).
    noteRequestFailure();
    if (err instanceof Error && err.name === "AbortError") {
      return {
        error: {
          kind: "timeout",
          code: "request_timeout",
          message: "Request timed out",
        },
      };
    }
    return { error: transportError(err) };
  } finally {
    window.clearTimeout(timer);
  }
}

export interface AuthApi {
  /** GET /api/v1/auth/me — returns the live session projection. */
  getAuthMe(signal?: AbortSignal): Promise<ApiResult<AuthMeResponse>>;

  /** POST /api/v1/auth/signup — creates tenant + user, sets session cookie. */
  signup(input: AuthSignupInput): Promise<ApiResult<AuthSignupResponse>>;

  /**
   * POST /api/v1/auth/login — validates password, sets session cookie.
   * On multi-tenant emails the response is `{needs_workspace, workspaces}`
   * and the caller MUST re-call with `workspace_id` set.
   */
  login(input: AuthLoginInput): Promise<ApiResult<AuthLoginResult>>;

  /**
   * Start an RFC 8628 grant that can only produce a short-lived session.
   * The returned device_code is a bearer secret and must remain in memory.
   */
  startDeviceSessionGrant(
    signal?: AbortSignal,
  ): Promise<ApiResult<AuthDeviceSessionStartResponse>>;

  /** Poll the public token endpoint at the interval returned by start. */
  pollDeviceSessionGrant(
    deviceCode: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<AuthDeviceSessionTokenResponse>>;

  /** Acknowledge receipt before the provisional session becomes usable. */
  confirmDeviceSessionGrant(
    deviceCode: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<AuthDeviceSessionConfirmResponse>>;

  /** Best-effort capability cancellation when the target abandons the flow. */
  cancelDeviceSessionGrant(
    deviceCode: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<{ ok: true; grant_kind: "session" }>>;

  /** Read-only disclosure for a user-entered approval code. */
  inspectDeviceGrant(
    userCode: string,
  ): Promise<ApiResult<AuthDeviceGrantDisclosure>>;

  /** Approve only after the caller has rendered the inspect disclosure. */
  approveDeviceGrant(
    userCode: string,
    consentToken?: string,
  ): Promise<ApiResult<AuthDeviceGrantDisclosure & { ok: true }>>;

  /** Explicitly deny a pending grant so its target stops polling. */
  denyDeviceGrant(
    userCode: string,
    consentToken?: string,
  ): Promise<ApiResult<AuthDeviceGrantDisclosure & { ok: true }>>;

  /** POST /api/v1/auth/logout — clears server session + cookie. 204. */
  logoutSession(): Promise<ApiResult<void>>;

  /** POST /api/v1/auth/magic-link/start — always 202 (no enumeration). */
  magicLinkStart(
    email: string,
    state: string,
  ): Promise<ApiResult<{ sent: boolean }>>;

  /** POST /api/v1/auth/magic-link/consume — sets session cookie. */
  magicLinkConsume(
    proof: DesktopAuthLinkProof,
  ): Promise<ApiResult<{ user_id: string; tenant_id: string }>>;

  /** POST /api/v1/auth/password-reset/start — always 202. */
  passwordResetStart(
    email: string,
    state: string,
  ): Promise<ApiResult<{ sent: boolean }>>;

  /** POST /api/v1/auth/password-reset/confirm — token + new password. */
  passwordResetConfirm(
    proof: DesktopAuthLinkProof,
    newPassword: string,
  ): Promise<ApiResult<{ reset: boolean }>>;

  /**
   * Returns the URL the desktop should open in the user's external
   * browser to start an OAuth flow. We DON'T fetch /start ourselves —
   * the backend returns a 302 directly to the IdP, and following 302s
   * inside the desktop's webview would lose the session cookie.
   */
  oauthStartUrl(provider: AuthOAuthProvider, redirectTo?: string): string;

  /**
   * Best-effort probe: HEADs /start with CORS to detect whether the
   * provider is configured. 404 ⇒ disabled. We don't follow the redirect.
   */
  oauthIsAvailable(provider: AuthOAuthProvider): Promise<boolean>;

  /** POST /api/v1/auth/totp/enroll — returns secret URI + recovery codes. */
  totpEnroll(): Promise<ApiResult<AuthTotpEnrollResponse>>;

  /**
   * POST /api/v1/auth/totp/verify — first-time confirmation; flips the
   * session's mfa_satisfied. Body: {code}.
   */
  totpVerify(
    code: string,
  ): Promise<ApiResult<{ verified: boolean; mfa_satisfied: boolean }>>;

  /**
   * POST /api/v1/auth/totp/challenge — per-session step-up. Body:
   * {code} XOR {recovery_code}.
   */
  totpChallenge(input: {
    code?: string;
    recovery_code?: string;
  }): Promise<ApiResult<{ mfa_satisfied: boolean; already?: boolean }>>;

  /** DELETE /api/v1/auth/totp — wipes enrollment. 204. */
  totpDisable(): Promise<ApiResult<void>>;

  // --- account security -----------------------------------------------------
  // Sessions, trusted devices and passkey management. Every one of these
  // endpoints was already mounted and manifested with no desktop consumer;
  // scripts/check-identity-surface-parity.mjs now fails the build if that
  // recurs. Passkey ENROLLMENT is deliberately absent — see the implementation.
  /** GET /api/v1/auth/sessions — where this account is signed in. */
  listSessions(): Promise<ApiResult<{ sessions: AuthSessionInfo[] }>>;
  /** DELETE /api/v1/auth/sessions/{id} — end one session. */
  revokeSession(id: string): Promise<ApiResult<{ revoked?: boolean }>>;
  /** POST /api/v1/auth/sessions/logout-all — end every OTHER session. */
  logoutAllOtherSessions(): Promise<ApiResult<{ revoked_count: number }>>;
  /** GET /api/v1/auth/trusted-devices — the standing MFA bypasses. */
  listTrustedDevices(): Promise<ApiResult<AuthTrustedDevicesResponse>>;
  /** DELETE /api/v1/auth/trusted-devices/{id} */
  revokeTrustedDevice(id: string): Promise<ApiResult<{ revoked?: boolean }>>;
  /** POST /api/v1/auth/trusted-devices/revoke-all */
  revokeAllTrustedDevices(): Promise<ApiResult<{ revoked_count: number }>>;
  /** GET /api/v1/auth/webauthn/credentials — passkeys that can sign in as you. */
  // `items` is the server's envelope key (webauthn_handlers.go).
  listPasskeys(): Promise<ApiResult<{ items: AuthPasskeyCredential[] }>>;
  /** PATCH /api/v1/auth/webauthn/credentials/{id} */
  renamePasskey(id: string, name: string): Promise<ApiResult<void>>;
  /** DELETE /api/v1/auth/webauthn/credentials/{id} */
  deletePasskey(id: string): Promise<ApiResult<void>>;

  /**
   * SUB-091: PATCH /api/v1/auth/me/viewer-mode — toggle the per-session
   * View-as-Viewer preview. Admin/owner only (server enforces). When
   * `enabled` is true the session gates on a down-only preview role
   * (default "viewer"); when false the override is cleared.
   */
  setViewerMode(input: {
    enabled: boolean;
    role?: string;
  }): Promise<ApiResult<ViewerModeResponse>>;
}

const authImpl: AuthApi = {
  getAuthMe(signal?: AbortSignal): Promise<ApiResult<AuthMeResponse>> {
    return authRequest<AuthMeResponse>("/api/v1/auth/me", {}, signal);
  },
  signup(input: AuthSignupInput): Promise<ApiResult<AuthSignupResponse>> {
    return authRequest<AuthSignupResponse>("/api/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  async login(input: AuthLoginInput): Promise<ApiResult<AuthLoginResult>> {
    const res = await authRequest<{
      user_id?: string;
      tenant_id?: string;
      needs_workspace?: boolean;
      workspaces?: Array<{ tenant_id: string; email: string }>;
    }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (res.error) return res;
    const j = res.data;
    if (j && j.needs_workspace && Array.isArray(j.workspaces)) {
      return {
        data: {
          needs_workspace: true,
          workspaces: j.workspaces,
        } as AuthLoginNeedsWorkspace,
      };
    }
    if (j && typeof j.user_id === "string" && typeof j.tenant_id === "string") {
      return {
        data: {
          ok: true,
          user_id: j.user_id,
          tenant_id: j.tenant_id,
        } as AuthLoginOk,
      };
    }
    return { error: { message: "unexpected login response" } };
  },
  startDeviceSessionGrant(
    signal?: AbortSignal,
  ): Promise<ApiResult<AuthDeviceSessionStartResponse>> {
    return authRequest<AuthDeviceSessionStartResponse>(
      "/api/v1/auth/cli/device/start",
      {
        method: "POST",
        body: JSON.stringify({ grant_kind: "session", remember: false }),
      },
      signal,
    );
  },
  pollDeviceSessionGrant(
    deviceCode: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<AuthDeviceSessionTokenResponse>> {
    return authRequest<AuthDeviceSessionTokenResponse>(
      "/api/v1/auth/cli/device/token",
      {
        method: "POST",
        body: JSON.stringify({ device_code: deviceCode }),
      },
      signal,
    );
  },
  confirmDeviceSessionGrant(
    deviceCode: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<AuthDeviceSessionConfirmResponse>> {
    return authRequest<AuthDeviceSessionConfirmResponse>(
      "/api/v1/auth/cli/device/token",
      {
        method: "POST",
        body: JSON.stringify({ device_code: deviceCode, action: "confirm" }),
      },
      signal,
    );
  },
  cancelDeviceSessionGrant(
    deviceCode: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<{ ok: true; grant_kind: "session" }>> {
    return authRequest<{ ok: true; grant_kind: "session" }>(
      "/api/v1/auth/cli/device/token",
      {
        method: "POST",
        body: JSON.stringify({ device_code: deviceCode, action: "cancel" }),
      },
      signal,
    );
  },
  inspectDeviceGrant(
    userCode: string,
  ): Promise<ApiResult<AuthDeviceGrantDisclosure>> {
    return authRequest<AuthDeviceGrantDisclosure>(
      "/api/v1/auth/cli/device/approve",
      {
        method: "POST",
        body: JSON.stringify({ user_code: userCode, action: "inspect" }),
      },
    );
  },
  approveDeviceGrant(
    userCode: string,
    consentToken?: string,
  ): Promise<ApiResult<AuthDeviceGrantDisclosure & { ok: true }>> {
    return authRequest<AuthDeviceGrantDisclosure & { ok: true }>(
      "/api/v1/auth/cli/device/approve",
      {
        method: "POST",
        body: JSON.stringify({
          user_code: userCode,
          action: "approve",
          ...(consentToken ? { consent_token: consentToken } : {}),
        }),
      },
    );
  },
  denyDeviceGrant(
    userCode: string,
    consentToken?: string,
  ): Promise<ApiResult<AuthDeviceGrantDisclosure & { ok: true }>> {
    return authRequest<AuthDeviceGrantDisclosure & { ok: true }>(
      "/api/v1/auth/cli/device/approve",
      {
        method: "POST",
        body: JSON.stringify({
          user_code: userCode,
          action: "deny",
          ...(consentToken ? { consent_token: consentToken } : {}),
        }),
      },
    );
  },
  async logoutSession(): Promise<ApiResult<void>> {
    const result = await authRequest<void>("/api/v1/auth/logout", {
      method: "POST",
    });
    // Local sign-out must remain authoritative even when the server is
    // unreachable. Rust clears the active pw_session without revealing it;
    // the server-side row can still be revoked from another signed-in device.
    if (isTauri()) {
      try {
        await tauriApi.clearSessionBroker();
      } catch {
        /* the caller still receives the original logout result */
      }
    }
    return result;
  },
  magicLinkStart(
    email: string,
    state: string,
  ): Promise<ApiResult<{ sent: boolean }>> {
    return authRequest<{ sent: boolean }>("/api/v1/auth/magic-link/start", {
      method: "POST",
      body: JSON.stringify({ email, ...desktopAuthLinkStart(state) }),
    });
  },
  magicLinkConsume(
    proof: DesktopAuthLinkProof,
  ): Promise<ApiResult<{ user_id: string; tenant_id: string }>> {
    return authRequest<{ user_id: string; tenant_id: string }>(
      "/api/v1/auth/magic-link/consume",
      { method: "POST", body: JSON.stringify(proof) },
    );
  },
  passwordResetStart(
    email: string,
    state: string,
  ): Promise<ApiResult<{ sent: boolean }>> {
    return authRequest<{ sent: boolean }>("/api/v1/auth/password-reset/start", {
      method: "POST",
      body: JSON.stringify({ email, ...desktopAuthLinkStart(state) }),
    });
  },
  passwordResetConfirm(
    proof: DesktopAuthLinkProof,
    newPassword: string,
  ): Promise<ApiResult<{ reset: boolean }>> {
    return authRequest<{ reset: boolean }>(
      "/api/v1/auth/password-reset/confirm",
      {
        method: "POST",
        body: JSON.stringify({ ...proof, new_password: newPassword }),
      },
    );
  },
  oauthStartUrl(provider: AuthOAuthProvider, redirectTo?: string): string {
    const params = new URLSearchParams();
    const safeRedirectTo = safeOAuthRedirectTo(redirectTo);
    if (safeRedirectTo) params.set("redirect_to", safeRedirectTo);
    const qs = params.toString();
    return apiUrl(
      `/api/v1/auth/oauth/${encodeURIComponent(provider)}/start${
        qs ? `?${qs}` : ""
      }`,
    );
  },
  async oauthIsAvailable(provider: AuthOAuthProvider): Promise<boolean> {
    // We can't HEAD the /start endpoint cleanly because it 302s to the
    // IdP. Instead we GET it with `redirect: "manual"` and `mode: "cors"`
    // — a "provider_disabled" 404 from our backend has a JSON body, while
    // a configured provider returns an opaque-redirect (status 0).
    return probeOAuthAvailability(
      apiUrl(`/api/v1/auth/oauth/${encodeURIComponent(provider)}/start`),
    );
  },
  totpEnroll(): Promise<ApiResult<AuthTotpEnrollResponse>> {
    return authRequest<AuthTotpEnrollResponse>("/api/v1/auth/totp/enroll", {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  totpVerify(
    code: string,
  ): Promise<ApiResult<{ verified: boolean; mfa_satisfied: boolean }>> {
    return authRequest<{ verified: boolean; mfa_satisfied: boolean }>(
      "/api/v1/auth/totp/verify",
      { method: "POST", body: JSON.stringify({ code }) },
    );
  },
  totpChallenge(input: {
    code?: string;
    recovery_code?: string;
  }): Promise<ApiResult<{ mfa_satisfied: boolean; already?: boolean }>> {
    const body: Record<string, string> = {};
    if (input.code) body.code = input.code;
    if (input.recovery_code) body.recovery_code = input.recovery_code;
    return authRequest<{ mfa_satisfied: boolean; already?: boolean }>(
      "/api/v1/auth/totp/challenge",
      { method: "POST", body: JSON.stringify(body) },
    );
  },
  totpDisable(): Promise<ApiResult<void>> {
    return authRequest<void>("/api/v1/auth/totp", { method: "DELETE" });
  },

  // --- account security -----------------------------------------------------
  //
  // Sessions, trusted devices and passkey credentials. All three endpoints have
  // been mounted, manifested and in the OpenAPI spec for a long time, and
  // desktop called NONE of them: a desktop user could not see where they were
  // signed in, could not end a session from a lost machine, could not audit the
  // devices allowed to skip their MFA, and could not remove a passkey.
  //
  // Guarded by scripts/check-identity-surface-parity.mjs so the gap cannot
  // silently reopen — an endpoint no client calls is indistinguishable from one
  // that does not exist.
  listSessions(): Promise<ApiResult<{ sessions: AuthSessionInfo[] }>> {
    return authRequest<{ sessions: AuthSessionInfo[] }>(
      "/api/v1/auth/sessions",
    );
  },
  revokeSession(id: string): Promise<ApiResult<{ revoked?: boolean }>> {
    return authRequest<{ revoked?: boolean }>(
      `/api/v1/auth/sessions/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
  logoutAllOtherSessions(): Promise<ApiResult<{ revoked_count: number }>> {
    return authRequest<{ revoked_count: number }>(
      "/api/v1/auth/sessions/logout-all",
      { method: "POST", body: JSON.stringify({}) },
    );
  },
  listTrustedDevices(): Promise<ApiResult<AuthTrustedDevicesResponse>> {
    return authRequest<AuthTrustedDevicesResponse>(
      "/api/v1/auth/trusted-devices",
    );
  },
  revokeTrustedDevice(id: string): Promise<ApiResult<{ revoked?: boolean }>> {
    return authRequest<{ revoked?: boolean }>(
      `/api/v1/auth/trusted-devices/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
  revokeAllTrustedDevices(): Promise<ApiResult<{ revoked_count: number }>> {
    return authRequest<{ revoked_count: number }>(
      "/api/v1/auth/trusted-devices/revoke-all",
      { method: "POST", body: JSON.stringify({}) },
    );
  },
  // Passkey MANAGEMENT only. Enrollment cannot happen here: the API's RPOrigins
  // is a single entry derived from POSTWAVE_PUBLIC_BASE_URL and this webview's
  // origin is tauri://localhost, so a ceremony started here cannot validate.
  // Adding that origin would let any locally-running application complete a
  // ceremony for a Moosewave account — strictly worse than linking out.
  listPasskeys(): Promise<ApiResult<{ items: AuthPasskeyCredential[] }>> {
    return authRequest<{ items: AuthPasskeyCredential[] }>(
      "/api/v1/auth/webauthn/credentials",
    );
  },
  renamePasskey(id: string, name: string): Promise<ApiResult<void>> {
    return authRequest<void>(
      `/api/v1/auth/webauthn/credentials/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
    );
  },
  deletePasskey(id: string): Promise<ApiResult<void>> {
    return authRequest<void>(
      `/api/v1/auth/webauthn/credentials/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
  setViewerMode(input: {
    enabled: boolean;
    role?: string;
  }): Promise<ApiResult<ViewerModeResponse>> {
    const body: { enabled: boolean; role?: string } = {
      enabled: input.enabled,
    };
    if (input.role) body.role = input.role;
    return authRequest<ViewerModeResponse>("/api/v1/auth/me/viewer-mode", {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  },
};

export function safeOAuthRedirectTo(value?: string): string | undefined {
  if (!value) return undefined;
  if (storageByteLength(value) > MAX_OAUTH_REDIRECT_TO_BYTES) return undefined;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "postwave:" ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return undefined;
    }
    if (url.hostname.toLowerCase() !== "auth") return undefined;
    const action = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    if (action !== "magic" && action !== "oauth-return") return undefined;
    const state = safeOAuthReturnState(url.searchParams.getAll("state"));
    if (state === null) return undefined;
    const normalized = new URL(`moosewave://auth/${action}`);
    if (state) normalized.searchParams.set("state", state);
    return normalized.toString();
  } catch {
    return undefined;
  }
}

function safeOAuthReturnState(values: string[]): string | undefined | null {
  if (values.length === 0) return undefined;
  if (values.length > 1) return null;
  const raw = values[0];
  if (storageByteLength(raw) > MAX_OAUTH_RETURN_STATE_BYTES) return null;
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  const value = raw.trim();
  if (!value) return undefined;
  return value;
}

/* =====================================================================
 * Inline AI Suggestions (Schedule banner / Subject lines / Inbox Reality)
 * — added by the Inline-AI agent. Append-only; no edits to existing
 * exports above.
 *
 * Two surfaces consume backend endpoints that already exist:
 *
 *   1. GET /api/v1/subscribers/{id}/best-send-time
 *      (already wrapped above as `api.getBestSendTime(id)` by the
 *       SendTime/Assets agent — re-used here, NOT redefined.)
 *      The Schedule banner also calls
 *      GET /api/v1/send-time-opt?segment_id=&campaign_id=. That route is
 *      mounted in apps/api and returns 404/insufficient_data when the
 *      tenant does not yet have enough engagement history, so the banner
 *      degrades to an honest "needs more send history" message.
 *
 *   2. POST /api/v1/predict — proxied to the deliverability service's
 *      `/v1/predict` handler. Body = `{html, subject, reputation,
 *      history, links, auth?}`; response = `{predicted, content, risk,
 *      at}`. The desktop only needs `predicted` (Primary/Promotions/
 *      Spam) for the InboxReality banner. We send minimal stub values
 *      for `reputation` + `history` so the predictor has its required
 *      inputs without forcing the desktop to fetch them — the predictor
 *      treats unknown reputation as "medium / no blacklist hits", which
 *      is the appropriate cold-start prior.
 *
 * NOTE FOR OTHER AGENTS: keep additions in this clearly-marked block so
 * we don't conflict on the same lines.
 * =================================================================== */

/* ---------- Send-Time-Opt (segment-aware) --------------------------- */

/**
 * Envelope for `GET /api/v1/send-time-opt`. Runtime `confidence` is coverage
 * (members with cached signal / total scoped members), not calibrated
 * predictive confidence. A 404 with
 * `insufficient_data` means the tenant does not yet have enough opens to
 * compute a reliable segment-level recommendation.
 */
export interface SegmentBestSendTime {
  segment_id?: string;
  /** Runtime canonical representation: UTC hour-of-day formatted HH:00. */
  best_hour_utc?: string;
  computed_at?: string;
  /** ISO weekday (1=Mon..7=Sun) the predictor recommends. */
  weekday?: number;
  /** Hour 0..23 in the recipient's local (or sender's UTC) frame. */
  hour?: number;
  /** Model coverage in [0..1]; retained under the server's legacy key. */
  confidence?: number;
  /** Human-readable label e.g. "Tuesday 9:24 AM". */
  label?: string;
  /** Number of subscribers with cached signal, not engagement-event count. */
  sample_size?: number;
  /** ISO 8601 timestamp the predictor would suggest scheduling at. */
  recommended_at?: string;
  /** Tolerate any extra fields the server attaches. */
  [extra: string]: unknown;
}

/**
 * Mirrors `send_time_opt.SegmentPattern`. The backend computes a 7×24
 * grid of average open density across all subscribers in a segment
 * (or campaign's audience). 404 with `insufficient_data` when fewer
 * than 30 subscribers have computed best hours.
 *
 * Field aliases (`has_secondary` and `has_secondary_window`) are both
 * declared because the JSON tag is `has_secondary_window` but the
 * desktop code historically reads `has_secondary`.
 */
export interface SegmentHeatmapResponse {
  segment_id?: string;
  subscribers_with_data: number;
  /** 7 rows × 24 cols, dow 0=Sun..6=Sat, hour 0..23 (UTC). */
  grid: number[][];
  best_dow: number;
  best_hour: number;
  secondary_dow?: number | null;
  secondary_hour?: number | null;
  has_secondary?: boolean;
  has_secondary_window?: boolean;
  computed_at?: string;
  [extra: string]: unknown;
}

/**
 * Mirrors `send_time_opt.OpenPattern` — per-subscriber open density
 * across day-of-week × hour-of-day, bounded to the most recent 2,000
 * qualifying events within 180 days.
 */
export interface SubscriberOpenPattern {
  email?: string;
  sample_size: number;
  /** 7 rows × 24 cols, dow 0=Sun..6=Sat, hour 0..23 (UTC). */
  grid: number[][];
  best_dow: number;
  best_hour: number;
  secondary_dow?: number | null;
  secondary_hour?: number | null;
  /** True when a clear second peak emerges (≥ 0.6× primary). */
  bimodal?: boolean;
  computed_at?: string;
  [extra: string]: unknown;
}

/* ---------- Inbox Reality predict ----------------------------------- */

/** Mirrors `domain.PredictedPlacement` in services/deliverability/internal/domain. */
export interface InboxRealityPlacement {
  primary: number;
  promotions: number;
  spam: number;
}

/**
 * Subset of the deliverability `/v1/predict` response that the desktop
 * needs. The full envelope additionally carries `content` + `risk`
 * breakdowns; we keep them as `unknown` so callers may inspect them
 * without forcing a tight-coupled type today.
 */
export interface InboxRealityPrediction {
  predicted: InboxRealityPlacement;
  content?: unknown;
  risk?: unknown;
  at?: string;
}

/** Body for POST /api/v1/predict. Reputation + history are required by
 *  the predictor; callers that don't have real tenant values get a
 *  typed `insufficient_data` absence instead of a prediction built on
 *  fabricated inputs (audit §4.2). */
export interface InboxRealityPredictInput {
  subject: string;
  bodyHtml: string;
  links?: string[];
  reputation?: {
    domain?: string;
    ip?: string;
    google_score?: "low" | "medium" | "high";
    microsoft_score?: "low" | "medium" | "high";
    sender_score?: number;
    blacklist_hits?: string[];
  };
  history?: {
    OpenRate?: number;
    ClickRate?: number;
    ComplaintRate?: number;
    BounceRate?: number;
    SendVolume?: number;
  };
}

const inlineAiMethods = {
  // (getSegmentBestSendTime lives on sendTimeAssetsMethods alongside the
  // rest of the send-time surface so apiSendTimeAssets exposes it.)

  /**
   * POST /api/v1/predict — pre-send inbox-placement prediction.
   *
   * Honesty contract (audit §4.2): the predictor REQUIRES real
   * reputation + history inputs. This wrapper no longer fabricates
   * benign defaults (`sender_score: 70`, `OpenRate: 0.22`, …) — a
   * prediction computed from invented numbers was presented to the
   * operator as a real statement about their sending. When the caller
   * has no reputation/history data we return a typed absence
   * (`kind:"http"`, `status: 422`, `code:"insufficient_data"`) WITHOUT
   * firing the HTTP request, so banners can render "not enough data"
   * instead of fake Primary/Promotions/Spam splits. Partial inputs are
   * forwarded exactly as supplied — never padded.
   */
  predictInboxPlacement(
    input: InboxRealityPredictInput,
  ): Promise<ApiResult<InboxRealityPrediction>> {
    const hasReputation =
      !!input.reputation &&
      Object.values(input.reputation).some((v) => v !== undefined && v !== "");
    const hasHistory =
      !!input.history &&
      Object.values(input.history).some((v) => v !== undefined);
    if (!hasReputation || !hasHistory) {
      return Promise.resolve({
        error: {
          kind: "http",
          status: 422,
          code: "insufficient_data",
          message:
            "Inbox placement prediction needs the tenant's real reputation and engagement history; not enough data is available yet.",
        },
      });
    }
    const body = {
      html: input.bodyHtml,
      subject: input.subject,
      links: input.links ?? [],
      reputation: {
        ...(input.reputation?.domain !== undefined
          ? { domain: input.reputation.domain }
          : {}),
        ...(input.reputation?.ip !== undefined
          ? { ip: input.reputation.ip }
          : {}),
        ...(input.reputation?.google_score !== undefined
          ? { google_score: input.reputation.google_score }
          : {}),
        ...(input.reputation?.microsoft_score !== undefined
          ? { microsoft_score: input.reputation.microsoft_score }
          : {}),
        ...(typeof input.reputation?.sender_score === "number"
          ? { sender_score: input.reputation.sender_score }
          : {}),
        ...(input.reputation?.blacklist_hits !== undefined
          ? { blacklist_hits: input.reputation.blacklist_hits }
          : {}),
        checked_at: new Date().toISOString(),
      },
      history: {
        ...(input.history?.OpenRate !== undefined
          ? { OpenRate: input.history.OpenRate }
          : {}),
        ...(input.history?.ClickRate !== undefined
          ? { ClickRate: input.history.ClickRate }
          : {}),
        ...(input.history?.ComplaintRate !== undefined
          ? { ComplaintRate: input.history.ComplaintRate }
          : {}),
        ...(input.history?.BounceRate !== undefined
          ? { BounceRate: input.history.BounceRate }
          : {}),
        ...(typeof input.history?.SendVolume === "number"
          ? { SendVolume: input.history.SendVolume }
          : {}),
      },
    };
    return request<InboxRealityPrediction>(
      "/api/v1/predict",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
      // Predictor calls fan into ML scoring — generous timeout, never
      // auto re-fire (same policy as the LLM-backed surfaces).
      { timeoutMs: 60_000, maxAttempts: 1 },
    );
  },
};

/* ---------- realtime event-bus connector ---------------------------- */

/**
 * One-shot SSE connector for the realtime event bus, modeled on
 * `connectDashboardLive` in lib/sse.ts. Most callers should use the
 * shared <EventBusProvider> + useEventBus() hook instead — this helper
 * exists for one-off / non-React subscribers (CLI tools, background
 * tasks, telemetry probes).
 *
 * Backed by `GET /api/v1/events?topics=<csv>`. Auth uses short-lived stream
 * tokens so long-lived API keys do not need to live in EventSource URLs.
 */
export interface EventBusEvent<T = Record<string, unknown>> {
  topic: string;
  tenant_id: string;
  at: string;
  payload?: T;
}

export type EventBusStreamStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export type EventBusDisconnect = () => void;

/**
 * Connect to /api/v1/events with the given topic-glob list. onEvent
 * fires for every named event the server pushes (server-side filtering
 * already trims to the subscriber's tenant). onStatus reports lifecycle
 * transitions; onError is best-effort because EventSource hides the
 * HTTP status on connection failures.
 */
export function connectEventBus(
  topics: string[],
  onEvent: (evt: EventBusEvent) => void,
  onStatus?: (status: EventBusStreamStatus) => void,
): EventBusDisconnect {
  if (DEMO_DATA_FALLBACK_ENABLED) {
    onStatus?.("open");
    return (): void => onStatus?.("closed");
  }
  if (
    typeof window === "undefined" ||
    typeof window.EventSource === "undefined"
  ) {
    // Hosts without EventSource (jsdom in unit tests) — return a no-op
    // disconnect so callers can wire useEffect cleanup unconditionally.
    onStatus?.("closed");
    return (): void => {
      /* no-op */
    };
  }
  const csv = normalizeEventBusTopics(topics);
  const path = `/api/v1/events?topics=${encodeURIComponent(csv)}`;

  let stopped = false;
  let backoffMs = 1000;
  const MAX = 30_000;
  let timer: number | null = null;
  let es: EventSource | null = null;
  const cleanups: Array<() => void> = [];

  const setStatus = (s: EventBusStreamStatus): void => {
    onStatus?.(s);
  };

  const cleanupES = (): void => {
    for (const fn of cleanups.splice(0, cleanups.length)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    if (es) {
      try {
        es.close();
      } catch {
        /* ignore */
      }
      es = null;
    }
  };

  const dispatch = (ev: MessageEvent<string>): void => {
    if (stopped) return;
    const parsed = parseJsonStreamPayload<EventBusEvent>(ev.data);
    if (!parsed.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        "[postwave-api] event-bus payload parse failed:",
        parsed.message,
      );
      return;
    }
    if (!parsed.value || typeof parsed.value.topic !== "string") return;
    onEvent(parsed.value);
  };

  const open = async (): Promise<void> => {
    if (stopped) return;
    setStatus(es == null && backoffMs === 1000 ? "connecting" : "reconnecting");
    let url: string;
    try {
      url = await buildStreamUrl(path);
    } catch {
      if (stopped) return;
      // eslint-disable-next-line no-console
      console.warn("[postwave-api] event-bus stream URL unavailable; retrying");
      schedule();
      return;
    }
    if (stopped) return;
    try {
      es = new EventSource(url);
    } catch {
      // eslint-disable-next-line no-console
      console.warn("[postwave-api] EventSource construction failed; retrying");
      schedule();
      return;
    }
    es.onopen = (): void => {
      if (stopped) return;
      backoffMs = 1000;
      setStatus("open");
    };
    // EventSource fires per-event-name listeners. We register against
    // every concrete topic the server may emit so wildcard subscriptions
    // still surface them, and fall back to `onmessage` for unknowns.
    const named = ["ready", ...CONCRETE_EVENT_BUS_TOPICS];
    for (const name of named) {
      const fn = dispatch as EventListener;
      es.addEventListener(name, fn);
      cleanups.push(() => es?.removeEventListener(name, fn));
    }
    es.onmessage = dispatch;
    es.onerror = (): void => {
      if (stopped) return;
      // eslint-disable-next-line no-console
      console.warn("[postwave-api] event-bus stream error, will reconnect");
      cleanupES();
      schedule();
    };
  };

  const schedule = (): void => {
    if (stopped) return;
    setStatus("reconnecting");
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX);
    timer = window.setTimeout(() => {
      timer = null;
      void open();
    }, wait);
  };

  void open();

  return (): void => {
    if (stopped) return;
    stopped = true;
    if (timer != null) {
      window.clearTimeout(timer);
      timer = null;
    }
    cleanupES();
    setStatus("closed");
  };
}

/* ===== end ===== */

// =============================================================================
// Slack approval-bot integration. APPEND-ONLY block — do not edit above.
// =============================================================================

/**
 * SlackConnection is the API shape returned by GET /api/v1/integrations/slack-workspace.
 * Mirrors the slack_workspace_connections row WITHOUT the bot token.
 */
export interface SlackConnection {
  connected: boolean;
  team_id?: string;
  team_name?: string;
  default_channel_id?: string;
  default_channel_name?: string;
  connected_at?: string;
}

/**
 * Returns the active Slack workspace connection for the current tenant
 * (or {connected: false} if none). The bot token never crosses the API
 * boundary — the server holds it envelope-encrypted.
 */
export async function getSlackConnection(): Promise<
  ApiResult<SlackConnection>
> {
  return request<SlackConnection>("/api/v1/integrations/slack-workspace");
}

/**
 * Disconnects the current tenant's Slack workspace. Best-effort: safe
 * to call when no connection exists (returns {ok: true} either way).
 */
export async function disconnectSlack(): Promise<ApiResult<{ ok: boolean }>> {
  return request<{ ok: boolean }>("/api/v1/integrations/slack-workspace", {
    method: "DELETE",
  });
}

/** Response of GET /api/v1/integrations/slack/availability. */
export interface SlackAvailability {
  /** True when starting OAuth needs a cookie session (API-key-only
   *  desktop sessions must gate the Connect button — see
   *  slackOAuthStartUrl's auth limitation note). */
  requires_session: boolean;
  /** True when the server has Slack OAuth client credentials set. */
  configured: boolean;
}

/**
 * GET /api/v1/integrations/slack/availability — can this deployment +
 * session start the Slack OAuth flow at all? Settings uses it to gate
 * the Connect button instead of letting users hit a dead 302.
 */
export async function getSlackAvailability(): Promise<
  ApiResult<SlackAvailability>
> {
  return request<SlackAvailability>("/api/v1/integrations/slack/availability");
}

/**
 * Returns the URL the browser should navigate to in order to start the
 * Slack OAuth flow. Hands off to the gateway's /api/v1/slack/oauth/start
 * endpoint, which 302s into Slack with a signed state token.
 */
export function slackOAuthStartUrl(): string {
  // AUTH LIMITATION (audit §4.3 L10): GET /api/v1/slack/oauth/start is
  // admin-scope tenant-authenticated (apps/api/main.go:2183) and the
  // stream-token middleware only accepts tokens on realtime stream
  // routes (apikeys.StreamTokenAllowedPath) — so NO token can be
  // attached to this URL. The flow therefore only works when opened in
  // a context that already carries the pw_session cookie for the
  // gateway domain (the desktop webview after a cookie sign-in, or the
  // user's browser with an active session). API-key-only desktop
  // sessions cannot start the Slack OAuth flow from here; the Settings
  // surface should gate the button on session auth.
  return apiUrl("/api/v1/slack/oauth/start");
}

export function safeSlackOAuthStartUrl(raw: string): string | null {
  if (storageByteLength(raw) > MAX_STORED_API_URL_BYTES) return null;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.protocol === "http:" && !isLocalApiHost(url.hostname)) return null;
    if (url.pathname !== "/api/v1/slack/oauth/start") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isLocalApiHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/* =====================================================================
 * Onboarding wizard helpers — added by the Onboarding agent.
 *
 * The first-run wizard needs:
 *   1. A way to seed sample data so an "exploring" tenant can poke a
 *      populated UI without doing the full setup chores. The endpoint
 *      is now live at POST /api/v1/onboarding/sample-data; the legacy
 *      permissive wrapper remains for older call sites.
 *   2. A first-run-emptiness probe. Implemented in OnboardingWizard
 *      itself via existing wrappers (listLists, listCampaigns,
 *      listCustomDomains) so we don't add a new endpoint — keeps the
 *      check honest if any of those services are degraded.
 *
 * NOTE FOR OTHER AGENTS: keep additions in this clearly-marked block so
 * we don't conflict on the same lines.
 * =================================================================== */

/**
 * Response shape from POST /api/v1/onboarding/sample-data. The backend
 * is expected to return the counts of created entities so the UI can
 * confirm something actually happened. Every field is optional so a
 * minimalist `{ok: true}` reply still parses cleanly.
 */
export interface SampleDataResponse {
  ok?: boolean;
  /** How many demo subscribers were inserted. */
  subscribers?: number;
  /** How many demo audience lists were created. */
  lists?: number;
  /** How many demo draft campaigns were created. */
  campaigns?: number;
}

/**
 * POST /api/v1/onboarding/sample-data — populates the tenant with a
 * small demo dataset (lists, subscribers, segments, campaigns, and
 * sequences). Prefer seedSampleDataStrict() when the caller needs exact
 * per-resource counts.
 */
export async function seedSampleData(): Promise<ApiResult<SampleDataResponse>> {
  return request<SampleDataResponse>("/api/v1/onboarding/sample-data", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** Response of GET /api/v1/onboarding/sample-data — has this tenant
 *  ever been seeded, and with what. */
export interface SampleDataStatus {
  seeded: boolean;
  seeded_at?: string;
  counts?: Record<string, number>;
}

/**
 * GET /api/v1/onboarding/sample-data — read-only probe so the wizard
 * can offer "Remove sample data" instead of re-seeding. Counts mirror
 * what the seeder inserted (keys: subscribers, lists, …).
 */
export async function getSampleDataStatus(): Promise<
  ApiResult<SampleDataStatus>
> {
  return request<SampleDataStatus>("/api/v1/onboarding/sample-data");
}

/* =====================================================================
 * Legacy sequence email wrappers. The current canvas uses api.updateSequence
 * with the full `steps` union. This remains for the older email-only
 * SequenceDetailSlideover and migration-era rows that still use `emails`.
 * ===================================================================== */

/**
 * Body shape accepted by PATCH /api/v1/voice/sequences/{id}.
 *
 * The Voice service handler (services/voice/internal/handlers/sequences.go)
 * still accepts this legacy `emails` projection alongside the v0.3+
 * `steps` union.
 */
export interface SequenceEmailPayload {
  position: number;
  delay_seconds: number;
  subject: string;
  body: string;
  body_html?: string;
}

/**
 * PATCH /api/v1/voice/sequences/{id} with the proper `emails` field.
 *
 * Returns the updated SequenceDetail on success. The wrapper mirrors
 * the Voice service contract verbatim so callers don't need to know
 * about the desktop-side `steps` mismatch.
 */
export async function updateSequenceEmails(
  id: string | number,
  emails: SequenceEmailPayload[],
  expectedVersion: number,
): Promise<ApiResult<SequenceDetail>> {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return {
      error: {
        kind: "invalid_config",
        message:
          "A fresh sequence version is required before saving. Reload the sequence and try again.",
      },
    };
  }
  return request<SequenceDetail>(
    `/api/v1/voice/sequences/${encodeURIComponent(String(id))}`,
    {
      method: "PATCH",
      body: JSON.stringify({ emails }),
      headers: { "If-Match": `"${expectedVersion}"` },
    },
  );
}

/* =====================================================================
 * Cross-machine cursor publish, A/B test campaign create, sample-data
 * remove. Added by the cross-cutting features agent.
 *
 * Append-only block; reusing existing `SampleDataResponse` for the
 * seedSampleData stub above (now backed by a real handler).
 * ===================================================================== */

/**
 * Topic strings the gateway accepts on POST /api/v1/events/publish.
 * Server-emitted topics (campaign.*, subscriber.*, audit.*, etc.) are
 * NOT publishable from the client — see internal/events/handler.go's
 * allowedPublishTopics. Trying to publish a non-allowlisted topic
 * returns 403.
 */
export type ClientPublishableTopic = "cursor.move" | "selection.move";

/**
 * publishEvent — POSTs a transient event to the realtime bus so other
 * sessions on the same tenant (across machines) pick it up via SSE.
 *
 * Used by CursorOverlay to broadcast cursor positions cross-machine
 * (the BroadcastChannel fallback handles same-origin tab sync). The
 * server enforces a 20 req/sec/user token bucket — the caller should
 * also throttle locally (CursorOverlay throttles to 100ms = 10/sec).
 *
 * The endpoint returns 202 on success; on 429 we surface the rate-
 * limit shape so the cursor flow can drop the frame (lossy by design).
 */
export interface PublishResult {
  published: boolean;
  topic: string;
}
export async function publishEvent(
  topic: ClientPublishableTopic,
  payload: Record<string, unknown>,
): Promise<ApiResult<PublishResult>> {
  return request<PublishResult>("/api/v1/events/publish", {
    method: "POST",
    body: JSON.stringify({ topic, payload }),
  });
}

/**
 * createABTestCampaign — POST /api/v1/campaigns/ab-test. Creates a
 * parent `ab_test` campaign in draft status plus N child campaigns,
 * one per subject variant. The server returns {parent, children}.
 */
export interface ABTestCreateInput {
  name: string;
  subject_variants: string[];
  audience_list_id?: string;
  audience_segment_id?: string;
  body_html?: string;
  preview_text?: string;
  from_name?: string;
  reply_to?: string;
  /** 0-100; defaults to even split server-side when omitted. */
  split_percentage?: number;
  /**
   * G14 (campaigns 2026): multivariate axes. When populated the test is
   * the cross-product over subject × from_name × body × send-time,
   * capped at 8 combos server-side. Empty axes fall back to the scalar
   * field, so a subject-only test is unchanged.
   */
  from_name_variants?: string[];
  body_html_variants?: string[];
  send_time_offset_minutes?: number[];
  /**
   * G11 (campaigns 2026): forwarded onto the parent campaign's
   * delivery_settings jsonb. Carries the optional bandit policy
   * surfaced by the Subject Lab — the existing dispatcher tolerates
   * absence, and the G4 bandit dispatcher (next on the roadmap)
   * picks up `delivery_settings.ab_test.bandit=true` to switch from
   * uniform split to Thompson-style reallocation.
   */
  delivery_settings?: Record<string, unknown>;
}

export interface ABTestCreateResponse {
  parent: Campaign;
  children: Campaign[];
}

export async function createABTestCampaign(
  input: ABTestCreateInput,
): Promise<ApiResult<ABTestCreateResponse>> {
  return request<ABTestCreateResponse>("/api/v1/campaigns/ab-test", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Per-resource counts returned by the seed/remove endpoints. Matches
 * apps/api/internal/onboarding.Counts verbatim. Distinct from the
 * older permissive `SampleDataResponse` so callers can prefer the
 * stricter shape going forward.
 */
export interface OnboardingSampleCounts {
  subscribers: number;
  lists: number;
  segments: number;
  campaigns: number;
  sequences: number;
}

export interface OnboardingSampleSeedResult {
  seeded: boolean;
  counts: OnboardingSampleCounts;
  note?: string;
}

export interface OnboardingSampleRemoveResult {
  removed: boolean;
  counts: OnboardingSampleCounts;
}

/**
 * removeSampleData — DELETE /api/v1/onboarding/sample-data. Deletes
 * exactly the rows the seeder inserted (matched by sentinel marker).
 * Safe to call when nothing was ever seeded — returns zeroed counts.
 */
export async function removeSampleData(): Promise<
  ApiResult<OnboardingSampleRemoveResult>
> {
  return request<OnboardingSampleRemoveResult>(
    "/api/v1/onboarding/sample-data",
    { method: "DELETE" },
  );
}

/* ---------- workspace-settings + notifications + privacy --------------
 *
 * Wrappers for the workspace, notification, and privacy settings UIs.
 * Backend endpoints live in apps/api/internal/settings/*.
 *
 *   GET    /api/v1/settings/workspace
 *   PATCH  /api/v1/settings/workspace
 *   GET    /api/v1/settings/notifications
 *   PATCH  /api/v1/settings/notifications
 *   GET    /api/v1/settings/privacy
 *   PATCH  /api/v1/settings/privacy
 *
 * Append-only block — desktop will switch its Settings page to call
 * these in a follow-up round; today only the web app uses them.
 * ---------------------------------------------------------------------- */

/** Mirrors `settings.Workspace` (Go). All optional fields are
 *  nullable strings on the wire; the Go side serialises empty values as
 *  JSON null. */
export interface WorkspaceSettings {
  tenant_id: string;
  display_name?: string | null;
  default_reply_to?: string | null;
  timezone: string;
  /** Server enum: "YYYY-MM-DD" | "MMM D, YYYY" | "D MMM YYYY" | "MM/DD/YYYY". */
  date_format?: string;
  brand_color?: string | null;
  logo_url?: string | null;
  updated_by_user_id?: string | null;
  updated_at?: string;
}

/** Body shape for `patchWorkspaceSettings`. Pointer-style: omit a key
 *  to leave it untouched. */
export interface WorkspaceSettingsPatch {
  display_name?: string;
  default_reply_to?: string;
  timezone?: string;
  date_format?: string;
  brand_color?: string;
  logo_url?: string;
}

export async function getWorkspaceSettings(): Promise<
  ApiResult<WorkspaceSettings>
> {
  return request<WorkspaceSettings>("/api/v1/settings/workspace");
}

export async function patchWorkspaceSettings(
  patch: WorkspaceSettingsPatch,
): Promise<ApiResult<WorkspaceSettings>> {
  return request<WorkspaceSettings>("/api/v1/settings/workspace", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** Mirrors `settings.NotificationPrefs` (Go). */
export interface NotificationPrefs {
  user_id: string;
  tenant_id: string;
  email_on_send_complete: boolean;
  email_on_approval_request: boolean;
  email_on_bounce_alert: boolean;
  /** "daily" | "weekly" | "never". Backend rejects others with 400. */
  digest_frequency: string;
  updated_at?: string;
}

export interface NotificationPrefsPatch {
  email_on_send_complete?: boolean;
  email_on_approval_request?: boolean;
  email_on_bounce_alert?: boolean;
  digest_frequency?: "daily" | "weekly" | "never";
}

export async function getNotificationPrefs(): Promise<
  ApiResult<NotificationPrefs>
> {
  return request<NotificationPrefs>("/api/v1/settings/notifications");
}

export async function patchNotificationPrefs(
  patch: NotificationPrefsPatch,
): Promise<ApiResult<NotificationPrefs>> {
  return request<NotificationPrefs>("/api/v1/settings/notifications", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** Mirrors `settings.RetentionPolicy` (Go). */
export interface RetentionPolicy {
  tenant_id: string;
  audit_log_retention_days: number;
  email_event_retention_days: number;
  unsubscribed_subscriber_retention_days: number;
  updated_by_user_id?: string | null;
  updated_at?: string;
}

export interface RetentionPolicyPatch {
  audit_log_retention_days?: number;
  email_event_retention_days?: number;
  unsubscribed_subscriber_retention_days?: number;
}

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
    | "fulfilled"
    | "rejected"
    | "cancelled"
    | "appealed";
  subject_type: "tenant_admin" | "subscriber" | "consumer";
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

export async function getRetentionPolicy(): Promise<
  ApiResult<RetentionPolicy>
> {
  return request<RetentionPolicy>("/api/v1/settings/privacy");
}

export async function patchRetentionPolicy(
  patch: RetentionPolicyPatch,
): Promise<ApiResult<RetentionPolicy>> {
  return request<RetentionPolicy>("/api/v1/settings/privacy", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function requestAccountDeletion(
  body: {
    region?: PrivacyRegion;
    notes?: string;
  } = {},
): Promise<ApiResult<PrivacyWorkflowResponse>> {
  return request<PrivacyWorkflowResponse>("/api/v1/privacy/deletion-requests", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function requestDataExport(
  body: {
    region?: PrivacyRegion;
    notes?: string;
  } = {},
): Promise<ApiResult<PrivacyWorkflowResponse>> {
  return request<PrivacyWorkflowResponse>("/api/v1/privacy/export-requests", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listPrivacyRequests(): Promise<
  ApiResult<PrivacyRequestsResponse>
> {
  return request<PrivacyRequestsResponse>("/api/v1/privacy/requests");
}

/**
 * seedSampleDataStrict — same wire endpoint as seedSampleData() above,
 * but typed against the stricter response shape the new backend
 * returns. Prefer this in new UI code; the old wrapper stays for
 * back-compat with code paths that already type against it.
 */
export async function seedSampleDataStrict(): Promise<
  ApiResult<OnboardingSampleSeedResult>
> {
  return request<OnboardingSampleSeedResult>("/api/v1/onboarding/sample-data", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/* =====================================================================
 * Listing wrappers with server-side ?query support — added by the
 * list-search agent.
 *
 * The backend `?query=` parameter is honoured by every list endpoint
 * referenced below (campaigns / lists / templates / tags / archive /
 * forms / inbound-webhooks). The desktop pages used to filter
 * client-side because the backend didn't support it — these helpers
 * thread the search string straight through so the server does the
 * filtering and the page only needs the rendering work.
 *
 * APPEND-ONLY by convention: these wrappers wrap the original ones
 * declared on `api` (which keep their existing parameter shape for
 * back-compat) and add the optional `query` field. If a caller wants
 * the server-side filter, use these; if not, the existing wrappers
 * still work.
 *
 * NOTE FOR OTHER AGENTS: keep additions in this clearly-marked block so
 * we don't conflict on the same lines.
 * =================================================================== */

/** Append `?query=` (and forward the rest verbatim). */
function appendQuery(path: string, query?: string): string {
  const q = (query ?? "").trim();
  if (!q) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}query=${encodeURIComponent(q)}`;
}

/** GET /api/v1/campaigns?query= — server-side substring filter on name OR subject. */
export function listCampaignsWithQuery(
  opts: { page?: number; perPage?: number; query?: string } = {},
): Promise<ApiResult<CampaignsResponse>> {
  const params = new URLSearchParams();
  if (opts.page) params.set("page", String(opts.page));
  if (opts.perPage) params.set("per_page", String(opts.perPage));
  const qs = params.toString();
  const base = `/api/v1/campaigns${qs ? `?${qs}` : ""}`;
  return request<CampaignsResponse>(appendQuery(base, opts.query));
}

/** GET /api/v1/lists?query= — server-side filter on list name + description. */
export function listListsWithQuery(
  opts: { query?: string } = {},
): Promise<ApiResult<ListsResponse>> {
  return request<ListsResponse>(appendQuery("/api/v1/lists", opts.query));
}

/** GET /api/v1/tags?query= — server-side filter on tag name. */
export function listTagsWithQuery(
  opts: { query?: string } = {},
): Promise<ApiResult<TagsResponse>> {
  return request<TagsResponse>(appendQuery("/api/v1/tags", opts.query));
}

/** GET /api/v1/forms?query= — server-side filter on form name OR slug. */
export function listFormsWithQuery(
  opts: { query?: string } = {},
): Promise<ApiResult<FormSummary[]>> {
  return request<FormSummary[]>(appendQuery("/api/v1/forms", opts.query));
}

/** GET /api/v1/archive?query= — server-side filter on subject OR archive_slug. */
export function listArchiveWithQuery(
  opts: { cursor?: string; limit?: number; query?: string } = {},
): Promise<ApiResult<ArchiveListResponse>> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const base = `/api/v1/archive${qs ? `?${qs}` : ""}`;
  return request<ArchiveListResponse>(appendQuery(base, opts.query));
}

/** GET /api/v1/campaign-templates?query= — server-side filter on name OR subject. */
export function listCampaignTemplatesWithQuery(
  opts: { query?: string } = {},
): Promise<ApiResult<CampaignTemplateListResponse>> {
  return request<CampaignTemplateListResponse>(
    appendQuery("/api/v1/campaign-templates", opts.query),
  );
}

/** GET /api/v1/inbound-webhooks?query= — server-side filter on endpoint name. */
export function listInboundWebhooksWithQuery(
  opts: { cursor?: string; limit?: number; query?: string } = {},
): Promise<ApiResult<InboundWebhookListResponse>> {
  return api.listInboundWebhooks(opts);
}

export interface InboundWebhookEndpointPatch {
  name?: string;
  enabled?: boolean;
  /** Empty string clears the transform; omission preserves it. */
  transform_jq?: string;
}

/** PATCH endpoint administration without rotating or exposing its secret. */
export function updateInboundWebhookEndpoint(
  id: string,
  patch: InboundWebhookEndpointPatch,
): Promise<ApiResult<InboundWebhookEndpoint>> {
  return request<unknown>(
    `/api/v1/inbound-webhooks/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
    { requireOnline: true, maxAttempts: 1 },
  ).then((result) =>
    decodeInboundWebhookEndpointResult(result as ApiResult<unknown>, id),
  );
}

/** Execute a jq transform through the same bounded server runtime as ingest. */
export function previewInboundWebhookTransform(input: {
  transform_jq: string;
  body: unknown;
}): Promise<ApiResult<{ body: unknown }>> {
  return request<{ body: unknown }>(
    "/api/v1/inbound-webhooks/transform/preview",
    { method: "POST", body: JSON.stringify(input) },
    { requireOnline: true, maxAttempts: 1 },
  );
}

/* =====================================================================
 * Migration progress streaming + cancellation — added by the migration
 * progress UI agent. APPEND-ONLY to avoid conflicts with adjacent
 * agents working in this file.
 *
 * Backend:
 *   GET    /api/v1/migrations/{id}/events  — SSE (event: progress | done)
 *   DELETE /api/v1/migrations/{id}         — idempotent cancel
 *
 * The SSE wrapper here uses its own EventSource (the global event-bus
 * is tenant-scoped to other topics — see lib/event-bus.ts). Auth uses the
 * same short-lived stream-token helper as the dashboard/event-bus streams.
 * =================================================================== */

/** Resource bucket the orchestrator advanced on a `progress` event. */
export type MigrationResource =
  | "subscribers"
  | "segments"
  | "automations"
  | "archive"
  | "paid_subs"
  | "templates"
  | "source_archive"
  | "all";

/** Wire shape of `event: progress`. */
export interface MigrationProgressEvent {
  resource: MigrationResource;
  completed: number;
  total: number;
  current_step: string;
  snapshot: MigrationProgress;
  at: string;
}

export interface MigrationDoneResourceCounts {
  imported: number;
  skipped: number;
  failed: number;
  review?: number;
}

/** Wire shape of `event: done`. */
export interface MigrationDoneEvent {
  status: MigrationStatus;
  resources: Record<string, MigrationDoneResourceCounts>;
  job: MigrationJob;
  error?: string;
}

export interface MigrationStreamHandlers {
  onSnapshot?: (job: MigrationJob) => void;
  onProgress?: (evt: MigrationProgressEvent) => void;
  onDone?: (evt: MigrationDoneEvent) => void;
  onError?: (err: { message: string }) => void;
  onStatus?: (
    status: "connecting" | "open" | "reconnecting" | "closed",
  ) => void;
}

/**
 * Subscribe to live migration progress for one job.
 *
 * Returns an idempotent disconnect function. The wrapper handles its own
 * exponential backoff on transient errors (1s → 30s) so callers wire
 * cleanup once and forget about it.
 */
export function connectMigrationEvents(
  jobId: string,
  handlers: MigrationStreamHandlers,
): () => void {
  const path = `/api/v1/migrations/${encodeURIComponent(jobId)}/events`;

  let es: EventSource | null = null;
  let stopped = false;
  let backoffMs = 1000;
  let retryTimer: number | null = null;

  const setStatus = (
    s: "connecting" | "open" | "reconnecting" | "closed",
  ): void => {
    handlers.onStatus?.(s);
  };

  const cleanup = (): void => {
    if (es) {
      es.onopen = null;
      es.onerror = null;
      es.close();
      es = null;
    }
  };

  const open = async (): Promise<void> => {
    if (stopped) return;
    setStatus(backoffMs === 1000 ? "connecting" : "reconnecting");
    let url: string;
    try {
      url = await buildStreamUrl(path);
    } catch {
      if (stopped) return;
      handlers.onError?.({
        message: "Could not establish the migration progress stream.",
      });
      scheduleRetry();
      return;
    }
    if (stopped) return;
    try {
      es = new EventSource(url);
    } catch {
      handlers.onError?.({
        message: "Could not open the migration progress stream.",
      });
      scheduleRetry();
      return;
    }

    es.onopen = (): void => {
      backoffMs = 1000;
      setStatus("open");
    };

    es.addEventListener("snapshot", (ev: MessageEvent<string>) => {
      const parsed = parseJsonStreamPayload<MigrationJob>(ev.data);
      if (parsed.ok) handlers.onSnapshot?.(parsed.value);
      else handlers.onError?.({ message: parsed.message });
    });

    es.addEventListener("progress", (ev: MessageEvent<string>) => {
      const parsed = parseJsonStreamPayload<MigrationProgressEvent>(ev.data);
      if (parsed.ok) handlers.onProgress?.(parsed.value);
      else handlers.onError?.({ message: parsed.message });
    });

    es.addEventListener("done", (ev: MessageEvent<string>) => {
      const parsed = parseJsonStreamPayload<MigrationDoneEvent>(ev.data);
      if (parsed.ok) handlers.onDone?.(parsed.value);
      else handlers.onError?.({ message: parsed.message });
      cleanup();
      stopped = true;
      setStatus("closed");
    });

    es.addEventListener("error", (ev) => {
      // Server emits an `event: error` frame for auth failures + the
      // 10-min connection cap. Surface the payload, then let the native
      // onerror fire to drive the reconnect dance.
      const data = (ev as MessageEvent<string>).data;
      if (typeof data === "string" && data.length > 0) {
        const parsed = parseJsonStreamPayload<{ error?: string }>(data);
        if (parsed.ok && parsed.value.error) {
          handlers.onError?.({ message: parsed.value.error });
        }
      }
    });

    es.onerror = (): void => {
      if (stopped) return;
      handlers.onError?.({ message: "Stream connection error" });
      cleanup();
      scheduleRetry();
    };
  };

  const scheduleRetry = (): void => {
    if (stopped) return;
    if (retryTimer != null) return;
    setStatus("reconnecting");
    const wait = backoffMs;
    backoffMs = Math.min(backoffMs * 2, 30_000);
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void open();
    }, wait);
  };

  void open();

  return (): void => {
    if (stopped) return;
    stopped = true;
    if (retryTimer != null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    cleanup();
    setStatus("closed");
  };
}

/**
 * POST /api/v1/migrations/{source}/dry-run — convenience wrapper that
 * matches the shape used by the new dry-run preview UI. Equivalent to
 * `api.previewMigration(source, jobId)` but kept out-of-band so callers
 * can import only the streaming-era helpers.
 */
export function startMigrationDryRun(
  source: MigrationSource,
  jobId: string,
): Promise<ApiResult<{ job_id: string }>> {
  return api.previewMigration(source, jobId);
}

/**
 * DELETE /api/v1/migrations/{job_id} — idempotent cancel.
 *
 * Returns `{cancelled, status}`. `cancelled=false` does NOT mean the
 * call failed — it just means no in-process runner was found (the job
 * may already be terminal, or running on a different worker). The
 * caller should treat the response status as authoritative.
 */
export function cancelMigration(
  jobId: string,
): Promise<ApiResult<{ job_id: string; cancelled: boolean; status: string }>> {
  return request<{ job_id: string; cancelled: boolean; status: string }>(
    `/api/v1/migrations/${encodeURIComponent(jobId)}`,
    { method: "DELETE" },
  );
}

/* ----- subscriber-drilldown: timeline fetch ---------------------------
 *
 * Mirrors the Go shape in apps/api/internal/subscribers/timeline.go.
 * The Type union intentionally stays open-ended (`string`) so future
 * event types added on the backend don't break older desktop builds —
 * the renderer in components/subscriber/TimelineEvent.tsx falls back
 * to a generic icon for unknown types.
 * --------------------------------------------------------------------- */

export interface SubscriberTimelineEvent {
  type: string;
  occurred_at: string;
  subject_id?: string;
  subject?: string;
  campaign_id?: string;
  detail?: Record<string, unknown>;
  source: string;
}

export interface SubscriberTimelineStats {
  sent_count: number;
  opened_count: number;
  clicked_count: number;
  bounced_count: number;
  replied_count: number;
  open_rate: number;
  click_rate: number;
  engagement_score: number;
  subscribed_at: string;
  last_active_at?: string;
  current_status: string;
}

export interface SubscriberTimelinePagination {
  before?: string;
  limit: number;
  has_more: boolean;
}

export interface SubscriberTimeline {
  subscriber_id: string;
  email: string;
  stats: SubscriberTimelineStats;
  events: SubscriberTimelineEvent[];
  pagination: SubscriberTimelinePagination;
}

/**
 * GET /api/v1/subscribers/{id}/timeline?before=&limit=
 *
 * `before` is the cursor (RFC3339, from the previous page's tail
 * `occurred_at`). When omitted the server returns the newest page.
 *
 * Honest fallback: if the server returns 404 (mis-deployed gateway,
 * older API build) the slideover keeps the old simple `/activity`
 * view + a muted "timeline unavailable" tag — see
 * SubscriberDetailSlideover.tsx.
 */
export function getSubscriberTimeline(
  id: string | number,
  opts: { before?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<ApiResult<SubscriberTimeline>> {
  const qs = new URLSearchParams();
  if (opts.before) qs.set("before", opts.before);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<SubscriberTimeline>(
    `/api/v1/subscribers/${encodeURIComponent(String(id))}/timeline${suffix}`,
    undefined,
    opts.signal ? { signal: opts.signal } : undefined,
  );
}

/* ----- SUB-058-070: LLM profile summary + driver explainability ------
 *
 * GET /api/v1/subscribers/{id}/ai-summary
 *   → {summary, drivers, last_updated, cache_hit, source}
 *
 * `source` is "ai" when the voice service synthesised the body, or
 * "deterministic" when the structured-signal fallback ran (provider
 * unavailable or absent). The wire shape is identical either way so
 * the slideover renders the same card.
 * --------------------------------------------------------------------- */

export interface SubscriberAISummaryDriver {
  key: string;
  label: string;
  value: string;
  weight?: "high" | "medium" | "low";
}

export interface SubscriberAISummary {
  summary: string;
  drivers: SubscriberAISummaryDriver[];
  last_updated: string;
  cache_hit: boolean;
  source: "ai" | "deterministic";
}

export function getSubscriberAISummary(
  id: string | number,
  opts?: { refresh?: boolean },
): Promise<ApiResult<SubscriberAISummary>> {
  const qs = opts?.refresh ? "?refresh=1" : "";
  return request<SubscriberAISummary>(
    `/api/v1/subscribers/${encodeURIComponent(String(id))}/ai-summary${qs}`,
  );
}

const canonicalOutboundWebhookOperations = createOutboundOps({ request });
const listWebhookOperations = createListWebhookOperations({ request });

export const {
  listOutboundWebhooks,
  createOutboundWebhook,
  updateOutboundWebhook,
  deleteOutboundWebhook,
  testOutboundWebhook,
  listOutboundWebhookDeliveries,
  replayOutboundWebhookDelivery,
  rotateOutboundWebhookSigningMaterial,
  getOutboundWebhookHealth,
  reEnableOutboundWebhook,
} = canonicalOutboundWebhookOperations;

export const {
  listListScopedWebhooks,
  createListScopedWebhook,
  updateListScopedWebhook,
  rotateListScopedWebhookSigningMaterial,
  deleteListScopedWebhook,
  testListScopedWebhook,
  listListScopedWebhookDeliveries,
} = listWebhookOperations;

export const {
  getABResults,
  getABWeightHistory,
  listInboundTriggers,
  createInboundTrigger,
  updateInboundTrigger,
  deleteInboundTrigger,
  listMergeFieldSchema,
  createMergeFieldSchema,
  patchMergeFieldSchema,
  deleteMergeFieldSchema,
  getSubscriberMergeFields,
  patchSubscriberMergeFields,
  listSavedSegments,
  createSavedSegment,
  patchSavedSegment,
  deleteSavedSegment,
  createLookalikeAudience,
  getLookalikeAudience,
  listLookalikeAudienceMembers,
  deleteLookalikeAudience,
  listSegmentFolders,
  createSegmentFolder,
  patchSegmentFolder,
  deleteSegmentFolder,
  previewSavedSegment,
  previewSavedSegmentDetail,
  previewCompiledSegment,
  getSegmentAIProcessingDisclosure,
  compileSegmentFromText,
  getSubscribersViewPrefs,
  putSubscribersViewPrefs,
  getSubscriberSendTimes,
  setSubscriberRating,
  listSubscriberHistory,
  listSubscriberAttributeHistory,
} = createAudienceSegmentationMethods(request, {
  llmRequestOptions: LLM_REQUEST_OPTS,
});

export const {
  suppressionsConvergedApi,
  subscriptionTypesApi,
  subscriberSubscriptionTypesApi,
  listsExtendedApi,
  segmentsExtendedApi,
  smsSuppressionsApi,
  smsQuietHoursApi,
} = createListsAndSuppressionsApis(request, {
  getApiIdentityGeneration: captureApiIdentityGeneration,
  getTenantId: () => getRememberedSession()?.tenant_id ?? null,
});

export const pushSuppressionsApi = createPushSuppressionsApi(request, {
  getApiIdentityGeneration: captureApiIdentityGeneration,
  getTenantId: () => getRememberedSession()?.tenant_id ?? null,
});

/* =====================================================================
 * Contract-backed compatibility facade for Privacy Portal, Deliverability Hub,
 * Retention Offers, List drill-down tabs, Archive moderation,
 * Audit-export jobs, frequency caps, and suppression mirror/trend.
 *
 * These narrow adapters match the current renderer consumers and the mounted
 * Go routes. Route-contract, OpenAPI parity and API-client tests are the
 * authoritative drift guards; this facade is retained while domain method
 * bags continue moving out of the legacy aggregate client.
 * =================================================================== */

/* ---------- Privacy Portal ---------------------------------------- */

export type PrivacyFramework =
  | "gdpr"
  | "ccpa"
  | "lgpd"
  | "pipeda"
  | "apo"
  | "other";

export interface PrivacyPortalRegion {
  id: string;
  region_code: string;
  framework: PrivacyFramework;
  requires_double_optin: boolean;
  requires_explicit_consent: boolean;
  do_not_sell_default: boolean;
  gpc_honored: boolean;
}

export interface PrivacyPortalDsarByType {
  request_type: string;
  open: number;
  overdue: number;
  closed: number;
}

export interface PrivacyPortalSuppressionBreakdown {
  reason: string;
  count: number;
  label?: string;
}

export interface PrivacyPortalConsentProofSummary {
  source: string;
  count: number;
}

export interface PrivacyPortalDoubleOptinPending {
  id: string;
  email: string;
  sent_at: string;
  expires_at: string;
}

export interface PrivacyPortalSummary {
  regions: PrivacyPortalRegion[];
  dsar_requests: PrivacyPortalDsarByType[];
  gpc_signaled_count: number;
  do_not_sell_count: number;
  double_optin_pending: number;
  suppression_breakdown: PrivacyPortalSuppressionBreakdown[];
  consent_proof_summary: PrivacyPortalConsentProofSummary[];
}

export interface PreferenceCenterCustomization {
  logo_url: string;
  primary_color: string;
  footer_text: string;
  show_postwave_badge?: boolean;
}

export function defaultPreferenceCustomization(): PreferenceCenterCustomization {
  return {
    logo_url: "",
    primary_color: "#5B6CFF",
    footer_text: "You're receiving this because you subscribed.",
    show_postwave_badge: true,
  };
}

export const privacyPortalApi = {
  get(): Promise<ApiResult<PrivacyPortalSummary>> {
    return request<PrivacyPortalSummary>("/api/v1/privacy/portal");
  },
  regions: {
    create(input: {
      region_code: string;
      framework: PrivacyFramework;
      requires_double_optin: boolean;
      requires_explicit_consent: boolean;
      do_not_sell_default: boolean;
      gpc_honored: boolean;
    }): Promise<ApiResult<PrivacyPortalRegion>> {
      return request<PrivacyPortalRegion>("/api/v1/privacy/portal/regions", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    remove(id: string): Promise<ApiResult<{ ok: boolean }>> {
      return request<{ ok: boolean }>(
        `/api/v1/privacy/portal/regions/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    },
  },
  doubleOptin: {
    listPending(): Promise<
      ApiResult<{ pending: PrivacyPortalDoubleOptinPending[] }>
    > {
      return request<{ pending: PrivacyPortalDoubleOptinPending[] }>(
        "/api/v1/privacy/portal/double-optin/pending",
      );
    },
    resend(id: string): Promise<ApiResult<{ ok: boolean }>> {
      return request<{ ok: boolean }>(
        `/api/v1/privacy/portal/double-optin/${encodeURIComponent(id)}/resend`,
        { method: "POST", body: JSON.stringify({}) },
        // Send-like POST (emails the subscriber): never auto-retry.
        { maxAttempts: 1 },
      );
    },
    cancel(id: string): Promise<ApiResult<{ ok: boolean }>> {
      return request<{ ok: boolean }>(
        `/api/v1/privacy/portal/double-optin/${encodeURIComponent(id)}/cancel`,
        { method: "POST", body: JSON.stringify({}) },
      );
    },
  },
  getPreferenceCustomization(): Promise<
    ApiResult<PreferenceCenterCustomization>
  > {
    // p0-privacy-portal-routes: collapsed under the canonical
    // /api/v1/privacy/portal/ namespace alongside regions + double-
    // optin so the contract test in privacy_portal/route_contract_test.go
    // can verify every privacyPortal URL resolves to a chi route.
    return request<PreferenceCenterCustomization>(
      "/api/v1/privacy/portal/preference-center",
    );
  },
  savePreferenceCustomization(
    theme: PreferenceCenterCustomization,
  ): Promise<ApiResult<PreferenceCenterCustomization>> {
    return request<PreferenceCenterCustomization>(
      "/api/v1/privacy/portal/preference-center",
      { method: "PATCH", body: JSON.stringify(theme) },
    );
  },
};

/* ---------- Archive comments moderation --------------------------- */

export interface ArchiveComment {
  id: string;
  body: string;
  status: "pending" | "visible" | "hidden" | "spam";
  pinned?: boolean;
  upvotes: number;
  downvotes: number;
  displayName?: string;
  parentId?: string | null;
  createdAt: string;
}

export interface ArchiveCommentsListResponse {
  items: ArchiveComment[];
  total: number;
}

interface ArchiveCommentExtensions {
  listArchiveComments(opts: {
    status: ArchiveComment["status"];
    campaignId?: string;
    limit?: number;
  }): Promise<ApiResult<ArchiveCommentsListResponse>>;
  moderateArchiveComment(
    id: string,
    status: "visible" | "hidden" | "spam",
  ): Promise<ApiResult<{ ok: boolean }>>;
  pinArchiveComment(id: string): Promise<ApiResult<{ ok: boolean }>>;
  unpinArchiveComment(id: string): Promise<ApiResult<{ ok: boolean }>>;
  deleteArchiveComment(id: string): Promise<ApiResult<{ ok: boolean }>>;
}

const archiveCommentExtensions: ArchiveCommentExtensions = {
  listArchiveComments(opts: {
    status: ArchiveComment["status"];
    campaignId?: string;
    limit?: number;
  }): Promise<ApiResult<ArchiveCommentsListResponse>> {
    const params = new URLSearchParams();
    params.set("status", opts.status);
    if (opts.campaignId) params.set("campaignId", opts.campaignId);
    if (opts.limit) params.set("limit", String(opts.limit));
    return request<ArchiveCommentsListResponse>(
      `/api/v1/archive/comments?${params.toString()}`,
    );
  },
  moderateArchiveComment(
    id: string,
    status: "visible" | "hidden" | "spam",
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/archive/comments/${encodeURIComponent(id)}/moderate`,
      { method: "POST", body: JSON.stringify({ status }) },
    );
  },
  pinArchiveComment(id: string): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/archive/comments/${encodeURIComponent(id)}/pin`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },
  unpinArchiveComment(id: string): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/archive/comments/${encodeURIComponent(id)}/unpin`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },
  deleteArchiveComment(id: string): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/archive/comments/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
};
/* ---------- Audit export jobs ------------------------------------- */

export interface AuditExportJob {
  id: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  estimatedRows?: number;
  exportedRows: number;
  totalBytes: number;
  fileUrl?: string;
  errorReason?: string;
  emailOnComplete: boolean;
  emailAddress?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  etaSeconds?: number;
}

export interface DLQReplayEntryStatus {
  id: number;
  status: "ok" | "failed" | "skipped" | "not_found";
  rows: number;
  errorMsg?: string;
}

export interface DLQReplayBulkResponse {
  replayed: number;
  failed: number;
  skipped: number;
  entries: DLQReplayEntryStatus[];
}

type AuditExportFilters = AuditQueryFilters;

/**
 * One audit-access request row — mirrors the camelCase JSON the Go
 * handlers emit for POST/GET /api/v1/audit/access-requests.
 */
export interface AuditAccessRequest {
  id: string;
  userId?: string;
  userEmail?: string;
  actorLabel?: string;
  note?: string;
  status: string;
  createdAt: string;
}

const auditExtensions = {
  async getAuditCount(
    filters: AuditExportFilters,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<ApiResult<AuditCountResponse>> {
    const query = serializeAuditQuery(filters);
    const response = await request<unknown>(
      `/api/v1/audit/count${query ? `?${query}` : ""}`,
      undefined,
      requestOptions?.signal ? { signal: requestOptions.signal } : undefined,
    );
    if (response.error) return response;
    const data = decodeAuditCountPayload(response.data);
    return data
      ? { ...response, data }
      : {
          error: {
            kind: "parse",
            code: "invalid_audit_payload",
            message: "The audit count response was invalid.",
          },
          retryability: "manual",
        };
  },
  exportAuditAsync(
    input: AuditExportFilters & {
      emailOnComplete?: boolean;
      emailAddress?: string;
    },
  ): Promise<ApiResult<AuditExportJob>> {
    return request<AuditExportJob>("/api/v1/audit/export-async", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  getAuditExportJob(id: string): Promise<ApiResult<AuditExportJob>> {
    return request<AuditExportJob>(
      `/api/v1/audit/export-jobs/${encodeURIComponent(id)}`,
    );
  },
  async auditExportJobDownloadUrlAuthed(id: string): Promise<string> {
    // Attach a short-lived stream token via buildStreamUrl — same
    // pattern as its siblings auditExportUrlAuthed / auditStreamUrlAuthed
    // (audit §4.3 L10): the bare path carried no auth at all for
    // anchor-click downloads in cookieless webviews. NOTE: the apikeys
    // middleware ignores the token when cookie auth already resolved a
    // tenant, so cookie contexts are unchanged; cookieless contexts
    // start working once the backend's StreamTokenAllowedPath allowlist
    // admits the audit download route (it must for the sibling audit
    // stream/export URLs too).
    return buildStreamUrl(
      `/api/v1/audit/export-jobs/${encodeURIComponent(id)}/download`,
    );
  },
  listAuditExportJobs(
    limit = 20,
  ): Promise<ApiResult<{ jobs: AuditExportJob[] }>> {
    return request<{ jobs: AuditExportJob[] }>(
      `/api/v1/audit/export-jobs?limit=${limit}`,
    );
  },
  // sse-pinned-tail (Audit UX, P1): bulk DLQ replay returns per-entry
  // status so the page can show a "Replayed N events, K failed" toast
  // plus inline badges on each row.
  replayDLQBulk(ids: number[]): Promise<ApiResult<DLQReplayBulkResponse>> {
    return request<DLQReplayBulkResponse>(
      "/api/v1/audit-sinks/dlq/replay-bulk",
      {
        method: "POST",
        body: JSON.stringify({ ids }),
      },
    );
  },
  /**
   * GET /api/v1/audit/events?ids=1,2,3 — batch lookup of audit rows by
   * id (≤100 per call; the wrapper rejects larger batches locally so
   * the server's 400 never fires). Rows share the listAudit shape.
   */
  async getAuditEventsByIds(
    ids: Array<number | string>,
  ): Promise<ApiResult<{ items: AuditRow[] }>> {
    if (ids.length === 0) {
      return Promise.resolve({ data: { items: [] } });
    }
    if (ids.length > 100) {
      return Promise.resolve({
        error: {
          kind: "invalid_config",
          message: "getAuditEventsByIds accepts at most 100 ids per call.",
        },
      });
    }
    const response = await request<unknown>(
      `/api/v1/audit/events?ids=${encodeURIComponent(ids.map(String).join(","))}`,
    );
    if (response.error) return response;
    const decoded = decodeAuditListPayload(response.data);
    return decoded
      ? { ...response, data: { items: decoded.rows } }
      : {
          error: {
            kind: "parse",
            code: "invalid_audit_payload",
            message: "The audit event detail response was invalid.",
          },
          retryability: "manual",
        };
  },
  /**
   * POST /api/v1/audit/access-requests — ask an operator with the
   * audit:read_pii scope for elevated access. Server returns 201 for a
   * new request or 200 for an existing open one; both resolve as
   * `{request}` here.
   */
  createAuditAccessRequest(
    input: { note?: string } = {},
  ): Promise<ApiResult<{ request: AuditAccessRequest }>> {
    return request<{ request: AuditAccessRequest }>(
      "/api/v1/audit/access-requests",
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  /** GET /api/v1/audit/access-requests?status= — review queue. */
  listAuditAccessRequests(
    opts: { status?: string } = {},
  ): Promise<ApiResult<{ items: AuditAccessRequest[] }>> {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    const qs = params.toString();
    return request<{ items: AuditAccessRequest[] }>(
      `/api/v1/audit/access-requests${qs ? `?${qs}` : ""}`,
    );
  },
};
/* ---------- Deliverability Hub ------------------------------------ */

/**
 * Mirrors `deliverability_hub.FixCTA` in the Go API.
 */
export interface DeliverabilityHubFixCTA {
  label: string;
  href?: string;
  section?: string;
}

/**
 * Mirrors `deliverability_hub.ThresholdBreach` in the Go API. JSON
 * keys are wire-canonical — keep aligned with the Go struct tags.
 * Severity uses the operator-facing taxonomy ("info" | "warn" |
 * "critical"); the raw metric/observed/threshold triple is preserved
 * for callers that want the underlying numbers.
 */
export interface DeliverabilityHubBreach {
  code: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail?: string;
  since?: string;
  fix_cta?: DeliverabilityHubFixCTA;
  metric?: string;
  threshold?: number;
  observed?: number;
  suggestion?: string;
}

/**
 * Mirrors `deliverability_hub.HubScore` in the Go API. The keys here
 * are the wire contract — any rename has to land in
 * apps/api/internal/deliverability_hub/hub.go::HubScore in lockstep,
 * and the migration that backs deliverability_hub_snapshots /
 * deliverability_repair_overrides has to ship first (see
 * infra/migrations/0334_deliverability_hub_tables.sql).
 */
export interface DeliverabilityHubSummary {
  tenant_id?: string;
  score: number;
  grade: string;
  status: string;
  trend: "up" | "down" | "flat";
  trend_delta: number;
  trend_reference_at?: string;
  history: number[];
  bounce_rate?: number;
  complaint_rate?: number;
  engagement_rate?: number;
  opens_machine_pct?: number;
  event_rate_scope: "campaigns";
  model_version: string;
  sample_qualified: boolean;
  minimum_sample_sends: number;
  sample_reason?: string;
  window_days?: number;
  breaches: DeliverabilityHubBreach[];
  dns_health?: Record<string, unknown>;
  blocklist_hits?: BlocklistHit[];
  auto_throttled: boolean;
  auto_throttle_reason?: string;
  totals: {
    sends_7d: number;
    sends_30d: number;
  };
  computed_at: string;
}

/**
 * Mirrors the row produced by `getBlocklistHits` in
 * apps/api/internal/deliverability_hub/handlers.go. `id` is a synthetic
 * stable key (subject_type|subject|list) so the table can `key` rows
 * without relying on a server-side primary key.
 */
export interface BlocklistHit {
  id: string;
  list_name: string;
  identifier: string;
  identifier_type: string;
  first_seen_at: string;
  confidence?: number;
  tier1?: boolean;
  delisting_status?: string;
  delist_url?: string;
}

/**
 * Mirrors the row produced by `getWebhookErrors`. `status_code` is
 * best-effort parsed from the `error` string by the API; absent when
 * the receiver returned a non-HTTP transport failure (timeout, DNS).
 */
export interface WebhookErrorRow {
  id: string;
  event: string;
  url?: string;
  error?: string;
  status_code?: number;
  attempt_count: number;
  last_attempt_at: string;
  status?: string;
}

export interface BounceClassBreakdownEntry {
  class_code: string;
  label: string;
  count: number;
  share: number;
}

export interface BounceClassBreakdownResponse {
  window_days: number;
  total_bounces: number;
  classes: BounceClassBreakdownEntry[];
}

/**
 * Mirrors the response from
 * `GET /api/v1/deliverability/hub/history` — sampled scores in
 * chronological order so the page can render its own sparkline /
 * line-chart from the snapshot table without recomputing from raw
 * events.
 */
export interface DeliverabilityHubHistoryPoint {
  sampled_at: string;
  score: number;
  model_version: string;
  sample_qualified: boolean;
  sample_size: number;
}

export interface DeliverabilityHubHistoryResponse {
  snapshots: DeliverabilityHubHistoryPoint[];
  window_days: number;
  count: number;
  model_version: string;
}

export type DeliverabilityRepairOverrideCapOutcome =
  | "committed"
  | "committed-conservatively-fenced"
  | "commit-outcome-unknown-conservatively-fenced"
  | "not-committed";

/**
 * Exact acknowledgement for the live send-cap restoration. A 503 can still
 * carry a committed outcome, so callers must classify this evidence instead
 * of treating HTTP success/failure as a proxy for whether the write happened.
 */
export interface DeliverabilityRepairOverrideResponse {
  ok: boolean;
  cleared: boolean;
  cap_coordination_outcome: DeliverabilityRepairOverrideCapOutcome;
}

export interface DeliverabilityProviderConfig {
  id: string;
  tenant_id: string;
  provider: string;
  display_name?: string;
  config?: Record<string, unknown>;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DeliverabilityProviderConfigInput {
  provider: string;
  display_name?: string;
  config?: Record<string, unknown>;
  active?: boolean;
}

export const deliverabilityHubApi = {
  get(): Promise<ApiResult<DeliverabilityHubSummary>> {
    return request<DeliverabilityHubSummary>("/api/v1/deliverability/hub");
  },
  history(
    days: number = 30,
  ): Promise<ApiResult<DeliverabilityHubHistoryResponse>> {
    return request<DeliverabilityHubHistoryResponse>(
      `/api/v1/deliverability/hub/history?days=${days}`,
    );
  },
  dnsHealth(): Promise<ApiResult<{ identities: DnsHealthStatus[] }>> {
    return request<{ identities: DnsHealthStatus[] }>(
      "/api/v1/deliverability/hub/dns-health",
    );
  },
  blocklistHits(): Promise<ApiResult<{ items: BlocklistHit[] }>> {
    return request<{ items: BlocklistHit[] }>(
      "/api/v1/deliverability/hub/blocklist-hits",
    );
  },
  webhookErrors(): Promise<ApiResult<{ items: WebhookErrorRow[] }>> {
    return request<{ items: WebhookErrorRow[] }>(
      "/api/v1/deliverability/hub/webhook-errors",
    );
  },
  bounceClassBreakdown(): Promise<ApiResult<BounceClassBreakdownResponse>> {
    return request<BounceClassBreakdownResponse>(
      "/api/v1/deliverability/hub/bounce-class-breakdown",
    );
  },
  repairOverride(): Promise<ApiResult<DeliverabilityRepairOverrideResponse>> {
    return request<DeliverabilityRepairOverrideResponse>(
      "/api/v1/deliverability/hub/repair-override",
      { method: "POST", body: JSON.stringify({}) },
      {
        // This endpoint has no server replay contract. In particular, a 503
        // can mean the override was durably cleared while Redis remains
        // conservatively fenced; retrying it turns that truthful outcome into
        // a misleading `no_override` response from a second request.
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: null,
      },
    );
  },
  providers(): Promise<ApiResult<{ items: DeliverabilityProviderConfig[] }>> {
    return request<{ items: DeliverabilityProviderConfig[] }>(
      "/api/v1/deliverability/providers",
    );
  },
  upsertProvider(
    input: DeliverabilityProviderConfigInput,
  ): Promise<ApiResult<{ item: DeliverabilityProviderConfig }>> {
    return request<{ item: DeliverabilityProviderConfig }>(
      "/api/v1/deliverability/providers",
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  deleteProvider(id: string): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/deliverability/providers/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
};

/* ---------- Frequency caps ---------------------------------------- */

export interface FrequencyCap {
  id: string;
  label: string;
  max_sends: number;
  window_hours: number;
  active: boolean;
  // SUB-133 per-channel scope. A send on any channel in this set counts
  // toward this rule's shared cap. Absent means legacy email-only; an explicit
  // empty array is a legacy global rule; new writes always carry a scope.
  channels?: string[];
  created_at?: string;
  /** Exact server revision required by PATCH and DELETE. */
  updated_at: string;
}

export interface FrequencyCapInput {
  label: string;
  max_sends: number;
  window_hours: number;
  active: boolean;
  channels?: string[];
}

export const frequencyCapsApi = {
  async list(): Promise<ApiResult<{ items: FrequencyCap[] }>> {
    const res = await request<{
      rules?: FrequencyCap[];
      items?: FrequencyCap[];
    }>("/api/v1/sending/frequency-caps");
    if (res.error) return res;
    return {
      data: { items: res.data?.rules ?? res.data?.items } as {
        items: FrequencyCap[];
      },
    };
  },
  async create(
    input: FrequencyCapInput,
    options: { idempotencyKey: string },
  ): Promise<ApiResult<FrequencyCap>> {
    const res = await request<FrequencyCap & { rule?: FrequencyCap }>(
      "/api/v1/sending/frequency-caps",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: options.idempotencyKey,
      },
    );
    if (res.error) return res;
    // Tolerate both `{rule: {...}}` and a bare unwrapped cap (audit
    // §4.3 I3 — an unwrapped server response used to resolve
    // `{data: undefined}`).
    return { data: res.data?.rule ?? res.data };
  },
  async update(
    id: string,
    input: Partial<FrequencyCapInput>,
    expectedUpdatedAt: string,
    options: { idempotencyKey: string },
  ): Promise<ApiResult<FrequencyCap>> {
    const res = await request<FrequencyCap & { rule?: FrequencyCap }>(
      `/api/v1/sending/frequency-caps/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          ...input,
          expected_updated_at: expectedUpdatedAt,
        }),
      },
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: options.idempotencyKey,
      },
    );
    if (res.error) return res;
    return { data: res.data?.rule ?? res.data };
  },
  remove(
    id: string,
    expectedUpdatedAt: string,
    options: { idempotencyKey: string },
  ): Promise<ApiResult<void>> {
    // The canonical handler returns 204 No Content. Keep that transport
    // contract intact instead of requiring a synthetic `{ok:true}` envelope.
    return request<void>(
      `/api/v1/sending/frequency-caps/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ expected_updated_at: expectedUpdatedAt }),
      },
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: options.idempotencyKey,
      },
    );
  },
};

/* ---------- Lists drill-down tabs --------------------------------- */

export interface ListActivityEvent {
  id: string;
  type: string;
  occurred_at: string;
  subscriber_email?: string;
  actor?: string;
}

export const listsActivityApi = {
  list(
    listId: string | number,
    opts: { page?: number; perPage?: number } = {},
  ): Promise<ApiResult<{ items: ListActivityEvent[]; total: number }>> {
    const params = new URLSearchParams();
    if (opts.page) params.set("page", String(opts.page));
    if (opts.perPage) params.set("per_page", String(opts.perPage));
    const qs = params.toString();
    return request<{ items: ListActivityEvent[]; total: number }>(
      `/api/v1/lists/${encodeURIComponent(String(listId))}/activity${qs ? `?${qs}` : ""}`,
    );
  },
};

export interface ListGrowthPoint {
  date: string;
  subscribed: number;
  unsubscribed: number;
  net: number;
}
export interface ListGrowthResponse {
  window_days: number;
  points: ListGrowthPoint[];
}
export interface ListSourceSlice {
  source: string;
  count: number;
}
export interface ListSourceMixResponse {
  slices: ListSourceSlice[];
}
export interface ListEngagementBucket {
  label: string;
  count: number;
}
export interface ListEngagementBreakdown {
  buckets: ListEngagementBucket[];
}
export interface ListPerRowEngagement {
  subscriber_id: string;
  email: string;
  opens: number;
  clicks: number;
  last_engaged_at?: string;
}
export interface ListHealthHistoryPoint {
  date: string;
  score: number;
}

// Paths verified against apps/api/internal/lists/analytics.go
// MountAnalyticsRoutes — the backend mounts these directly under
// /api/v1/lists/{id}/ with NO `/analytics/` segment (audit §5.2: the
// extra segment 404'd all five cards forever).
export const listsAnalyticsApi = {
  growth(
    listId: string | number,
    days: number,
  ): Promise<ApiResult<ListGrowthResponse>> {
    return request<ListGrowthResponse>(
      `/api/v1/lists/${encodeURIComponent(String(listId))}/growth?days=${days}`,
    );
  },
  sourceMix(
    listId: string | number,
  ): Promise<ApiResult<ListSourceMixResponse>> {
    return request<ListSourceMixResponse>(
      `/api/v1/lists/${encodeURIComponent(String(listId))}/source-mix`,
    );
  },
  engagementBreakdown(
    listId: string | number,
  ): Promise<ApiResult<ListEngagementBreakdown>> {
    return request<ListEngagementBreakdown>(
      `/api/v1/lists/${encodeURIComponent(String(listId))}/engagement-breakdown`,
    );
  },
  perRowEngagement(
    listId: string | number,
    opts: { perPage?: number } = {},
  ): Promise<ApiResult<{ items: ListPerRowEngagement[]; total: number }>> {
    const qs = opts.perPage ? `?per_page=${opts.perPage}` : "";
    return request<{ items: ListPerRowEngagement[]; total: number }>(
      `/api/v1/lists/${encodeURIComponent(String(listId))}/per-row-engagement${qs}`,
    );
  },
  healthHistory(
    listId: string | number,
    days: number,
  ): Promise<ApiResult<{ points: ListHealthHistoryPoint[] }>> {
    return request<{ points: ListHealthHistoryPoint[] }>(
      `/api/v1/lists/${encodeURIComponent(String(listId))}/health-history?days=${days}`,
    );
  },
};

export interface ListAutomationSummary {
  id: string;
  name: string;
  status: string;
  trigger_type?: string;
  enrolled_count?: number;
  updated_at?: string;
  created_at?: string;
}

export const listsAutomationsApi = {
  list(
    listId: string | number,
  ): Promise<ApiResult<{ items: ListAutomationSummary[] }>> {
    return request<{ items: ListAutomationSummary[] }>(
      `/api/v1/lists/${encodeURIComponent(String(listId))}/automations`,
    );
  },
};

export interface ListFormSummary {
  id: string;
  name: string;
  url?: string;
  view_count?: number;
  submission_count?: number;
  created_at?: string;
}

export const listsFormsApi = {
  list(
    listId: string | number,
  ): Promise<ApiResult<{ items: ListFormSummary[] }>> {
    return request<{ items: ListFormSummary[] }>(
      `/api/v1/lists/${encodeURIComponent(String(listId))}/forms`,
    );
  },
};

/**
 * Per-list merge field — wire shape verified against
 * apps/api/internal/lists/merge_fields.go::MergeField. Rows are keyed
 * by `tag` (uppercase, ≤10 chars), NOT by id — the backend stores them
 * in list_metadata JSONB with no synthetic ids. The server's JSON key
 * for the default value is `default`; the client surfaces it as
 * `default_value` for consistency with the tenant-wide merge-field
 * schema type.
 */
export interface ListMergeField {
  tag: string;
  name: string;
  type: "text" | "number" | "date" | "email" | "phone" | "address";
  required?: boolean;
  default_value?: string;
  help_text?: string;
  created_at?: string;
}

export interface ListMergeFieldInput {
  /** Required by the backend: 1-10 uppercase chars, ^[A-Z][A-Z0-9_]*$. */
  tag: string;
  name: string;
  type: ListMergeField["type"];
  required?: boolean;
  default_value?: string;
  help_text?: string;
}

/** Wire shape the Go handlers read/write (`default`, not `default_value`). */
interface ListMergeFieldWire {
  tag: string;
  name: string;
  type: ListMergeField["type"];
  required?: boolean;
  default?: string;
  help_text?: string;
  created_at?: string;
}

function listMergeFieldFromWire(w: ListMergeFieldWire): ListMergeField {
  return {
    tag: w.tag,
    name: w.name,
    type: w.type,
    ...(w.required !== undefined ? { required: w.required } : {}),
    ...(w.default !== undefined ? { default_value: w.default } : {}),
    ...(w.help_text !== undefined ? { help_text: w.help_text } : {}),
    ...(w.created_at !== undefined ? { created_at: w.created_at } : {}),
  };
}

function listMergeFieldToWire(input: ListMergeFieldInput): ListMergeFieldWire {
  return {
    tag: input.tag,
    name: input.name,
    type: input.type,
    required: !!input.required,
    // Backend JSON key is `default` (merge_fields.go struct tag).
    ...(input.default_value !== undefined && input.default_value !== ""
      ? { default: input.default_value }
      : {}),
    ...(input.help_text ? { help_text: input.help_text } : {}),
  };
}

/**
 * Per-list merge fields (audit §5.3 — all three wire-shape mismatches
 * fixed): list unwraps the server's `{merge_fields: [...]}` envelope,
 * create sends the REQUIRED `tag`, and update/delete are keyed by tag
 * (the rows carry no id).
 */
export const listsMergeFieldsApi = {
  async list(
    listId: string | number,
  ): Promise<ApiResult<{ items: ListMergeField[] }>> {
    const res = await request<{
      list_id?: string;
      merge_fields?: ListMergeFieldWire[];
    }>(`/api/v1/lists/${encodeURIComponent(String(listId))}/merge-fields`);
    if (res.error) return res;
    return {
      data: {
        items: (res.data?.merge_fields ?? []).map(listMergeFieldFromWire),
      },
    };
  },
  async create(
    listId: string | number,
    input: ListMergeFieldInput,
  ): Promise<ApiResult<ListMergeField>> {
    const res = await request<ListMergeFieldWire>(
      `/api/v1/lists/${encodeURIComponent(String(listId))}/merge-fields`,
      { method: "POST", body: JSON.stringify(listMergeFieldToWire(input)) },
    );
    if (res.error) return res;
    return { data: listMergeFieldFromWire(res.data) };
  },
  async update(
    listId: string | number,
    tag: string,
    input: ListMergeFieldInput,
  ): Promise<ApiResult<ListMergeField>> {
    // NB: the backend's update is a full-field upsert (validateMergeField
    // requires name + type), so the input shape matches create. The tag
    // in the body is ignored server-side — the URL is the source of truth.
    const res = await request<ListMergeFieldWire>(
      `/api/v1/lists/${encodeURIComponent(String(listId))}/merge-fields/${encodeURIComponent(tag)}`,
      { method: "PATCH", body: JSON.stringify(listMergeFieldToWire(input)) },
    );
    if (res.error) return res;
    return { data: listMergeFieldFromWire(res.data) };
  },
  remove(
    listId: string | number,
    tag: string,
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/lists/${encodeURIComponent(String(listId))}/merge-fields/${encodeURIComponent(tag)}`,
      { method: "DELETE" },
    );
  },
};

/* ---------- Retention offers (subscriber portal modal) ------------ */

export interface RetentionOffer {
  id: string;
  tenant_id?: string;
  paywall_tier_id: string;
  percent_off?: number | null;
  fixed_off_cents?: number | null;
  duration_months: number;
  headline: string;
  body: string;
  stripe_coupon_id?: string;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface RetentionOfferFunnelTile {
  offer_id: string;
  tier_id?: string;
  shown: number;
  accepted: number;
  declined?: number;
  expired?: number;
  acceptance_rate: number;
}

export interface RetentionOfferInput {
  id?: string;
  paywall_tier_id: string;
  percent_off?: number | null;
  fixed_off_cents?: number | null;
  duration_months?: number;
  headline?: string;
  body?: string;
  active?: boolean;
}

export interface PortalRetentionOfferLookup {
  has_offer: boolean;
  offer?: RetentionOffer;
  amount_label?: string;
}

export const apiRetentionOffers = {
  listRetentionOffers(): Promise<
    ApiResult<{ offers: RetentionOffer[]; count?: number }>
  > {
    return request<{ offers: RetentionOffer[]; count?: number }>(
      "/api/v1/retention-offers",
    );
  },
  getRetentionOfferFunnel(): Promise<
    ApiResult<{ tiles: RetentionOfferFunnelTile[]; count?: number }>
  > {
    return request<{ tiles: RetentionOfferFunnelTile[]; count?: number }>(
      "/api/v1/retention-offers/funnel",
    );
  },
  upsertRetentionOffer(
    input: RetentionOfferInput,
  ): Promise<ApiResult<RetentionOffer>> {
    return request<RetentionOffer>("/api/v1/retention-offers", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  deactivateRetentionOffer(id: string): Promise<ApiResult<void>> {
    return request<void>(`/api/v1/retention-offers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  lookupPortalRetentionOffer(
    tierID: string,
  ): Promise<ApiResult<PortalRetentionOfferLookup>> {
    return request<PortalRetentionOfferLookup>(
      `/api/v1/portal/retention-offer?tier_id=${encodeURIComponent(tierID)}`,
    );
  },
  logRetentionOfferEvent(
    offerID: string,
    input: {
      event_type: "shown" | "accepted" | "declined";
      paid_sub_id?: string;
      subscriber_email?: string;
    },
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/retention-offers/${encodeURIComponent(offerID)}/events`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  acceptPortalRetentionOffer(input: {
    offer_id: string;
    paid_sub_id?: string;
    subscriber_email?: string;
    stripe_subscription_id?: string;
  }): Promise<ApiResult<{ applied: boolean }>> {
    return request<{ applied: boolean }>(
      "/api/v1/portal/retention-offer/accept",
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  declinePortalRetentionOffer(input: {
    offer_id: string;
    paid_sub_id?: string;
    subscriber_email?: string;
  }): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>("/api/v1/portal/retention-offer/decline", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
};

/* ---------- Suppressions mirror + trend (extends suppressionsApi) - */

/** Providers the suppression mirror can pull from. */
export type SuppressionMirrorProvider =
  | "ses"
  | "mailgun"
  | "postmark"
  | "mailchimp"
  | "sendgrid";

/**
 * Result of POST /api/v1/suppressions/mirror/{provider}. A 200 carries
 * the counts; a 503 (provider credentials not configured) is folded by
 * the wrapper into `{not_configured: true, not_configured_reason}` so
 * the page can render a setup CTA instead of a generic error toast.
 */
export interface SuppressionMirrorResult {
  provider: string;
  fetched: number;
  imported: number;
  skipped: number;
  errors: number;
  window_from?: string;
  window_to?: string;
  not_configured?: boolean;
  not_configured_reason?: string;
}

/** One day in GET /api/v1/suppressions/trend. */
export interface SuppressionTrendPoint {
  date: string;
  count: number;
  by_reason: Record<string, number>;
}

/** Response of GET /api/v1/suppressions/trend?days=. */
export interface SuppressionTrendResponse {
  points: SuppressionTrendPoint[];
  days: number;
}

/** Response of POST /api/v1/suppressions/bulk-delete (and the
 *  `action: "delete"` arm of bulk-action). `blocked` lists rows the
 *  server refused without `force` (e.g. compliance-pinned reasons). */
export interface SuppressionBulkDeleteResult {
  deleted_count: number;
  errors: string[];
  blocked: string[];
}

/** `action: "change_reason"` arm of bulk-action. */
export interface SuppressionBulkReasonResult {
  updated_count: number;
  errors: string[];
}

/** `action: "export"` arm of bulk-action. */
export interface SuppressionBulkExportResult {
  export_url: string;
  ids: string[];
}

/**
 * Discriminate by key presence: `deleted_count` (delete),
 * `updated_count` (change_reason), `export_url` (export).
 */
export type SuppressionBulkActionResult =
  | SuppressionBulkDeleteResult
  | SuppressionBulkReasonResult
  | SuppressionBulkExportResult;

/** Selector for the bulk endpoints — ids and/or emails. */
export interface SuppressionBulkSelector {
  ids?: string[];
  emails?: string[];
}

/**
 * Body for POST /api/v1/suppressions/bulk-import (SUB-050). `emails` is
 * the de-duplicated, CSV/paste-expanded list to write onto the modern
 * subscriber_suppressions table (the one the send-loop converger reads).
 * `reason`/`channel`/`scope` are optional batch-wide overrides; empty
 * values default to manual_unsubscribe / email / marketing server-side.
 */
export interface SuppressionBulkImportInput {
  emails: string[];
  reason?: SuppressionReason | string;
  channel?: SuppressionChannel;
  scope?: SuppressionScope;
}

/**
 * Response of POST /api/v1/suppressions/bulk-import. `imported` counts
 * rows newly written; `skipped` counts duplicate-or-invalid rows the
 * import silently dropped; `errors` carries per-row "email: reason"
 * strings for the rare DB-layer failure (usually empty).
 */
export interface SuppressionBulkImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

const suppressionsExtensions = {
  /**
   * POST /api/v1/suppressions/bulk-import — write a batch of addresses
   * to the modern subscriber_suppressions table idempotently (SUB-050).
   * Unlike {@link suppressionsApi.bulkAdd}, this lands on the canonical
   * subscriber_suppressions table. The send-time converger also reads the
   * legacy compatibility store, so callers must not describe either write
   * path as the whole suppression truth. Up to 50,000 emails per call; the
   * caller should cap pasted input well under the 16 MiB body limit.
   */
  importBulk(
    input: SuppressionBulkImportInput,
  ): Promise<ApiResult<SuppressionBulkImportResult>> {
    return request<SuppressionBulkImportResult>(
      "/api/v1/suppressions/bulk-import",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      // A 50k-row import does real DB work in one tx; give it a generous
      // window and a single attempt (idempotent on the server, but an
      // auto-retry would re-walk the whole batch for no benefit).
      { timeoutMs: 65_000, maxAttempts: 1 },
    );
  },
  /**
   * POST /api/v1/suppressions/mirror/{provider} — pull the provider's
   * own suppression list into Moosewave. 503 (provider not configured)
   * is normalized into a `not_configured` data result; other errors
   * pass through untouched.
   */
  async mirror(
    provider: SuppressionMirrorProvider,
  ): Promise<ApiResult<SuppressionMirrorResult>> {
    const res = await request<SuppressionMirrorResult>(
      `/api/v1/suppressions/mirror/${encodeURIComponent(provider)}`,
      { method: "POST", body: JSON.stringify({}) },
      // A mirror pull walks the provider's API server-side — give it a
      // long window and exactly one attempt (an auto-retried pull would
      // re-walk the provider; the 503 not-configured reply must also
      // surface immediately instead of burning the retry budget).
      { timeoutMs: 65_000, maxAttempts: 1 },
    );
    if (res.error && res.error.kind === "http" && res.error.status === 503) {
      const reason = res.error.details?.not_configured_reason;
      return {
        data: {
          provider,
          fetched: 0,
          imported: 0,
          skipped: 0,
          errors: 0,
          not_configured: true,
          not_configured_reason:
            typeof reason === "string" && reason ? reason : res.error.message,
        },
      };
    }
    return res;
  },
  /** GET /api/v1/suppressions/trend?days= — daily counts + per-reason
   *  breakdown for the suppressions dashboard chart. */
  trend(
    opts: { days?: number } = {},
  ): Promise<ApiResult<SuppressionTrendResponse>> {
    const params = new URLSearchParams();
    if (opts.days) params.set("days", String(opts.days));
    const qs = params.toString();
    return request<SuppressionTrendResponse>(
      `/api/v1/suppressions/trend${qs ? `?${qs}` : ""}`,
    );
  },
  /**
   * POST /api/v1/suppressions/bulk-delete — remove many rows by id
   * and/or email. Without `force`, compliance-protected rows come back
   * in `blocked` instead of being deleted.
   */
  bulkDelete(
    input: SuppressionBulkSelector & { force?: boolean },
  ): Promise<ApiResult<SuppressionBulkDeleteResult>> {
    return request<SuppressionBulkDeleteResult>(
      "/api/v1/suppressions/bulk-delete",
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  /**
   * POST /api/v1/suppressions/bulk-action — delete / change_reason /
   * export over an id/email selection. The response shape follows the
   * action (see {@link SuppressionBulkActionResult}).
   */
  bulkAction(
    input: SuppressionBulkSelector & {
      action: "delete" | "change_reason" | "export";
      reason?: string;
      force?: boolean;
    },
  ): Promise<ApiResult<SuppressionBulkActionResult>> {
    return request<SuppressionBulkActionResult>(
      "/api/v1/suppressions/bulk-action",
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  /** GET /api/v1/suppressions/{emailOrId}/audit?page=&size= — paginated
   *  audit trail for one address (accepts the email or a suppression
   *  row id; the response echoes the resolved `email`). No empty-page
   *  fallback: errors pass through for the caller to handle. */
  audit(
    emailOrId: string,
    opts: { page?: number; size?: number } = {},
  ): Promise<ApiResult<SuppressionAuditPage>> {
    const params = new URLSearchParams();
    if (opts.page) params.set("page", String(opts.page));
    if (opts.size) params.set("size", String(opts.size));
    const qs = params.toString();
    return request<SuppressionAuditPage>(
      `/api/v1/suppressions/${encodeURIComponent(emailOrId)}/audit${qs ? `?${qs}` : ""}`,
    );
  },
};
/**
 * One explicit construction point for the desktop API facade. Spread order
 * matches the historical augmentation order, so a duplicate method would
 * retain the same last-writer behavior while remaining visible to TypeScript.
 */
export type DesktopApi = typeof coreApi &
  DeferredRouteApi &
  typeof auditOperationsMethods &
  typeof sendTimeAssetsMethods &
  DiscountsAndGiftsApi &
  AuthApi &
  typeof inlineAiMethods & {
    privacyPortal: typeof privacyPortalApi;
  } & ArchiveCommentExtensions &
  typeof auditExtensions;

type DeferredApiImplementation = (...args: unknown[]) => unknown;

let deferredRouteApiPromise: Promise<DeferredRouteApi> | null = null;

registerRouteApiTransport({
  request,
  queueableRequest,
  getApiUrl,
  buildStreamUrl,
  getTenantId: () => getRememberedSession()?.tenant_id ?? null,
});

function loadDeferredRouteApi(): Promise<DeferredRouteApi> {
  deferredRouteApiPromise ??= import("./api-client-route-runtime").then(
    ({ deferredRouteApi }) => deferredRouteApi,
  );
  return deferredRouteApiPromise;
}

function createDeferredRouteMethod(
  name: (typeof DEFERRED_ROUTE_API_METHOD_NAMES)[number],
): DeferredApiImplementation {
  const method = async (...args: unknown[]): Promise<unknown> => {
    const runtime = await loadDeferredRouteApi();
    const implementation = runtime[
      name
    ] as unknown as DeferredApiImplementation;
    return implementation(...args);
  };
  // Function names are part of the long-running extraction contracts and make
  // stack traces useful after the lazy boundary resolves.
  Object.defineProperty(method, "name", { value: name });
  return method;
}

const deferredRouteMethods = Object.fromEntries(
  DEFERRED_ROUTE_API_METHOD_NAMES.map((name) => [
    name,
    createDeferredRouteMethod(name),
  ]),
) as unknown as DeferredRouteApi;

export const api: DesktopApi = {
  ...coreApi,
  ...deferredRouteMethods,
  ...auditOperationsMethods,
  ...sendTimeAssetsMethods,
  ...monetizationImpl,
  ...authImpl,
  ...inlineAiMethods,
  privacyPortal: privacyPortalApi,
  ...archiveCommentExtensions,
  ...auditExtensions,
};

// Compatibility names intentionally share one identity; they no longer rely
// on a progressively mutated object or assertion-only type widening.
export const apiSendTimeAssets = api;
export const apiMonetization = api;
export const apiAuth = api;
export const apiInlineAi = api;

export type SuppressionsApi = typeof suppressionsApiCore &
  typeof suppressionsExtensions;

export const suppressionsApi: SuppressionsApi = {
  ...suppressionsApiCore,
  ...suppressionsExtensions,
};

/* ---------- end compatibility facade ------------------------------ */

/* =====================================================================
 * Audience syncs (A13 — GAPS-REMAINING-2026-06-10)
 *
 * Working reverse-ETL surface: push a list's / segment's members to a
 * tenant webhook in HMAC-signed batches (same X-Postwave-Signature
 * convention as outbound webhooks). v1 ships the webhook destination
 * only; run-now executes synchronously server-side and returns the
 * closed run row.
 *
 * Backend: apps/api/internal/audience_destinations/sync_handlers.go
 *   GET    /api/v1/audience-syncs            → {items: AudienceSync[]}
 *   POST   /api/v1/audience-syncs            → AudienceSync (201)
 *   GET    /api/v1/audience-syncs/{id}       → AudienceSync
 *   PATCH  /api/v1/audience-syncs/{id}       → AudienceSync
 *   DELETE /api/v1/audience-syncs/{id}       → 204
 *   POST   /api/v1/audience-syncs/{id}/run   → AudienceSyncRun
 *   GET    /api/v1/audience-syncs/{id}/runs  → {items: AudienceSyncRun[]}
 *
 * Secrets are write-only: reads return secret_set + secret_hint, never
 * the plaintext.
 * =================================================================== */

/** Exactly one of list_id / segment_id is set (backend XOR CHECK).
 *  list_id accepts a Listmonk integer id or a Moosewave uuid — the
 *  backend normalizes via list_id_map. */
export interface AudienceSyncSource {
  list_id?: string | null;
  segment_id?: string | null;
}

export interface AudienceSyncDestination {
  /** v1: always "webhook". */
  type: string;
  url: string;
  /** Write-only — accepted on create/update, never echoed back. */
  secret?: string;
  /** Read-side substitute for `secret`. */
  secret_set?: boolean;
  secret_hint?: string;
}

export type AudienceSyncSchedule = "manual" | "hourly" | "daily";

export interface AudienceSync {
  id: string;
  name: string;
  source: AudienceSyncSource;
  destination: AudienceSyncDestination;
  schedule: AudienceSyncSchedule | string;
  enabled: boolean;
  last_run_at?: string | null;
  last_run_status?: string;
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
  excluded_count?: number;
}

/** Wire shape of GET /api/v1/audience-syncs/{id}/exclusion-preview
 *  (Consent-Safe Activation Firewall, feature #2). A count of -1 means
 *  "unavailable" — never render it as 0. */
export interface SyncExclusionPreview {
  audience_count: number; // -1 = unavailable
  excluded_consent: number;
  excluded_suppression: number;
  excluded_total: number;
  purpose: string;
  computed_at: string;
}

export interface AudienceSyncCreateInput {
  name: string;
  source: AudienceSyncSource;
  destination: { type?: string; url: string; secret: string };
  schedule: AudienceSyncSchedule;
  enabled?: boolean;
}

export interface AudienceSyncUpdateInput {
  name?: string;
  source?: AudienceSyncSource;
  /** Omit `secret` (or send "") to keep the stored one. */
  destination?: { type?: string; url?: string; secret?: string };
  schedule?: AudienceSyncSchedule;
  enabled?: boolean;
}

export const audienceSyncsApi = {
  list(): Promise<ApiResult<{ items: AudienceSync[] }>> {
    return request<{ items: AudienceSync[] }>("/api/v1/audience-syncs");
  },
  get(id: string): Promise<ApiResult<AudienceSync>> {
    return request<AudienceSync>(
      `/api/v1/audience-syncs/${encodeURIComponent(id)}`,
    );
  },
  create(input: AudienceSyncCreateInput): Promise<ApiResult<AudienceSync>> {
    return request<AudienceSync>("/api/v1/audience-syncs", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  update(
    id: string,
    input: AudienceSyncUpdateInput,
  ): Promise<ApiResult<AudienceSync>> {
    return request<AudienceSync>(
      `/api/v1/audience-syncs/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  },
  remove(id: string): Promise<ApiResult<void>> {
    return request<void>(`/api/v1/audience-syncs/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  /** Synchronous server-side execution — returns the CLOSED run row.
   *  A failed run is still HTTP 200 with status:"failed" + error, so
   *  callers must branch on `run.status`, not just `res.error`.
   *
   *  The server bounds a run at 60s (SyncRunTimeout), so this call
   *  overrides the default 5s client timeout; no retries (a re-fired
   *  run re-delivers real batches) and never queued offline. */
  run(id: string): Promise<ApiResult<AudienceSyncRun>> {
    return request<AudienceSyncRun>(
      `/api/v1/audience-syncs/${encodeURIComponent(id)}/run`,
      { method: "POST" },
      { timeoutMs: 65_000, maxAttempts: 1, requireOnline: true },
    );
  },
  listRuns(id: string): Promise<ApiResult<{ items: AudienceSyncRun[] }>> {
    return request<{ items: AudienceSyncRun[] }>(
      `/api/v1/audience-syncs/${encodeURIComponent(id)}/runs`,
    );
  },

  /** Pre-flight exclusion count for a sync (feature #2). Advisory —
   *  never gates the run. -1 counts mean "unavailable" (honest-UI). */
  previewExclusions(id: string): Promise<ApiResult<SyncExclusionPreview>> {
    return request<SyncExclusionPreview>(
      `/api/v1/audience-syncs/${encodeURIComponent(id)}/exclusion-preview`,
    );
  },
  /** Downloads the signed exclusion-receipt CSV for a run (admin scope).
   *  Returns the blob + server-suggested filename; caller triggers the
   *  save (anchor + createObjectURL), mirroring downloadAIVSBundle. */
  async downloadExclusionReceipt(
    runId: string,
  ): Promise<ApiResult<{ blob: Blob; filename: string }>> {
    const identityGeneration = captureApiIdentityGeneration();
    if (identityGeneration === null) {
      return apiIdentityTransitionError("identity_transition");
    }
    try {
      const headers: Record<string, string> = { Accept: "text/csv" };
      const key = normalizeApiKey(getApiKey());
      if (key) headers.Authorization = `Bearer ${key}`;
      const res = await nativeAwareFetch(
        apiUrl(
          `/api/v1/audience-sync-runs/${encodeURIComponent(runId)}/exclusion-receipt`,
        ),
        {
          method: "GET",
          headers,
          mode: "cors",
          credentials: "include",
          cache: "no-store",
          signal: apiIdentitySignal(null),
        },
      );
      if (!apiIdentityGenerationIsCurrent(identityGeneration)) {
        return apiIdentityTransitionError("identity_changed");
      }
      if (!res.ok) {
        const error = await errorFromResponse(res);
        if (!apiIdentityGenerationIsCurrent(identityGeneration)) {
          return apiIdentityTransitionError("identity_changed");
        }
        return { error };
      }
      const cd = res.headers.get("Content-Disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename = m?.[1] ?? `exclusion-receipt-${runId}.csv`;
      const blob = await res.blob();
      if (!apiIdentityGenerationIsCurrent(identityGeneration)) {
        return apiIdentityTransitionError("identity_changed");
      }
      return { data: { blob, filename } };
    } catch (err) {
      if (!apiIdentityGenerationIsCurrent(identityGeneration)) {
        return apiIdentityTransitionError("identity_changed");
      }
      return { error: transportError(err) };
    }
  },
};

/* ---------- end audience syncs ------------------------------------ */

/* =====================================================================
 * Audience destinations — native ad-platform sync (SUB-113)
 *
 * Meta / Google Ads / TikTok / LinkedIn / Snap Custom Audiences built
 * from a list or segment, with consent-aware exclusion. Each destination
 * is a per-tenant row keyed by provider + source (list_id XOR segment_id)
 * + a provider config block holding the platform credentials/ids. A sync
 * resolves members, applies the consent firewall, and ships the kept rows
 * to the provider's audience API.
 *
 * Backend: apps/api/internal/audience_destinations/{handlers,platform_adapter}.go
 *   GET    /api/v1/audience-destinations              → {items: AudienceDestination[]}
 *   POST   /api/v1/audience-destinations              → AudienceDestination (201)
 *   GET    /api/v1/audience-destinations/{id}         → AudienceDestination
 *   PATCH  /api/v1/audience-destinations/{id}         → AudienceDestination
 *   DELETE /api/v1/audience-destinations/{id}         → AudienceDestinationDisconnectResponse
 *   POST   /api/v1/audience-destinations/{id}/sync    → 202 {status, job, destination}
 *   GET    /api/v1/audience-destinations/{id}/jobs    → {items: AudienceDestinationJob[]}
 *   GET    /api/v1/audience-destinations/{id}/preview → AudienceDestinationPreview
 *   GET    /api/v1/audience-destinations/providers    → {providers, capabilities}
 *   POST   /api/v1/audience-destinations/{provider}/readiness → PlatformReadiness
 *
 * Credentials live in the config block and are sent on create/update;
 * the readiness probe reports the exact missing keys so the UI can guide
 * OAuth/credential setup before a sync is attempted.
 * =================================================================== */

export type AudiencePlatform =
  | "meta"
  | "google_ads"
  | "tiktok"
  | "linkedin"
  | "snap";

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
  provider: AudiencePlatform | string;
  list_id?: string | null;
  segment_id?: string | null;
  external_audience_id?: string;
  status: AudienceDestinationStatus;
  last_synced_at?: string | null;
  /** Provider config — credentials/ids. Read-back echoes what was stored. */
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

export interface AudienceDestinationSyncResult {
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

export interface AudienceDestinationProviderCapabilities {
  configured: boolean;
  diagnostics: boolean;
}

export interface AudienceDestinationProvidersResponse {
  providers: string[];
  capabilities: Record<string, AudienceDestinationProviderCapabilities>;
}

/** POST /api/v1/audience-destinations/{provider}/readiness response —
 *  mirrors PlatformAdapterStatus. `missing` lists the env-style keys the
 *  adapter still needs (e.g. META_AUDIENCE_ID). */
export interface PlatformReadiness {
  provider: string;
  ready: boolean;
  /** "configured" | "missing_credentials" */
  status: string;
  detail: string;
  missing?: string[];
  docs?: string[];
}

/** GET /api/v1/audience-destinations/{id}/preview — consent-aware
 *  exclusion preview. Nothing is shipped. */
export interface AudienceDestinationPreview {
  destination_id: string;
  provider: string;
  total_members: number;
  excluded_count: number;
  deliverable: number;
  truncated: boolean;
  firewall_active: boolean;
}

export interface AudienceDestinationCreateInput {
  provider: AudiencePlatform | string;
  list_id?: string | null;
  segment_id?: string | null;
  external_audience_id?: string;
  config?: Record<string, unknown>;
}

export interface AudienceDestinationUpdateInput {
  status?: string;
  external_audience_id?: string;
  config?: Record<string, unknown>;
}

export const audienceDestinationsApi = {
  /** GET /api/v1/audience-destinations → `{items}`. Optional provider
   *  filter narrows to one platform. */
  list(
    provider?: string,
  ): Promise<ApiResult<{ items: AudienceDestination[] }>> {
    const qs = provider ? `?provider=${encodeURIComponent(provider)}` : "";
    return request<{ items: AudienceDestination[] }>(
      `/api/v1/audience-destinations${qs}`,
    );
  },
  /** GET /api/v1/audience-destinations/providers → deployment capabilities. */
  providers(): Promise<ApiResult<AudienceDestinationProvidersResponse>> {
    return request<AudienceDestinationProvidersResponse>(
      "/api/v1/audience-destinations/providers",
    );
  },
  /** GET /api/v1/audience-destinations/{id}. */
  get(id: string): Promise<ApiResult<AudienceDestination>> {
    return request<AudienceDestination>(
      `/api/v1/audience-destinations/${encodeURIComponent(id)}`,
    );
  },
  /** POST /api/v1/audience-destinations → 201. */
  create(
    input: AudienceDestinationCreateInput,
  ): Promise<ApiResult<AudienceDestination>> {
    return request<AudienceDestination>("/api/v1/audience-destinations", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  /** PATCH /api/v1/audience-destinations/{id}. */
  update(
    id: string,
    input: AudienceDestinationUpdateInput,
  ): Promise<ApiResult<AudienceDestination>> {
    return request<AudienceDestination>(
      `/api/v1/audience-destinations/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  },
  /** DELETE /api/v1/audience-destinations/{id} → cleanup evidence. */
  remove(
    id: string,
  ): Promise<ApiResult<AudienceDestinationDisconnectResponse>> {
    return request<AudienceDestinationDisconnectResponse>(
      `/api/v1/audience-destinations/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
  /** POST /api/v1/audience-destinations/{provider}/readiness — validate
   *  a platform config block, report the exact missing keys. */
  readiness(
    provider: string,
    config: Record<string, unknown>,
  ): Promise<ApiResult<PlatformReadiness>> {
    return request<PlatformReadiness>(
      `/api/v1/audience-destinations/${encodeURIComponent(provider)}/readiness`,
      { method: "POST", body: JSON.stringify({ config }) },
    );
  },
  /** GET /api/v1/audience-destinations/{id}/preview — consent-exclusion
   *  preview, ships nothing. */
  preview(id: string): Promise<ApiResult<AudienceDestinationPreview>> {
    return request<AudienceDestinationPreview>(
      `/api/v1/audience-destinations/${encodeURIComponent(id)}/preview`,
    );
  },
  /** POST /api/v1/audience-destinations/{id}/sync → 202 (records a job). */
  sync(id: string): Promise<ApiResult<AudienceDestinationSyncResult>> {
    return request<AudienceDestinationSyncResult>(
      `/api/v1/audience-destinations/${encodeURIComponent(id)}/sync`,
      { method: "POST", body: JSON.stringify({}) },
      { timeoutMs: 60_000, maxAttempts: 1, requireOnline: true },
    );
  },
  /** GET /api/v1/audience-destinations/{id}/jobs → `{items}`. */
  listJobs(
    id: string,
  ): Promise<ApiResult<{ items: AudienceDestinationJob[] }>> {
    return request<{ items: AudienceDestinationJob[] }>(
      `/api/v1/audience-destinations/${encodeURIComponent(id)}/jobs`,
    );
  },
  /** GET /api/v1/audience-destinations/{id}/jobs/{job_id}/diagnostics. */
  jobDiagnostics(
    id: string,
    jobId: string,
  ): Promise<ApiResult<AudienceDestinationJobDiagnosticsResponse>> {
    return request<AudienceDestinationJobDiagnosticsResponse>(
      `/api/v1/audience-destinations/${encodeURIComponent(id)}/jobs/${encodeURIComponent(jobId)}/diagnostics`,
    );
  },
};

/* ---------- end audience destinations ----------------------------- */

export const {
  emailBlocksApi,
  sendWindowApi,
  a11yApi,
  translationsApi,
  fromNamePickerApi,
  linkCheckerApi,
  utmTemplatesApi,
  subjectAnalyzerApi,
  emailValidationApi,
  resendUnopenedApi,
  campaignCloneApi,
  holdoutApi,
  controlGroupsApi,
  contentOptimizerApi,
  contentRemixApi,
} = createCampaignAuthoringApis(request, {
  apiUrl,
  errorFromResponse,
  getApiKey,
  llmRequestOptions: LLM_REQUEST_OPTS,
  nativeFetch: apiIdentityAwareNativeFetch,
  normalizeApiKey,
  transportError,
});

/* ---------- #16 Reply analytics (reply_analytics) ------------------- */
// summary / timeseries / top-senders were ALREADY wired on the main
// `api` object (getRepliesSummary / getRepliesTimeseries /
// getRepliesTopSenders — types RepliesSummary, ReplyTimeseriesResponse,
// ReplyTopSendersResponse near line 9800). This group completes the
// surface with the per-campaign drill-down and re-exposes the trio
// under one roof for new UI code.

export interface ReplyPreview {
  recipient_email: string;
  subject?: string;
  body_snippet?: string;
  source: string;
  received_at: string;
}

export interface ReplyByCampaignResponse {
  campaign_id: string;
  replies: number;
  distinct_replyers: number;
  unique_recipients: number;
  reply_rate: number;
  recent: ReplyPreview[];
}

export const replyAnalyticsApi = {
  /** GET /api/v1/replies/summary?days=. */
  summary(days?: number): Promise<ApiResult<RepliesSummary>> {
    const qs = days != null ? `?days=${days}` : "";
    return request<RepliesSummary>(`/api/v1/replies/summary${qs}`);
  },
  /** GET /api/v1/replies/by-campaign/{id}. */
  byCampaign(
    campaignId: string | number,
  ): Promise<ApiResult<ReplyByCampaignResponse>> {
    return request<ReplyByCampaignResponse>(
      `/api/v1/replies/by-campaign/${encodeURIComponent(String(campaignId))}`,
    );
  },
  /** GET /api/v1/replies/top-senders?days=. */
  topSenders(days?: number): Promise<ApiResult<ReplyTopSendersResponse>> {
    const qs = days != null ? `?days=${days}` : "";
    return request<ReplyTopSendersResponse>(`/api/v1/replies/top-senders${qs}`);
  },
  /** GET /api/v1/replies/timeseries?days=. */
  timeseries(days?: number): Promise<ApiResult<ReplyTimeseriesResponse>> {
    const qs = days != null ? `?days=${days}` : "";
    return request<ReplyTimeseriesResponse>(`/api/v1/replies/timeseries${qs}`);
  },
};

export const {
  lifecycleRollupApi,
  leadScoringApi,
  contactRatingsApi,
  eqScoreApi,
  subscriberNotesApi,
  customFieldsApi,
  predictiveApi,
  zeroCopyTriggersApi,
  triggerDelayApi,
} = createSubscriberIntelligenceApis(request);

/* ---------- #30 Omnichannel campaigns (omnichannel) ------------------ */

export interface OmniCatalogItem {
  key: string;
  label: string;
  runtime_status: string;
  provider?: string;
  fields?: Array<{
    key: string;
    type: string;
    required?: boolean;
    options?: string[];
  }>;
}

export interface OmniCatalogResponse {
  schema_version: string;
  channels: OmniCatalogItem[];
  send_strategies: OmniCatalogItem[];
  recipient_snapshot_modes: OmniCatalogItem[];
  path_statuses: string[];
}

export interface OmniCampaignPath {
  id?: string;
  campaign_id?: string;
  path_key: string;
  name: string;
  channel: string;
  status?: string;
  audience?: Record<string, unknown>;
  message_template_id?: string;
  fallback_path_key?: string;
  traffic_weight_basis_points?: number;
  sequence?: number;
  settings?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface OmniCampaign {
  id?: string;
  tenant_id?: string;
  name: string;
  status?: string;
  objective?: string;
  audience_strategy?: Record<string, unknown>;
  schedule?: Record<string, unknown>;
  send_strategy?: Record<string, unknown>;
  recipient_snapshot_mode?: string;
  source_campaign_id?: string;
  paths?: OmniCampaignPath[];
  created_at?: string;
  updated_at?: string;
}

export interface OmniValidationResponse {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
  supported_paths: number;
  [extra: string]: unknown;
}

export const omnichannelApi = {
  /** GET /api/v1/omnichannel/catalog. */
  catalog(): Promise<ApiResult<OmniCatalogResponse>> {
    return request<OmniCatalogResponse>("/api/v1/omnichannel/catalog");
  },
  /** GET /api/v1/omnichannel/campaigns?status= → `{items}`. */
  listCampaigns(
    opts: { status?: string } = {},
  ): Promise<ApiResult<{ items: OmniCampaign[] }>> {
    const qs = opts.status ? `?status=${encodeURIComponent(opts.status)}` : "";
    return request<{ items: OmniCampaign[] }>(
      `/api/v1/omnichannel/campaigns${qs}`,
    );
  },
  /** GET /api/v1/omnichannel/campaigns/{id} — includes paths. */
  getCampaign(id: string): Promise<ApiResult<OmniCampaign>> {
    return request<OmniCampaign>(
      `/api/v1/omnichannel/campaigns/${encodeURIComponent(id)}`,
    );
  },
  /** POST /api/v1/omnichannel/campaigns — 201, or 422 with the
   *  validation payload when invalid. */
  createCampaign(input: OmniCampaign): Promise<ApiResult<OmniCampaign>> {
    return request<OmniCampaign>("/api/v1/omnichannel/campaigns", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  /** POST /api/v1/omnichannel/validate — body `{campaign}`. */
  validate(campaign: OmniCampaign): Promise<ApiResult<OmniValidationResponse>> {
    return request<OmniValidationResponse>("/api/v1/omnichannel/validate", {
      method: "POST",
      body: JSON.stringify({ campaign }),
    });
  },
};

/* ---------- #31 Scheduled reports (scheduled_reports) ---------------- */

export type ScheduledReportRunStatus =
  | "queued"
  | "leased"
  | "delivering"
  | "succeeded"
  | "partial"
  | "failed"
  | "needs_review";

export interface ScheduledReport {
  id: string;
  name: string;
  enabled: boolean;
  template: string;
  schedule: string;
  timezone: string;
  recipients: string[];
  last_run_at?: string | null;
  last_run_error?: string;
  latest_run_id?: string | null;
  latest_run_status?: ScheduledReportRunStatus | null;
  latest_run_created_at?: string | null;
  latest_run_accepted_count: number;
  latest_run_failed_count: number;
  latest_run_unknown_count: number;
  latest_run_recipient_count: number;
  next_due_at?: string | null;
  created_at: string;
}

export interface ScheduledReportCreateInput {
  name: string;
  template: string;
  schedule: string;
  timezone: string;
  recipients: string[];
}

export interface ScheduledReportPatchInput {
  enabled?: boolean;
  schedule?: string;
  timezone?: string;
  recipients?: string[];
  name?: string;
}

export interface ScheduledReportCreateResponse {
  id: string;
  next_due_at: string;
  timezone: string;
}

export interface ScheduledReportSendNowReceipt {
  queued: true;
  run_id: string;
  scheduled_report_id: string;
  run_kind: "manual";
  status: "queued";
  occurrence_at: string;
  created_at: string;
}

export type ScheduledReportApiError = ApiErr["error"];

function isScheduledReportSendNowReceipt(
  value: ScheduledReportSendNowReceipt | undefined,
  reportID: string,
): value is ScheduledReportSendNowReceipt {
  return Boolean(
    value &&
    value.queued === true &&
    value.scheduled_report_id === reportID &&
    value.run_kind === "manual" &&
    value.status === "queued" &&
    typeof value.run_id === "string" &&
    value.run_id.length > 0 &&
    typeof value.occurrence_at === "string" &&
    !Number.isNaN(Date.parse(value.occurrence_at)) &&
    typeof value.created_at === "string" &&
    !Number.isNaN(Date.parse(value.created_at)),
  );
}

export const scheduledReportsApi = {
  /** GET /api/v1/scheduled-reports (admin) → `{reports}`. */
  list(
    opts: ApiRequestOpts = {},
  ): Promise<ApiResult<{ reports: ScheduledReport[] }>> {
    return request<{ reports: ScheduledReport[] }>(
      "/api/v1/scheduled-reports",
      {},
      opts,
    );
  },
  /** POST /api/v1/scheduled-reports (admin) — returns normalized timezone. */
  create(
    input: ScheduledReportCreateInput,
    opts: ApiRequestOpts = {},
  ): Promise<ApiResult<ScheduledReportCreateResponse>> {
    return request<ScheduledReportCreateResponse>(
      "/api/v1/scheduled-reports",
      { method: "POST", body: JSON.stringify(input) },
      opts,
    );
  },
  /** PATCH /api/v1/scheduled-reports/{id} (admin) → `{updated:true}`. */
  update(
    id: string,
    input: ScheduledReportPatchInput,
    opts: ApiRequestOpts = {},
  ): Promise<ApiResult<{ updated: boolean }>> {
    return request<{ updated: boolean }>(
      `/api/v1/scheduled-reports/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(input) },
      opts,
    );
  },
  /** DELETE /api/v1/scheduled-reports/{id} (admin) → `{deleted:true}`. */
  remove(
    id: string,
    opts: ApiRequestOpts = {},
  ): Promise<ApiResult<{ deleted: boolean }>> {
    return request<{ deleted: boolean }>(
      `/api/v1/scheduled-reports/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      opts,
    );
  },
  /** Mint once when the operator opens a send-now review. The caller retains
   * this key across any response-ambiguous retry. */
  newSendNowKey(): string {
    return newUUIDv7();
  },
  /** Queue one bodyless manual run under a caller-held stable identity. */
  async sendNow(
    id: string,
    idempotencyKey: string,
    opts: ApiRequestOpts = {},
  ): Promise<ApiResult<ScheduledReportSendNowReceipt>> {
    if (!idempotencyKey.trim()) {
      return {
        error: {
          kind: "invalid_config",
          code: "idempotency_key_required",
          message: "A stable request identity is required.",
        },
      };
    }
    const result = await request<ScheduledReportSendNowReceipt>(
      `/api/v1/scheduled-reports/${encodeURIComponent(id)}/send-now`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
      },
      { ...opts, requireOnline: true },
    );
    if (result.error || isScheduledReportSendNowReceipt(result.data, id)) {
      return result;
    }
    return {
      error: {
        kind: "parse",
        code: "invalid_scheduled_report_run_receipt",
        message: "The server returned an invalid run receipt.",
      },
    };
  },
};

/* ---------- #32 Conversions (conversions) ----------------------------- */

export interface ConversionRow {
  id: number;
  tenant_id: string;
  subscriber_email?: string;
  event_name: string;
  amount_cents?: number | null;
  currency?: string;
  campaign_id?: string;
  /**
   * How campaign attribution was established. Missing means a legacy row that
   * has not yet been classified; it must never be presented as certain.
   */
  attributed_via?:
    | "explicit"
    | "last_touch"
    | "none"
    | "code_redemption"
    | "campaign_vanity_path";
  properties: Record<string, unknown>;
  occurred_at: string;
}

export interface ConversionTrackingKey {
  id: string;
  tenant_id: string;
  label: string;
  prefix: string;
  revoked_at?: string | null;
  created_at: string;
}

/** Admin-listable metadata for one private signed-conversion credential. */
export interface ConversionIngestSecretSummary {
  key_id: string;
  label: string;
  created_at: string;
  revoked_at?: string | null;
  identity_projection_status: "pending" | "ready" | "failed";
  identity_projection_error_code?: "secret_unavailable" | "projection_failed";
  identity_projection_updated_at: string;
}

/** The only response shape in which the private signing secret may appear. */
export interface ConversionIngestSecretIssueResponse {
  secret: ConversionIngestSecretSummary & { secret: string };
  notice: string;
}

export interface ConversionIngestSecretListResponse {
  items: ConversionIngestSecretSummary[];
  next_cursor?: string;
}

export interface ConversionListCursor {
  /** Oldest row timestamp from the previous page. */
  before: string;
  /** Oldest row ID from the previous page; disambiguates equal timestamps. */
  beforeId: number;
}

export const conversionsApi = {
  /** GET /api/v1/conversions?before=<RFC3339>&before_id=<int64> — BARE
   *  ARRAY, newest-first, 50 per page. The timestamp and ID form one
   *  deterministic cursor and are therefore accepted only as a pair.
   *  Reading this subscriber-linked feed requires both `read:reports`
   *  and `read:subscribers`. */
  list(cursor?: ConversionListCursor): Promise<ApiResult<ConversionRow[]>> {
    const params = new URLSearchParams();
    if (cursor) {
      params.set("before", cursor.before);
      params.set("before_id", String(cursor.beforeId));
    }
    const qs = params.toString();
    return request<ConversionRow[]>(`/api/v1/conversions${qs ? `?${qs}` : ""}`);
  },
  /** GET /api/v1/conversions/keys (admin) — BARE ARRAY. */
  listKeys(): Promise<ApiResult<ConversionTrackingKey[]>> {
    return request<ConversionTrackingKey[]>("/api/v1/conversions/keys");
  },
  /** POST /api/v1/conversions/keys (admin) — 201; plaintext is present in
   *  the creation response and its 24h idempotent replay, never the register. */
  createKey(
    label: string,
  ): Promise<ApiResult<{ key: ConversionTrackingKey; plaintext: string }>> {
    return request<{ key: ConversionTrackingKey; plaintext: string }>(
      "/api/v1/conversions/keys",
      { method: "POST", body: JSON.stringify({ label }) },
      { requireOnline: true },
    );
  },
  /** DELETE /api/v1/conversions/keys/{id} (admin) → `{ok:true}`. */
  revokeKey(id: string): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/conversions/keys/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
  /** GET /api/v1/conversions/ingest-secrets (admin) — no secret material. */
  listIngestSecrets(
    cursor?: string,
  ): Promise<ApiResult<ConversionIngestSecretListResponse>> {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    return request<ConversionIngestSecretListResponse>(
      `/api/v1/conversions/ingest-secrets?${params.toString()}`,
      { cache: "no-store" },
    );
  },
  /** POST /api/v1/conversions/ingest-secrets (admin) — secret shown once. */
  issueIngestSecret(
    label: string,
  ): Promise<ApiResult<ConversionIngestSecretIssueResponse>> {
    return request<ConversionIngestSecretIssueResponse>(
      "/api/v1/conversions/ingest-secrets",
      {
        method: "POST",
        body: JSON.stringify({ label }),
        cache: "no-store",
      },
      {
        requireOnline: true,
        maxAttempts: 1,
        // The 201 contains the only copy of this credential. Never queue,
        // retry, or place it in the server's generic replay ledger.
        idempotencyKey: null,
      },
    );
  },
  /** POST .../{keyID}/revoke (admin) — immediate, irreversible revocation. */
  revokeIngestSecret(keyID: string): Promise<ApiResult<{ revoked: boolean }>> {
    return request<{ revoked: boolean }>(
      `/api/v1/conversions/ingest-secrets/${encodeURIComponent(keyID)}/revoke`,
      { method: "POST", body: "{}", cache: "no-store" },
      { requireOnline: true, maxAttempts: 1 },
    );
  },
};

/* ---------- #34 Exports (exports) ------------------------------------ */
// Retention-policy GET/PATCH already live on the main `api` object
// (getExportRetentionPolicy / patchExportRetentionPolicy).

export interface TenantExportRow {
  id: string;
  status: string;
  include: string[];
  requested_by_email?: string;
  requested_by?: string;
  bytes_total: number;
  rows_total: number;
  download_url?: string;
  expires_at?: string;
  error?: string;
  created_at: string;
}

export const exportsApi = {
  /** POST /api/v1/exports (admin) — 202 {id, status:"queued", include}. */
  create(
    include: string[],
  ): Promise<ApiResult<{ id: string; status: string; include: string[] }>> {
    return request<{ id: string; status: string; include: string[] }>(
      "/api/v1/exports",
      { method: "POST", body: JSON.stringify({ include }) },
      { requireOnline: true },
    );
  },
  /** GET /api/v1/exports (admin) → `{exports}`. */
  list(): Promise<ApiResult<{ exports: TenantExportRow[] }>> {
    return request<{ exports: TenantExportRow[] }>("/api/v1/exports");
  },
  /** GET /api/v1/exports/{id} (admin) — includes download_url when ready. */
  get(id: string): Promise<ApiResult<TenantExportRow>> {
    return request<TenantExportRow>(
      `/api/v1/exports/${encodeURIComponent(id)}`,
    );
  },
};

/* ---------- #35 Warehouse (warehouse) -------------------------------- */

const warehouseApis = createWarehouseApis(request);
export const writebackApi = warehouseApis.writebackApi;
export const warehouseApi = warehouseApis.warehouseApi;

/* ---------- #36 Custom objects (customobjects) ------------------------ */
// NOTE: camelCase wire format (customobjects/types.go).

export interface CustomObjectType {
  id: string;
  tenantId: string;
  /** e.g. "order", "wishlist". */
  key: string;
  label: string;
  /** Which property is the natural id; default "external_id". */
  primaryKey: string;
  schema: Record<string, unknown>;
  /** active | deprecated | disabled */
  status: "active" | "deprecated" | "disabled";
  /** Monotonic compare-and-swap version used by every update/delete. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomObjectRecord {
  id: string;
  tenantId: string;
  objectTypeId: string;
  externalId: string;
  properties: Record<string, unknown>;
  /** Monotonic compare-and-swap version used by every update/delete. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomObjectRecordPage {
  items: CustomObjectRecord[];
  limit: number;
  hasMore: boolean;
}

export interface CustomObjectDeleteReceipt {
  deleted: true;
  id: string;
  expectedVersion: number;
}

export const customObjectsApi = {
  /** GET /api/v1/custom-objects/types → `{items}`. */
  listTypes(): Promise<ApiResult<{ items: CustomObjectType[] }>> {
    return request<{ items: CustomObjectType[] }>(
      "/api/v1/custom-objects/types",
    );
  },
  /** POST /api/v1/custom-objects/types — 201, returns the row. */
  createType(input: {
    key: string;
    label: string;
    primaryKey?: string;
    schema: Record<string, unknown>;
  }): Promise<ApiResult<CustomObjectType>> {
    return request<CustomObjectType>(
      "/api/v1/custom-objects/types",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
      { requireOnline: true },
    );
  },
  /** GET /api/v1/custom-objects/types/{id}. */
  getType(id: string): Promise<ApiResult<CustomObjectType>> {
    return request<CustomObjectType>(
      `/api/v1/custom-objects/types/${encodeURIComponent(id)}`,
    );
  },
  /** PUT /api/v1/custom-objects/types/{id}. */
  updateType(
    id: string,
    input: {
      label: string;
      schema: Record<string, unknown>;
      status: "active" | "deprecated" | "disabled";
      expectedVersion: number;
    },
  ): Promise<ApiResult<CustomObjectType>> {
    return request<CustomObjectType>(
      `/api/v1/custom-objects/types/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(input) },
      { requireOnline: true },
    );
  },
  /** DELETE /api/v1/custom-objects/types/{id}; exact-version + typed key. */
  deleteType(
    id: string,
    input: { expectedVersion: number; confirmationKey: string },
  ): Promise<ApiResult<CustomObjectDeleteReceipt>> {
    return request<CustomObjectDeleteReceipt>(
      `/api/v1/custom-objects/types/${encodeURIComponent(id)}`,
      { method: "DELETE", body: JSON.stringify(input) },
      { requireOnline: true },
    );
  },
  /** GET the unfiltered record page, or POST an exact filter in the request
   *  body so customer data never enters URLs, history, referrers, or logs. */
  listRecords(
    typeId: string,
    opts: { propertyKey?: string; propertyValue?: string; limit?: number } = {},
  ): Promise<ApiResult<CustomObjectRecordPage>> {
    const limit = opts.limit ?? 100;
    if (opts.propertyKey && opts.propertyValue) {
      return request<CustomObjectRecordPage>(
        `/api/v1/custom-objects/types/${encodeURIComponent(typeId)}/records/search`,
        {
          method: "POST",
          body: JSON.stringify({
            property: opts.propertyKey,
            value: opts.propertyValue,
            limit,
          }),
        },
        { requireOnline: true, idempotencyKey: null },
      );
    }
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    const qs = params.toString();
    return request<CustomObjectRecordPage>(
      `/api/v1/custom-objects/types/${encodeURIComponent(typeId)}/records?${qs}`,
    );
  },
  /** POST /api/v1/custom-objects/types/{id}/records — schema-validated
   *  upsert keyed on externalId; 422 with violations when invalid. */
  upsertRecord(
    typeId: string,
    input: {
      externalId: string;
      properties: Record<string, unknown>;
      /** Zero creates only; a positive value updates that exact version. */
      expectedVersion: number;
    },
  ): Promise<ApiResult<CustomObjectRecord>> {
    return request<CustomObjectRecord>(
      `/api/v1/custom-objects/types/${encodeURIComponent(typeId)}/records`,
      { method: "POST", body: JSON.stringify(input) },
      { requireOnline: true },
    );
  },
  /** GET /api/v1/custom-objects/records/{id}. */
  getRecord(id: string): Promise<ApiResult<CustomObjectRecord>> {
    return request<CustomObjectRecord>(
      `/api/v1/custom-objects/records/${encodeURIComponent(id)}`,
    );
  },
  /** DELETE /api/v1/custom-objects/records/{id}; exact-version + typed id. */
  deleteRecord(
    id: string,
    input: {
      expectedVersion: number;
      confirmationExternalId: string;
    },
  ): Promise<ApiResult<CustomObjectDeleteReceipt>> {
    return request<CustomObjectDeleteReceipt>(
      `/api/v1/custom-objects/records/${encodeURIComponent(id)}`,
      { method: "DELETE", body: JSON.stringify(input) },
      { requireOnline: true },
    );
  },
};

/* ---------- SUB-011 — custom-object profile links --------------------- *
 *
 * Binds custom object records (orders, reservations, B2B accounts…) to a
 * subscriber profile. Mirrors `customobjects.ProfileObjectLink` and its
 * params (apps/api/internal/customobjects/{types,profile_links}.go). The
 * per-profile list response denormalizes the linked record's type +
 * properties so the UI renders each card without a second round-trip.
 */
export interface ProfileObjectLink {
  id: string;
  tenantId: string;
  objectTypeId: string;
  objectRecordId: string;
  subscriberId?: string;
  subscriberEmail?: string;
  /** Free-text relationship label ("purchased", "owns", "related"). */
  relationship: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  /** Denormalized linked-record context (per-profile list only). */
  objectTypeKey?: string;
  objectTypeLabel?: string;
  externalId?: string;
  properties?: Record<string, unknown>;
}

export const subscriberCustomObjectsApi = {
  /** GET /api/v1/subscribers/{id}/custom-objects → `{items}`. */
  list(
    subscriberId: string | number,
  ): Promise<ApiResult<{ items: ProfileObjectLink[] }>> {
    return request<{ items: ProfileObjectLink[] }>(
      `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/custom-objects`,
    );
  },
  /** POST /api/v1/subscribers/{id}/custom-objects — link a record (201). */
  link(
    subscriberId: string | number,
    input: {
      objectRecordId: string;
      relationship?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ApiResult<ProfileObjectLink>> {
    return request<ProfileObjectLink>(
      `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/custom-objects`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  /** PATCH /api/v1/subscribers/{id}/custom-objects/{link_id}. */
  update(
    subscriberId: string | number,
    linkId: string,
    input: {
      relationship?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ApiResult<ProfileObjectLink>> {
    return request<ProfileObjectLink>(
      `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/custom-objects/${encodeURIComponent(linkId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  },
  /** DELETE /api/v1/subscribers/{id}/custom-objects/{link_id} — 204. */
  unlink(
    subscriberId: string | number,
    linkId: string,
  ): Promise<ApiResult<void>> {
    return request<void>(
      `/api/v1/subscribers/${encodeURIComponent(String(subscriberId))}/custom-objects/${encodeURIComponent(linkId)}`,
      { method: "DELETE" },
    );
  },
};

/* ---------- #37 CDP transforms (cdp_transforms) ----------------------- */

export interface CDPTransformOp {
  /** Registered op name, e.g. "regex_replace" — discover via ops(). */
  type: string;
  /** Dotted path for nested access ("address.country"). */
  field: string;
  args?: Record<string, unknown>;
}

export interface CDPTransformResult {
  op: CDPTransformOp;
  changed: boolean;
  old_value?: unknown;
  new_value?: unknown;
  error?: string;
}

export interface CDPTransformOutcome {
  properties: Record<string, unknown>;
  results: CDPTransformResult[];
  success: number;
  failed: number;
}

export const cdpTransformsApi = {
  /** POST /api/v1/cdp/transforms/preview — pure-function dry run. */
  preview(input: {
    properties: Record<string, unknown>;
    ops: CDPTransformOp[];
  }): Promise<ApiResult<CDPTransformOutcome>> {
    return request<CDPTransformOutcome>("/api/v1/cdp/transforms/preview", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  /** GET /api/v1/cdp/transforms/ops → `{ops}` registered op names. */
  ops(): Promise<ApiResult<{ ops: string[] }>> {
    return request<{ ops: string[] }>("/api/v1/cdp/transforms/ops");
  },
};

/* ---------- #33 Commerce suite (commerce) ----------------------------- */

export const commerceApi = createCommerceApi(request);
export const nextBestProductApi = createNextBestProductApi(request);
export const deliverabilityControlApi = createDeliverabilityControlApi(request);
export const optimizerRunsApi = createOptimizerRunsApi(request);
export const cohortsApi = createCohortsApi(request);
export const domainWarmupApi = createDomainWarmupApi(request);
export const botOpensApi = createBotOpensApi(request);
export const verificationApi = createVerificationApi(request);
export const activationExclusionsApi = createActivationExclusionsApi(request);
export const maintenanceWindowsApi = createMaintenanceWindowsApi(request);
export const feedbackApi = createfeedbackApi(request);
/**
 * Onboarding DECISIONS. Paired with `api.onboardingProgress()` above, which
 * stays the only source of done-ness: this client may record what a person
 * CHOSE, never that a setup step is complete.
 */
export const onboardingDecisionsApi = createOnboardingDecisionsApi(request);
export const sendSettingsApi = createSendSettingsApi(request);
export const profileTransformRulesApi = createprofileTransformRulesApi(request);

/* ---------- #38 Spam-trap guard (spam_trap_guard) --------------------- */

export interface SpamTrapHit {
  email: string;
  first_hit_at: string;
  last_hit_at: string;
  hit_count: number;
  subscriber_id?: string;
  status?: string;
}

export const spamTrapGuardApi = {
  /** GET /api/v1/spam-trap-guard/hits → `{hits, count}`. */
  hits(): Promise<ApiResult<{ hits: SpamTrapHit[]; count: number }>> {
    return request<{ hits: SpamTrapHit[]; count: number }>(
      "/api/v1/spam-trap-guard/hits",
    );
  },
  /** GET /api/v1/spam-trap-guard/stats. */
  stats(): Promise<
    ApiResult<{
      hits_last_30_days: number;
      blocklisted_count: number;
      eligible_now: number;
      observed_at: string;
    }>
  > {
    return request<{
      hits_last_30_days: number;
      blocklisted_count: number;
      eligible_now: number;
      observed_at: string;
    }>("/api/v1/spam-trap-guard/stats");
  },
  /** POST /api/v1/spam-trap-guard/run-now (admin) → mutation receipt. */
  runNow(): Promise<ApiResult<{ blocklisted: number; completed_at: string }>> {
    return request<{ blocklisted: number; completed_at: string }>(
      "/api/v1/spam-trap-guard/run-now",
      { method: "POST", body: JSON.stringify({}) },
      { timeoutMs: 30_000, maxAttempts: 1, requireOnline: true },
    );
  },
};

/* ---------- #39 Soft-bounce recovery (soft_bounce_recovery) ----------- */

export const softBounceRecoveryApi = {
  /** GET /api/v1/soft-bounce-recovery/stats. */
  stats(): Promise<
    ApiResult<{
      disabled_count: number;
      eligible_now: number;
      eligible_suppressions_now: number;
      recovery_window_days: number;
      automatic_reactivation_active: boolean;
    }>
  > {
    return request<{
      disabled_count: number;
      eligible_now: number;
      eligible_suppressions_now: number;
      recovery_window_days: number;
      automatic_reactivation_active: boolean;
    }>("/api/v1/soft-bounce-recovery/stats");
  },
  /** POST /api/v1/soft-bounce-recovery/run-now?window_days= (admin). */
  runNow(
    windowDays?: number,
  ): Promise<ApiResult<{ recovered: number; expired_suppressions: number }>> {
    const qs = windowDays != null ? `?window_days=${windowDays}` : "";
    return request<{ recovered: number; expired_suppressions: number }>(
      `/api/v1/soft-bounce-recovery/run-now${qs}`,
      { method: "POST", body: JSON.stringify({}) },
      { timeoutMs: 30_000, maxAttempts: 1, requireOnline: true },
    );
  },
};

/* ---------- #40 Intelligent retry (intelligent_retry) ----------------- */

export interface IntelligentRetryEvent {
  id: string;
  tenant_id: string;
  campaign_id: string;
  subscriber_email: string;
  reason: "frequency_cap";
  status: IntelligentRetryStatus;
  retry_after: string;
  attempts: number;
  breakdown?: Array<{
    rule_id?: string;
    rule_label?: string;
    skipped?: number;
  }>;
  created_at: string;
  updated_at: string;
}

export type IntelligentRetryStatus =
  | "pending"
  | "ready"
  | "retrying"
  | "retried"
  | "failed"
  | "dismissed";

export const intelligentRetryApi = {
  /** GET /api/v1/intelligent-retry/events?status=&limit= → `{items}`. */
  events(
    opts: { status?: IntelligentRetryStatus; limit?: number } = {},
  ): Promise<ApiResult<{ items: IntelligentRetryEvent[] }>> {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request<{ items: IntelligentRetryEvent[] }>(
      `/api/v1/intelligent-retry/events${qs ? `?${qs}` : ""}`,
    );
  },
  /** POST /api/v1/intelligent-retry/events/{id}/mark-ready (admin). */
  markReady(
    id: string,
    expectedUpdatedAt: string,
  ): Promise<ApiResult<IntelligentRetryEvent>> {
    return request<IntelligentRetryEvent>(
      `/api/v1/intelligent-retry/events/${encodeURIComponent(id)}/mark-ready`,
      {
        method: "POST",
        body: JSON.stringify({ expected_updated_at: expectedUpdatedAt }),
      },
      { requireOnline: true, maxAttempts: 1 },
    );
  },
  /** POST /api/v1/intelligent-retry/events/{id}/dismiss (admin). */
  dismiss(
    id: string,
    expectedUpdatedAt: string,
  ): Promise<ApiResult<IntelligentRetryEvent>> {
    return request<IntelligentRetryEvent>(
      `/api/v1/intelligent-retry/events/${encodeURIComponent(id)}/dismiss`,
      {
        method: "POST",
        body: JSON.stringify({ expected_updated_at: expectedUpdatedAt }),
      },
      { requireOnline: true, maxAttempts: 1 },
    );
  },
};

/* ---------- #41 ISP breakdown (isp_breakdown) ------------------------- */

export interface ISPBucket {
  isp: string;
  subscribers: number;
  sent: number;
  opens: number;
  clicks: number;
  bounces: number;
  complaints: number;
  open_rate: number;
  click_rate: number;
  bounce_rate: number;
  complaint_rate: number;
}

export const ispBreakdownApi = {
  /** GET /api/v1/isp-breakdown?days= → `{window_days, buckets}`. */
  tenant(
    days?: number,
  ): Promise<ApiResult<{ window_days: number; buckets: ISPBucket[] }>> {
    const qs = days != null ? `?days=${days}` : "";
    return request<{ window_days: number; buckets: ISPBucket[] }>(
      `/api/v1/isp-breakdown${qs}`,
    );
  },
  /** GET /api/v1/isp-breakdown/by-campaign/{id} → `{campaign_id, buckets}`. */
  byCampaign(
    campaignId: string | number,
  ): Promise<ApiResult<{ campaign_id: string; buckets: ISPBucket[] }>> {
    return request<{ campaign_id: string; buckets: ISPBucket[] }>(
      `/api/v1/isp-breakdown/by-campaign/${encodeURIComponent(String(campaignId))}`,
    );
  },
};

/* ---------- #42-#44 Deliverability service (proxied) ------------------ */
// Gateway mounts verified in apps/api/main.go:
//   GET  /api/v1/inbox-reality/campaigns/{id} → svc /v1/inbox-reality/campaigns/{id}
//   GET  /api/v1/auth-checks                  → svc /v1/auth-checks
//   POST /api/v1/diagnose/{campaign_id}       → svc /v1/diagnose/{campaign_id}
// All three carry read_reports scope and require the deliverability
// service to be configured — a 503 means "service not wired".

export interface PlacementProviderBreakdown {
  provider: string;
  total: number;
  /** placement → count; placements: inbox | spam | promotions | missing. */
  placements: Record<string, number>;
}

export interface CampaignPlacementReport {
  campaign_id: string;
  providers: PlacementProviderBreakdown[];
  /** placement → fraction (0..1). */
  overall_pct: Record<string, number>;
  total_inboxes: number;
  generated_at: string;
  diagnostic_id?: string;
  reports?: Array<{
    campaign_id: string;
    provider: string;
    mailbox_id: string;
    placement: string;
    checked_at: string;
  }>;
}

export interface AuthCheckRecord {
  /** ok | warn | fail */
  status: string;
  detail: string;
}

export interface AuthCheckMatrixRow {
  domain: string;
  spf: AuthCheckRecord;
  dkim: AuthCheckRecord;
  dmarc: AuthCheckRecord;
  bimi: AuthCheckRecord;
  ptr: AuthCheckRecord;
}

export interface DiagnosisFix {
  title: string;
  detail: string;
  /** dns_record | copy_change | image_swap | resend */
  action: string;
  dns_record?: Record<string, unknown>;
  /** 0..1 estimated added inbox-rate. */
  estimated_impact: number;
}

export interface CampaignDiagnosis {
  campaign_id: string;
  /** Markdown. */
  diagnosis: string;
  fixes: DiagnosisFix[];
  predicted_impact: Record<string, number>;
  generated_at: string;
}

/** Optional signals the caller can feed the diagnostician; every field
 *  the service doesn't receive it gathers/derives itself. */
export interface DiagnoseSignalsInput {
  campaign_id?: string;
  domain?: string;
  ip?: string;
  auth?: Partial<AuthCheckMatrixRow>;
  reputation?: Record<string, unknown>;
  content?: Record<string, unknown>;
  seedlist?: Partial<CampaignPlacementReport>;
}

export const inboxRealityCampaignsApi = {
  /** GET /api/v1/inbox-reality/campaigns/{id} (proxied) — 404 until a
   *  seedlist test has reported for the campaign. */
  report(
    campaignId: string | number,
    reqOpts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<CampaignPlacementReport>> {
    return request<CampaignPlacementReport>(
      `/api/v1/inbox-reality/campaigns/${encodeURIComponent(String(campaignId))}`,
      {},
      reqOpts,
    );
  },
};

export const authChecksApi = {
  /** GET /api/v1/auth-checks (proxied) — BARE ARRAY (one row per
   *  resolved sending domain; currently always length 1). DNS-bound,
   *  so it gets a longer timeout. */
  matrix(
    reqOpts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<AuthCheckMatrixRow[]>> {
    return request<AuthCheckMatrixRow[]>(
      "/api/v1/auth-checks",
      {},
      { timeoutMs: 20_000, ...reqOpts },
    );
  },
};

export const diagnosticianApi = {
  /** POST /api/v1/diagnose/{campaign_id} (proxied, LLM-backed) — 503
   *  with "LLM not wired" when the service has no model configured. */
  diagnose(
    campaignId: string | number,
    signals: DiagnoseSignalsInput = {},
    reqOpts: { signal?: AbortSignal } = {},
  ): Promise<ApiResult<CampaignDiagnosis>> {
    return request<CampaignDiagnosis>(
      `/api/v1/diagnose/${encodeURIComponent(String(campaignId))}`,
      { method: "POST", body: JSON.stringify(signals) },
      { ...LLM_REQUEST_OPTS, ...reqOpts },
    );
  },
};

/* ---------- #45 Blocklist auto-suppress (search pkg) ------------------- */

export const blocklistAutoSuppressApi = {
  /** GET /api/v1/blocklist/auto-suppress → setting + action preview. */
  get(): Promise<ApiResult<BlocklistAutoSuppressState>> {
    return request<BlocklistAutoSuppressState>(
      "/api/v1/blocklist/auto-suppress",
    );
  },
  /** PATCH /api/v1/blocklist/auto-suppress (admin) → mutation receipt. */
  set(autoSuppress: boolean): Promise<ApiResult<BlocklistAutoSuppressState>> {
    return request<BlocklistAutoSuppressState>(
      "/api/v1/blocklist/auto-suppress",
      {
        method: "PATCH",
        body: JSON.stringify({ auto_suppress: autoSuppress }),
      },
    );
  },
};

export interface BlocklistAutoSuppressState {
  auto_suppress: boolean;
  eligible_now: number;
  active_suppressions: number;
  observed_at: string;
}

/* ---------- #46 Per-list inbox reality (search pkg) -------------------- */

export interface ListInboxRealityRow {
  test_id: string;
  subject?: string;
  created_at: string;
  status: string;
  total_seeds: number;
  inbox: number;
  spam: number;
  missing: number;
  inbox_pct: number;
}

export const listsInboxRealityApi = {
  /** GET /api/v1/lists/{id}/inbox-reality?limit= → `{list_id, items}`. */
  list(
    listId: string | number,
    limit?: number,
  ): Promise<ApiResult<{ list_id: string; items: ListInboxRealityRow[] }>> {
    const qs = limit != null ? `?limit=${limit}` : "";
    return request<{ list_id: string; items: ListInboxRealityRow[] }>(
      `/api/v1/lists/${encodeURIComponent(String(listId))}/inbox-reality${qs}`,
    );
  },
};

/* ---------- #48 Firewall attack mode (firewall_attack_mode) ------------ */

export interface FirewallSettings {
  tenant_id: string;
  attack_mode_enabled: boolean;
  auto_attack_mode: boolean;
  fingerprint_required: boolean;
  attack_mode_threshold: number;
  surge_multiplier: number;
  surge_min_per_hour: number;
  attack_mode_auto_enabled_at?: string | null;
  attack_mode_auto_cooldown_until?: string | null;
  updated_at: string;
}

export interface FirewallSettingsInput {
  attack_mode_enabled?: boolean;
  auto_attack_mode?: boolean;
  fingerprint_required?: boolean;
  attack_mode_threshold?: number;
  surge_multiplier?: number;
  surge_min_per_hour?: number;
}

export interface FirewallEvent {
  id: string;
  form_id?: string;
  browser_fp_present: boolean;
  ua_quality: number;
  referer_quality: number;
  rate_5m: number;
  risk_score: number;
  action: string;
  ip?: string;
  user_agent?: string;
  at: string;
}

export interface FirewallStats {
  last_24h: { accepted: number; rejected: number; observed: number };
  last_7d: { accepted: number; rejected: number; observed: number };
}

export const firewallApi = {
  /** GET /api/v1/firewall/settings. */
  settings(): Promise<ApiResult<FirewallSettings>> {
    return request<FirewallSettings>("/api/v1/firewall/settings");
  },
  /** PUT /api/v1/firewall/settings (admin) — partial via pointers. */
  putSettings(
    input: FirewallSettingsInput,
  ): Promise<ApiResult<FirewallSettings>> {
    return request<FirewallSettings>("/api/v1/firewall/settings", {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  /** GET /api/v1/firewall/events?limit=&action= → `{events, count}`. */
  events(
    opts: { limit?: number; action?: string } = {},
  ): Promise<ApiResult<{ events: FirewallEvent[]; count: number }>> {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set("limit", String(opts.limit));
    if (opts.action) params.set("action", opts.action);
    const qs = params.toString();
    return request<{ events: FirewallEvent[]; count: number }>(
      `/api/v1/firewall/events${qs ? `?${qs}` : ""}`,
    );
  },
  /** GET /api/v1/firewall/stats. */
  stats(): Promise<ApiResult<FirewallStats>> {
    return request<FirewallStats>("/api/v1/firewall/stats");
  },
  /** POST /api/v1/firewall/detect (admin) — surge sweep → `{flipped}`. */
  detect(): Promise<ApiResult<{ flipped: boolean }>> {
    return request<{ flipped: boolean }>("/api/v1/firewall/detect", {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
};

/* ---------- #49 Onsite growth (onsite_growth) -------------------------- */

export interface OnsiteGrowthCatalog {
  schema_version: string;
  trigger_types: OmniCatalogItem[];
  targeting_groups: OmniCatalogItem[];
  frequency_modes: OmniCatalogItem[];
  experiment_modes: OmniCatalogItem[];
  winner_metrics: OmniCatalogItem[];
  spin_reward_types: OmniCatalogItem[];
  experiment_events: string[];
}

export interface OnsiteTargetingRules {
  id?: string;
  form_id?: string;
  status?: string;
  priority?: number;
  trigger?: Record<string, unknown>;
  frequency?: Record<string, unknown>;
  audience?: Record<string, unknown>;
  url_rules?: Record<string, unknown>;
  utm_rules?: Record<string, unknown>;
  cart_rules?: Record<string, unknown>;
  geo_rules?: Record<string, unknown>;
  device_rules?: Record<string, unknown>;
  visitor_state_rules?: Record<string, unknown>;
  custom_trigger_rules?: Record<string, unknown>;
  compiled?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface OnsiteExperimentVariant {
  id?: string;
  experiment_id?: string;
  key: string;
  name: string;
  traffic_weight_basis_points: number;
  is_control?: boolean;
  status?: string;
  form_snapshot?: Record<string, unknown>;
  success_behavior?: Record<string, unknown>;
  coupon_pool_id?: string;
  metrics?: Record<string, unknown>;
}

export interface OnsiteExperiment {
  id?: string;
  form_id?: string;
  key: string;
  name: string;
  status?: string;
  allocation_mode?: string;
  winner_metric?: string;
  adaptive_config?: Record<string, unknown>;
  winner_variant_id?: string;
  starts_at?: string | null;
  ends_at?: string | null;
  variants?: OnsiteExperimentVariant[];
  created_at?: string;
  updated_at?: string;
}

export interface OnsiteSpinReward {
  id?: string;
  form_id?: string;
  variant_id?: string;
  key: string;
  label: string;
  reward_type?: string;
  weight_basis_points: number;
  static_code?: string;
  coupon_pool_id?: string;
  success_step_key?: string;
  flow_branch_key?: string;
  display?: Record<string, unknown>;
  status?: string;
  sort_order?: number;
}

export interface OnsiteValidationResponse {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

export interface OnsiteSpinResolveResponse {
  reward: OnsiteSpinReward;
  coupon?: {
    code: string;
    pool_id: string;
    assignment_id?: string;
    expires_at?: string | null;
  };
  entropy_basis_points: number;
}

export const onsiteGrowthApi = {
  /** GET /api/v1/onsite-growth/catalog. */
  catalog(): Promise<ApiResult<OnsiteGrowthCatalog>> {
    return request<OnsiteGrowthCatalog>("/api/v1/onsite-growth/catalog");
  },
  /** POST /api/v1/onsite-growth/validate — any of targeting / experiment
   *  / spin_rewards in one bag. */
  validate(input: {
    targeting?: OnsiteTargetingRules;
    experiment?: OnsiteExperiment;
    spin_rewards?: OnsiteSpinReward[];
  }): Promise<ApiResult<OnsiteValidationResponse>> {
    return request<OnsiteValidationResponse>("/api/v1/onsite-growth/validate", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  /** GET /api/v1/onsite-growth/forms/{form_id}/targeting. */
  getTargeting(formId: string): Promise<ApiResult<OnsiteTargetingRules>> {
    return request<OnsiteTargetingRules>(
      `/api/v1/onsite-growth/forms/${encodeURIComponent(formId)}/targeting`,
    );
  },
  /** PUT /api/v1/onsite-growth/forms/{form_id}/targeting — 422 with the
   *  validation payload when invalid. */
  putTargeting(
    formId: string,
    input: OnsiteTargetingRules,
  ): Promise<ApiResult<OnsiteTargetingRules>> {
    return request<OnsiteTargetingRules>(
      `/api/v1/onsite-growth/forms/${encodeURIComponent(formId)}/targeting`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  },
  /** GET /api/v1/onsite-growth/forms/{form_id}/experiments → `{items}`. */
  listExperiments(
    formId: string,
  ): Promise<ApiResult<{ items: OnsiteExperiment[] }>> {
    return request<{ items: OnsiteExperiment[] }>(
      `/api/v1/onsite-growth/forms/${encodeURIComponent(formId)}/experiments`,
    );
  },
  /** PUT /api/v1/onsite-growth/forms/{form_id}/experiments/{key}. */
  upsertExperiment(
    formId: string,
    experimentKey: string,
    input: OnsiteExperiment,
  ): Promise<ApiResult<OnsiteExperiment>> {
    return request<OnsiteExperiment>(
      `/api/v1/onsite-growth/forms/${encodeURIComponent(formId)}/experiments/${encodeURIComponent(experimentKey)}`,
      { method: "PUT", body: JSON.stringify(input) },
    );
  },
  /** POST .../experiments/{key}/events — 202 `{ok, event_id}`. */
  recordExperimentEvent(
    formId: string,
    experimentKey: string,
    input: {
      event_type: string;
      variant_id?: string;
      reward_id?: string;
      subscriber_id?: string;
      email?: string;
      revenue_cents?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ApiResult<{ ok: boolean; event_id: string }>> {
    return request<{ ok: boolean; event_id: string }>(
      `/api/v1/onsite-growth/forms/${encodeURIComponent(formId)}/experiments/${encodeURIComponent(experimentKey)}/events`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },
  /** GET /api/v1/onsite-growth/forms/{form_id}/spin/rewards → `{items}`. */
  listSpinRewards(
    formId: string,
  ): Promise<ApiResult<{ items: OnsiteSpinReward[] }>> {
    return request<{ items: OnsiteSpinReward[] }>(
      `/api/v1/onsite-growth/forms/${encodeURIComponent(formId)}/spin/rewards`,
    );
  },
  /** PUT /api/v1/onsite-growth/forms/{form_id}/spin/rewards — full
   *  replace, body `{items}`. */
  replaceSpinRewards(
    formId: string,
    items: OnsiteSpinReward[],
  ): Promise<ApiResult<{ items: OnsiteSpinReward[] }>> {
    return request<{ items: OnsiteSpinReward[] }>(
      `/api/v1/onsite-growth/forms/${encodeURIComponent(formId)}/spin/rewards`,
      { method: "PUT", body: JSON.stringify({ items }) },
    );
  },
  /** POST /api/v1/onsite-growth/forms/{form_id}/spin/resolve — admin
   *  preview of the weighted spin (public form path exists separately). */
  resolveSpin(
    formId: string,
    input: {
      variant_id?: string;
      subscriber_id?: string;
      subscriber_email?: string;
      context_key?: string;
      render_key?: string;
      entropy_basis_points?: number;
      reservation_ttl_seconds?: number;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<ApiResult<OnsiteSpinResolveResponse>> {
    return request<OnsiteSpinResolveResponse>(
      `/api/v1/onsite-growth/forms/${encodeURIComponent(formId)}/spin/resolve`,
      { method: "POST", body: JSON.stringify(input) },
    );
  },
};

/* ---------- #50 Archive comments admin (archive_comments) -------------- */
// ALREADY WIRED: api.listArchiveComments / moderateArchiveComment /
// pinArchiveComment / unpinArchiveComment / deleteArchiveComment (see
// ArchiveCommentExtensions earlier in this file; types ArchiveComment +
// ArchiveCommentsListResponse, camelCase wire format). This grouped
// alias only re-exposes the same routes for UI agents that expect the
// per-domain object style; no new endpoints.

export const archiveCommentsAdminApi = {
  /** GET /api/v1/archive/comments?status=&campaignId=&limit= →
   *  `{items, total}` (flat moderation list, NOT the public tree). */
  list(opts: {
    status: ArchiveComment["status"];
    campaignId?: string;
    limit?: number;
  }): Promise<ApiResult<ArchiveCommentsListResponse>> {
    const params = new URLSearchParams();
    params.set("status", opts.status);
    if (opts.campaignId) params.set("campaignId", opts.campaignId);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    return request<ArchiveCommentsListResponse>(
      `/api/v1/archive/comments?${params.toString()}`,
    );
  },
  /** POST /api/v1/archive/comments/{id}/moderate — body `{status}`. */
  moderate(
    id: string,
    status: "visible" | "hidden" | "spam",
  ): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/archive/comments/${encodeURIComponent(id)}/moderate`,
      { method: "POST", body: JSON.stringify({ status }) },
    );
  },
  /** POST /api/v1/archive/comments/{id}/pin → `{ok, pinned:true}`. */
  pin(id: string): Promise<ApiResult<{ ok: boolean; pinned?: boolean }>> {
    return request<{ ok: boolean; pinned?: boolean }>(
      `/api/v1/archive/comments/${encodeURIComponent(id)}/pin`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },
  /** POST /api/v1/archive/comments/{id}/unpin → `{ok, pinned:false}`. */
  unpin(id: string): Promise<ApiResult<{ ok: boolean; pinned?: boolean }>> {
    return request<{ ok: boolean; pinned?: boolean }>(
      `/api/v1/archive/comments/${encodeURIComponent(id)}/unpin`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },
  /** DELETE /api/v1/archive/comments/{id} → `{ok}`. */
  remove(id: string): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/archive/comments/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
};

/* ---------- #52 Podcast tokens (podcast) -------------------------------- */

export interface PodcastSubscriberToken {
  tenant_id: string;
  subscriber_email: string;
  /** Raw secret — returned ONLY by the POST (mint/rotate); GET omits it. */
  token?: string;
  feed_url?: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
  created_at: string;
  updated_at: string;
}

export const podcastTokensApi = {
  /** GET /api/v1/podcast/subscribers/{email}/token (admin) — 404 when none. */
  get(email: string): Promise<ApiResult<PodcastSubscriberToken>> {
    return request<PodcastSubscriberToken>(
      `/api/v1/podcast/subscribers/${encodeURIComponent(email)}/token`,
    );
  },
  /** POST /api/v1/podcast/subscribers/{email}/token (admin) — mints or
   *  ROTATES; the raw secret is only returned here, never re-issued. */
  mint(email: string): Promise<ApiResult<PodcastSubscriberToken>> {
    return request<PodcastSubscriberToken>(
      `/api/v1/podcast/subscribers/${encodeURIComponent(email)}/token`,
      { method: "POST", body: JSON.stringify({}) },
      { requireOnline: true },
    );
  },
  /** DELETE /api/v1/podcast/subscribers/{email}/token (admin) → `{ok}`. */
  revoke(email: string): Promise<ApiResult<{ ok: boolean }>> {
    return request<{ ok: boolean }>(
      `/api/v1/podcast/subscribers/${encodeURIComponent(email)}/token`,
      { method: "DELETE" },
    );
  },
};

export const crmIntegrationsApi = createCrmIntegrationsApi(request, apiUrl);

export const leadIntegrationsApi = createLeadIntegrationsApi(request);
export const reviewIntegrationsApi = createReviewIntegrationsApi(request);
export const loyaltyIntegrationsApi = createLoyaltyIntegrationsApi(request);
export const subscriptionIntegrationsApi =
  createSubscriptionIntegrationsApi(request);
export const supportIntegrationsApi = createSupportIntegrationsApi(request);
export const analyticsIntegrationsApi = createAnalyticsIntegrationsApi(request);

/* ---------- Integrations catalog facade -------------------------------- */

export const integrationsApi = createIntegrationsCatalogApi(request);

const platformOperationsApis = createPlatformOperationsApis(request);
export const {
  apiUsageApi,
  billingApi,
  costsApi,
  featureFlagsApi,
  openApiSpecApi,
  regionsApi,
  searchApi,
} = platformOperationsApis;

/* ====================================================================
 * Roadmap build-tier wrappers (2026-06 follow-up).
 *
 * Every shape below was verified against the Go handlers — package
 * paths are noted per feature. Exported names + types are catalogued
 * in apps/desktop/ROADMAP-WRAPPERS.md (the manifest frontend agents
 * consume). Keep additions inside this block.
 * ================================================================== */

/* ---------- R1 Feed sources (feed_ingest) --------------------------- */

export const feedSourcesApi = createFeedSourcesApi(request);

/* ---------- R2 Engagement scores (subscriberscore) ------------------ */

/** GET …/engagement-score body. `score` is null when never computed. */
export interface EngagementScoreResponse {
  score: number | null;
  computed_at?: string;
}

/** One histogram bucket (subscriberscore.ScoreBucket). */
export interface EngagementScoreBucket {
  range: string;
  min: number;
  max: number;
  count: number;
}

export interface EngagementScoreSubscriber {
  id: string;
  email: string;
  score: number;
}

export const engagementScoresApi = {
  /** GET /api/v1/subscribers/{id}/engagement-score (404 → unknown subscriber). */
  get(subscriberId: string): Promise<ApiResult<EngagementScoreResponse>> {
    return request<EngagementScoreResponse>(
      `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/engagement-score`,
    );
  },
  /** GET /api/v1/engagement-scores/distribution → `{buckets}`. */
  distribution(): Promise<ApiResult<{ buckets: EngagementScoreBucket[] }>> {
    return request<{ buckets: EngagementScoreBucket[] }>(
      "/api/v1/engagement-scores/distribution",
    );
  },
  /** GET /api/v1/engagement-scores/subscribers?min=&max=&page=&per_page=
   *  → `{items,total,page,per_page}` (page/per_page echoed clamped). */
  subscribers(
    opts: { min?: number; max?: number; page?: number; perPage?: number } = {},
  ): Promise<
    ApiResult<{
      items: EngagementScoreSubscriber[];
      total: number;
      page: number;
      per_page: number;
    }>
  > {
    const params = new URLSearchParams();
    if (opts.min != null) params.set("min", String(opts.min));
    if (opts.max != null) params.set("max", String(opts.max));
    if (opts.page != null) params.set("page", String(opts.page));
    if (opts.perPage != null) params.set("per_page", String(opts.perPage));
    const qs = params.toString();
    return request(
      `/api/v1/engagement-scores/subscribers${qs ? `?${qs}` : ""}`,
    );
  },
};

/* ---------- R3 Analytics extras (analytics pkg, ExtendedDeps) ------- */

/** analytics.TemplateLeaderboardItem — rates are 0..1 fractions. */
export interface TemplateLeaderboardItem {
  template_id: string;
  template_name: string;
  campaigns_used: number;
  sent: number;
  opens: number;
  clicks: number;
  open_rate: number;
  click_rate: number;
}

/** analytics.FatigueDecile — open/unsub rates per send-frequency bucket. */
export interface FatigueDecile {
  sends_bucket: string;
  subscribers: number;
  open_rate: number;
  unsub_rate: number;
}

/** analytics.SubscriberFunnelStep — one labeled stage in the aggregate
 *  subscriber cohort funnel (SUB-128). conversion_rate is the percentage
 *  (0..100) reaching this stage from the prior one. */
export interface SubscriberFunnelStep {
  stage: "signup" | "first_purchase" | "repeat_purchase";
  label: string;
  count: number;
  conversion_rate: number;
}

/** analytics.CohortFunnelRow — one signup-month cohort in the subscriber
 *  cohort funnel (SUB-128). *_rate fields are conversion percentages
 *  (0..100) relative to the prior stage. */
export interface CohortFunnelRow {
  cohort_label: string;
  signup_count: number;
  first_purchase_count: number;
  repeat_purchase_count: number;
  first_purchase_rate: number;
  repeat_purchase_rate: number;
}

/** analytics.SubscriberFunnel — full subscriber cohort-funnel payload
 *  (SUB-128): aggregate stage roll-up (steps) + per-cohort breakdown. */
export interface SubscriberFunnel {
  bucket: "month";
  cohort_by: "created_at_month";
  steps: SubscriberFunnelStep[];
  cohorts: CohortFunnelRow[];
}

/** analytics.CrossChannelItem — channel is "email" | "sms". */
export interface CrossChannelTimelineItem {
  at: string;
  channel: string;
  type: string;
  label: string;
  campaign_id?: string;
  detail?: string;
}

export interface CrossChannelTimelineResponse {
  items: CrossChannelTimelineItem[];
  has_more: boolean;
  /** RFC3339Nano cursor — feed back as `before` for the next page. */
  next_before?: string;
}

export const analyticsExtrasApi = {
  /** GET /api/v1/analytics/template-leaderboard?days= (default 90) → `{items}`. */
  templateLeaderboard(
    opts: { days?: number } = {},
  ): Promise<ApiResult<{ items: TemplateLeaderboardItem[] }>> {
    if (
      opts.days != null &&
      (!Number.isSafeInteger(opts.days) || opts.days < 1 || opts.days > 365)
    ) {
      return Promise.resolve({
        error: {
          kind: "invalid_config",
          code: "invalid_template_leaderboard_days",
          message:
            "Template performance days must be an integer from 1 to 365.",
        },
      });
    }
    const qs =
      opts.days != null ? `?days=${encodeURIComponent(String(opts.days))}` : "";
    return request<{ items: TemplateLeaderboardItem[] }>(
      `/api/v1/analytics/template-leaderboard${qs}`,
    );
  },
  /** GET /api/v1/analytics/fatigue?days= (default 30) → `{deciles}`. */
  fatigue(
    opts: { days?: number } = {},
  ): Promise<ApiResult<{ deciles: FatigueDecile[] }>> {
    const qs =
      opts.days != null ? `?days=${encodeURIComponent(String(opts.days))}` : "";
    return request<{ deciles: FatigueDecile[] }>(
      `/api/v1/analytics/fatigue${qs}`,
    );
  },
  /** GET /api/v1/analytics/subscribers/funnel?cohort_by=&bucket=&weeks=&audience_id=
   *  → SubscriberFunnel (SUB-128). All params optional; backend defaults to
   *  cohort_by=created_at_month, bucket=month, weeks=12. audience_id scopes
   *  the funnel to a tagged audience cohort. */
  getSubscriberFunnel(
    opts: {
      cohortBy?: "created_at_month";
      bucket?: "month";
      weeks?: number;
      audienceId?: string;
    } = {},
  ): Promise<ApiResult<SubscriberFunnel>> {
    const params = new URLSearchParams();
    if (opts.cohortBy) params.set("cohort_by", opts.cohortBy);
    if (opts.bucket) params.set("bucket", opts.bucket);
    if (opts.weeks != null) params.set("weeks", String(opts.weeks));
    if (opts.audienceId) params.set("audience_id", opts.audienceId);
    const qs = params.toString();
    return request<SubscriberFunnel>(
      `/api/v1/analytics/subscribers/funnel${qs ? `?${qs}` : ""}`,
    );
  },
  /** GET /api/v1/subscribers/{id}/cross-channel-timeline?limit=&before=
   *  (id or email; 404 when unknown). */
  crossChannelTimeline(
    subscriberIdOrEmail: string,
    opts: { limit?: number; before?: string } = {},
  ): Promise<ApiResult<CrossChannelTimelineResponse>> {
    const params = new URLSearchParams();
    if (opts.limit != null) params.set("limit", String(opts.limit));
    if (opts.before) params.set("before", opts.before);
    const qs = params.toString();
    return request<CrossChannelTimelineResponse>(
      `/api/v1/subscribers/${encodeURIComponent(subscriberIdOrEmail)}/cross-channel-timeline${qs ? `?${qs}` : ""}`,
    );
  },
};

/* ---------- R4 Revenue attribution (conversions/attribution.go) ----- */

/** One campaign row; the 51st+ campaigns roll up into a single item
 *  with campaign_id:"" and campaign_name:"(other campaigns)". */
export interface RevenueAttributionItem {
  campaign_id: string;
  campaign_name: string;
  conversions: number;
  revenue_cents: number;
  emails_sent: number;
  /** Absent for the "(other campaigns)" rollup / zero-send rows. */
  revenue_per_send_cents?: number;
}

export interface RevenueCurrencyTotal {
  currency: string;
  conversions: number;
  revenue_cents: number;
}

export interface CampaignAttributionResponse {
  items: RevenueAttributionItem[];
  total_revenue_cents: number;
  unattributed_cents: number;
  unattributed_conversions: number;
  /** Dominant currency; empty/absent when totals span several. */
  currency?: string;
  currencies: RevenueCurrencyTotal[];
  /**
   * Distinct campaigns with attributed revenue in the window, BEFORE the
   * top-N rollup. When it exceeds the individually-listed (non-rollup)
   * rows, the UI honestly shows "top N of M". May be absent on older
   * backends (then the UI just omits the provenance line).
   */
  total_campaigns?: number;
  days: number;
}

export interface RevenueTimeseriesPoint {
  /** YYYY-MM-DD (UTC); the window is zero-filled (no gaps). */
  date: string;
  revenue_cents: number;
  conversions: number;
}

export interface RevenueTimeseriesResponse {
  points: RevenueTimeseriesPoint[];
  currency?: string;
  currencies: RevenueCurrencyTotal[];
  days: number;
  campaign_id?: string;
}

export const revenueAttributionApi = {
  /** GET /api/v1/conversions/attribution/campaigns?days= — top-50 +
   *  rollup; see {@link CampaignAttributionResponse}. */
  campaigns(
    opts: { days?: number } = {},
  ): Promise<ApiResult<CampaignAttributionResponse>> {
    const qs =
      opts.days != null ? `?days=${encodeURIComponent(String(opts.days))}` : "";
    return request<CampaignAttributionResponse>(
      `/api/v1/conversions/attribution/campaigns${qs}`,
    );
  },
  /** GET /api/v1/conversions/attribution/timeseries?days=&campaign_id= —
   *  zero-filled daily points. */
  timeseries(
    opts: { days?: number; campaignId?: string } = {},
  ): Promise<ApiResult<RevenueTimeseriesResponse>> {
    const params = new URLSearchParams();
    if (opts.days != null) params.set("days", String(opts.days));
    if (opts.campaignId) params.set("campaign_id", opts.campaignId);
    const qs = params.toString();
    return request<RevenueTimeseriesResponse>(
      `/api/v1/conversions/attribution/timeseries${qs ? `?${qs}` : ""}`,
    );
  },
};

export const reportingApi = createReportingApi(request);

export const reviewsApi = createReviewsApi(request);

export const serviceSuiteApi = createServiceSuiteApi(request);

export const agentRoutinesApi = createAgentRoutinesApi(request);

export const analyticsNlqApi = createAnalyticsNlqApi(request, LLM_REQUEST_OPTS);

export const voiceRoadmapApi = createVoiceRoadmapApi(request, {
  llmRequestOptions: LLM_REQUEST_OPTS,
  sequencePositionPathSegment,
});

export const smsBroadcastsApi = createSmsBroadcastsApi(
  request,
  () => getRememberedSession()?.tenant_id ?? null,
);

export const goalsApi = roadmapApi.createGoalsApi(request);

export const auditExportSchedulesApi =
  roadmapApi.createAuditExportSchedulesApi(request);

export const segmentInsightsApi = createSegmentInsightsApi(request, {
  apiUrl,
  createDownloadController,
  errorFromResponse,
  getApiKey,
  nativeFetch: apiIdentityAwareNativeFetch,
  normalizeApiKey,
  transportError,
});

/* Referrals leaderboard API extracted to api-client-roadmap.ts. */
export const referralsLeaderboardApi =
  roadmapApi.createReferralsLeaderboardApi(request);

/* Win-back settings API extracted to api-client-roadmap.ts. */
export const winbackSettingsApi = roadmapApi.createWinbackSettingsApi(request);

/* Merge API extracted to api-client-roadmap.ts. */
export const mergeApplyApi = roadmapApi.createMergeApplyApi(request);

/* Form variants API extracted to api-client-roadmap.ts. */
export const formVariantsApi = roadmapApi.createFormVariantsApi(request);

/* Landing pages API extracted to api-client-roadmap.ts. */
export const landingPagesApi = roadmapApi.createLandingPagesApi(request);

/* Social capture API extracted to api-client-roadmap.ts. */
export const socialCaptureApi = roadmapApi.createSocialCaptureApi(request);

/* Pre-send refine API extracted to api-client-roadmap.ts. */
export const presendRefineApi = roadmapApi.createPresendRefineApi(request);
