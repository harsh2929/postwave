// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { apiErrorMessage, isApiError } from "@/lib/api";

import type { CursorPager } from "./use-cursor-pager";

/** The server's sentence, except a 404 on the whole feature, which the
 *  server phrases as "not found" and the reader would take for a bad id. */
export function commerceFailureMessage(error: unknown): string {
  if (isApiError(error) && error.status === 404) {
    return "Commerce catalogs are not enabled on this Moosewave server.";
  }
  return apiErrorMessage(error, "The request could not be completed.");
}

export function CommerceErrorNotice({
  error,
  label,
  stale,
  retrying,
  onRetry,
  describe = commerceFailureMessage,
}: {
  error: unknown;
  label: string;
  /** True when an earlier successful page is still on screen. */
  stale: boolean;
  retrying: boolean;
  onRetry: () => void;
  /** How to phrase the failure; defaults to the catalogs reading of a 404.
   *  Per-store routes pass a resolver that keeps the server's own sentence
   *  ("integration not found", "product not found"). */
  describe?: (error: unknown) => string;
}) {
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span>
          {describe(error)}
          {stale ? ` Showing the last successfully loaded ${label}.` : ""}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRetry}
          loading={retrying}
        >
          Retry {label}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function CursorPagerControls({
  pager,
  itemCount,
  nextCursor,
  busy,
  label,
}: {
  pager: CursorPager;
  itemCount: number;
  nextCursor: string | null;
  busy: boolean;
  label: string;
}) {
  const canNext = Boolean(nextCursor) && !pager.visited(nextCursor ?? "");
  return (
    <nav
      aria-label={`${label} pagination`}
      className="flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
    >
      <p aria-live="polite">
        Page {pager.pageNumber.toLocaleString()} · {itemCount.toLocaleString()}{" "}
        {itemCount === 1 ? "item" : "items"} on this page
        {canNext ? "; more are available." : "."}
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!pager.hasPrevious || busy}
          onClick={pager.previous}
          aria-label={`Previous page of ${label.toLowerCase()}`}
        >
          Previous
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canNext || busy}
          onClick={() => {
            if (nextCursor) pager.next(nextCursor);
          }}
          aria-label={`Next page of ${label.toLowerCase()}`}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}

export function FieldError({
  id,
  message,
}: {
  id: string;
  message: string | null;
}) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-destructive-emphasis">
      {message}
    </p>
  );
}

export function FieldHint({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * Close guard for a dialog holding an unsent draft: closing a dirty form
 * asks first and names what is lost; closing while the request is in flight
 * is refused, because the request cannot be recalled.
 */
export function useDraftCloseGuard({
  dirty,
  pending,
  onDiscard,
  onClose,
}: {
  dirty: boolean;
  pending: boolean;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const [discardOpen, setDiscardOpen] = useState(false);
  const requestClose = () => {
    if (pending) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  };
  const discardAndClose = () => {
    onDiscard();
    setDiscardOpen(false);
    onClose();
  };
  return {
    requestClose,
    discardOpen,
    keepEditing: () => setDiscardOpen(false),
    discardAndClose,
  };
}

export function DiscardDraftDialog({
  open,
  title,
  description,
  onConfirm,
  onKeepEditing,
}: {
  open: boolean;
  title: string;
  description: string;
  onConfirm: () => void;
  onKeepEditing: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeepEditing();
      }}
      title={title}
      description={description}
      confirmLabel="Discard draft"
      cancelLabel="Keep editing"
      onConfirm={onConfirm}
    />
  );
}
