/**
 * lib/onsiteGrowth.ts — parsing and judging one form's onsite-growth
 * configuration: popup targeting, experiments, spin-to-win rewards.
 *
 * Scope of the mobile port (deliberately READ + ENABLE/DISABLE, per the
 * parity register): the phone answers "is the popup armed, what triggers it,
 * are experiments running, are spin rewards active" and offers exactly one
 * write — flipping the targeting status. Rule AUTHORING (audiences, URL
 * rules, weights) stays desk-side.
 *
 * THE PUT IS A FULL REPLACE (`ON CONFLICT … DO UPDATE SET` on every column,
 * onsite_growth repo), so the status toggle must send back the ENTIRE record
 * the GET returned with only `status` changed. `rawRecord` is kept verbatim
 * for exactly that — the same defence the referral programme save uses.
 *
 * Server contract (apps/api/internal/onsite_growth/onsite_growth.go):
 *   GET  /onsite-growth/forms/{id}/targeting    read:campaigns → bare record
 *        (404 = never configured — a RESTING state, not a failure)
 *   PUT  same path                              write:campaigns / admin floor
 *        status ∈ draft|published|paused|archived
 *   GET  …/experiments                          → {items: [...]}
 *   GET  …/spin/rewards                         → {items: [...]}
 *
 * Import-free; node-tested.
 */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The manifest floor for the PUT. */
export const ONSITE_TARGETING_WRITE_MINIMUM_ROLE = "admin" as const;

export interface OnsiteTargeting {
  status: string;
  priority: number | null;
  /** trigger.type, e.g. immediate | delay | scroll | exit_intent. */
  triggerType: string;
  /** The whole wire record, verbatim, for the full-replace PUT. */
  rawRecord: Record<string, unknown>;
}

/** Null only for a payload with no object shape at all. */
export function parseOnsiteTargeting(payload: unknown): OnsiteTargeting | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const env = record(payload);
  const priority = env.priority;
  return {
    status: text(env.status) || "draft",
    priority:
      typeof priority === "number" && Number.isFinite(priority)
        ? Math.trunc(priority)
        : null,
    triggerType: text(record(env.trigger).type),
    rawRecord: { ...env },
  };
}

export interface OnsiteExperimentSummary {
  key: string;
  name: string;
  status: string;
  variantCount: number;
}

export function parseOnsiteExperiments(
  payload: unknown,
): OnsiteExperimentSummary[] {
  const items = record(payload).items;
  if (!Array.isArray(items)) return [];
  const out: OnsiteExperimentSummary[] = [];
  for (const raw of items) {
    const row = record(raw);
    const key = text(row.key);
    if (key === "") continue;
    out.push({
      key,
      name: text(row.name) || key,
      status: text(row.status) || "draft",
      variantCount: Array.isArray(row.variants) ? row.variants.length : 0,
    });
  }
  return out;
}

export interface OnsiteSpinRewardSummary {
  key: string;
  label: string;
  status: string;
}

export function parseOnsiteSpinRewards(
  payload: unknown,
): OnsiteSpinRewardSummary[] {
  const items = record(payload).items;
  if (!Array.isArray(items)) return [];
  const out: OnsiteSpinRewardSummary[] = [];
  for (const raw of items) {
    const row = record(raw);
    const key = text(row.key);
    if (key === "") continue;
    out.push({
      key,
      label: text(row.label) || key,
      status: text(row.status) || "active",
    });
  }
  return out;
}

export interface OnsiteToggleVerb {
  /** What the PUT's `status` will say. */
  target: "published" | "paused";
  label: string;
  confirmTitle: string;
  confirmMessage: string;
  destructive: boolean;
  successMessage: string;
}

/**
 * The one status verb the targeting record offers, or null when there is no
 * safe verb: archived is not resurrected from a phone, and an unknown status
 * gets no guess.
 */
export function onsiteToggleVerb(
  status: string | null | undefined,
): OnsiteToggleVerb | null {
  const current = (status ?? "").trim().toLowerCase();
  if (current === "published") {
    return {
      target: "paused",
      label: "Pause popup",
      confirmTitle: "Pause this popup?",
      confirmMessage:
        "Visitors stop seeing it the moment this lands. The targeting rules are kept and it can be published again.",
      destructive: true,
      successMessage: "Popup paused — visitors no longer see it.",
    };
  }
  if (current === "paused" || current === "draft") {
    return {
      target: "published",
      label: current === "paused" ? "Resume popup" : "Publish popup",
      confirmTitle:
        current === "paused" ? "Resume this popup?" : "Publish this popup?",
      confirmMessage:
        "Visitors matching the targeting rules start seeing it immediately.",
      destructive: false,
      successMessage: "Popup live — matching visitors now see it.",
    };
  }
  return null;
}

/**
 * The full-replace PUT body: the record the GET returned, verbatim, with only
 * `status` changed. Anything less erases rules this phone never rendered.
 */
export function buildTargetingStatusPut(
  targeting: OnsiteTargeting,
  status: "published" | "paused",
): Record<string, unknown> {
  return { ...targeting.rawRecord, status };
}
