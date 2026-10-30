// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// The recovery for a 412 on a form write (desktop FormDetailSlideover
// requestConflictReload / "Reload current version"). The server refused the
// save because the form moved on since it was loaded; this re-reads
// GET /api/v1/forms/{id} — through getForm, so the fresh ETag is captured —
// and hands the latest version back to the editor.
//
// Reloading replaces the operator's draft, so with unsaved changes it goes
// through a confirm that names that consequence first.

import { useState } from "react";
import { RotateCcw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { apiErrorMessage } from "@/lib/api";
import { reloadLatestForm } from "@/lib/forms-extras-api";
import type { Form } from "@/lib/forms-types";

export const EDIT_CONFLICT_MESSAGE =
  "This form was changed somewhere else after you opened it, so your save was not applied. Reload the latest version to continue.";

interface EditConflictReloadBannerProps {
  formId: string;
  /** True when reloading would discard edits the operator has not saved. */
  hasUnsavedChanges: boolean;
  onReloaded: (latest: Form) => void;
  /** Override the explanation (e.g. a draft that went stale before saving). */
  message?: string;
}

export function EditConflictReloadBanner({
  formId,
  hasUnsavedChanges,
  onReloaded,
  message = EDIT_CONFLICT_MESSAGE,
}: EditConflictReloadBannerProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setReloading(true);
    setError(null);
    try {
      const latest = await reloadLatestForm(formId);
      onReloaded(latest);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not load the latest version."));
    } finally {
      setReloading(false);
    }
  }

  return (
    <Alert variant="warning" role="alert">
      <AlertTitle>Form changed elsewhere</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {error ? (
          <p className="mt-1 text-destructive-emphasis">{error}</p>
        ) : null}
        <div className="mt-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={reloading}
            aria-busy={reloading}
            onClick={() => {
              if (hasUnsavedChanges) setConfirmOpen(true);
              else void reload();
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            {reloading ? "Reloading…" : "Reload latest version"}
          </Button>
        </div>
      </AlertDescription>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Discard your changes and reload?"
        description="Your unsaved changes will be discarded and replaced with the latest saved version from the server. They cannot be recovered."
        confirmLabel="Discard and reload"
        onConfirm={async () => {
          await reload();
          setConfirmOpen(false);
        }}
      />
    </Alert>
  );
}
