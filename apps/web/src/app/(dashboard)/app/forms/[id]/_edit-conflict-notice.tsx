// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { EditConflictReloadBanner } from "@/components/forms/edit-conflict-reload-banner";
import { isFormEditConflict } from "@/lib/forms-extras-api";
import type { Form } from "@/lib/forms-types";

/**
 * Renders the reload banner when a save was refused as stale (412), and
 * nothing for any other save error.
 *
 * The conflict predicate lives in `@/lib/forms-extras-api`, which drags the
 * whole extras API into any module that imports it. Only this notice needs
 * it, so the page loads the notice (and with it the banner) through
 * next/dynamic once a save has failed, keeping both off the route's eager
 * graph (bundle budget).
 */
export function EditConflictNotice({
  saveError,
  formId,
  hasUnsavedChanges,
  onReloaded,
}: {
  saveError: unknown;
  formId: string;
  hasUnsavedChanges: boolean;
  onReloaded: (latest: Form) => void;
}) {
  if (!isFormEditConflict(saveError)) return null;
  return (
    <div className="border-b px-4 py-2 sm:px-6">
      <EditConflictReloadBanner
        formId={formId}
        hasUnsavedChanges={hasUnsavedChanges}
        onReloaded={onReloaded}
      />
    </div>
  );
}
