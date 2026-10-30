/**
 * tagRowActions — the tag chip's long-press / rotor verbs.
 *
 * Extracted verbatim from app/(tabs)/tags.tsx so the screen stays inside
 * its file budget as it grows a create path; the behaviour and its history
 * (LOVE#32, the VoiceOver rotor mirror) are unchanged and still pinned by
 * __tests__/row-action-menu.native.test.tsx through the mounted screen.
 */
import { router } from "expo-router";
import { Share } from "react-native";

import type { RowAction } from "@/components/RowActionSheet";
import type { TagChipAction } from "@/components/tags/TagChip";
import type { useToast } from "@/components/Toast";
import { copyToClipboard } from "@/lib/clipboard";
import { haptics } from "@/lib/haptics";
import type { TagCatalogueRow } from "@/lib/tagCatalogue";

/** The toast callback the row verbs report through. */
export type ToastFn = ReturnType<typeof useToast>["toast"];

/** Module-level so an empty menu is not a new array identity per render. */
export const EMPTY_ACTIONS: RowAction[] = [];

/**
 * The chip's VoiceOver rotor actions — the same three verbs `tagMenuActions`
 * builds, without the per-row closures, so this can be a module constant and
 * the memoised `TagChip` keeps its identity across a re-sort.
 *
 * A long press is unperformable with VoiceOver, so without this the copy and
 * share verbs exist for sighted users only — and `tagSpokenLabel` was narrating
 * a gesture the chip never published. `row-action-menu.native.test.tsx` pins
 * this list against `tagMenuActions` so the two cannot drift.
 */
export const TAG_CHIP_ACTIONS: readonly TagChipAction[] = [
  { name: "subscribers", label: "See who's tagged" },
  { name: "copy", label: "Copy tag name" },
  { name: "share", label: "Share tag name" },
  // Viewer-scoped (GET /tags/{id}/history), so it can live in the static
  // rotor list. The editor-only Edit verb is NOT here: publishing it to
  // every rotor would advertise a verb most sessions cannot use.
  { name: "history", label: "Membership history" },
];

// LOVE#32. A long press used to do exactly one thing — open the share
// sheet — which spent the phone's right-click on the least likely verb: the
// reason to long-press a tag is almost always to get its EXACT name into a
// segment rule, and Share is three taps away from a paste. The gesture now
// opens a menu whose first item is the one people actually want.
//
// The base verbs plus the maintenance openers the SCREEN passes in:
// History (viewer, GET /tags/{id}/history) always when offered; Edit
// (editor, conditional PATCH) only when the caller's role clears the
// floor — an absent opener is an absent row, never a disabled one.
// DELETE is deliberately not here: both delete routes answer an
// unconditional server-side 409 hold (tags.go Delete, bulk_delete.go),
// and a verb that always fails is an advertisement for a feature that
// does not exist.
export function tagMenuActions(
  row: TagCatalogueRow,
  toast: ToastFn,
  openers: {
    onHistory?: ((row: TagCatalogueRow) => void) | undefined;
    onEdit?: ((row: TagCatalogueRow) => void) | undefined;
  } = {},
): RowAction[] {
  const name = (row.name ?? "").trim();
  const maintenance: RowAction[] = [
    ...(openers.onHistory
      ? [
          {
            key: "history",
            label: "Membership history",
            hint: "When this tag was applied and removed",
            onPress: () => openers.onHistory?.(row),
          },
        ]
      : []),
    ...(openers.onEdit
      ? [
          {
            key: "edit",
            label: "Edit tag",
            hint: "Color, description, and group",
            onPress: () => openers.onEdit?.(row),
          },
        ]
      : []),
  ];
  return [
    {
      key: "subscribers",
      label: "See who's tagged",
      hint: "Opens Subscribers filtered to this tag",
      onPress: () =>
        router.push({
          pathname: "/(tabs)/subscribers",
          params: { q: name },
        }),
    },
    {
      key: "copy",
      label: "Copy tag name",
      hint: "Paste it into a segment rule",
      onPress: () => {
        void copyToClipboard(name).then((copied) => {
          // `setStringAsync` resolves false on a locked pasteboard rather
          // than throwing, so a "Copied" toast would be a lie.
          haptics.tap();
          toast(
            copied
              ? { kind: "success", message: `Copied “${name}”` }
              : { kind: "error", message: "Couldn't copy that tag." },
          );
        });
      },
    },
    {
      key: "share",
      label: "Share tag name",
      onPress: () => shareTagName(row, toast),
    },
    ...maintenance,
  ];
}

function shareTagName(row: TagCatalogueRow, toast: ToastFn) {
  const name = (row.name ?? "").trim();
  if (!name) return;
  haptics.tap();
  void Share.share({ message: name }, { dialogTitle: `Tag: ${name}` }).catch(
    (e: unknown) => {
      // A failed share is worth reporting and not worth a modal — the user
      // is still looking at the list they wanted.
      toast({
        kind: "error",
        message:
          `Couldn't share that tag. ${e instanceof Error ? e.message : ""}`.trim(),
      });
    },
  );
}
