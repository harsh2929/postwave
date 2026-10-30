/**
 * lib/campaignAbVariants.ts — the multivariate axis rules for the A/B
 * hand-off, and the payload builder the hook posts.
 *
 * Pure on purpose (the eventBus → eventBusStream idiom): the hook in
 * hooks/useCampaignAbHandoff.ts owns react-query and navigation; everything
 * that can be wrong about the REQUEST lives here where node vitest can reach
 * it.
 *
 * SERVER FACTS THIS MODULE MIRRORS (apps/api/internal/campaigns/abtest.go):
 *   - `from_name_variants` is a multivariate axis (G14): when it carries 2+
 *     names the test becomes the cross-product subjects × from-names.
 *   - the cross-product is capped at 8 combos (`abMaxCombos = 8`,
 *     abtest.go:80) — the server 400s above it, so the client refuses BEFORE
 *     the POST, the same way abHandoffBlockReason refuses a missing audience.
 *   - blanks are dropped server-side (`trimNonEmpty`), so they are dropped
 *     here too and never counted toward the cap.
 *   - a single from-name is NOT an axis. Desktop sends the axis only at 2+
 *     lines (useCampaignCreation.ts:367-377); one name crossed with anything
 *     is just a scalar from_name, and sending it as an axis would relabel
 *     every variant for nothing.
 */

/** `abMaxCombos` server-side (abtest.go:80). */
export const AB_MAX_COMBOS = 8;

/** One from-name per line, trimmed, blanks dropped — desktop's exact parse. */
export function parseFromNameVariants(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * How many campaign rows the server would create. From-names below 2 fall
 * back to the scalar field, i.e. an axis length of 1 (abtest.go axisLen).
 */
export function abComboCount(
  subjectCount: number,
  fromNameCount: number,
): number {
  const subjects = Math.max(0, subjectCount);
  const fromNames = fromNameCount >= 2 ? fromNameCount : 1;
  return subjects * fromNames;
}

/**
 * Non-null when the cross-product cannot be posted. Evaluated BEFORE the
 * request so the operator keeps the variants instead of losing them to a 400.
 */
export function abComboBlockReason(
  subjectCount: number,
  fromNames: readonly string[],
): string | null {
  const combos = abComboCount(subjectCount, fromNames.length);
  if (combos <= AB_MAX_COMBOS) return null;
  return `${subjectCount} subjects × ${fromNames.length} from-names is ${combos} combinations — the server caps a test at ${AB_MAX_COMBOS}. Remove a from-name or a subject.`;
}

/** The caption under the from-names field: what the cross-product will be. */
export function abComboCaption(
  subjectCount: number,
  fromNames: readonly string[],
): string {
  if (fromNames.length === 0) {
    return "Optional: one from-name per line. With 2+ names, variants become the cross-product of subjects × from-names (capped at 8).";
  }
  if (fromNames.length === 1) {
    return "One from-name is used as the sender for every variant. Add a second line to test sender identity.";
  }
  const combos = abComboCount(Math.max(2, subjectCount), fromNames.length);
  return `${Math.max(2, subjectCount)} subjects × ${fromNames.length} from-names = ${combos} variant${combos === 1 ? "" : "s"} (capped at ${AB_MAX_COMBOS}).`;
}

/**
 * `delivery_settings` for the one-tap bandit — the exact object desktop's
 * runBandit sends (useCampaignCreation.ts:415-421). The server stores this
 * map verbatim on the parent, so the client must not invent fields.
 */
export const AB_BANDIT_DELIVERY_SETTINGS = {
  ab_test: {
    bandit: true,
    policy: "thompson_opens",
    explore_floor: 0.1,
  },
} as const;

/** The campaign fields the payload builder reads. Structural so lib stays pure. */
export interface AbHandoffCampaignFields {
  id: string;
  name?: string | null | undefined;
  subject?: string | null | undefined;
  body_html?: string | null | undefined;
  body_mjml?: string | null | undefined;
  plain_text?: string | null | undefined;
  preview_text?: string | null | undefined;
  from_name?: string | null | undefined;
  reply_to?: string | null | undefined;
  list_id?: string | null | undefined;
  segment_id?: string | null | undefined;
}

export interface AbHandoffOptions {
  splitPercentage: number | null;
  /** 2+ entries make the test multivariate; fewer are ignored as an axis. */
  fromNameVariants?: readonly string[] | undefined;
  /** One-tap bandit: Thompson sampling on opens with a 10% explore floor. */
  bandit?: boolean | undefined;
}

/** Matches api/abTests.ts ABTestCreateInput without importing the api module. */
export interface AbHandoffPayload {
  name: string;
  subject_variants: string[];
  body_html: string;
  body_mjml?: string;
  plain_text?: string;
  preview_text?: string;
  from_name?: string;
  from_name_variants?: string[];
  reply_to?: string;
  audience_list_id?: string;
  audience_segment_id?: string;
  split_percentage?: number;
  delivery_settings?: Record<string, unknown>;
}

function trimmed(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * Build the POST /api/v1/campaigns/ab-test body from the campaign being
 * edited. Optional fields are OMITTED, never sent empty — the previous inline
 * version established that contract and the checkpoint test pins it.
 *
 * When the from-name AXIS is active the scalar `from_name` is omitted: the
 * server ignores the scalar once the axis is populated (buildABCombos), and
 * sending both would misstate which sender identity each arm carries.
 */
export function buildAbHandoffPayload(
  campaign: AbHandoffCampaignFields,
  variants: readonly string[],
  options: AbHandoffOptions,
): AbHandoffPayload {
  const bodyMjml = trimmed(campaign.body_mjml);
  const plainText = trimmed(campaign.plain_text);
  const previewText = trimmed(campaign.preview_text);
  const fromName = trimmed(campaign.from_name);
  const replyTo = trimmed(campaign.reply_to);
  const listId = trimmed(campaign.list_id);
  const segmentId = trimmed(campaign.segment_id);
  const fromNames = (options.fromNameVariants ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const axisActive = fromNames.length >= 2;
  return {
    name: (campaign.name ?? campaign.subject ?? "Untitled") + " A/B",
    subject_variants: [...variants],
    body_html: trimmed(campaign.body_html),
    ...(bodyMjml ? { body_mjml: bodyMjml } : {}),
    ...(plainText ? { plain_text: plainText } : {}),
    ...(previewText ? { preview_text: previewText } : {}),
    ...(axisActive
      ? { from_name_variants: fromNames }
      : fromName
        ? { from_name: fromName }
        : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(listId ? { audience_list_id: listId } : {}),
    ...(segmentId ? { audience_segment_id: segmentId } : {}),
    ...(options.splitPercentage !== null
      ? { split_percentage: options.splitPercentage }
      : {}),
    ...(options.bandit
      ? {
          delivery_settings: AB_BANDIT_DELIVERY_SETTINGS as unknown as Record<
            string,
            unknown
          >,
        }
      : {}),
  };
}
