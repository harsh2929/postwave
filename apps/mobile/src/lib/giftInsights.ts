/** Pure presentation and integrity helpers for the sanitized Gift archive. */
import type {
  GiftHistoryPage,
  GiftHistoryRecord,
  GiftHistoryStats,
  GiftHistoryStatus,
} from "@/lib/giftSubscriptions";

export type GiftTone = "neutral" | "success" | "warning" | "danger" | "info";

export function giftStatusLabel(status: GiftHistoryStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "paid":
      return "Paid · awaiting access";
    case "redeemed":
      return "Redeemed";
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "Expired";
    case "refunded":
      return "Refunded";
    case "unclassified":
      return "Data issue";
  }
}

export function giftStatusTone(status: GiftHistoryStatus): GiftTone {
  switch (status) {
    case "redeemed":
      return "success";
    case "pending":
      return "info";
    case "paid":
    case "expired":
      return "warning";
    case "cancelled":
    case "refunded":
      return "danger";
    case "unclassified":
      return "neutral";
  }
}

export function recordHasDataIssue(record: GiftHistoryRecord): boolean {
  return record.issues.length > 0;
}

export function conversionRate(
  stats: GiftHistoryStats | null,
): { rate: number; resolved: number } | null {
  if (!stats) return null;
  const resolved =
    stats.redeemed + stats.cancelled + stats.expired + stats.refunded;
  if (resolved <= 0) return null;
  return { rate: stats.conversionRate, resolved };
}

export interface GiftObservation {
  id: string;
  severity: "warn" | "info";
  title: string;
  detail: string;
}

export function giftObservations({
  pages,
  stats,
}: {
  pages: readonly GiftHistoryPage[];
  stats: GiftHistoryStats | null;
}): GiftObservation[] {
  const out: GiftObservation[] = [];
  const rejected = pages.reduce((sum, page) => sum + page.rejectedRows, 0);
  const envelopeIssues = pages.reduce(
    (sum, page) => sum + page.envelopeIssues.length,
    0,
  );
  const recordIssues = pages
    .flatMap((page) => page.items)
    .filter(recordHasDataIssue).length;
  if (rejected + envelopeIssues + recordIssues > 0) {
    out.push({
      id: "integrity",
      severity: "warn",
      title: "Some archive evidence needs review",
      detail:
        "Malformed or contradictory values were contained instead of being presented as trustworthy history.",
    });
  }
  const totals = new Set(pages.map((page) => page.total));
  if (totals.size > 1) {
    out.push({
      id: "page-drift",
      severity: "info",
      title: "The archive changed while more records loaded",
      detail:
        "Each page is a fresh server read. The displayed records are de-duplicated, but the total changed between requests.",
    });
  }
  if (stats && stats.paid > 0) {
    out.push({
      id: "paid",
      severity: "warn",
      title:
        stats.paid === 1
          ? "1 gift is paid and awaiting access"
          : `${stats.paid} gifts are paid and awaiting access`,
      detail:
        "Payment evidence exists, but the archive does not prove that access was granted. Gift commerce remains read-only.",
    });
  }
  if (stats && stats.unclassified > 0) {
    out.push({
      id: "unclassified",
      severity: "warn",
      title:
        stats.unclassified === 1
          ? "1 record is outside the lifecycle totals"
          : `${stats.unclassified} records are outside the lifecycle totals`,
      detail:
        "The aggregate total is larger than the recognized lifecycle buckets.",
    });
  }
  return out;
}

export function statusDrift(
  cached: GiftHistoryRecord | null | undefined,
  fresh: GiftHistoryRecord | null | undefined,
): { from: GiftHistoryStatus; to: GiftHistoryStatus } | null {
  if (!cached || !fresh || cached.id !== fresh.id) return null;
  return cached.status === fresh.status
    ? null
    : { from: cached.status, to: fresh.status };
}
