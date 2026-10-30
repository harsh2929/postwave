import { type ReactElement, useMemo } from "react";

import { useOutbox } from "../lib/outbox";
import type { OfflineMutation } from "../lib/offline-store";

interface PendingSyncStatusProps {
  /** Exact API resource path for an existing object. */
  path?: string;
  /** Resource bucket for page-level create/update summaries. */
  resource?: string;
  /** Optional human record label for queued creates without a server id. */
  record?: string;
  compact?: boolean;
}

/**
 * Persistent object/page-local projection of the encrypted sync journal.
 * Unlike a toast, this rehydrates after navigation or restart and therefore
 * keeps local acceptance distinct from server confirmation.
 */
export function PendingSyncStatus({
  path,
  resource,
  record,
  compact = false,
}: PendingSyncStatusProps): ReactElement | null {
  const outbox = useOutbox();
  const items = useMemo(
    () =>
      outbox.all.filter((item) => {
        if (path && normalizedPath(item.path) !== normalizedPath(path)) {
          return false;
        }
        if (resource && item.resource !== resource) return false;
        if (record && item.recordLabel !== record) return false;
        return true;
      }),
    [outbox.all, path, record, resource],
  );
  if (items.length === 0) return null;

  const state = mostImportantState(items);
  const label = stateLabel(state, items.length);
  return (
    <span
      className={`pending-sync-status pending-sync-status-${state}${compact ? " is-compact" : ""}`}
      role={state === "conflict" || state === "failed" ? "alert" : "status"}
      aria-live="polite"
      title="Stored in the encrypted sync journal; not yet confirmed by the server"
    >
      <span className="pending-sync-status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function normalizedPath(path: string): string {
  return path.split("?", 1)[0]?.replace(/\/+$/, "") ?? path;
}

function mostImportantState(
  items: OfflineMutation[],
): "pending" | "replaying" | "conflict" | "failed" {
  if (items.some((item) => item.status === "conflict")) return "conflict";
  if (
    items.some(
      (item) => item.status === "failed" || item.status === "dead-letter",
    )
  ) {
    return "failed";
  }
  if (items.some((item) => item.status === "replaying")) return "replaying";
  return "pending";
}

function stateLabel(
  state: ReturnType<typeof mostImportantState>,
  count: number,
): string {
  if (state === "conflict") return "Sync conflict · review journal";
  if (state === "failed") return "Sync paused · review journal";
  if (state === "replaying") return "Syncing with server…";
  return count === 1
    ? "Saved on this device · pending sync"
    : `${count} changes saved on this device · pending sync`;
}
