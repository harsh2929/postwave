/**
 * subscriberSegmentDecisions — SUB-070 right-to-explanation (EU AI Act
 * Art. 86): WHY an automated system placed this person in a segment.
 *
 * Desktop's SegmentDecisionsPanel translated:
 *  1. live membership — every tenant segment with matched/total condition
 *     counts and per-condition natural-language reasons;
 *  2. stored decision snapshots — persisted segment/campaign explanations,
 *     rendered as key/value rows because the snapshot is operator-defined
 *     JSON with no promised shape.
 *
 * Import-free so every rule runs in the node vitest suite.
 */

export interface SegmentConditionRow {
  matched: boolean;
  /** The server's natural-language sentence, verbatim. */
  description: string;
}

export interface SegmentMembershipRow {
  segmentId: string;
  segmentName: string;
  isMember: boolean;
  /** e.g. "matched 3 of 5 conditions in 'High-Engagement'" — server-authored. */
  summary: string;
  conditions: SegmentConditionRow[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The GET /subscribers/{id}/segment-membership {segments} body. */
export function parseSegmentMemberships(
  payload: unknown,
): SegmentMembershipRow[] {
  const rec =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  if (!Array.isArray(rec.segments)) return [];
  return rec.segments.flatMap((row): SegmentMembershipRow[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const segmentId = str(r.segment_id);
    if (!segmentId) return [];
    const conditions: SegmentConditionRow[] = Array.isArray(r.conditions)
      ? r.conditions.flatMap((c): SegmentConditionRow[] => {
          if (!c || typeof c !== "object") return [];
          const cond = c as Record<string, unknown>;
          const description = str(cond.description);
          if (!description) return [];
          return [{ matched: cond.matched === true, description }];
        })
      : [];
    return [
      {
        segmentId,
        segmentName: str(r.segment_name) || segmentId,
        isMember: r.is_member === true,
        summary: str(r.summary),
        conditions,
      },
    ];
  });
}

export interface DecisionExplanationRow {
  id: string;
  /** "Segment" | "Campaign" | the raw decision_type for anything newer. */
  typeLabel: string;
  targetId: string;
  createdAt: string;
  /** The operator/automation snapshot as printable key/value pairs. */
  snapshot: [key: string, value: string][];
}

/** Desktop's decisionTypeLabel, verbatim. */
export function decisionTypeLabel(t: string): string {
  switch (t) {
    case "segment":
      return "Segment";
    case "campaign":
      return "Campaign";
    default:
      return t;
  }
}

/** The GET /subscribers/{id}/decision-explanations {items} body. */
export function parseDecisionExplanations(
  payload: unknown,
): DecisionExplanationRow[] {
  const rec =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  if (!Array.isArray(rec.items)) return [];
  return rec.items.flatMap((row): DecisionExplanationRow[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const id = str(r.id);
    if (!id) return [];
    const snapshot: [string, string][] = [];
    if (r.reasoning_snapshot && typeof r.reasoning_snapshot === "object") {
      for (const [k, v] of Object.entries(
        r.reasoning_snapshot as Record<string, unknown>,
      )) {
        snapshot.push([
          k,
          v == null
            ? "—"
            : typeof v === "object"
              ? JSON.stringify(v)
              : String(v),
        ]);
      }
    }
    return [
      {
        id,
        typeLabel: decisionTypeLabel(str(r.decision_type)),
        targetId: str(r.target_id),
        createdAt: str(r.created_at),
        snapshot,
      },
    ];
  });
}
