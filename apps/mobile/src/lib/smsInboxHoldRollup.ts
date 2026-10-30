/**
 * smsInboxHoldRollup — the inbox-level sentence for an unresolved encrypted
 * SMS reply intent.
 *
 * The mobile intent store holds AT MOST ONE unresolved reply intent, globally
 * (a deliberate PII-minimised design: the record carries hashes, not a phone).
 * So the inbox roll-up is one banner, not a list: whether a hold exists,
 * whether it belongs to this workspace identity, and — when one of the rows
 * already on screen hashes to the held thread — which conversation to open.
 * Every sentence keeps the store's own invariant: a hold is only cleared on
 * server-authoritative evidence, so the copy never suggests retrying.
 */
import type { SmsInboxHoldSummary } from "./smsReplyIntentStore";

export interface SmsInboxHoldBanner {
  tone: "warning" | "danger";
  text: string;
  /** Set when a visible row carries the hold — tapping opens that thread. */
  targetPhone?: string | undefined;
}

export function smsInboxHoldBanner(
  summary: SmsInboxHoldSummary,
  matchedPhone: string | null,
): SmsInboxHoldBanner | null {
  if (summary.status === "none") return null;
  if (summary.status === "storage_unavailable") {
    return {
      tone: "danger",
      text: "The encrypted reply-intent safeguard could not be verified. Sending stays locked everywhere; do not recreate or resend a prior draft.",
    };
  }
  const stateLine =
    summary.state === "reconciliation_required"
      ? "its provider outcome is still uncertain"
      : "its dispatch outcome was never confirmed";
  if (summary.status === "other_identity") {
    return {
      tone: "warning",
      text: `Another workspace identity holds an unresolved SMS reply intent (${stateLine}). New replies from this device stay locked until it is resolved there.`,
    };
  }
  if (matchedPhone) {
    return {
      tone: "warning",
      text: `An unresolved reply safeguard is held on the conversation with ${matchedPhone} — ${stateLine}. New replies everywhere are locked; open the thread to resolve it.`,
      targetPhone: matchedPhone,
    };
  }
  return {
    tone: "warning",
    text: `An unresolved reply safeguard is held on a conversation not in this view (${stateLine}). New replies everywhere are locked until it is resolved from its thread.`,
  };
}
