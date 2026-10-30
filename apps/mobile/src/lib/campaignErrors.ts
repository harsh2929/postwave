/**
 * lib/campaignErrors.ts — one place that turns an API failure into a sentence
 * an operator can act on.
 *
 * ErrorState.tsx documents the app's policy explicitly ("Raw error — used to
 * derive a fallback message; never shown verbatim") and the campaigns list
 * honours it. The detail screen and all six `Alert.alert` error paths in the
 * cluster did not: they rendered `err.message` straight through, so a phone
 * operator saw HTTP/transport text instead of what to do next.
 *
 * Mapping is by status code plus the API's machine-readable `code` field,
 * which the gateway sets on every error envelope.
 */
import { assuranceRefusal } from "@/lib/campaignAssuranceGate";

export interface CampaignErrorShape {
  status?: unknown;
  code?: unknown;
  message?: unknown;
}

/** Extract the HTTP status an API error carries, or 0 when it has none. */
export function campaignErrorStatus(err: unknown): number {
  if (err && typeof err === "object" && "status" in err) {
    const n = Number((err as CampaignErrorShape).status);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Extract the API's machine-readable error code, or "" when absent. */
export function campaignErrorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const raw = (err as CampaignErrorShape).code;
    if (typeof raw === "string") return raw;
  }
  return "";
}

/** True when the error means "this campaign no longer exists". */
export function isCampaignMissingError(err: unknown): boolean {
  return campaignErrorStatus(err) === 404;
}

/**
 * Human message for a campaign API failure.
 *
 * `fallback` is what an unrecognised failure renders — pass something the
 * screen can say truthfully, e.g. "Couldn't schedule the campaign."
 */
export function campaignErrorMessage(err: unknown, fallback: string): string {
  const code = campaignErrorCode(err);

  // Campaign Assurance refuses a send with five distinct codes spread across
  // three statuses (handlers_queue.go:133-157) — `_required`, `_pending` and
  // `_stale` all arrive as 409. Mapping those by status sent a BLOCKED operator to
  // "pull to refresh", which cannot clear a finding, so the code decides here
  // before the status switch ever sees it. The sentences and the remedy each code
  // admits live in campaignAssuranceGate.
  const refusal = assuranceRefusal(code);
  if (refusal) return refusal.sentence;

  // Code-specific cases first: the same status can mean different things.
  switch (code) {
    case "campaign_dispatch_state_owned":
      // NOT a transient condition. The gateway rejects ANY authoring write
      // carrying `status` or `scheduled_at` — verified by the passing Go test
      // TestGenericAuthoringRejectsDispatchOwnedState in
      // apps/api/internal/campaigns/authoring_input_test.go, which asserts 422
      // for `PATCH {scheduled_at}` and even for `{scheduled_at: null}`.
      // Desktop's drag-to-reschedule hits the same wall. Saying "right now"
      // implied a hiccup worth retrying; the honest answer names what DOES
      // work from here.
      return "This deployment doesn't accept a scheduled time from a client — the delivery system owns it. You can still send this campaign now, or set the schedule from the web app.";
    case "campaign_not_draft":
      return "Only draft campaigns can be deleted. Cancel it instead.";
    case "ambiguous_audience":
      return "This campaign targets both a list and a segment. Pick one on the web app.";
    case "list_not_found":
      return "The audience list on this campaign no longer exists.";
    case "segment_not_found":
      return "The segment on this campaign no longer exists.";
    case "duplicate_subject":
      return "The resend needs a subject different from the original.";
    default:
      break;
  }

  switch (campaignErrorStatus(err)) {
    case 0:
      // No status at all — almost always a transport failure on mobile.
      return `${fallback} Check your connection and try again.`;
    case 401:
      return "Your session expired. Sign in again to continue.";
    case 403:
      return "Your role doesn't allow this. Ask a workspace admin to do it.";
    case 404:
      return "This campaign no longer exists — it may have been deleted.";
    case 409:
      return "This campaign changed since you opened it. Pull to refresh and try again.";
    case 422:
      return `${fallback} The campaign isn't in a state that allows it.`;
    case 423:
      return "Sending is paused for this workspace. Contact a workspace admin.";
    case 429:
      return "Too many requests. Wait a moment and try again.";
    default:
      break;
  }

  if (campaignErrorStatus(err) >= 500) {
    return `${fallback} The server had a problem — try again shortly.`;
  }
  return fallback;
}
