// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * ConflictModal — side-by-side resolver for items the server rejected
 * with HTTP 409/412. See apps/desktop/src/components/ConflictModal.tsx
 * for the desktop twin.
 *
 *   - Keep mine    → reissue with `If-Match: *` (server overwrites).
 *   - Keep server  → discard our copy, server version stands.
 * Uniqueness conflicts (409) cannot be overwritten; the only safe resolution
 * is to keep the server copy and edit the resource normally. Version
 * conflicts (412) may be explicitly overwritten with a fresh idempotency key.
 */

import { useEffect, useMemo, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { OfflineMutation } from "@/lib/offline-store";

interface ConflictModalProps {
  open: boolean;
  item: OfflineMutation | null;
  onClose: () => void;
  onKeepMine: (id: string) => void;
  onKeepServer: (id: string) => void;
}

export function ConflictModal({
  open,
  item,
  onClose,
  onKeepMine,
  onKeepServer,
}: ConflictModalProps) {
  const [serverVersion, setServerVersion] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const hasComparableServerVersion = item?.method !== "POST";

  useEffect(() => {
    if (!open || !item) return;
    if (item.method === "POST") {
      // A uniqueness-conflicting create points at a collection endpoint. GETing
      // that collection and labelling the payload "Server version" invites a
      // false side-by-side comparison with an unrelated row. There is no
      // authoritative resource version for a create that never succeeded.
      setServerVersion(null);
      setLoadError(null);
      setLoading(false);
      return;
    }
    // Cancellation matters for correctness here, not just for leaks. Resolving
    // conflict A (slow path), closing, then opening conflict B (fast path) let
    // A's response land last and overwrite serverVersion — so the dialog showed
    // B's method/path in the header alongside A's JSON in the "Server version"
    // pane, and the operator chose Keep mine / Keep server after comparing
    // against the wrong server state. The flag gates the state writes; the
    // AbortController also stops the superseded request.
    let active = true;
    const controller = new AbortController();
    setServerVersion(null);
    setLoadError(null);
    setLoading(true);
    void fetch(item.path, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`The server returned HTTP ${res.status}.`);
        }
        try {
          return await res.json();
        } catch {
          throw new Error("The server returned an unreadable response.");
        }
      })
      .then((data) => {
        if (active) setServerVersion(data);
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setServerVersion(null);
        setLoadError(
          error instanceof Error
            ? error.message
            : "The server version could not be loaded.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [open, item, reloadKey]);

  const mineText = useMemo(() => safeJson(item?.body), [item?.body]);
  const serverText = useMemo(
    () =>
      loading
        ? "Loading…"
        : !hasComparableServerVersion
          ? "This create request has no comparable server version. Discard it, then choose a different unique value in the editor."
          : loadError
            ? "Server version unavailable. Retry before choosing a version."
            : safeJson(serverVersion),
    [hasComparableServerVersion, loadError, loading, serverVersion],
  );

  if (!item) return null;
  const canOverwrite =
    item.conflictStatus === 412 || item.lastError?.includes("(412)");
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent className="max-w-2xl" aria-busy={loading || undefined}>
        <DialogHeader>
          <DialogTitle>Resolve conflict</DialogTitle>
          <DialogDescription className="font-mono text-xs text-muted-foreground">
            {item.method} {item.path}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-muted/40">
            <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Your version
            </div>
            <pre
              tabIndex={0}
              aria-label="Your pending version"
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11.5px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {mineText}
            </pre>
          </div>
          <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-muted/40">
            <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {hasComparableServerVersion
                ? "Server version"
                : "Conflict context"}
            </div>
            <pre
              tabIndex={0}
              aria-label="Current server version"
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11.5px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {serverText}
            </pre>
          </div>
        </div>
        {loadError ? (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis sm:flex-row sm:items-center sm:justify-between"
          >
            <span>
              Couldn&apos;t load the current server version. {loadError}
            </span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 shrink-0 sm:min-h-9"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              Retry server version
            </Button>
          </div>
        ) : null}
        {!canOverwrite ? (
          <p className="text-xs text-warning-emphasis">
            This is a uniqueness conflict. Discard the queued create, then open
            the editor and choose a different name or slug.
          </p>
        ) : null}
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11 sm:min-h-9"
            disabled={
              hasComparableServerVersion && (loading || loadError !== null)
            }
            onClick={() => onKeepServer(item.id)}
          >
            {hasComparableServerVersion
              ? "Keep server"
              : "Discard queued change"}
          </Button>
          {canOverwrite ? (
            <Button
              type="button"
              className="min-h-11 sm:min-h-9"
              disabled={loading || loadError !== null}
              onClick={() => onKeepMine(item.id)}
            >
              Keep mine
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return "(no body)";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
