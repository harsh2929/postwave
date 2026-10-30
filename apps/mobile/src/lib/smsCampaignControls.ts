/**
 * lib/smsCampaignControls.ts — which SMS campaign verb is legal right now.
 *
 * ── WHY THIS MATTERS MORE THAN THE EMAIL EQUIVALENT ────────────────────────
 * VERB#4: SMS campaign controls had no mobile surface at all —
 * `apps/mobile/app/(tabs)/sms/` held only the two-way inbox and suppressions. SMS is
 * the one channel that bills PER MESSAGE, so a send going out wrong costs money for
 * every second it continues, and the phone could not stop it. Of every gap in this
 * audit, this is the one with a running meter attached.
 *
 * ── THE SERVER'S TRANSITIONS, READ FROM THE SQL ────────────────────────────
 * Pause and cancel both go through `UpdateCampaignStatus` (store.go:1065), whose
 * UPDATE carries `AND status IN ('draft', 'scheduled', 'paused', 'sending')`
 * (store.go:1084). So a campaign already `cancelled`, `sent` or `failed` matches
 * nothing and the verb is a no-op that returns an error.
 *
 * Resume is a DIFFERENT statement (store.go:1107-1142) with `AND status = 'paused'`
 * — only a paused campaign resumes — and its target depends on whether recipients
 * remain queued: `sending` when some are pending, otherwise back to `draft`. That
 * is worth telling the operator, because resuming a campaign whose queue has
 * drained does NOT start sending again, and silently landing in `draft` would look
 * like the verb failed.
 *
 * Import-free of react-native, so every rule is node-tested.
 */

/** Statuses the store writes. */
export type SmsCampaignStatus =
  | "draft"
  | "scheduled"
  | "sending"
  | "paused"
  | "cancelled"
  | "sent"
  | "failed";

export type SmsCampaignVerb = "pause" | "resume" | "cancel" | "retry-failed";

/** The set the pause/cancel UPDATE matches (store.go:1084). */
export const SMS_MUTABLE_STATUSES = [
  "draft",
  "scheduled",
  "paused",
  "sending",
] as const;

function normalized(status: string): string {
  return status.trim().toLowerCase();
}

/** True when pause/cancel would match a row rather than silently doing nothing. */
export function smsCampaignIsMutable(status: string): boolean {
  return (SMS_MUTABLE_STATUSES as readonly string[]).includes(
    normalized(status),
  );
}

export function smsCampaignIsPaused(status: string): boolean {
  return normalized(status) === "paused";
}

/** True while the campaign is actively spending money. */
export function smsCampaignIsSending(status: string): boolean {
  return normalized(status) === "sending";
}

/**
 * The verbs to offer, in reading order.
 *
 * Cancel is last and only offered for a row the UPDATE would match. `retry-failed`
 * is deliberately NOT offered from this list: it re-sends to every failed
 * recipient, which spends money per message, and it belongs behind its own
 * confirmation with a count rather than beside pause in a row of links.
 */
export function smsCampaignVerbs(
  status: string,
  dispatchAvailable = false,
): SmsCampaignVerb[] {
  if (!smsCampaignIsMutable(status)) return [];
  if (smsCampaignIsPaused(status)) {
    return dispatchAvailable ? ["resume", "cancel"] : ["cancel"];
  }
  return ["pause", "cancel"];
}

export const SMS_VERB_LABELS: Readonly<Record<SmsCampaignVerb, string>> = {
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel",
  "retry-failed": "Retry failed",
};

export function smsVerbIsDestructive(verb: SmsCampaignVerb): boolean {
  return verb === "cancel" || verb === "retry-failed";
}

/**
 * What resuming will actually do.
 *
 * The server picks `sending` only when recipients are still queued, otherwise
 * `draft` (store.go:1123-1125). An operator who resumes a drained campaign and
 * lands in draft would reasonably think the button failed.
 */
export function smsResumeOutcomeCopy(pendingRecipients: number | null): string {
  if (pendingRecipients === null) {
    return "Resuming sends to whoever is still queued. If the queue has drained, the campaign returns to draft instead.";
  }
  return pendingRecipients > 0
    ? `Resuming sends to ${pendingRecipients} queued recipient${pendingRecipients === 1 ? "" : "s"}.`
    : "No recipients are still queued, so resuming returns this campaign to draft rather than sending anything.";
}

/** The confirmation for a destructive SMS verb. */
export function smsVerbConfirmCopy(
  verb: SmsCampaignVerb,
  campaignName: string,
): { title: string; body: string; confirmLabel: string } {
  if (verb === "retry-failed") {
    return {
      title: `Retry failed messages for ${campaignName}?`,
      body: "Every failed recipient is sent to again. SMS bills per message, so this costs money immediately.",
      confirmLabel: "Retry failed",
    };
  }
  return {
    title: `Cancel ${campaignName}?`,
    body: "Queued messages stop. Anything already handed to the carrier may still arrive, and cancelling cannot be undone.",
    confirmLabel: "Cancel campaign",
  };
}

/** Operator-facing sentence for a failed SMS control call. */
export function smsVerbErrorMessage(status: number, fallback: string): string {
  if (status === 409 || status === 422) {
    return "This campaign moved on before the change landed. Pull to refresh to see where it is now.";
  }
  if (status === 403) {
    return "Your role doesn't allow changing SMS campaigns. Ask a workspace admin.";
  }
  return fallback;
}
