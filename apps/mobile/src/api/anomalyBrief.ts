/**
 * api/anomalyBrief.ts — `POST /api/v1/analytics/anomaly-brief`.
 *
 * The dashboard can now say "bounces are unusual". This is the endpoint that
 * says WHY, or at least what the numbers are consistent with.
 *
 * The trust posture is the server's, and this client must not soften it: the
 * model never touches SQL. The API gathers a fixed set of aggregates for a
 * WHITELISTED metric with its own parameterised queries, then asks the model
 * only to interpret those numbers — and it returns the aggregates verbatim so
 * a reader can check the prose against the figures it was written from. This
 * module therefore keeps `aggregates` rather than discarding it, and the sheet
 * shows the totals beside the summary.
 *
 * The parser is pure and lives here so the RENDERER never has to decide what a
 * missing field means. Three rules:
 *
 *  - A brief with no summary is not a brief. Rendering empty bullet lists
 *    under a blank heading reads as "the AI has nothing to say about your
 *    bounce spike", which is a different claim from "the request failed".
 *  - Bullets are strings or they are dropped. One object in the array must not
 *    render as "[object Object]" in an advisory about deliverability.
 *  - The metric echo is trusted over the request. If the server answered about
 *    a different metric than we asked for, the sheet must label what it got.
 */
import { getClient } from "@/api/client";

export const ANOMALY_BRIEF_PATH = "/api/v1/analytics/anomaly-brief";

/**
 * The server's whitelist, verified at apps/api/internal/nql/anomaly_brief.go.
 * Anything else is rejected with `invalid_metric` BEFORE a query runs, so the
 * client must not offer a metric that is not on it — notably `subscribers`,
 * which the dashboard charts but the brief endpoint does not accept.
 */
export const ANOMALY_BRIEF_METRICS = [
  "opens",
  "clicks",
  "bounces",
  "complaints",
  "unsubscribes",
  "revenue",
] as const;

export type AnomalyBriefMetric = (typeof ANOMALY_BRIEF_METRICS)[number];

export function isAnomalyBriefMetric(
  value: unknown,
): value is AnomalyBriefMetric {
  return (
    typeof value === "string" &&
    (ANOMALY_BRIEF_METRICS as readonly string[]).includes(value)
  );
}

export interface AnomalyBrief {
  metric: string;
  windowDays: number;
  summary: string;
  probableCauses: string[];
  suggestedActions: string[];
  /** The figures the brief was written from — shown beside the prose. */
  currentTotal: number | null;
  previousTotal: number | null;
}

export class AnomalyBriefUnreadableError extends Error {
  override readonly name = "AnomalyBriefUnreadableError";

  constructor() {
    super("The brief could not be read.");
  }
}

function stringList(value: unknown, max = 6): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && !!item.trim())
    .map((item) => item.trim())
    .slice(0, max);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseAnomalyBrief(raw: unknown): AnomalyBrief {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AnomalyBriefUnreadableError();
  }
  const body = raw as Record<string, unknown>;
  const summary =
    typeof body.summary === "string" ? body.summary.trim() : "";
  // No summary is not an empty brief — it is an unusable one.
  if (!summary) throw new AnomalyBriefUnreadableError();

  const aggregates =
    typeof body.aggregates === "object" && body.aggregates !== null
      ? (body.aggregates as Record<string, unknown>)
      : {};

  return {
    metric: typeof body.metric === "string" ? body.metric : "",
    windowDays: finiteOrNull(body.window_days) ?? 0,
    summary,
    probableCauses: stringList(body.probable_causes),
    suggestedActions: stringList(body.suggested_actions),
    currentTotal: finiteOrNull(aggregates.current_total),
    previousTotal: finiteOrNull(aggregates.previous_total),
  };
}

export interface RequestAnomalyBriefInput {
  metric: AnomalyBriefMetric;
  /** Trailing window. The server clamps this; 7 is its own default. */
  windowDays?: number;
}

export async function requestAnomalyBrief({
  metric,
  windowDays = 7,
}: RequestAnomalyBriefInput): Promise<AnomalyBrief> {
  const { client } = getClient();
  const res = await client.request<unknown>("POST", ANOMALY_BRIEF_PATH, {
    body: { metric, window_days: windowDays },
  });
  return parseAnomalyBrief(res);
}
