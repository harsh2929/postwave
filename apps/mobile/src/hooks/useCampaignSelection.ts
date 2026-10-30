/**
 * hooks/useCampaignSelection.ts — the campaigns list's selection mode.
 *
 * Long-press a row to enter it; tap rows to add and remove; Done to leave.
 * That is the iOS convention, and it is the only one that works without the
 * header checkbox column desktop's bulk toolbar is built around.
 *
 * The hook owns the selection, the sheets it opens, and every guard, so
 * app/(tabs)/campaigns/index.tsx stays a readable state ladder rather than growing
 * a second screen inside itself.
 *
 * WHAT IS DELIBERATELY NOT HERE. Desktop's bulk set includes a twelve-column
 * CSV DOWNLOAD; a phone has no download folder worth the name and this app
 * has no filesystem dependency, so Export writes the same rows to the
 * clipboard and offers the share sheet instead — see lib/campaignExport, which
 * also stamps the export with what it actually contains.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Share } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import type { SelectionVerb } from "@/components/campaigns/CampaignSelectionBar";
import { useToast } from "@/components/Toast";
import {
  useCampaignCompare,
  useCampaignFolders,
  useCampaignOrganizeActions,
} from "@/hooks/useCampaignOrganize";
import type { Campaign } from "@/hooks/useCampaigns";
import { copyToClipboard } from "@/lib/clipboard";
import {
  campaignExportCaveat,
  campaignExportText,
  type CampaignExportScope,
} from "@/lib/campaignExport";
import {
  CAMPAIGN_SELECTION_MAX,
  bulkTagBlockedReason,
  campaignSelectionLabel,
  compareBlockedReason,
  partitionDeletable,
  pruneCampaignSelection,
  selectedCampaigns,
  toggleCampaignSelection,
} from "@/lib/campaignSelection";
import { plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";

export type BulkSheet = "tag" | "folder" | "compare" | null;

export interface CampaignSelectionController {
  active: boolean;
  selected: string[];
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  /** Long-press handler: enters selection mode with that row already picked. */
  begin: (id: string) => void;
  exit: () => void;
  verbs: SelectionVerb[];
  busyLabel: string | null;
  sheet: BulkSheet;
  closeSheet: () => void;
  /** Rows behind the current selection, in list order. */
  rows: Campaign[];
  folders: ReturnType<typeof useCampaignFolders>;
  compare: ReturnType<typeof useCampaignCompare>;
  applyTag: (tag: string) => void;
  applyFolder: (folderId: string | null) => void;
  /** Create a folder (create-or-reuse server-side) and file the selection into it. */
  applyNewFolder: (name: string) => void;
  nameFor: (campaignId: string) => string;
  pending: boolean;
}

export interface UseCampaignSelectionInput {
  /** Every row currently loaded and visible after filtering. */
  visible: readonly Campaign[];
  canMutate: boolean;
  /** Stated on every disabled verb when the role or session blocks writes. */
  blockedReason: string | null;
  /** Describes an export of the whole visible list (used when nothing is picked). */
  exportScope: Omit<CampaignExportScope, "exported" | "selection">;
}

