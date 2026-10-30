/**
 * subscriberDemographics — the confidence-labelled inferred demographics
 * (SUB-063) on a phone profile.
 *
 * The server's composite read (`GET /api/v1/subscribers/{id}/demographics`,
 * viewer) returns three traits — gender, age_group, interests — each nil when
 * NEVER INFERRED. The presentation rules this module owns:
 *
 *  - an absent trait renders as nothing, not as "unknown": these are model
 *    inferences, and inventing a row for one the model never made would
 *    overstate what the workspace knows about a person;
 *  - the confidence label always accompanies the value — a bare "female" and
 *    a "female (62% confidence)" are different claims, and desktop's
 *    DemographicsPanel prints the pair;
 *  - interests may arrive as a JSON array; anything else renders as text.
 *
 * Import-free so every rule runs in the node vitest suite.
 */

export interface DemographicTraitRow {
  key: "gender" | "age_group" | "interests";
  label: string;
  /** Human value ("female", "25-34", "cycling, jazz"). */
  value: string;
  /** "62% confidence" or "" when the model reported none. */
  confidence: string;
  source: string;
}

const TRAIT_LABELS: Record<DemographicTraitRow["key"], string> = {
  gender: "Gender",
  age_group: "Age group",
  interests: "Interests",
};

function traitValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .join(", ");
  }
  return "";
}

function confidenceLabel(confidence: unknown): string {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return "";
  }
  const pct = Math.round(Math.min(1, Math.max(0, confidence)) * 100);
  return `${pct}% confidence`;
}

/**
 * Rows for the card, in canonical order, ONLY for traits that exist. An
 * empty array means "nothing inferred", which the card renders as its honest
 * empty line.
 */
export function parseDemographics(payload: unknown): DemographicTraitRow[] {
  const body =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const rows: DemographicTraitRow[] = [];
  for (const key of ["gender", "age_group", "interests"] as const) {
    const trait = body[key];
    if (!trait || typeof trait !== "object") continue;
    const rec = trait as Record<string, unknown>;
    const value = traitValue(rec.value);
    if (!value) continue;
    rows.push({
      key,
      label: TRAIT_LABELS[key],
      value,
      confidence: confidenceLabel(rec.confidence),
      source: typeof rec.source === "string" ? rec.source : "",
    });
  }
  return rows;
}
