export interface InboxRealityRiskBreakdown {
  weights?: Partial<
    Record<"content" | "reputation" | "auth" | "engagement", number>
  >;
  content?: number;
  reputation?: number;
  auth?: number;
  engagement?: number;
  combined?: number;
  assumptions?: string[];
  model?: unknown;
}

const SIGNALS = ["content", "reputation", "auth", "engagement"] as const;

function finite01(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : null;
}

/** Turn the predictor's actual weighted risk payload into concise UI copy. */
export function inboxRealityRiskExplanation(
  risk: InboxRealityRiskBreakdown | null | undefined,
): string | null {
  if (!risk || typeof risk !== "object") return null;
  const components = SIGNALS.flatMap((key) => {
    const score = finite01(risk[key]);
    if (score == null) return [];
    const weight = finite01(risk.weights?.[key]) ?? 1;
    return [{ key, contribution: score * weight }];
  }).sort((a, b) => b.contribution - a.contribution);
  if (components.length === 0) return null;

  const combined = finite01(risk.combined);
  const leading = components
    .slice(0, 2)
    .map(
      ({ key, contribution }) =>
        `${key[0]?.toUpperCase() ?? ""}${key.slice(1)} ${Math.round(contribution * 100)} points`,
    );
  const assumption = Array.isArray(risk.assumptions)
    ? risk.assumptions.find(
        (value) => typeof value === "string" && value.trim(),
      )
    : undefined;
  return [
    combined == null
      ? null
      : `Overall modeled risk is ${Math.round(combined * 100)}%.`,
    `Largest weighted signals: ${leading.join(" and ")}.`,
    assumption ? `Assumption: ${assumption.trim()}.` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}
