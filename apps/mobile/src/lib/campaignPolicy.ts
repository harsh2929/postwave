/**
 * lib/campaignPolicy.ts — the campaign rules that are pure decisions, not
 * network calls.
 *
 * These lived in src/hooks/useCampaigns.ts. That module now transitively
 * imports react-native (through lib/connectivity, for the offline snapshot),
 * so it can no longer be imported in the node vitest environment — and the
 * suite that covered these helpers stopped being able to load them. Per the
 * app's own testing contract, pure policy lives in an import-free module.
 *
 * The hook modules re-export everything here, so no call site changes.
 */
import { plural } from "@/lib/format";


/** Server page size for the campaigns list. */
export const CAMPAIGN_PAGE_SIZE = 100;

const DRAFT = "draft";

/**
 * Which page to ask for next. A short page means the server has no more rows,
 * so returning undefined is what stops an infinite fetch loop at the end of
 * the list.
 */
export function nextCampaignPage(
  lastPage: readonly unknown[],
  allPages: readonly (readonly unknown[])[],
): number | undefined {
  return lastPage.length < CAMPAIGN_PAGE_SIZE ? undefined : allPages.length + 1;
}

export function isDraftCampaignStatus(
  status: string | undefined | null,
): boolean {
  return status?.toLowerCase() === DRAFT;
}

export type CampaignLifecycleAction = "pause" | "resume" | "cancel";

/** The lifecycle transitions the gateway will accept from a given status. */
export function campaignLifecycleActions(
  status: string | null | undefined,
): CampaignLifecycleAction[] {
  switch ((status ?? "").toLowerCase()) {
    case "scheduled":
    case "sending":
      return ["pause", "cancel"];
    case "paused":
      return ["resume", "cancel"];
    case "draft":
      return ["cancel"];
    default:
      return [];
  }
}

/**
 * Deliberately lenient email shape check for the test-send recipient field.
 * Trims; requires a single `@` with non-empty local + domain parts and a dot
 * in the domain. Not RFC-complete — the gateway is the real validator — just
 * enough to catch obvious typos before a round trip.
 */
export function isValidTestEmail(raw: string | undefined | null): boolean {
  const v = (raw ?? "").trim();
  if (!v || v.length > 254) return false;
  const at = v.indexOf("@");
  if (at <= 0 || at !== v.lastIndexOf("@")) return false;
  const domain = v.slice(at + 1);
  if (!domain || /\s/.test(v)) return false;
  const dot = domain.indexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

/**
 * Copy for the post-resend success toast. Falls back to `non_openers_total`
 * when the queued count is absent, and reads cleanly when there were no
 * non-openers to chase.
 */
export function resendSummaryMessage(res: {
  recipients_queued?: number | undefined;
  non_openers_total?: number | undefined;
}): string {
  const n = res.recipients_queued ?? res.non_openers_total ?? 0;
  if (n <= 0) {
    return "No non-openers to resend to — everyone who received this campaign opened it.";
  }
  return `Queued a follow-up to ${plural(n, "non-opener")}. The clone is in your campaigns list.`;
}
