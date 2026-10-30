// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Letter-grade pill (A–F) summarising a list's 90-day deliverability +
 * engagement profile. The grade comes from the server (list_health.go) and
 * is never recomputed here. `total_subscribers === 0` is "no data": the
 * server grades an empty set A/100, and showing that would fabricate health
 * for a list nobody is on (desktop Lists.tsx:175 suppresses it the same way).
 */
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api";
import type { ListHealthScore } from "@/lib/lists-api";

export type HealthState =
  | { status: "pending" }
  | { status: "error"; error: unknown }
  | { status: "success"; health: ListHealthScore };

function variantFor(grade: string): "success" | "warning" | "destructive" {
  const g = grade.toUpperCase()[0];
  if (g === "A" || g === "B") return "success";
  if (g === "C" || g === "D") return "warning";
  return "destructive";
}

export function ListHealthBadge({
  listName,
  state,
}: {
  listName: string;
  state: HealthState;
}) {
  if (state.status === "pending")
    return (
      <Skeleton
        className="inline-block h-5 w-12 align-middle"
        role="status"
        aria-label={`Loading health for ${listName}`}
      />
    );
  if (state.status === "error")
    return (
      <span
        className="font-mono text-xs text-muted-foreground"
        title={apiErrorMessage(state.error, "Health could not be loaded")}
        aria-label={`Health unavailable for ${listName}`}
      >
        —
      </span>
    );
  const h = state.health;
  if (h.total_subscribers === 0)
    return (
      <span
        className="font-mono text-xs text-muted-foreground"
        title={`No health data — no subscribers carry the tag "${listName}"`}
        aria-label={`No health data for ${listName}`}
      >
        —
      </span>
    );
  const pct = (r: number, d = 2) => `${(r * 100).toFixed(d)}%`;
  return (
    <Badge
      variant={variantFor(h.grade)}
      className="cursor-help gap-1 tabular-nums"
      title={[
        `Score ${h.score}/100 over ${h.window_days} days`,
        `Engagement ${pct(h.engagement_rate, 1)}`,
        `Bounce ${pct(h.bounce_rate)}`,
        `Complaint ${pct(h.complaint_rate, 3)}`,
        `Unsubscribe ${pct(h.unsubscribe_rate)}`,
        ...h.notes,
      ].join("\n")}
      aria-label={`Health grade ${h.grade}, score ${h.score} of 100 for ${listName}`}
    >
      {h.grade}
      <span className="font-normal text-muted-foreground">{h.score}</span>
    </Badge>
  );
}
