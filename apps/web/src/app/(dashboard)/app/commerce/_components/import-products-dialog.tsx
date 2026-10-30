// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Commerce → Catalogs → "Import products".
 *
 * Bounded synchronous JSON product import whose 202 summary is rendered
 * verbatim. Split from catalogs-tab.tsx so the dialog only loads once an
 * admin opens it; the tab mounts it on demand.
 */

import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  commerceApi,
  type CommerceCatalog,
  type CommerceCatalogImportInput,
} from "@/lib/commerce-api";
import {
  formatCommerceTime,
  importSummaryMessage,
  MAX_IMPORT_BODY_BYTES,
  MAX_IMPORT_PRODUCTS,
  MAX_IMPORT_TEXT_LENGTH,
  prepareImportPayload,
} from "@/lib/commerce-catalog-helpers";

import type {
  CommerceAdminOperation,
  CommerceWorkspaceContext,
} from "./commerce-context";
import {
  commerceFailureMessage,
  DiscardDraftDialog,
  FieldError,
  FieldHint,
  useDraftCloseGuard,
} from "./commerce-primitives";

export function ImportProductsDialog({
  ctx,
  catalog,
  onClose,
  onImported,
}: {
  ctx: CommerceWorkspaceContext;
  catalog: CommerceCatalog;
  onClose: () => void;
  onImported: () => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [replace, setReplace] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false);

  const importMutation = useMutation({
    mutationFn: async ({
      payload,
      operation,
    }: {
      payload: CommerceCatalogImportInput;
      operation: CommerceAdminOperation;
    }) => {
      try {
        await ctx.authorizeAdminOperation(operation);
        return await commerceApi.importCatalogProducts(catalog.id, payload, {
          signal: operation.controller.signal,
          idempotencyKey: operation.idempotencyKey,
        });
      } finally {
        ctx.finishAdminOperation(operation);
      }
    },
    onSuccess: (summary) => {
      toast.success(importSummaryMessage(summary));
      onImported();
    },
  });
  const pending = importMutation.isPending;
  const summary = importMutation.data ?? null;
  const dirty = !summary && Boolean(text || replace);
  const guard = useDraftCloseGuard({
    dirty,
    pending,
    onDiscard: () => {
      setText("");
      setReplace(false);
      setValidationError(null);
      setReplaceConfirmOpen(false);
      importMutation.reset();
    },
    onClose,
  });

  const requestImport = () => {
    if (pending || summary) return;
    const prepared = prepareImportPayload(text, replace);
    if (!prepared.ok) {
      setValidationError(prepared.error);
      return;
    }
    setValidationError(null);
    if (replace) {
      setReplaceConfirmOpen(true);
      return;
    }
    const operation = ctx.beginAdminOperation();
    if (!operation) return;
    importMutation.mutate({ payload: prepared.payload, operation });
  };
  const confirmReplace = async () => {
    const prepared = prepareImportPayload(text, true);
    if (!prepared.ok) {
      setValidationError(prepared.error);
      return;
    }
    const operation = ctx.beginAdminOperation();
    if (!operation) return;
    try {
      await importMutation.mutateAsync({
        payload: prepared.payload,
        operation,
      });
    } catch {
      // The failure renders inside the import dialog, next to the payload,
      // so the reader can fix it there instead of in the confirm.
    }
  };
  const errorMessage = validationError
    ? validationError
    : importMutation.isError
      ? commerceFailureMessage(importMutation.error)
      : null;

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) guard.requestClose();
        }}
      >
        <DialogContent
          className="max-w-2xl"
          closeDisabled={pending}
          aria-busy={pending}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Import products — {catalog.name}</DialogTitle>
            <DialogDescription>
              Paste a JSON array of up to {MAX_IMPORT_PRODUCTS.toLocaleString()}{" "}
              product objects and {MAX_IMPORT_BODY_BYTES.toLocaleString()}{" "}
              encoded request bytes. Keep this dialog open while the server
              processes the import.
            </DialogDescription>
          </DialogHeader>
          {summary ? (
            <div className="space-y-3">
              <div
                role="status"
                className="rounded-md border border-success/40 bg-success-subtle p-3 text-sm"
              >
                <p className="font-medium">{importSummaryMessage(summary)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Accepted {formatCommerceTime(summary.imported_at)} · catalog{" "}
                  <span className="font-mono">{summary.catalog_id}</span>
                </p>
              </div>
              <DialogFooter>
                <Button type="button" onClick={onClose}>
                  Done
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                requestImport();
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-json`}>Products JSON</Label>
                <Textarea
                  id={`${id}-json`}
                  rows={10}
                  value={text}
                  onChange={(event) => {
                    setText(event.target.value);
                    setValidationError(null);
                  }}
                  className="font-mono text-xs"
                  placeholder='[{"source_id": "p1", "title": "Mug", "price_cents": 1900, "currency": "USD"}]'
                  maxLength={MAX_IMPORT_TEXT_LENGTH + 1}
                  disabled={pending}
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-invalid={errorMessage ? true : undefined}
                  aria-describedby={
                    errorMessage ? `${id}-json-error` : `${id}-json-hint`
                  }
                />
                <FieldError id={`${id}-json-error`} message={errorMessage} />
                <FieldHint id={`${id}-json-hint`}>
                  Use a bare array or {'{"products": [...]}'}. Each item must be
                  an object; include stable source_id, title, price_cents, and
                  currency values.
                </FieldHint>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={replace}
                  onChange={(event) => setReplace(event.target.checked)}
                  disabled={pending}
                  className="mt-0.5"
                />
                <span>
                  Replace existing catalog items instead of merging
                  <span className="block text-xs text-muted-foreground">
                    This can remove existing catalog membership and requires a
                    second confirmation.
                  </span>
                </span>
              </label>
              <p
                role="status"
                aria-live="polite"
                className="text-xs text-muted-foreground"
              >
                {pending
                  ? "Import in progress. Keep this dialog open; the draft and dismissal stay locked until the server answers."
                  : `${text.length.toLocaleString()} of ${MAX_IMPORT_TEXT_LENGTH.toLocaleString()} characters entered.`}
              </p>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={guard.requestClose}
                  disabled={pending}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={pending}>
                  {pending
                    ? "Importing…"
                    : replace
                      ? "Review replacement import"
                      : "Import products"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={replaceConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !pending) setReplaceConfirmOpen(false);
        }}
        title={`Replace products in ${catalog.name}?`}
        description="This import uses replacement mode and may remove existing catalog membership that is absent from the pasted payload. The catalog itself is kept."
        confirmLabel="Import and replace"
        cancelLabel="Review payload"
        onConfirm={confirmReplace}
      />
      <DiscardDraftDialog
        open={guard.discardOpen}
        title="Discard product import draft?"
        description="The pasted JSON and replacement choice will be cleared. Nothing has been imported."
        onConfirm={guard.discardAndClose}
        onKeepEditing={guard.keepEditing}
      />
    </>
  );
}
