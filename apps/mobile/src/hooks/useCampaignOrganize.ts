/**
 * hooks/useCampaignOrganize.ts — folders, bulk tag, bulk move, bulk delete
 * and the side-by-side compare, for the campaigns list.
 *
 * WHY BULK DELETE IS A LOOP AND NOT ONE CALL. There is no bulk delete route:
 * the only delete is `DELETE /api/v1/campaigns/{id}` and it refuses anything
 * that has left draft (`ErrDeleteRequiresDraft` → 409 `campaign_not_draft`).
 * Desktop loops too, and reports per-item results for the same reason. The
 * loop is SEQUENTIAL on purpose — firing fifty parallel deletes at a phone's
 * connection is how you get half of them timing out and no idea which half.
 *
 * WHY BULK TAG IS NOT A LOOP. `POST /api/v1/campaigns/org-tags/bulk` already
 * takes the whole list and applies it inside one transaction
 * (campaigns/org_tags.go:153), so a loop would be strictly worse: slower, and
 * capable of a partial result the server itself would never produce.
 *
 * WHY MOVE IS A LOOP. `PATCH /api/v1/campaigns/{id}/folder` is per-campaign;
 * there is no bulk folder route.
 */
import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  bulkTagCampaigns,
  compareCampaigns,
  createCampaignFolder,
  listCampaignFolders,
  moveCampaignToFolder,
} from "@/api/campaignOrganize";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { getClient } from "@/api/client";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import type { CampaignCompareRow } from "@/lib/campaignCompare";
import type { CampaignFolder } from "@/lib/campaignFolders";
import {
  bulkOutcomeMessage,
  campaignSelectionLabel,
  type BulkOutcome,
  type SelectableCampaign,
} from "@/lib/campaignSelection";

/** GET /api/v1/campaigns/folders — read scope, so every role may list them. */
export function useCampaignFolders() {
  const gate = useOnlineQueryGate();
  return useQuery<CampaignFolder[]>({
    queryKey: ["campaign-folders", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    queryFn: listCampaignFolders,
  });
}

/**
 * GET /api/v1/analytics/campaigns/compare — enabled only once the caller has
 * a usable pair, so opening the sheet is what triggers the read rather than
 * every selection change firing one.
 */
export function useCampaignCompare(ids: readonly string[], enabled: boolean) {
  const gate = useOnlineQueryGate();
  const key = [...ids].join(",");
  return useQuery<CampaignCompareRow[]>({
    queryKey: ["campaign-compare", gate.tenantId, key],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId) && ids.length > 1,
    queryFn: () => compareCampaigns(ids),
  });
}

export interface BulkActionState {
  /** The verb currently running, or null. Drives the action bar's labels. */
  running: "delete" | "tag" | "move" | null;
  /** Completed / total, so a long loop is not a frozen spinner. */
  progress: { done: number; total: number } | null;
}

export interface CampaignOrganizeActions extends BulkActionState {
  deleteDrafts: (rows: readonly SelectableCampaign[]) => Promise<string>;
  moveToFolder: (
    rows: readonly SelectableCampaign[],
    folderId: string | null,
  ) => Promise<string>;
  /**
   * Mint a folder, then file the selection into it — one gesture on mobile,
   * where the create field lives inside the picker rather than on a settings
   * page. `POST /campaigns/folders` is create-or-reuse (`ON CONFLICT … DO
   * UPDATE`), so a name that already exists files into the existing folder.
   */
  createFolderAndMove: (
    rows: readonly SelectableCampaign[],
    name: string,
  ) => Promise<string>;
  tag: (rows: readonly SelectableCampaign[], tag: string) => Promise<string>;
}

/**
 * The bulk verbs. Each resolves to the sentence that should be shown to the
 * operator — the caller decides whether that is a toast or an inline line, and
 * every one of them names the failures rather than reporting "5 of 7".
 */
