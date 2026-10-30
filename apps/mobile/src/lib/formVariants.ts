/**
 * lib/formVariants.ts — form display-optimization (A/B) presentation policy.
 *
 * Server contract (apps/api/internal/form_variants):
 *   GET /api/v1/forms/{id}/variants             read:reports
 *   GET /api/v1/forms/{id}/variants/promotions  read:reports
 *   (create/update/delete/evaluate are ADMIN and stay off mobile)
 *
 * Note the read scope: `read:reports`, NOT the `read:campaigns` the rest of
 * the forms screen uses. A token that can read the form can legitimately be
 * refused here, so a 403 is an expected answer and gets its own sentence.
 *
 * The honesty rule this module enforces: a z-score is meaningless below the
 * server's own sample floor. `form_variants.MinSampleForPromotion` is 200
 * impressions per arm, and its comment says why — "two variants at 0% vs 100%
 * have z = +inf but tell us nothing". So `significant` is reported as false
 * until BOTH arms clear that floor, no matter what z says, and the UI shows
 * "collecting" rather than a confident winner.
 *
 * Import-free so the statistics gating is unit-testable.
 */

/** Mirrors form_variants.MinSampleForPromotion. */
export const MIN_IMPRESSIONS_PER_ARM = 200;
/** Mirrors form_variants.ConfidenceZ (two-tailed alpha = 0.05). */
export const CONFIDENCE_Z = 1.96;

export interface FormVariantWire {
  id: string;
  formId?: string;
  label?: string;
  trafficPct?: number;
  status?: string;
  promotedAt?: string | null;
  lastZScore?: number;
  impressions?: number;
  submissions?: number;
  /** 0..1 on the wire. */
  conversionRate?: number;
}

export interface FormVariantPromotionWire {
  id: string;
  winnerVariantId?: string;
  winnerRate?: number;
  runnerUpRate?: number;
  zScore?: number;
  winnerImpressions?: number;
  runnerUpImpressions?: number;
  decidedAt?: string;
}

export interface FormVariantRow {
  id: string;
  label: string;
  status: "exploring" | "promoted" | "paused" | "unknown";
  statusLabel: string;
  impressions: number;
  submissions: number;
  /** 0..1 */
  rate: number;
  trafficPct: number;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function rate01(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

const STATUS_LABELS: Record<string, string> = {
  exploring: "Exploring",
  promoted: "Promoted",
  paused: "Paused",
};

export function normalizeFormVariants(
  wire: FormVariantWire[] | null | undefined,
): FormVariantRow[] {
  if (!Array.isArray(wire)) return [];
  return wire
    .filter((v): v is FormVariantWire => Boolean(v && typeof v.id === "string"))
    .map((v, index) => {
      const status = (v.status ?? "").trim().toLowerCase();
      const known =
        status === "exploring" || status === "promoted" || status === "paused";
      return {
        id: v.id,
        label: v.label?.trim() || `Variant ${index + 1}`,
        status: known ? (status as FormVariantRow["status"]) : "unknown",
        statusLabel: STATUS_LABELS[status] ?? "Unknown",
        impressions: int(v.impressions),
        submissions: int(v.submissions),
        rate: rate01(v.conversionRate),
        trafficPct: int(v.trafficPct),
      };
    });
}

export interface FormVariantVerdict {
  /** True only when a leader clears the sample floor AND the z cutoff. */
  significant: boolean;
  /** Winner row id, or null while there is no defensible leader. */
  leaderId: string | null;
  /** The sentence to render under the badge. Never "no winner yet" alone. */
  hint: string;
  /** True when at least one arm is still below the sample floor. */
  collecting: boolean;
}

/**
 * Decide whether the test has actually said anything.
 *
 * Order matters: the sample floor is checked BEFORE the z-score, because a
 * z-score computed on a handful of impressions is exactly the number that
 * makes a UI claim a winner it does not have.
 */
export function formVariantVerdict(
  rows: readonly FormVariantRow[],
  latestPromotion: FormVariantPromotionWire | null | undefined,
): FormVariantVerdict {
  if (rows.length < 2) {
    return {
      significant: false,
      leaderId: null,
      collecting: false,
      hint:
        rows.length === 0
          ? "No display variants are configured for this form."
          : "Only one variant — there is nothing to compare it against.",
    };
  }
  const promoted = rows.find((r) => r.status === "promoted");
  const sorted = [...rows].sort((a, b) => b.rate - a.rate);
  const leader = sorted[0];
  const runnerUp = sorted[1];
  if (!leader || !runnerUp) {
    return {
      significant: false,
      leaderId: null,
      collecting: true,
      hint: "Not enough data yet.",
    };
  }

  const shortfall = rows.filter(
    (r) => r.impressions < MIN_IMPRESSIONS_PER_ARM,
  ).length;
  if (shortfall > 0) {
    return {
      significant: false,
      leaderId: promoted?.id ?? null,
      collecting: true,
      hint: `Still collecting: ${shortfall === 1 ? "one variant has" : `${shortfall} variants have`} fewer than ${MIN_IMPRESSIONS_PER_ARM} impressions, which is the floor below which a result means nothing.`,
    };
  }

  const z =
    typeof latestPromotion?.zScore === "number" &&
    Number.isFinite(latestPromotion.zScore)
      ? Math.abs(latestPromotion.zScore)
      : null;
  if (z === null) {
    return {
      significant: false,
      leaderId: promoted?.id ?? leader.id,
      collecting: false,
      hint: "Enough traffic, but this form has not been evaluated yet. Run the evaluation from desktop.",
    };
  }
  if (z < CONFIDENCE_Z) {
    return {
      significant: false,
      leaderId: promoted?.id ?? leader.id,
      collecting: false,
      hint: "Leading, but not by enough to call. The arms are still within noise of each other.",
    };
  }
  return {
    significant: true,
    leaderId: latestPromotion?.winnerVariantId ?? promoted?.id ?? leader.id,
    collecting: false,
    hint: "95% confident this variant converts better.",
  };
}

/** Human sentence for a failed variants read. */
export function formVariantsErrorMessage(
  status: number,
  fallback?: string | undefined,
): string {
  if (status === 403) {
    // A DIFFERENT scope from the rest of the forms screen — see the header.
    return "Variant results need reporting access. Ask an admin.";
  }
  if (status === 404 || status === 405 || status === 501) {
    return "This deployment doesn't expose form display variants.";
  }
  return fallback?.trim() || "Couldn't load variant results.";
}

/**
 * Whether the variants section renders NOTHING at all.
 *
 * Route-absent statuses (404/405/501) hide it for everyone — a workspace that
 * never used display optimisation, a deployment without the routes, and a
 * token without read:reports should all leave the screen exactly as it was.
 * An empty, settled read hides it too, EXCEPT for an actionable admin, whose
 * card hosts the "Add variant" entry.
 */
export function formVariantsSectionHidden(input: {
  errorStatus: number;
  loading: boolean;
  rowCount: number;
  actionable: boolean;
}): boolean {
  if (
    input.errorStatus === 404 ||
    input.errorStatus === 405 ||
    input.errorStatus === 501
  ) {
    return true;
  }
  return (
    !input.loading &&
    input.errorStatus === 0 &&
    input.rowCount === 0 &&
    !input.actionable
  );
}
