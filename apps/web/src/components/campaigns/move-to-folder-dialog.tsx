// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage, isApiError } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import {
  type CampaignFolder,
  campaignFolderId,
  campaignFolderKeys,
  listCampaignFolders,
  moveCampaignToFolder,
} from "@/lib/campaign-folders-api";
import type { Campaign } from "@/lib/campaigns-api";
import { base, type RoleKey, STALE } from "@/lib/query-keys";

import { useCampaignWriteGate } from "./use-campaign-write-gate";

export interface CampaignMoveOutcome {
  /** Campaigns the server confirmed moved, in request order. */
  movedIds: string[];
  /** Campaigns the server refused (and the ones never attempted). */
  remainingIds: string[];
  /** The run stopped because campaign write authority changed mid-way. */
  authorityLost: boolean;
  /** The folder the campaigns were moved into ("" = uncategorised). */
  folderId: string;
}

function campaignLabel(campaign: Campaign): string {
  return campaign.name?.trim() || campaign.subject?.trim() || "Untitled campaign";
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Folder picker for ONE campaign (row "Move") or for the whole selection
 * (bulk "Move to folder") — desktop parity campaigns-9 / campaigns-10
 * (CampaignActionOverlays.tsx, useCampaignBulkActions.ts).
 *
 * The server has no bulk move route, so a bulk move is a sequence of
 * `PATCH /api/v1/campaigns/{id}/folder`, one campaign at a time, exactly as
 * desktop does it. The run stops — rather than pressing on — the moment
 * campaign write authority changes: a 401/403 from the server, or a fresh
 * identity elsewhere on the page that no longer matches the one this dialog
 * was opened under. What was confirmed, and what was not, is reported per
 * campaign; the dialog stays open on anything short of full success.
 */
export function MoveToFolderDialog({
  identity,
  tenantId,
  role,
  campaigns,
  open,
  onOpenChange,
  snapshotStale = false,
  onMoved,
}: {
  identity: MeResponse | null | undefined;
  tenantId: string;
  role: RoleKey;
  campaigns: readonly Campaign[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshotStale?: boolean;
  onMoved?: (outcome: CampaignMoveOutcome) => void;
}) {
  const queryClient = useQueryClient();
  const gate = useCampaignWriteGate(identity, snapshotStale);
  const selectId = useId();
  const reasonId = useId();
  const single = campaigns.length === 1 ? campaigns[0] : null;
  const currentFolder = single ? campaignFolderId(single) : null;
  const [pick, setPick] = useState<string>(currentFolder ?? "");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const busyRef = useRef(false);

  // Re-seed the picker each time the dialog opens for a (possibly different)
  // target, so a previous run's choice or error never leaks into this one.
  useEffect(() => {
    if (!open) return;
    setPick(currentFolder ?? "");
    setProblem(null);
    setProgress(0);
  }, [open, currentFolder]);

  const foldersQuery = useQuery({
    queryKey: campaignFolderKeys.list(tenantId, role),
    queryFn: listCampaignFolders,
    enabled: open && identity != null,
    staleTime: STALE.list,
  });
  const folders: CampaignFolder[] = Array.isArray(foldersQuery.data)
    ? foldersQuery.data
    : [];
  const folderName = (id: string): string =>
    id === ""
      ? "Uncategorised"
      : (folders.find((folder) => folder.id === id)?.name ?? "the folder");

  const unchanged = single !== null && pick === currentFolder;
  const blocked =
    gate.blockedReason ??
    (campaigns.length === 0 ? "Select at least one campaign to move." : null);

  const run = async (): Promise<void> => {
    if (busyRef.current || blocked || unchanged) return;
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    setProgress(0);
    const target = pick;
    const ids = campaigns.map((campaign) => campaign.id);
    const movedIds: string[] = [];
    let failed = 0;
    let firstFailure: string | null = null;
    let authorityLost = false;
    let authorityMessage: string | null = null;
    try {
      try {
        await gate.confirmFresh();
      } catch (error) {
        setProblem(apiErrorMessage(error, "Could not confirm your access."));
        return;
      }
      for (const id of ids) {
        if (!gate.stillAuthorized()) {
          authorityLost = true;
          break;
        }
        try {
          await moveCampaignToFolder(id, target);
          movedIds.push(id);
          setProgress(movedIds.length);
        } catch (error) {
          if (
            isApiError(error) &&
            (error.status === 401 || error.status === 403)
          ) {
            authorityLost = true;
            authorityMessage = apiErrorMessage(error);
            break;
          }
          failed += 1;
          firstFailure ??= apiErrorMessage(error, "The server refused the move.");
        }
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }

    if (movedIds.length > 0) {
      // List rows (folder_id), status counts and folder counts all changed.
      void queryClient.invalidateQueries({
        queryKey: base("campaigns", tenantId, role),
      });
    }
    const moved = new Set(movedIds);
    const outcome: CampaignMoveOutcome = {
      movedIds,
      remainingIds: ids.filter((id) => !moved.has(id)),
      authorityLost,
      folderId: target,
    };
    onMoved?.(outcome);

    const destination = folderName(target);
    if (authorityLost) {
      setProblem(
        `Stopped when your campaign write authority changed: ${plural(movedIds.length, "campaign")} moved to “${destination}”; ${plural(ids.length - movedIds.length, "campaign")} not moved.` +
          (authorityMessage ? ` ${authorityMessage}` : "") +
          " Refresh the page and confirm your access before retrying.",
      );
      return;
    }
    if (failed > 0) {
      setProblem(
        `${plural(movedIds.length, "campaign")} moved to “${destination}”; ${plural(failed, "campaign")} could not be moved. ${firstFailure ?? ""}`.trim(),
      );
      return;
    }
    toast.success(
      single
        ? `Moved “${campaignLabel(single)}” to “${destination}”.`
        : `Moved ${plural(movedIds.length, "campaign")} to “${destination}”.`,
    );
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busyRef.current) return;
        onOpenChange(next);
      }}
    >
      <DialogContent closeDisabled={busy}>
        <DialogHeader>
          <DialogTitle>
            {single
              ? `Move “${campaignLabel(single)}”`
              : `Move ${plural(campaigns.length, "campaign")}`}
          </DialogTitle>
          <DialogDescription>
            Pick a folder, or move back to Uncategorised. Folders only group
            campaigns in this list; nothing about delivery changes.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor={selectId}>Folder</Label>
          <Select
            id={selectId}
            value={pick}
            disabled={busy || blocked !== null}
            aria-describedby={blocked ? reasonId : undefined}
            onChange={(event) => setPick(event.target.value)}
          >
            <option value="">Uncategorised</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </Select>
          {foldersQuery.isError ? (
            <p className="text-xs text-destructive" role="alert">
              Could not load folders.{" "}
              {apiErrorMessage(foldersQuery.error, "")}{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => void foldersQuery.refetch()}
              >
                Retry
              </button>
            </p>
          ) : null}
          {blocked ? (
            <p id={reasonId} className="text-xs text-muted-foreground">
              {blocked}
            </p>
          ) : null}
          {busy && campaigns.length > 1 ? (
            <p className="text-xs text-muted-foreground" role="status">
              Moved {progress.toLocaleString()} of{" "}
              {campaigns.length.toLocaleString()}…
            </p>
          ) : null}
        </div>
        {problem ? <Alert variant="destructive">{problem}</Alert> : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={blocked !== null || unchanged}
            loading={busy}
            title={
              blocked ??
              (unchanged ? "The campaign is already in this folder." : undefined)
            }
            onClick={() => void run()}
          >
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
