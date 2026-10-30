// Typed client for the feedback surface — mounted at /api/v1/feedback
// (apps/api/internal/feedback). The engine records every ESP bounce and
// complaint (Postmark / SendGrid / RFC5965 ARF webhooks ingest them over
// HMAC-signed internal routes) and exposes a single operator-facing read:
// the per-subscriber deliverability history. That surface shipped with no client,
// so operators couldn't see WHY a given address stopped receiving mail. This
// is the client layer the desktop Deliverability > Feedback panel drives.
// Shapes match the endpoint's deliberately minimal response projection: raw
// provider payloads, tenant ids, and the queried mailbox are never returned.
// Both arrays are always present and are empty when no evidence exists.
import type { ApiRequester, ApiResult } from "./result";

// A permanent (hard) vs. transient (soft) vs. temporary (transient) failure.
export type BounceType = "hard" | "soft" | "transient";

// fbl = RFC5965 ARF feedback loop; spam = Postmark/SendGrid spamreport;
// abuse = direct abuse-desk report.
export type ComplaintType = "abuse" | "fbl" | "spam";

export interface BounceEvent {
  id?: number; // int64; omitted when 0 (json omitempty) — treat as optional
  bounce_type: BounceType;
  esp: string; // e.g. "postmark", "sendgrid"
  esp_message_id?: string; // omitempty (server COALESCEs null -> "", so may be "")
  received_at: string; // RFC3339 timestamp, ordered DESC, max 200 rows
}

export interface ComplaintEvent {
  id?: number; // int64; omitempty
  complaint_type: ComplaintType;
  esp?: string; // omitempty
  esp_message_id?: string; // omitempty
  received_at: string; // RFC3339, DESC, max 200 rows
}

// FeedbackHistory is the history envelope: both arrays are always present (never
// null); each is empty when the subscriber has no events of that kind.
export interface FeedbackHistory {
  bounces: BounceEvent[];
  complaints: ComplaintEvent[];
}

const BASE = "/api/v1/feedback";

// createfeedbackApi wires typed methods over the operator-facing admin route.
export function createfeedbackApi(request: ApiRequester) {
  return {
    // The mailbox travels in a POST body, never in a URL, request-target log,
    // history entry, or intermediary cache key. The server canonicalizes it.
    getHistory(email: string): Promise<ApiResult<FeedbackHistory>> {
      return request<FeedbackHistory>(`${BASE}/history`, {
        method: "POST",
        body: JSON.stringify({ email }),
      });
    },
  };
}

export type FeedbackApi = ReturnType<typeof createfeedbackApi>;
