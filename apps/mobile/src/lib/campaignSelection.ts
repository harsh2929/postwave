/**
 * lib/campaignSelection.ts — the rules of multi-select on the campaigns list.
 *
 * Desktop has had select-all-on-page plus bulk delete / move / tag / CSV for
 * a long time (apps/desktop/src/pages/campaigns/useCampaignBulkActions.ts).
 * A phone cannot copy that shape — there is no header checkbox column and a
 * twelve-column CSV download is not a phone artefact — but the three verbs
 * that genuinely belong on a phone (tag a batch, file a batch, delete dead
 * drafts) all need the same thing first: a selection.
 *
 * Everything here is pure and import-free so it can be unit-tested in the
 * node vitest environment. The screen owns the array; this module owns what
 * may be done with it.
 *
 * THE TWO SERVER FACTS THAT SHAPE IT
 *
 *   1. DELETE IS DRAFT-ONLY. apps/api/internal/campaigns returns
 *      ErrDeleteRequiresDraft → 409 `campaign_not_draft` for anything that has
 *      left draft. A bulk delete that fires at a mixed selection therefore
 *      half-succeeds by design, which is precisely the outcome a phone must
 *      not report as "Deleted 7 campaigns". The selection is partitioned
 *      BEFORE the round trips, the sheet states the split, and the result
 *      names the failures.
 *   2. BULK TAG IS ALL-OR-NOTHING AND CAPPED AT 500.
 *      `bulkOrgTag` (campaigns/org_tags.go:153) rejects an empty list or one
 *      over 500 with a 400, and runs the inserts inside ONE transaction — so
 *      unlike delete it either tags everything or nothing.
 */

/** Hard ceiling from campaigns/org_tags.go:176 (`bad_count`). */
export const CAMPAIGN_BULK_TAG_MAX = 500;

/**
 * A phone ceiling, not a server one. Beyond this a "selection" stops being
 * something anyone reviewed before acting on it, and the honest answer is to
 * do it on desktop where the whole set is visible at once.
 */
export const CAMPAIGN_SELECTION_MAX = 100;

/** GET /api/v1/analytics/campaigns/compare accepts up to 25 (handlers.go:376). */
export const CAMPAIGN_COMPARE_MAX = 25;

/**
 * Comparing more than this on a phone produces columns too narrow to read.
 * Deliberately lower than the server's 25: side-by-side is the point.
 */
export const CAMPAIGN_COMPARE_PHONE_MAX = 3;

export interface SelectableCampaign {
  id: string;
  name?: string | undefined;
  subject?: string | undefined;
  status?: string | undefined;
}

/** Add or remove one id, preserving selection order (oldest tap first). */
export function toggleCampaignSelection(
  selected: readonly string[],
  id: string,
): string[] {
  return selected.includes(id)
    ? selected.filter((s) => s !== id)
    : [...selected, id];
}

/**
 * Drop ids that are no longer in the loaded list.
 *
 * Without this, a refetch that removes a campaign leaves a phantom id in the
 * selection and the count in the action bar disagrees with the number of
 * highlighted rows — and a bulk verb then fires at something the operator
 * cannot see.
 */
export function pruneCampaignSelection(
  selected: readonly string[],
  visibleIds: readonly string[],
): string[] {
  const present = new Set(visibleIds);
  return selected.filter((id) => present.has(id));
}

/** The rows behind a selection, in the order they appear in the list. */
export function selectedCampaigns<T extends SelectableCampaign>(
  rows: readonly T[],
  selected: readonly string[],
): T[] {
  const wanted = new Set(selected);
  return rows.filter((r) => wanted.has(String(r.id)));
}

/** A row's display name, used in every bulk confirmation and result line. */
export function campaignSelectionLabel(c: SelectableCampaign): string {
  const name = (c.name ?? "").trim();
  if (name) return name;
  const subject = (c.subject ?? "").trim();
  return subject || "Untitled";
}

export interface DeletePartition {
  /** Drafts — the only status the server will delete. */
  deletable: SelectableCampaign[];
  /** Everything else, kept so the sheet can say what it will NOT touch. */
  blocked: SelectableCampaign[];
}

/**
 * Split a selection into what delete can actually act on.
 *
 * Mirrors `isDraftCampaignStatus`, deliberately re-implemented here rather
 * than imported so this module stays free of the campaign hooks graph. The
 * status vocabulary is the one in lib/campaignFormat's CAMPAIGN_STATUSES.
 */
export function partitionDeletable(
  rows: readonly SelectableCampaign[],
): DeletePartition {
  const deletable: SelectableCampaign[] = [];
  const blocked: SelectableCampaign[] = [];
  for (const row of rows) {
    const status = (row.status ?? "").trim().toLowerCase();
    // An absent status is NOT assumed to be a draft: guessing here would send
    // a delete at a campaign that may already be sending.
    if (status === "draft") deletable.push(row);
    else blocked.push(row);
  }
  return { deletable, blocked };
}

export interface BulkOutcome {
  /** Labels of the items that succeeded. */
  succeeded: string[];
  /** Labels of the items that failed, each with the reason the server gave. */
  failed: { label: string; reason: string }[];
}

/**
 * One sentence describing a partially-applied bulk action.
 *
 * "Deleted 5 of 7" with no further detail is the failure mode this exists to
 * prevent — the operator cannot tell WHICH two survived, so they have to
 * re-scan the list. Up to three failures are named; beyond that the count
 * stands in, because a toast that quotes forty names is not read.
 */
export function bulkOutcomeMessage(
  outcome: BulkOutcome,
  verb: { done: string; doing: string },
): string {
  const okCount = outcome.succeeded.length;
  const failCount = outcome.failed.length;
  if (failCount === 0) {
    return `${verb.done} ${okCount} ${okCount === 1 ? "campaign" : "campaigns"}.`;
  }
  if (okCount === 0) {
    const only = outcome.failed[0];
    if (failCount === 1 && only) {
      return `Couldn't ${verb.doing} "${only.label}" — ${only.reason}`;
    }
    return `Couldn't ${verb.doing} any of the ${failCount} selected campaigns.`;
  }
  const named = outcome.failed
    .slice(0, 3)
    .map((f) => `"${f.label}"`)
    .join(", ");
  const rest = failCount > 3 ? ` and ${failCount - 3} more` : "";
  return `${verb.done} ${okCount} of ${okCount + failCount}. ${named}${rest} ${
    failCount === 1 ? "was" : "were"
  } left unchanged.`;
}

/**
 * Why a bulk verb is unavailable for the current selection, or null when it
 * is available. Returned as a SENTENCE because it is rendered next to the
 * disabled control — a greyed-out button with no reason is the thing this
 * app's other screens were audited for.
 */
export function bulkTagBlockedReason(count: number): string | null {
  if (count === 0) return "Select campaigns to tag them.";
  if (count > CAMPAIGN_BULK_TAG_MAX) {
    return `Tagging is capped at ${CAMPAIGN_BULK_TAG_MAX} campaigns at a time.`;
  }
  return null;
}

/** Same, for the compare action. */
export function compareBlockedReason(count: number): string | null {
  if (count < 2) return "Select two campaigns to compare them side by side.";
  if (count > CAMPAIGN_COMPARE_PHONE_MAX) {
    return `Compare shows up to ${CAMPAIGN_COMPARE_PHONE_MAX} campaigns side by side on a phone.`;
  }
  return null;
}
