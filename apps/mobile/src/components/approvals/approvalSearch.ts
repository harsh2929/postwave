/**
 * approvalSearch — the queue's client-side search predicate.
 *
 * Its own module rather than another entry in `approvalPresentation`, which is
 * at its 450-line ceiling: the house rule is to split rather than to raise one.
 * It is also a genuinely separate concern — presentation decides what a row
 * SAYS, this decides whether a row is shown at all.
 *
 * Import-free of react-native/expo, so it is unit-tested under node.
 */
import { resourceLabel } from "@/components/approvals/approvalPresentation";

/**
 * The minimum row shape the queue's search box reads. Structural rather than
 * importing the hook's `Approval`, so this module stays free of transport
 * concerns and testable under node.
 */
export interface ApprovalSearchRow {
  resourceType: string;
  resourceId?: string | null;
  requestedByActorLabel?: string | null;
  requestedByActorType?: string | null;
  notes?: string | null;
  status: string;
}

/**
 * Client-side search over the loaded page.
 *
 * The HUMAN-READABLE label is matched as well as the wire value, because the
 * screen shows "Campaign send" and a reader who types what they can see must
 * find it — matching only `resourceType` would silently fail for every term the
 * UI itself chose. Paired with `approvalTruncationNotice`, which discloses that
 * this searches the loaded window and not the full history.
 */
export function filterApprovals<T extends ApprovalSearchRow>(
  rows: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows as T[];
  return rows.filter((a) =>
    [
      a.resourceType,
      resourceLabel(a.resourceType),
      a.resourceId ?? "",
      a.requestedByActorLabel ?? "",
      a.requestedByActorType ?? "",
      a.notes ?? "",
      a.status,
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}
