import type { ApprovalRow } from "../../lib/api-client";
import {
  canRejectApproval,
  type DecodedApproval,
} from "../../lib/approvals-helpers";
import type {
  ApprovalRouteView,
  ApprovalWorkspaceTab,
} from "./approvals-route";

export interface ApprovalWindowStats {
  approvedSevenDays: number;
  rejectedSevenDays: number;
  averageDecisionMinutes: number | null;
}

function timeValue(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatApprovalInstant(value: string | undefined): string {
  const parsed = timeValue(value);
  if (parsed === null) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

export function formatApprovalRelative(
  value: string | undefined,
  now = Date.now(),
): string {
  const parsed = timeValue(value);
  if (parsed === null) return "Time unavailable";
  const distanceSeconds = Math.round(Math.abs(now - parsed) / 1_000);
  const future = parsed > now;
  if (distanceSeconds < 45) return future ? "in a few seconds" : "just now";
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  const [unitSize, unit] =
    units.find(([size]) => distanceSeconds >= size) ?? units.at(-1)!;
  const amount = Math.max(1, Math.round(distanceSeconds / unitSize));
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    future ? amount : -amount,
    unit,
  );
}

export function approvalResourceSummary(row: DecodedApproval): string {
  const compactId =
    row.resourceId.length <= 24
      ? row.resourceId
      : `${row.resourceId.slice(0, 12)}…${row.resourceId.slice(-6)}`;
  return `${row.resourceLabel} · ${compactId}`;
}

export { canRejectApproval };

function searchableApproval(row: DecodedApproval): string {
  return [
    row.resourceLabel,
    row.resourceId,
    row.statusLabel,
    row.requestedByActorLabel,
    row.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function compareOptionalText(
  left: string | undefined,
  right: string | undefined,
): number {
  return (left ?? "").localeCompare(right ?? "", undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function sortedApprovals(
  rows: readonly DecodedApproval[],
  sort: ApprovalRouteView["sort"],
): DecodedApproval[] {
  return [...rows].sort((left, right) => {
    if (sort === "oldest") {
      return Date.parse(left.requestedAt) - Date.parse(right.requestedAt);
    }
    if (sort === "resource") {
      return compareOptionalText(
        `${left.resourceLabel} ${left.resourceId}`,
        `${right.resourceLabel} ${right.resourceId}`,
      );
    }
    if (sort === "requester") {
      return compareOptionalText(
        left.requestedByActorLabel,
        right.requestedByActorLabel,
      );
    }
    if (sort === "status") {
      return compareOptionalText(left.statusLabel, right.statusLabel);
    }
    return Date.parse(right.requestedAt) - Date.parse(left.requestedAt);
  });
}

export function visibleApprovalRows(
  rows: readonly DecodedApproval[],
  tab: ApprovalWorkspaceTab,
  view: ApprovalRouteView,
): DecodedApproval[] {
  if (tab === "governance") return [];
  const query = view.query.toLocaleLowerCase();
  const scoped = rows.filter((row) => {
    const belongs =
      tab === "pending" ? row.status === "pending" : row.status !== "pending";
    if (!belongs) return false;
    if (
      tab === "history" &&
      view.status !== "all" &&
      row.status !== view.status
    ) {
      return false;
    }
    return !query || searchableApproval(row).includes(query);
  });
  return sortedApprovals(scoped, view.sort);
}

export function deriveApprovalWindowStats(
  rows: readonly DecodedApproval[],
  now = Date.now(),
): ApprovalWindowStats {
  const sevenDaysAgo = now - 7 * 86_400_000;
  let approvedSevenDays = 0;
  let rejectedSevenDays = 0;
  let totalDecisionMs = 0;
  let decisionCount = 0;
  for (const row of rows) {
    if (row.status !== "approved" && row.status !== "rejected") continue;
    const decidedAt = timeValue(row.decidedAt);
    if (decidedAt !== null && decidedAt >= sevenDaysAgo && decidedAt <= now) {
      if (row.status === "approved") approvedSevenDays += 1;
      if (row.status === "rejected") rejectedSevenDays += 1;
    }
    const requestedAt = timeValue(row.requestedAt);
    if (
      decidedAt !== null &&
      decidedAt <= now &&
      requestedAt !== null &&
      decidedAt >= requestedAt
    ) {
      totalDecisionMs += decidedAt - requestedAt;
      decisionCount += 1;
    }
  }
  return {
    approvedSevenDays,
    rejectedSevenDays,
    averageDecisionMinutes:
      decisionCount === 0
        ? null
        : Math.round(totalDecisionMs / decisionCount / 60_000),
  };
}

export function decodedApprovalAsRow(row: DecodedApproval): ApprovalRow {
  return {
    id: row.id,
    status: row.status,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    requestedAt: row.requestedAt,
    requestedByActorType: row.requestedByActorType,
    requestedByActorLabel: row.requestedByActorLabel,
    decidedAt: row.decidedAt,
    notes: row.notes,
    expiresAt: row.expiresAt,
  };
}
