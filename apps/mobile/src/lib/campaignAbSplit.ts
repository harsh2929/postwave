/**
 * lib/campaignAbSplit.ts — the A/B hand-off's split percentage, and whether
 * the hand-off can run at all.
 *
 * Two gaps this closes, both pure so they are unit-tested rather than
 * re-derived inside a modal handler:
 *
 *  1. SPLIT WAS UNREACHABLE. `ABTestCreateInput` has carried
 *     `split_percentage` since the endpoint shipped (src/api/abTests.ts) and
 *     the Go handler validates it 0–100 (apps/api/internal/campaigns/
 *     abtest.go:496), but mobile never sent it — so every test on a phone was
 *     an even split, and a "send 10% now, the winner to the rest" test could
 *     only be started from a desk.
 *  2. THE HAND-OFF COULD ONLY FAIL. `createABTest` rejects a body with
 *     neither `audience_list_id` nor `audience_segment_id`
 *     (abtest.go:492-494). A campaign with no audience therefore produced a
 *     validation error AFTER the AI variants had streamed and the operator
 *     had committed to the action. That is knowable before the tap.
 */

/**
 * A split option offered in the hand-off.
 *
 * `key` is a string because SegmentedControl is generic over `T extends
 * string` (its selection indicator keys an offsets map by value). `percent`
 * is the wire value: `null` means "omit split_percentage" so the server
 * computes the even split.
 */
export interface AbSplitOption {
  key: AbSplitKey;
  percent: number | null;
  label: string;
}

export type AbSplitKey = "even" | "10" | "20" | "50";

/**
 * The offered splits. "Even" is `null` so the payload omits the field and the
 * server computes 100/N — which is a different, correct answer for two arms
 * (50) than for three (33), and one the client should not duplicate.
 */
export const AB_SPLIT_OPTIONS: readonly AbSplitOption[] = [
  { key: "even", percent: null, label: "Even" },
  { key: "10", percent: 10, label: "10%" },
  { key: "20", percent: 20, label: "20%" },
  { key: "50", percent: 50, label: "50%" },
];

/** The wire value for a chosen key; `null` omits the field. */
export function splitPercentForKey(key: string): number | null {
  return AB_SPLIT_OPTIONS.find((o) => o.key === key)?.percent ?? null;
}

/**
 * The even split the server would compute for `variantCount` arms, used for
 * the caption under the control so "Even" is never an opaque word.
 * Mirrors `splitPct = 100 / n` in abtest.go:310.
 */
export function evenSplitPercent(variantCount: number): number | null {
  if (!Number.isFinite(variantCount) || variantCount < 2) return null;
  return Math.floor(100 / variantCount);
}

/** Human sentence describing what the chosen split will do. */
export function splitCaption(
  split: number | null,
  variantCount: number,
): string {
  if (split === null) {
    const even = evenSplitPercent(variantCount);
    return even === null
      ? "Each variant gets an equal share of the audience."
      : `Each of the ${variantCount} variants gets about ${even}% of the audience.`;
  }
  return `Each variant is sent to ${split}% of the audience; the rest is held for the winner.`;
}

/** True when the value is a split the API will accept. */
export function isValidSplitPercentage(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

export interface AbHandoffAudience {
  list_id?: string | null | undefined;
  segment_id?: string | null | undefined;
}

/**
 * Why the A/B hand-off cannot run, or null when it can.
 *
 * The server requires an audience; discovering that only after the create
 * POST means the operator loses the streamed variants to a validation error.
 */
export function abHandoffBlockReason(
  campaign: AbHandoffAudience | null | undefined,
): string | null {
  const list = (campaign?.list_id ?? "").trim();
  const segment = (campaign?.segment_id ?? "").trim();
  if (list.length > 0 || segment.length > 0) return null;
  return "This campaign has no list or segment yet. Set its audience on the web app before splitting it into an A/B test.";
}
