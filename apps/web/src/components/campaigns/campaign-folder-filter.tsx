// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useState, type FormEvent } from "react";
import { FolderPlus } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import {
  ALL_FOLDERS,
  UNCATEGORISED_FOLDER,
  type CampaignFolder,
  campaignFolderKeys,
  createCampaignFolder,
  listCampaignFolders,
} from "@/lib/campaign-folders-api";
import { type RoleKey, STALE } from "@/lib/query-keys";

import { useCampaignWriteGate } from "./use-campaign-write-gate";

/**
 * Folder filter + "New folder" for the campaigns list (desktop parity
 * campaigns-7 / campaigns-8; desktop CampaignsTopPanels.tsx).
 *
 * The filter is a controlled value — `ALL_FOLDERS`, `UNCATEGORISED_FOLDER`, or
 * a folder id — that the list applies through `filterAndSortCampaigns`'s
 * `folder` option. Creating a folder is a campaign write: withheld with the
 * reason for read-only sessions and for a stale snapshot, and re-checked
 * against a fresh identity before the POST.
 */
export function CampaignFolderFilter({
  identity,
  tenantId,
  role,
  value,
  onChange,
  snapshotStale = false,
}: {
  identity: MeResponse | null | undefined;
  tenantId: string;
  role: RoleKey;
  value: string;
  onChange: (folder: string) => void;
  snapshotStale?: boolean;
}) {
  const queryClient = useQueryClient();
  const gate = useCampaignWriteGate(identity, snapshotStale);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const reasonId = useId();
  const errorId = useId();

  const foldersKey = campaignFolderKeys.list(tenantId, role);
  const foldersQuery = useQuery({
    queryKey: foldersKey,
    queryFn: listCampaignFolders,
    enabled: identity != null,
    staleTime: STALE.list,
  });
  const folders: CampaignFolder[] = Array.isArray(foldersQuery.data)
    ? foldersQuery.data
    : [];

  const createMut = useMutation({
    mutationFn: async (name: string) => {
      await gate.confirmFresh();
      return createCampaignFolder(name);
    },
    onSuccess: (folder) => {
      // The server answers a repeated name with the EXISTING folder, so say
      // which of the two happened instead of claiming a new one.
      const existed = folders.some((row) => row.id === folder.id);
      setNewName("");
      setCreateError(null);
      void queryClient.invalidateQueries({ queryKey: foldersKey });
      if (existed) {
        toast.message(`A folder named “${folder.name}” already exists.`);
      } else {
        toast.success(`Folder “${folder.name}” created.`);
      }
    },
    onError: (error) => {
      setCreateError(apiErrorMessage(error, "Could not create the folder."));
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (gate.blockedReason || createMut.isPending) return;
    const name = newName.trim();
    if (!name) {
      setCreateError("Name the folder before creating it.");
      return;
    }
    createMut.mutate(name);
  };

  const describedBy =
    [gate.blockedReason ? reasonId : null, createError ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div
      className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start"
      data-testid="campaign-folder-filter"
    >
      <div className="min-w-0 sm:w-56">
        <Select
          aria-label="Filter by folder"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value={ALL_FOLDERS}>All folders</option>
          <option value={UNCATEGORISED_FOLDER}>Uncategorised</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name} ({folder.campaign_count.toLocaleString()})
            </option>
          ))}
        </Select>
        {foldersQuery.isError ? (
          <p className="mt-1 text-xs text-destructive" role="alert">
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
      </div>
      <form className="min-w-0 sm:w-64" onSubmit={submit}>
        <div className="flex gap-2">
          <Input
            aria-label="New folder name"
            placeholder="New folder"
            maxLength={120}
            value={newName}
            disabled={gate.blockedReason !== null || createMut.isPending}
            aria-describedby={describedBy}
            aria-invalid={createError ? true : undefined}
            onChange={(event) => {
              setNewName(event.target.value);
              if (createError) setCreateError(null);
            }}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={gate.blockedReason !== null}
            loading={createMut.isPending}
            title={gate.blockedReason ?? undefined}
          >
            <FolderPlus className="h-4 w-4" aria-hidden />
            Create folder
          </Button>
        </div>
        {gate.blockedReason ? (
          <p id={reasonId} className="mt-1 text-xs text-muted-foreground">
            {gate.blockedReason}
          </p>
        ) : null}
        {createError ? (
          <p id={errorId} className="mt-1 text-xs text-destructive" role="alert">
            {createError}
          </p>
        ) : null}
      </form>
    </div>
  );
}
