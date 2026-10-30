/**
 * segmentAdvancedRows — pure parsing for the segment-detail evidence panels
 * (desktop anchors: SegmentSnapshotsSection / SegmentDetailSlideover
 * definition-history + usage / SegmentGrowthReport):
 *
 *   GET  /api/v1/segments/{id}/snapshots          → {items:[Snapshot]}
 *        Snapshot: {id, segment_id, count, sample_size, evaluator_version,
 *                   evaluated_at, created_at} (snapshots.go)
 *   POST /api/v1/segments/{id}/snapshot           → 201 Snapshot   (editor)
 *   GET  /api/v1/segments/snapshots/{sid}/members → paginated members
 *   GET  /api/v1/segments/{id}/definition-history → {items:[{audit_id, at,
 *        actor_label, action, before?, after?}]} (decay.go)
 *   GET  /api/v1/segments/{id}/usage              → {items:[{kind,id,name,
 *        status?}], count} (usage.go)
 *   GET  /api/v1/segments/{id}/growth/report      → GrowthReportResponse
 *        {series, anomalies, total_adds, total_drops, net_delta, net_pct,
 *         note?} (growth_report.go — the JSON twin of desktop's report.csv;
 *        a phone renders the report, it does not download a file)
 *
 * All reads are viewer; the snapshot WRITE is editor. react-native-free.
 */

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function items(res: unknown): Record<string, unknown>[] {
  const rows = (res as { items?: unknown[] } | null | undefined)?.items;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (r): r is Record<string, unknown> => !!r && typeof r === "object",
  );
}

// ── snapshots ───────────────────────────────────────────────────────────────

export interface SegmentSnapshotRow {
  id: string;
  count: number;
  sampleSize: number;
  evaluatorVersion: string;
  evaluatedAt: string;
}

export function parseSegmentSnapshot(raw: unknown): SegmentSnapshotRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = r.id == null ? "" : String(r.id);
  if (!id) return null;
  return {
    id,
    count: num(r.count),
    sampleSize: num(r.sample_size),
    evaluatorVersion: str(r.evaluator_version),
    evaluatedAt: str(r.evaluated_at) || str(r.created_at),
  };
}

export function parseSegmentSnapshots(res: unknown): SegmentSnapshotRow[] {
  const out: SegmentSnapshotRow[] = [];
  for (const raw of items(res)) {
    const parsed = parseSegmentSnapshot(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

// ── definition history ──────────────────────────────────────────────────────

export interface DefinitionHistoryRow {
  auditId: string;
  at: string;
  actorLabel: string;
  action: string;
}

export function parseDefinitionHistory(res: unknown): DefinitionHistoryRow[] {
  return items(res)
    .filter((r) => str(r.at))
    .map((r) => ({
      auditId: r.audit_id == null ? "" : String(r.audit_id),
      at: str(r.at),
      actorLabel: str(r.actor_label),
      action: str(r.action),
    }));
}

// ── usage ───────────────────────────────────────────────────────────────────

export interface SegmentUsageRow {
  kind: string;
  id: string;
  name: string;
  status: string;
}

/** The server's kind vocabulary, humanised; unknown kinds pass through. */
export function segmentUsageKindLabel(kind: string): string {
  if (kind === "campaign") return "Campaign";
  if (kind === "social_capture") return "Capture rule";
  if (kind === "audience_destination") return "Ad-audience sync";
  return kind.replaceAll("_", " ");
}

export function parseSegmentUsage(res: unknown): SegmentUsageRow[] {
  return items(res)
    .filter((r) => r.id != null)
    .map((r) => ({
      kind: str(r.kind),
      id: String(r.id),
      name: str(r.name) || String(r.id),
      status: str(r.status),
    }));
}

// ── growth report ───────────────────────────────────────────────────────────

export interface SegmentGrowthReport {
  days: number;
  totalAdds: number;
  totalDrops: number;
  netDelta: number;
  netPct: number;
  anomalyCount: number;
  /** The server's own honesty note (e.g. sparse snapshot coverage). */
  note: string;
}

export function parseSegmentGrowthReport(res: unknown): SegmentGrowthReport {
  const r = (res ?? {}) as Record<string, unknown>;
  return {
    days: num(r.days),
    totalAdds: num(r.total_adds),
    totalDrops: num(r.total_drops),
    netDelta: num(r.net_delta),
    netPct: num(r.net_pct),
    anomalyCount: Array.isArray(r.anomalies) ? r.anomalies.length : 0,
    note: str(r.note),
  };
}
