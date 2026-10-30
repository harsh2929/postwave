/**
 * lib/campaignOptimizer.ts — the content-optimizer bandit allocation.
 *
 * Server (apps/api/internal/content_optimizer/content_optimizer.go):
 *   GET  /campaigns/{id}/content-optimizer          viewer — latest run (404 = none)
 *   POST /campaigns/{id}/content-optimizer/preview  editor — allocation preview
 *   POST /campaigns/{id}/content-optimizer          editor — persisted run
 *
 * THE PERSISTED RUN IS DELIBERATELY NOT OFFERED, mirroring desktop's own
 * anchor: ContentOptimizerCard.tsx sets CONTENT_OPTIMIZER_DISPATCH_ENABLED =
 * false because "persisted optimizer runs are not consumed by recipient
 * dispatch yet" — a run that looks active while changing nothing at send time
 * is exactly the kind of phantom control this app refuses to grow. The phone
 * ships what desktop actually wires: the latest run (if one exists) and the
 * on-demand allocation preview.
 */

export interface OptimizerArmRow {
  key: string;
  subject: string;
  allocationPercent: number;
  score: number;
  reason: string;
}

export interface OptimizerPreviewReading {
  method: string;
  primaryMetric: string;
  arms: OptimizerArmRow[];
}

export function readOptimizerPreview(
  data: unknown,
): OptimizerPreviewReading | null {
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  const armsRaw = Array.isArray(body.recommended_arms)
    ? body.recommended_arms
    : null;
  if (!armsRaw) return null;
  const arms: OptimizerArmRow[] = [];
  for (const item of armsRaw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key : "";
    if (!key) continue;
    arms.push({
      key,
      subject: typeof row.subject === "string" ? row.subject : "",
      allocationPercent:
        typeof row.allocation_percent === "number"
          ? row.allocation_percent
          : 0,
      score: typeof row.score === "number" ? row.score : 0,
      reason: typeof row.reason === "string" ? row.reason : "",
    });
  }
  return {
    method: typeof body.method === "string" ? body.method : "",
    primaryMetric:
      typeof body.primary_metric === "string" ? body.primary_metric : "",
    arms,
  };
}

export interface OptimizerRunReading {
  id: string;
  status: string;
  preview: OptimizerPreviewReading | null;
}

export function readOptimizerRun(data: unknown): OptimizerRunReading | null {
  if (!data || typeof data !== "object") return null;
  const body = data as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return null;
  return {
    id,
    status: typeof body.status === "string" ? body.status : "",
    preview: readOptimizerPreview(body.preview),
  };
}
