/**
 * hooks/useAssetOrganize.ts — the organising verbs for the asset library:
 * move-to-folder, folder create/rename/delete, tag add/remove, plus the
 * per-asset tag read the organise sheet shows.
 *
 * A sibling of useAssetActions (upload / delete / copy) rather than an
 * extension of it: that hook is the CONSEQUENTIAL half of the surface, while
 * everything here is reversible with one more tap — a moved asset moves back,
 * a removed tag re-adds, a deleted folder leaves its images in place
 * (ON DELETE SET NULL, migration 0236). The one destructive verb — folder
 * delete — therefore gets a plain confirm, not the typed-phrase gate.
 *
 * ALL WRITES ARE ONLINE-ONLY, matching the surface's standing policy
 * (hooks/useAssets header): the screen hides every write affordance offline,
 * none of these paths is in lib/offlineQueueSafety's SAFE_MUTATION_PATTERNS,
 * and an organising write replayed hours later could quietly re-file an asset
 * a teammate has since organised differently.
 *
 * INVALIDATIONS. Folder membership is projected onto the grid rows
 * (`folderId`) and counted on the folder rail (`assetCount`), and tags feed
 * both the tenant rail and the `?tag=` filter — so each verb invalidates the
 * true prefix of everything it can have moved, and nothing is patched
 * optimistically (`counts` describe the whole tenant set).
 *
 * EVERY VERB HERE IS VERSION-GATED, AND THE NUMBER IS ALWAYS READ.
 * `expected_version` is not optional server-side: the move (folders.go:531),
 * the rename (folders.go:448), the folder delete (folders.go:486) and both tag
 * writes (tags.go:364, tags.go:415) all answer **428
 * `expected_version_required`** without a positive one, and the folder CREATE
 * demands exactly **0** (folders.go:402). Mobile sent none of them, so all six
 * verbs failed 100% of the time. Which row's number each verb needs is not
 * uniform: filing an image into a folder writes the ASSET row, while renaming
 * or deleting the folder writes the FOLDER row.
 *
 * AND THE NUMBER MOVES UNDER YOU. `AddTagsToAsset`, `RemoveTagFromAsset` and
 * `MoveAssetToFolder` each bump `assets.version`, so a second write made before
 * the invalidated read has landed would send the number the first one consumed
 * — a 412 blamed on a teammate who did nothing. Each write's answer therefore
 * feeds the ledger in lib/assetVersionGate, which the next write reads first.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addAssetTagVersioned,
  removeAssetTagVersioned,
} from "@/api/assetTagWrites";
import {
  createAssetFolder,
  deleteAssetFolder,
  fetchAssetTagList,
  moveAssetToFolder,
  renameAssetFolder,
} from "@/api/assets";
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { AssetFolder } from "@/lib/assetLibrary";
import { assetOrganizeErrorMessage } from "@/lib/assetOrganize";
import {
  ASSET_CREATE_VERSION,
  ASSET_FOLDER_VERSION_MISSING,
  EMPTY_ASSET_VERSION_LEDGER,
  assetVersionErrorMessage,
  assetWriteBlockNote,
  forgetRowVersion,
  ledgerVersion,
  recordRowVersion,
  type AssetVersionLedger,
} from "@/lib/assetVersionGate";
import { haptics } from "@/lib/haptics";
import { plural } from "@/lib/format";

const TAG_LIST_KEY = "asset-tag-list";

/**
 * The asset's OWN tags — `GET /assets/{id}/tags`. Fetched when the organise
 * sheet opens (the grid row does not carry them), `staleTime: 0` because the
 * sheet edits them in place.
 */
export function useAssetTagList(assetId: string | null) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: [TAG_LIST_KEY, gate.tenantId, assetId ?? null],
    enabled: gate.enabled && Boolean(gate.tenantId) && Boolean(assetId),
    staleTime: 0,
    queryFn: (): Promise<string[]> => fetchAssetTagList(assetId!),
  });
}

/**
 * Every asset-gated verb takes the row's version beside its id. `null` is
 * accepted at the type level — the screen can genuinely be looking at a row
 * whose payload carried none — and is REFUSED with a sentence rather than
 * guessed at, because a guess is either an immediate 428 or a silent overwrite
 * of a teammate's edit.
 */