export function useCampaignOrganizeActions(): CampaignOrganizeActions {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState<BulkActionState["running"]>(null);
  const [progress, setProgress] = useState<BulkActionState["progress"]>(null);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    void queryClient.invalidateQueries({ queryKey: ["campaign-counts"] });
    void queryClient.invalidateQueries({ queryKey: ["campaign-folders"] });
  }, [queryClient]);

  /**
   * Run one per-campaign call across a selection, sequentially, collecting a
   * per-item outcome. Shared by delete and move because the failure story is
   * identical: some rows can succeed while others 409 or 404.
   */
  const runSequential = useCallback(
    async (
      rows: readonly SelectableCampaign[],
      verb: "delete" | "move",
      run: (row: SelectableCampaign) => Promise<unknown>,
      words: { done: string; doing: string },
    ): Promise<string> => {
      setRunning(verb);
      setProgress({ done: 0, total: rows.length });
      const outcome: BulkOutcome = { succeeded: [], failed: [] };
      try {
        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i] as SelectableCampaign;
          const label = campaignSelectionLabel(row);
          try {
            await run(row);
            outcome.succeeded.push(label);
          } catch (err) {
            outcome.failed.push({
              label,
              // The server's own reason, not a generic one: "only draft
              // campaigns can be deleted" is the sentence that tells the
              // operator what to do next.
              reason: campaignErrorMessage(err, "the server refused it"),
            });
          }
          setProgress({ done: i + 1, total: rows.length });
        }
      } finally {
        setRunning(null);
        setProgress(null);
        invalidate();
      }
      return bulkOutcomeMessage(outcome, words);
    },
    [invalidate],
  );

  const deleteDrafts = useCallback(
    (rows: readonly SelectableCampaign[]) =>
      runSequential(
        rows,
        "delete",
        async (row) => {
          const { client } = getClient();
          await client.campaigns.delete(String(row.id));
        },
        { done: "Deleted", doing: "delete" },
      ),
    [runSequential],
  );

  const moveToFolder = useCallback(
    (rows: readonly SelectableCampaign[], folderId: string | null) =>
      runSequential(
        rows,
        "move",
        (row) => moveCampaignToFolder(String(row.id), folderId),
        { done: "Moved", doing: "move" },
      ),
    [runSequential],
  );

  const createFolderMutation = useMutation({
    mutationFn: (name: string) => createCampaignFolder(name),
  });
  const createFolderMutate = createFolderMutation.mutateAsync;

  const createFolderAndMove = useCallback(
    async (
      rows: readonly SelectableCampaign[],
      name: string,
    ): Promise<string> => {
      // The bar shows "Moving…" for the whole gesture: to the operator the
      // create is a detail of the move, not a separate verb.
      setRunning("move");
      let folder;
      try {
        folder = await createFolderMutate(name);
      } catch (err) {
        setRunning(null);
        throw new Error(
          campaignErrorMessage(err, "Couldn't create the folder."),
        );
      }
      // The folder now exists even if every move below fails, so the chip row
      // must learn about it either way. runSequential re-invalidates on its
      // own finally, which is harmless.
      void queryClient.invalidateQueries({ queryKey: ["campaign-folders"] });
      const moved = await runSequential(
        rows,
        "move",
        (row) => moveCampaignToFolder(String(row.id), folder.id),
        { done: "Moved", doing: "move" },
      );
      return `Created "${folder.name}". ${moved}`;
    },
    [createFolderMutate, queryClient, runSequential],
  );

  const tagMutation = useMutation({
    mutationFn: (input: { ids: string[]; tag: string }) =>
      bulkTagCampaigns(input.ids, input.tag),
  });
  const tagMutate = tagMutation.mutateAsync;

  const tag = useCallback(
    async (rows: readonly SelectableCampaign[], value: string): Promise<string> => {
      setRunning("tag");
      try {
        const result = await tagMutate({
          ids: rows.map((r) => String(r.id)),
          tag: value,
        });
        invalidate();
        // `tagged` counts rows actually inserted; ON CONFLICT DO NOTHING means
        // a campaign that already carried the tag is not a failure, and saying
        // "tagged 3 of 7" for that would read as one.
        const already = rows.length - result.tagged;
        const base = `Tagged ${result.tagged} ${result.tagged === 1 ? "campaign" : "campaigns"} "${result.tag}".`;
        return already > 0
          ? `${base} ${already} already had it.`
          : base;
      } catch (err) {
        // The bulk route is one transaction: it either tags everything or
        // nothing, so there is no partial state to describe here.
        throw new Error(
          campaignErrorMessage(err, "Couldn't tag the selected campaigns."),
        );
      } finally {
        setRunning(null);
      }
    },
    [invalidate, tagMutate],
  );

  return {
    running,
    progress,
    deleteDrafts,
    moveToFolder,
    createFolderAndMove,
    tag,
  };
}
