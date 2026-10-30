import { rawRequest, type AIApiResult } from "./request";

/** Mirrors `settings.Workspace` (Go) — display-level workspace prefs. */
export interface WorkspaceSettings {
  tenant_id?: string;
  display_name?: string | null;
  default_reply_to?: string | null;
  timezone?: string;
  /** Non-pointer on the Go side (settings.Workspace), so always present. */
  date_format?: string;
  brand_color?: string | null;
  logo_url?: string | null;
  updated_by_user_id?: string | null;
  updated_at?: string;
}

export interface WorkspaceSettingsPatch {
  display_name?: string;
  default_reply_to?: string;
  timezone?: string;
  /** One of settings.allowedDateFormats; anything else is 400 bad_date_format. */
  date_format?: string;
  brand_color?: string;
  logo_url?: string;
}

export async function getWorkspaceSettings(): Promise<
  AIApiResult<WorkspaceSettings>
> {
  return rawRequest<WorkspaceSettings>("GET", "/api/v1/settings/workspace");
}

export async function patchWorkspaceSettings(
  patch: WorkspaceSettingsPatch,
): Promise<AIApiResult<WorkspaceSettings>> {
  return rawRequest<WorkspaceSettings>(
    "PATCH",
    "/api/v1/settings/workspace",
    patch,
  );
}

/** Mirrors `settings.NotificationPrefs` (Go). */
export interface NotificationPrefs {
  user_id?: string;
  tenant_id?: string;
  email_on_send_complete: boolean;
  email_on_approval_request: boolean;
  email_on_bounce_alert: boolean;
  /** "daily" | "weekly" | "never". Backend rejects others with 400. */
  digest_frequency: string;
  /**
   * Usage/spend alert threshold, as a percent of a plan limit (BILL-038).
   *
   * The Go field is `*int` with `omitempty`
   * (apps/api/internal/settings/notifications.go:35), so an unset threshold
   * is ABSENT from the JSON, not 0 — which is why this is optional and
   * nullable rather than `number`. Absent means "no alert configured";
   * rendering it as 0% would claim the user asked to be warned at zero
   * usage.
   */
  usage_alert_threshold_pct?: number | null;
  /** Whether crossing the threshold also sends an email. */
  email_on_usage_alert?: boolean;
  updated_at?: string;
}

export interface NotificationPrefsPatch {
  email_on_send_complete?: boolean;
  email_on_approval_request?: boolean;
  email_on_bounce_alert?: boolean;
  digest_frequency?: "daily" | "weekly" | "never";
  /**
   * 0 CLEARS the threshold (disables the alert), 1..100 sets it, and
   * omitting the key leaves it untouched — the three-way contract is
   * implemented in the handler's `$7` CASE
   * (apps/api/internal/settings/notifications.go:150-152 maps a nil pointer
   * to the sentinel -1 = "leave as-is"). Never send `null`: Go decodes it to
   * a nil pointer, i.e. "leave as-is", not "clear".
   */
  usage_alert_threshold_pct?: number;
  email_on_usage_alert?: boolean;
}

export async function getNotificationPrefs(): Promise<
  AIApiResult<NotificationPrefs>
> {
  return rawRequest<NotificationPrefs>("GET", "/api/v1/settings/notifications");
}

export async function patchNotificationPrefs(
  patch: NotificationPrefsPatch,
): Promise<AIApiResult<NotificationPrefs>> {
  return rawRequest<NotificationPrefs>(
    "PATCH",
    "/api/v1/settings/notifications",
    patch,
  );
}

/** What the test-send answers on success (`{"sent": true, "to": "…"}`). */
export interface NotificationTestResult {
  sent?: boolean;
  /** The address the server actually mailed — echo it, never assume it. */
  to?: string;
}

