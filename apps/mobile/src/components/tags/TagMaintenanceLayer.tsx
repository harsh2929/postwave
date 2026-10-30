/**
 * TagMaintenanceLayer — the tag screen's row-menu + maintenance-sheet
 * cluster, extracted so app/(tabs)/tags.tsx stays inside its function
 * budget as the catalogue grows verbs.
 *
 * The hook owns WHICH row's menu/sheet is open and hands the screen:
 *  - `openMenu` for the chip long-press;
 *  - `runTagAction` for the VoiceOver rotor (the SAME verbs, per LOVE#32);
 *  - `layer`, the element rendering the RowActionSheet plus the edit /
 *    history / group sheets.
 * Role honesty is decided HERE once: History rides every role (viewer
 * read); Edit and Manage-groups exist only past the editor floor.
 */
import { useCallback, useMemo, useState } from "react";

import { RowActionSheet } from "@/components/RowActionSheet";
import { useToast } from "@/components/Toast";
import {
  TagEditSheet,
  TagGroupManageSheet,
  TagHistorySheet,
} from "@/components/tags/TagManageSheets";
import {
  EMPTY_ACTIONS,
  tagMenuActions,
} from "@/components/tags/tagRowActions";
import type { TagCatalogueRow } from "@/lib/tagCatalogue";
import type { TagGroup } from "@/lib/tagGroups";
import type { ThemeTokens } from "@/lib/theme";

export function useTagMaintenance({
  canEdit,
  groups,
  t,
}: {
  /** Editor floor — gates Edit and the group sheet, never History. */
  canEdit: boolean;
  groups: readonly TagGroup[];
  t: ThemeTokens;
}) {
  const { toast } = useToast();
  const [menuRow, setMenuRow] = useState<TagCatalogueRow | null>(null);
  const [editRow, setEditRow] = useState<TagCatalogueRow | null>(null);
  const [historyRow, setHistoryRow] = useState<TagCatalogueRow | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);

  // The openers close the row menu first so two sheets never stack.
  const openHistory = useCallback((row: TagCatalogueRow) => {
    setMenuRow(null);
    setHistoryRow(row);
  }, []);
  const openEdit = useCallback((row: TagCatalogueRow) => {
    setMenuRow(null);
    setEditRow(row);
  }, []);
  const menuOpeners = useMemo(
    () => ({
      onHistory: openHistory,
      ...(canEdit ? { onEdit: openEdit } : {}),
    }),
    [canEdit, openEdit, openHistory],
  );

  // The rotor path into the SAME verbs the long press opens. Stable across
  // renders so the memoised chips do not re-render when the list re-sorts.
  const runTagAction = useCallback(
    (row: TagCatalogueRow, name: string) => {
      tagMenuActions(row, toast, menuOpeners)
        .find((a) => a.key === name)
        ?.onPress();
    },
    [menuOpeners, toast],
  );

  const menuActions = menuRow
    ? tagMenuActions(menuRow, toast, menuOpeners)
    : EMPTY_ACTIONS;

  const layer = (
    <>
      <RowActionSheet
        visible={menuRow !== null}
        title={menuRow?.name || "Tag"}
        {...(menuRow?.description ? { subtitle: menuRow.description } : {})}
        actions={menuActions}
        onClose={() => setMenuRow(null)}
      />
      <TagEditSheet
        row={editRow}
        groups={groups}
        onClose={() => setEditRow(null)}
        t={t}
      />
      <TagHistorySheet
        row={historyRow}
        onClose={() => setHistoryRow(null)}
        t={t}
      />
      <TagGroupManageSheet
        visible={groupsOpen}
        groups={groups}
        onClose={() => setGroupsOpen(false)}
        t={t}
      />
    </>
  );

  return {
    openMenu: setMenuRow,
    runTagAction,
    openGroups: () => setGroupsOpen(true),
    layer,
  };
}
