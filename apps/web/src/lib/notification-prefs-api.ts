// SPDX-License-Identifier: AGPL-3.0-only
//
// Client for per-user notification preferences in the workspace settings area.
// Keeping this domain wrapper out of lib/api.ts lets that file stay focused on
// shared transport, auth, and offline replay behavior.

import { api } from "./api";

/** Notification categories, each deliverable over email / in-app / webhook. */
export type NotificationCategory =
  | "send_complete"
  | "approval_request"
  | "bounce_alert"
  | "deliverability_alert"
  | "usage_alert";

/** Webhook payload flavor; both send a Slack-compatible `{ text }` body. */
export type WebhookKind = "slack" | "generic";

export interface NotificationPrefs {
  user_id: string;
  tenant_id: string;
  email_on_send_complete: boolean;
  email_on_approval_request: boolean;
  email_on_bounce_alert: boolean;
  /** Blocklist-hit / reputation-drop alerts (INBOX-036). */
  email_on_deliverability_alert: boolean;
  email_on_usage_alert?: boolean;
  // SETC-037 in-app channel (feed + web/mobile push). Defaults on — it preserves
  // the pre-split delivery behavior, where email_on_* also gated the feed/push.
  inapp_on_send_complete?: boolean;
  inapp_on_approval_request?: boolean;
  inapp_on_bounce_alert?: boolean;
  inapp_on_deliverability_alert?: boolean;
  inapp_on_usage_alert?: boolean;
  // SETC-037 webhook channel (opt-in). Fires only when the flag is on AND a
  // notification_webhook_url is set.
  webhook_on_send_complete?: boolean;
  webhook_on_approval_request?: boolean;
  webhook_on_bounce_alert?: boolean;
  webhook_on_deliverability_alert?: boolean;
  webhook_on_usage_alert?: boolean;
  notification_webhook_url?: string;
  notification_webhook_kind?: WebhookKind;
  digest_frequency: string;
  /** Usage-alert threshold % (BILL-038); absent/undefined = disabled. */
  usage_alert_threshold_pct?: number | null;
  updated_at?: string;
}

export interface NotificationPrefsPatch {
  email_on_send_complete?: boolean;
  email_on_approval_request?: boolean;
  email_on_bounce_alert?: boolean;
  email_on_deliverability_alert?: boolean;
  email_on_usage_alert?: boolean;
  inapp_on_send_complete?: boolean;
  inapp_on_approval_request?: boolean;
  inapp_on_bounce_alert?: boolean;
  inapp_on_deliverability_alert?: boolean;
  inapp_on_usage_alert?: boolean;
  webhook_on_send_complete?: boolean;
  webhook_on_approval_request?: boolean;
  webhook_on_bounce_alert?: boolean;
  webhook_on_deliverability_alert?: boolean;
  webhook_on_usage_alert?: boolean;
  /** Empty string clears the destination; a value sets it (https public host). */
  notification_webhook_url?: string;
  notification_webhook_kind?: WebhookKind;
  digest_frequency?: "daily" | "weekly" | "never";
  /** 0 disables, 1..100 sets the threshold. */
  usage_alert_threshold_pct?: number;
}

/** Result of a test-notification send (SETC-053). */
export interface SendTestResult {
  sent: boolean;
  to: string;
}

export const notificationPrefsApi = {
  get: () => api.get<NotificationPrefs>("/api/v1/settings/notifications"),
  patch: (patch: NotificationPrefsPatch) =>
    api.patch<NotificationPrefs>("/api/v1/settings/notifications", patch),
  /** Send a sample notification email to the signed-in user (SETC-053). */
  sendTest: (kind: "category" | "digest" = "category") =>
    api.post<SendTestResult>("/api/v1/settings/notifications/test", { kind }),
};