/**
 * Send a sample notification to the signed-in user's own address.
 *
 * The third sibling of GET/PATCH on the same object
 * (apps/api/internal/settings/notifications.go MountRoutes), and the only one
 * mobile lacked — so a user could change which emails Moosewave sends them and
 * had no way to learn whether any of them arrive. The server distinguishes
 * three outcomes a caller must not flatten into one: 503 `mailer_unavailable`
 * (this deployment has no mailer), 422 `no_email` (this account has no address
 * to send to), and a genuine 5xx.
 *
 * `kind` is optional server-side and only selects the sample copy —
 * "digest" describes the periodic rollup, anything else the plain notification.
 */
export async function sendTestNotification(
  kind: "category" | "digest" = "category",
): Promise<AIApiResult<NotificationTestResult>> {
  return rawRequest<NotificationTestResult>(
    "POST",
    "/api/v1/settings/notifications/test",
    { kind },
  );
}

/** Mirrors `settings.RetentionPolicy` (Go). */
export interface RetentionPolicy {
  tenant_id?: string;
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

export async function getRetentionPolicy(): Promise<
  AIApiResult<RetentionPolicy>
> {
  return rawRequest<RetentionPolicy>("GET", "/api/v1/settings/privacy");
}

export async function patchRetentionPolicy(
  patch: RetentionPolicyPatch,
): Promise<AIApiResult<RetentionPolicy>> {
  return rawRequest<RetentionPolicy>(
    "PATCH",
    "/api/v1/settings/privacy",
    patch,
  );
}

/**
 * Event-type catalog, kept as a re-export so there is exactly ONE client copy.
 *
 * This used to be its own hand-maintained 7-item array whose comment claimed to
 * mirror `AllowedEvents` in apps/api/internal/outbound_webhooks/outbound_webhooks.go
 * — and it had silently fallen two entries behind it (`subscriber.unsubscribed`,
 * `list.subscriber.added`). The single source of truth is now
 * `OUTBOUND_WEBHOOK_EVENT_FALLBACK`, which a colocated contract test diffs
 * against the Go array on every run; the create form prefers the live catalog
 * from GET /api/v1/outbound-webhooks/playground/events and only falls back to
 * it. Keeping a second literal here is exactly how the drift happened.
 */
export { OUTBOUND_WEBHOOK_EVENT_FALLBACK as OUTBOUND_WEBHOOK_EVENTS } from "@/lib/outboundWebhookForm";

export interface OutboundWebhook {
  id: string;
  tenant_id?: string;
  url: string;
  description?: string;
  events: string[];
  active: boolean;
  created_by_user_id?: string;
  created_at: string;
  updated_at?: string;
  last_succeeded_at?: string | null;
  last_failed_at?: string | null;
  consecutive_failures: number;
}

export interface OutboundWebhookCreateInput {
  url: string;
  description?: string;
  events: string[];
}

export interface OutboundWebhookCreateResponse {
  webhook: OutboundWebhook;
  signing_secret: string;
}

export interface OutboundWebhookTestResult {
  webhook_id?: string;
  status_code: number;
  signed: boolean;
  signature?: string;
  response?: string;
  response_body?: string;
  error?: string;
}

export async function listOutboundWebhooks(): Promise<
  AIApiResult<{ webhooks: OutboundWebhook[] }>
> {
  return rawRequest<{ webhooks: OutboundWebhook[] }>(
    "GET",
    "/api/v1/outbound-webhooks",
  );
}

export async function createOutboundWebhook(
  input: OutboundWebhookCreateInput,
): Promise<AIApiResult<OutboundWebhookCreateResponse>> {
  return rawRequest<OutboundWebhookCreateResponse>(
    "POST",
    "/api/v1/outbound-webhooks",
    input,
  );
}

export async function deleteOutboundWebhook(
  id: string,
): Promise<AIApiResult<{ ok: boolean; soft?: boolean }>> {
  return rawRequest<{ ok: boolean; soft?: boolean }>(
    "DELETE",
    `/api/v1/outbound-webhooks/${encodeURIComponent(id)}`,
  );
}

export async function testOutboundWebhook(
  id: string,
): Promise<AIApiResult<OutboundWebhookTestResult>> {
  return rawRequest<OutboundWebhookTestResult>(
    "POST",
    `/api/v1/outbound-webhooks/${encodeURIComponent(id)}/test`,
    {},
  );
}