export function useCampaignSelection(
  input: UseCampaignSelectionInput,
): CampaignSelectionController {
  const { visible, canMutate, blockedReason } = input;
  const { toast } = useToast();
  const confirm = useConfirm();
  const folders = useCampaignFolders();
  const actions = useCampaignOrganizeActions();

  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [sheet, setSheet] = useState<BulkSheet>(null);

  const visibleIds = useMemo(
    () => visible.map((c) => String(c.id)),
    [visible],
  );

  // A refetch that removes a campaign must not leave a phantom id behind: the
  // count in the bar would then disagree with the highlighted rows, and a
  // bulk verb would fire at something nobody can see.
  useEffect(() => {
    setSelected((prev) => {
      const next = pruneCampaignSelection(prev, visibleIds);
      return next.length === prev.length ? prev : next;
    });
  }, [visibleIds]);

  const rows = useMemo(
    () => selectedCampaigns(visible, selected),
    [visible, selected],
  );

  const nameFor = useCallback(
    (campaignId: string) => {
      const row = visible.find((c) => String(c.id) === campaignId);
      return row ? campaignSelectionLabel(row) : "This campaign";
    },
    [visible],
  );

  const exit = useCallback(() => {
    setActive(false);
    setSelected([]);
    setSheet(null);
  }, []);

  const begin = useCallback((id: string) => {
    haptics.impact();
    setActive(true);
    setSelected([id]);
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = toggleCampaignSelection(prev, id);
      // Deselecting the last row leaves selection mode rather than stranding
      // an empty bar whose every verb is disabled.
      if (next.length === 0) setActive(false);
      return next;
    });
  }, []);

  const isSelected = useCallback(
    (id: string) => selected.includes(id),
    [selected],
  );

  const closeSheet = useCallback(() => setSheet(null), []);

  const compare = useCampaignCompare(selected, sheet === "compare");

  const runDelete = useCallback(() => {
    void (async () => {
      const { deletable, blocked } = partitionDeletable(rows);
      if (deletable.length === 0) {
        toast({
          kind: "warning",
          message:
            "None of the selected campaigns are drafts. Only a draft can be deleted — everything else has already sent or is sending.",
        });
        return;
      }
      const ok = await confirm({
        title: `Delete ${plural(deletable.length, "draft")}?`,
        message: deletable
          .slice(0, 5)
          .map((c) => campaignSelectionLabel(c))
          .join(", "),
        // The split is stated BEFORE the tap, not discovered afterwards as a
        // string of 409s.
        ...(blocked.length > 0
          ? {
              consequence: `${plural(blocked.length, "selected campaign")} will be left alone — only drafts can be deleted. This can't be undone.`,
            }
          : { consequence: "This can't be undone." }),
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      const message = await actions.deleteDrafts(deletable);
      toast({ kind: "info", message });
      exit();
    })();
  }, [actions, confirm, exit, rows, toast]);

  // Read out of the props object rather than closed over, so a fresh literal
  // from the screen does not rebuild the whole verb list every render.
  const { moreAvailable, query, filterLabel } = input.exportScope;

  const runExport = useCallback(() => {
    void (async () => {
      const source = rows.length > 0 ? rows : visible;
      const scope: CampaignExportScope = {
        moreAvailable,
        ...(query ? { query } : {}),
        ...(filterLabel ? { filterLabel } : {}),
        exported: source.length,
        selection: rows.length > 0,
      };
      if (source.length === 0) {
        toast({ kind: "warning", message: "There are no campaigns to export." });
        return;
      }
      const text = campaignExportText(source, scope);
      const copied = await copyToClipboard(text);
      // Share is offered whether or not the clipboard write landed, because
      // it is the path that actually leaves the device. A "Copied" toast for
      // a clipboard that refused would be a lie.
      toast({
        kind: copied ? "success" : "warning",
        message: copied
          ? `Copied as CSV — ${campaignExportCaveat(scope)}`
          : "Couldn't write to the clipboard; opening the share sheet instead.",
      });
      await Share.share(
        { message: text },
        { dialogTitle: "Export campaigns" },
      ).catch(() => {
        /* the clipboard copy above is the fallback; a cancelled sheet is not
           an error worth a second toast. */
      });
    })();
  }, [filterLabel, moreAvailable, query, rows, toast, visible]);

  const applyTag = useCallback(
    (tag: string) => {
      void (async () => {
        try {
          const message = await actions.tag(rows, tag);
          toast({ kind: "success", message });
          setSheet(null);
          exit();
        } catch (err) {
          toast({
            kind: "error",
            message:
              err instanceof Error
                ? err.message
                : "Couldn't tag the selected campaigns.",
          });
        }
      })();
    },
    [actions, exit, rows, toast],
  );

  const applyFolder = useCallback(
    (folderId: string | null) => {
      void (async () => {
        const message = await actions.moveToFolder(rows, folderId);
        toast({ kind: "info", message });
        setSheet(null);
        exit();
      })();
    },
    [actions, exit, rows, toast],
  );

  const applyNewFolder = useCallback(
    (name: string) => {
      void (async () => {
        try {
          const message = await actions.createFolderAndMove(rows, name);
          toast({ kind: "success", message });
          setSheet(null);
          exit();
        } catch (err) {
          // The sheet stays open: the typed name is still in the field, and
          // closing over a failure would throw it away with the reason.
          toast({
            kind: "error",
            message:
              err instanceof Error ? err.message : "Couldn't create the folder.",
          });
        }
      })();
    },
    [actions, exit, rows, toast],
  );

  const count = selected.length;
  const writeBlocked = canMutate
    ? null
    : (blockedReason ??
      "Your role can't change campaigns in this workspace.");
  const overLimit =
    count > CAMPAIGN_SELECTION_MAX
      ? `Selections are capped at ${CAMPAIGN_SELECTION_MAX} campaigns on a phone — narrow the list first, or do this on the web app.`
      : null;

  const verbs = useMemo<SelectionVerb[]>(
    () => [
      {
        key: "tag",
        label: "Tag",
        onPress: () => setSheet("tag"),
        blockedReason: writeBlocked ?? overLimit ?? bulkTagBlockedReason(count),
      },
      {
        key: "folder",
        label: "Move",
        onPress: () => setSheet("folder"),
        blockedReason:
          writeBlocked ??
          overLimit ??
          (count === 0 ? "Select campaigns to file them." : null),
      },
      {
        key: "compare",
        label: "Compare",
        onPress: () => setSheet("compare"),
        // Read-only: a viewer may compare. Only the count constrains it.
        blockedReason: compareBlockedReason(count),
      },
      {
        key: "export",
        label: "Export",
        onPress: runExport,
        blockedReason: count === 0 ? "Select campaigns to export them." : null,
      },
      {
        key: "delete",
        label: "Delete",
        onPress: runDelete,
        destructive: true,
        blockedReason:
          writeBlocked ??
          overLimit ??
          (count === 0 ? "Select drafts to delete them." : null),
      },
    ],
    [count, overLimit, runDelete, runExport, writeBlocked],
  );

  const busyLabel = actions.progress
    ? `${actions.running === "delete" ? "Deleting" : "Moving"} ${actions.progress.done} of ${actions.progress.total}…`
    : actions.running === "tag"
      ? "Tagging…"
      : null;

  return {
    active,
    selected,
    isSelected,
    toggle,
    begin,
    exit,
    verbs,
    busyLabel,
    sheet,
    closeSheet,
    rows,
    folders,
    compare,
    applyTag,
    applyFolder,
    applyNewFolder,
    nameFor,
    pending: actions.running !== null,
  };
}