export interface AssetOrganizeActions {
  /** True while any organising write is in flight; the sheet disables on it. */
  busy: boolean;
  moveToFolder: (
    assetId: string,
    assetVersion: number | null,
    folderId: string | null,
    folderName: string | null,
  ) => void;
  /** Create the folder, then file the asset into it — one gesture. */
  createFolderAndMove: (
    assetId: string,
    assetVersion: number | null,
    name: string,
  ) => void;
  /** Takes the whole folder row: the gate is the FOLDER's version, not the asset's. */
  renameFolder: (folder: AssetFolder, name: string) => void;
  /** Confirmed inline; images inside fall back to Uncategorised. */
  deleteFolder: (folder: AssetFolder) => void;
  addTag: (assetId: string, assetVersion: number | null, tag: string) => void;
  removeTag: (assetId: string, assetVersion: number | null, tag: string) => void;
}

export function useAssetOrganizeActions(): AssetOrganizeActions {
  const gate = useOnlineQueryGate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const confirm = useConfirm();

  const invalidateMembership = (assetId?: string) => {
    void qc.invalidateQueries({ queryKey: ["assets", gate.tenantId] });
    void qc.invalidateQueries({ queryKey: ["asset-folders", gate.tenantId] });
    if (assetId) {
      void qc.invalidateQueries({
        queryKey: ["asset", gate.tenantId, assetId],
      });
    }
  };
  const invalidateTags = (assetId: string) => {
    void qc.invalidateQueries({
      queryKey: [TAG_LIST_KEY, gate.tenantId, assetId],
    });
    void qc.invalidateQueries({ queryKey: ["asset-tags", gate.tenantId] });
    void qc.invalidateQueries({ queryKey: ["assets", gate.tenantId] });
    // A tag write bumps `assets.version`, so the detail read behind the sheet
    // is now holding a stale number as well as a stale tag list.
    void qc.invalidateQueries({
      queryKey: ["asset", gate.tenantId, assetId],
    });
  };

  /**
   * Versions learned from the writes' own answers, keyed by row id. Seeded
   * empty and only ever written from a server response — never from a
   * client-side increment, which is the difference between a read number and a
   * guessed one.
   */
  const [ledger, setLedger] = useState<AssetVersionLedger>(
    EMPTY_ASSET_VERSION_LEDGER,
  );
  const learn = (rowId: string, version: unknown) => {
    setLedger((prev) => recordRowVersion(prev, rowId, version));
  };

  const fail = (err: unknown, fallback: string, noun: string) => {
    haptics.error();
    toast({
      kind: "error",
      // The 412 and the 428 are facts about CONCURRENCY, not about the network
      // or the workspace, and must not be flattened into "couldn't do that".
      message:
        assetVersionErrorMessage(err, noun) ??
        assetOrganizeErrorMessage(err, fallback),
    });
  };
  const done = (message: string) => {
    haptics.success();
    toast({ kind: "success", message });
  };
  /**
   * The write is not attempted at all. The sheet already withholds these
   * affordances when a row carries no version, so this is the backstop for a
   * path that reached the verb anyway — never the operator's first news of it.
   */
  const refuse = (note: string) => {
    haptics.error();
    toast({ kind: "error", message: note });
  };
  const assetNote = assetWriteBlockNote(true, true, false) ?? "";

  const move = useMutation({
    mutationFn: (input: {
      assetId: string;
      folderId: string | null;
      expectedVersion: number;
    }) =>
      moveAssetToFolder(input.assetId, input.folderId, input.expectedVersion),
  });
  const create = useMutation({
    // A create has no prior row to have read a version from, so the number is
    // the constant the handler demands (`!= 0` is a 428, folders.go:402).
    mutationFn: (name: string) =>
      createAssetFolder(name, ASSET_CREATE_VERSION),
  });
  const rename = useMutation({
    mutationFn: (input: {
      folderId: string;
      name: string;
      expectedVersion: number;
    }) => renameAssetFolder(input.folderId, input.name, input.expectedVersion),
  });
  const removeFolder = useMutation({
    mutationFn: (input: { folderId: string; expectedVersion: number }) =>
      deleteAssetFolder(input.folderId, input.expectedVersion),
  });
  const tagAdd = useMutation({
    mutationFn: (input: {
      assetId: string;
      tag: string;
      expectedVersion: number;
    }) =>
      addAssetTagVersioned(input.assetId, input.tag, input.expectedVersion),
  });
  const tagRemove = useMutation({
    mutationFn: (input: {
      assetId: string;
      tag: string;
      expectedVersion: number;
    }) =>
      removeAssetTagVersioned(input.assetId, input.tag, input.expectedVersion),
  });

  const moveToFolder = (
    assetId: string,
    assetVersion: number | null,
    folderId: string | null,
    folderName: string | null,
  ) => {
    const expectedVersion = ledgerVersion(ledger, assetId, assetVersion);
    if (expectedVersion === null) {
      refuse(assetNote);
      return;
    }
    move.mutate(
      { assetId, folderId, expectedVersion },
      {
        onSuccess: (version) => {
          // `MoveAssetToFolder` bumps the asset's version, and the answer
          // carries the new one — so a tag added straight after this move
          // sends a number that is still true.
          learn(assetId, version);
          invalidateMembership(assetId);
          done(
            folderId
              ? `Filed into ${folderName ?? "the folder"}.`
              : "Moved back to Uncategorised.",
          );
        },
        onError: (err) => fail(err, "Couldn't move that image.", "image"),
      },
    );
  };

  const createFolderAndMove = (
    assetId: string,
    assetVersion: number | null,
    name: string,
  ) => {
    create.mutate(name, {
      onSuccess: (folder) => {
        // The folder exists even if the move below fails, so the rail must
        // learn about it either way — and so must the ledger, because the
        // Manage strip can rename it before the folder list refetches.
        learn(folder.id, folder.version);
        invalidateMembership();
        moveToFolder(assetId, assetVersion, folder.id, folder.name);
      },
      onError: (err) => fail(err, "Couldn't create the folder.", "folder"),
    });
  };

  const renameFolder = (folder: AssetFolder, name: string) => {
    // The FOLDER's version, not the asset's: this write touches the folder row.
    const expectedVersion = ledgerVersion(ledger, folder.id, folder.version);
    if (expectedVersion === null) {
      refuse(ASSET_FOLDER_VERSION_MISSING);
      return;
    }
    rename.mutate(
      { folderId: folder.id, name, expectedVersion },
      {
        onSuccess: (renamed) => {
          learn(renamed.id, renamed.version);
          invalidateMembership();
          done(`Renamed to ${renamed.name}.`);
        },
        onError: (err) => fail(err, "Couldn't rename the folder.", "folder"),
      },
    );
  };

  const deleteFolder = (folder: AssetFolder) => {
    const expectedVersion = ledgerVersion(ledger, folder.id, folder.version);
    if (expectedVersion === null) {
      refuse(ASSET_FOLDER_VERSION_MISSING);
      return;
    }
    void (async () => {
      const ok = await confirm({
        title: `Delete the ${folder.name} folder?`,
        message:
          folder.assetCount > 0
            ? `The ${plural(folder.assetCount, "image")} inside stay in the library — they just go back to Uncategorised.`
            : "It has no images in it.",
        confirmLabel: "Delete folder",
        destructive: true,
      });
      if (!ok) return;
      removeFolder.mutate(
        { folderId: folder.id, expectedVersion },
        {
          onSuccess: () => {
            // The row is gone; a remembered number for a reused id would be a
            // guess dressed as a reading.
            setLedger((prev) => forgetRowVersion(prev, folder.id));
            invalidateMembership();
            done(
              `Deleted the ${folder.name} folder. Its images are unfiled, not gone.`,
            );
          },
          onError: (err) => fail(err, "Couldn't delete the folder.", "folder"),
        },
      );
    })();
  };

  const addTag = (
    assetId: string,
    assetVersion: number | null,
    tag: string,
  ) => {
    const expectedVersion = ledgerVersion(ledger, assetId, assetVersion);
    if (expectedVersion === null) {
      refuse(assetNote);
      return;
    }
    tagAdd.mutate(
      { assetId, tag, expectedVersion },
      {
        onSuccess: (result) => {
          // `AddTagsToAsset` bumps `assets.version` even though the tag lands
          // in a join table, so the SECOND tag needs this number, not the one
          // that was on screen.
          learn(assetId, result.version);
          invalidateTags(assetId);
          done(`Tagged “${tag}”.`);
        },
        onError: (err) => fail(err, "Couldn't add that tag.", "image"),
      },
    );
  };

  const removeTag = (
    assetId: string,
    assetVersion: number | null,
    tag: string,
  ) => {
    const expectedVersion = ledgerVersion(ledger, assetId, assetVersion);
    if (expectedVersion === null) {
      refuse(assetNote);
      return;
    }
    tagRemove.mutate(
      { assetId, tag, expectedVersion },
      {
        onSuccess: (version) => {
          learn(assetId, version);
          invalidateTags(assetId);
          done(`Removed “${tag}”.`);
        },
        onError: (err) => fail(err, "Couldn't remove that tag.", "image"),
      },
    );
  };

  return {
    busy:
      move.isPending ||
      create.isPending ||
      rename.isPending ||
      removeFolder.isPending ||
      tagAdd.isPending ||
      tagRemove.isPending,
    moveToFolder,
    createFolderAndMove,
    renameFolder,
    deleteFolder,
    addTag,
    removeTag,
  };
}
