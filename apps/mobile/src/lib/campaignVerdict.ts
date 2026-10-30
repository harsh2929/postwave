/**
 * lib/campaignVerdict.ts — the one-shot pre-send AI verdict.
 *
 * POST /api/v1/presend/verdict (apps/api/internal/presend/verdict.go) fans out
 * to EQ score + voice drift + placement (+ cached campaign assurance) and
 * returns ONE verdict: ok | warn | critical | incomplete, with per-component
 * rows. Desktop runs it on demand from the CopilotRail; the phone mirrors the
 * on-demand contract — the check is LLM-cost and never auto-fires.
 *
 * Manifest: editor. `incomplete` deliberately does not collapse to ok — at
 * least one required component could not produce a trustworthy result, and
 * the reading keeps that distinction.
 */

export type PresendVerdict = "ok" | "warn" | "critical" | "incomplete";

export interface VerdictComponentRow {
  name: string;
  label: string;
  status: string;
  /** "82/100" style, or null when the component carried no score. */
  scoreLabel: string | null;
  message: string;
}

export interface PresendVerdictReading {
  verdict: PresendVerdict;
  summary: string;
  complete: boolean;
  components: VerdictComponentRow[];
}

const COMPONENT_LABELS: Record<string, string> = {
  eq_score: "EQ score",
  voice_drift: "Voice drift",
  placement: "Placement",
  campaign_assurance: "Campaign assurance",
};

/** Components score 0..1 or 0..100 depending on component (verdict.go:74). */
function scoreLabel(score: unknown): string | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  const normalized = score <= 1 ? score * 100 : score;
  return `${Math.round(normalized)}/100`;
}

export function readPresendVerdict(
  data: unknown,
): PresendVerdictReading | null {
  if (!data || typeof data !== "object") return null;
  const body = data as {
    verdict?: unknown;
    summary?: unknown;
    complete?: unknown;
    components?: unknown;
  };
  const verdict = body.verdict;
  if (
    verdict !== "ok" &&
    verdict !== "warn" &&
    verdict !== "critical" &&
    verdict !== "incomplete"
  ) {
    return null;
  }
  const components: VerdictComponentRow[] = [];
  for (const item of Array.isArray(body.components) ? body.components : []) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name : "";
    if (!name) continue;
    components.push({
      name,
      label: COMPONENT_LABELS[name] ?? name,
      status: typeof row.status === "string" ? row.status : "",
      scoreLabel: scoreLabel(row.score),
      message:
        typeof row.message === "string"
          ? row.message
          : typeof row.error === "string"
            ? row.error
            : "",
    });
  }
  return {
    verdict,
    summary: typeof body.summary === "string" ? body.summary : "",
    complete: body.complete === true,
    components,
  };
}

export function verdictTone(
  verdict: PresendVerdict,
): "success" | "warning" | "danger" | "neutral" {
  switch (verdict) {
    case "ok":
      return "success";
    case "warn":
      return "warning";
    case "critical":
      return "danger";
    default:
      return "neutral";
  }
}

export function verdictHeadline(reading: PresendVerdictReading): string {
  switch (reading.verdict) {
    case "ok":
      return "Verdict: looks safe to send";
    case "warn":
      return "Verdict: send with caution";
    case "critical":
      return "Verdict: do not send as-is";
    default:
      return "Verdict: incomplete — not every check could run";
  }
}
