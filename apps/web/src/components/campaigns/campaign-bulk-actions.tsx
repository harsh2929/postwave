// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import { Download, FolderInput, Tag } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { MeResponse } from "@/lib/auth-api";
import type { CampaignBulkTagResult } from "@/lib/campaign-folders-api";
import type { Campaign } from "@/lib/campaigns-api";
import type { RoleKey } from "@/lib/query-keys";

import { BulkTagDialog } from "./bulk-tag-dialog";
import { exportCampaignsCsv } from "./export-campaigns-csv";
import {
  type CampaignMoveOutcome,
  MoveToFolderDialog,
} from "./move-to-folder-dialog";
import { useCampaignWriteGate } from "./use-campaign-write-gate";

/**
 * The selection verbs desktop's bulk toolbar has and web's bulk bar lacked:
 * Move to folder, Tag, Export CSV (desktop parity campaigns-10 / 11 / 12;
 * CampaignsTopPanels.tsx `CampaignBulkToolbar`). Rendered inside the list's
 * bulk bar next to its Delete/Clear. The two writes are withheld with the
 * reason for read-only sessions and a stale snapshot; export only reads the
 * rows already on screen, so it stays available.
 */
export function CampaignBulkActions({
  identity,
  tenantId,
  role,
  selected,
  snapshotStale = false,
  onMoved,
  onTagged,
}: {
  identity: MeResponse | null | undefined;
  tenantId: string;
  role: RoleKey;
  /** The selected rows, in list order. */
  selected: readonly Campaign[];
  snapshotStale?: boolean;
  onMoved?: (outcome: CampaignMoveOutcome) => void;
  onTagged?: (result: CampaignBulkTagResult & { ids: string[] }) => void;
}) {
  const gate = useCampaignWriteGate(identity, snapshotStale);
  const [moveOpen, setMoveOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  if (selected.length === 0) return null;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={gate.blockedReason !== null}
        title={gate.blockedReason ?? undefined}
        onClick={() => setMoveOpen(true)}
      >
        <FolderInput className="h-4 w-4" aria-hidden />
        Move to folder
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={gate.blockedReason !== null}
        title={gate.blockedReason ?? undefined}
        onClick={() => setTagOpen(true)}
      >
        <Tag className="h-4 w-4" aria-hidden />
        Tag
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          const exported = exportCampaignsCsv(selected);
          if (exported > 0) {
            toast.success(
              `Exported ${exported.toLocaleString()} campaign${exported === 1 ? "" : "s"} to CSV.`,
            );
          }
        }}
      >
        <Download className="h-4 w-4" aria-hidden />
        Export CSV
      </Button>
      <MoveToFolderDialog
        identity={identity}
        tenantId={tenantId}
        role={role}
        campaigns={selected}
        open={moveOpen}
        onOpenChange={setMoveOpen}
        snapshotStale={snapshotStale}
        onMoved={onMoved}
      />
      <BulkTagDialog
        identity={identity}
        campaigns={selected}
        open={tagOpen}
        onOpenChange={setTagOpen}
        snapshotStale={snapshotStale}
        onTagged={onTagged}
      />
    </>
  );
}
