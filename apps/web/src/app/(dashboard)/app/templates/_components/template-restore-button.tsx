// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// TMPL-040 — restore an earlier template revision from the version-history
// list. The server component renders the history; this client control performs
// the mutation and refreshes the route so the restored content is shown.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ApiError } from "@/lib/api";
import { restoreCampaignTemplateRevision } from "@/lib/campaign-templates-api";

export function TemplateRestoreButton({
  templateId,
  version,
}: {
  templateId: string;
  version: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <ConfirmDialog
      title={`Restore version ${version}?`}
      description="This replaces the template's current content with this version. The current version is kept in history, so you can undo the restore."
      confirmLabel={busy ? "Restoring…" : "Restore"}
      onConfirm={async () => {
        setBusy(true);
        try {
          await restoreCampaignTemplateRevision(templateId, version);
          toast.success(`Restored version ${version}.`);
          router.refresh();
        } catch (err) {
          toast.error(
            err instanceof ApiError
              ? err.message
              : "Could not restore this version.",
          );
        } finally {
          setBusy(false);
        }
      }}
      trigger={
        <Button type="button" variant="ghost" size="sm" disabled={busy}>
          Restore
        </Button>
      }
    />
  );
}
