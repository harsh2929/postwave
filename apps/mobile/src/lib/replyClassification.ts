/**
 * lib/replyClassification.ts — labelling what a campaign reply was about.
 *
 * ── A CORRECTION TO THIS APP'S OWN NOTE ────────────────────────────────────
 * `lib/campaignReplies.ts` states: "A REPLY IS UNADDRESSABLE FROM THIS PAYLOAD…
 * the `recent` rows carry no `id`… That is a server-side gap, not a mobile one,
 * and it is why this surface is read-only."
 *
 * The first half is true and the conclusion is not. That payload comes from
 * `GET /api/v1/replies/by-campaign/{id}`, an ANALYTICS rollup. A different route —
 * `GET /api/v1/campaigns/{id}/replies` (campaign_replies.go:128) — returns rows
 * carrying `id`, `body_redacted`, `intent_label` and `classification`, which is
 * everything the classify endpoint needs. The addressable surface exists; mobile
 * was reading the wrong one for this purpose.
 *
 * ── THE TWO SERVER REFUSALS, MIRRORED ──────────────────────────────────────
 *  - 503 `classifier_unavailable` when no intent classifier is configured
 *    (campaign_replies.go:273-276). A deployment without one must not be offered
 *    a button; the control would fail identically every time.
 *  - 409 `reply_body_redacted` when the body has been erased
 *    (:288-290). Reply subject/envelope erasure is a governed privacy act, and a
 *    reclassify would ask a model to read evidence that was deliberately destroyed.
 *
 * Import-free of react-native, so it is node-tested.
 */

/** The labels the server accepts (campaign_replies.go:193). */
export const REPLY_INTENTS = [
  "question",
  "praise",
  "unsub",
  "ooo",
  "other",
] as const;

export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export const REPLY_INTENT_LABELS: Readonly<Record<ReplyIntent, string>> = {
  question: "Question",
  praise: "Praise",
  unsub: "Unsubscribe",
  ooo: "Out of office",
  other: "Other",
};

export interface CampaignReply {
  id: string;
  fromEmail: string;
  subject: string;
  receivedAt: string;
  intentLabel: string;
  bodyRedacted: boolean;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseCampaignReplies(payload: unknown): CampaignReply[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as Record<string, unknown>).items ??
          (payload as Record<string, unknown>).replies)
      : null;
  if (!Array.isArray(rows)) return [];
  const out: CampaignReply[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = str(row.id);
    // No id means the row came from the analytics rollup rather than the
    // addressable list; classifying it is impossible, so it is not shown here.
    if (!id) continue;
    out.push({
      id,
      fromEmail: str(row.from_email),
      subject: str(row.subject) || "(no subject)",
      receivedAt: str(row.received_at),
      intentLabel: str(row.intent_label) || str(row.classification),
      // Absent means NOT redacted; only an explicit true withholds the control,
      // and treating an unknown as redacted would hide a usable verb.
      bodyRedacted: row.body_redacted === true,
    });
  }
  return out;
}

/**
 * Whether this reply may be classified.
 *
 * A redacted body is a hard no: the server answers 409, and the reason is a
 * privacy act rather than a transient state — the evidence a classifier would read
 * was deliberately destroyed.
 */
export function replyIsClassifiable(reply: CampaignReply): boolean {
  return !reply.bodyRedacted;
}

/** Why a reply cannot be classified, for the row that cannot offer the control. */
export function replyClassifyBlockedReason(reply: CampaignReply): string | null {
  if (reply.bodyRedacted) {
    return "Body erased under a privacy request — it can't be reclassified.";
  }
  return null;
}

export function replyClassifyErrorMessage(
  code: string,
  fallback: string,
): string {
  switch (code) {
    case "classifier_unavailable":
      return "This deployment has no reply classifier configured, so intent can't be set.";
    case "reply_body_redacted":
      return "That reply's body was erased under a privacy request and can't be reclassified.";
    case "invalid_intent":
      return "That isn't an intent this workspace accepts.";
    default:
      return fallback;
  }
}
