/**
 * SubscribersSavedSegments — the saved-segment strip, wired, now with the
 * WRITE half: save the applied view (editor+) and long-press-delete a chip.
 *
 * A container so the subscribers screen keeps one state variable and one
 * callback instead of a query, two mutations, a toast, a confirm and an
 * applicability decision. The presentation lives in SavedSegmentRow; the
 * reduction rules in src/lib/savedSegments.ts; the save/round-trip rules in
 * src/lib/subscriberSavedSegmentDraft.ts.
 *
 * Renders nothing when the workspace has no saved segments AND the current
 * view offers nothing to save — an empty "Saved segments" heading over blank
 * space is worse than silence on a phone header that is already four rows
 * tall.
 *
 * Role honesty: both writes are editor-scoped (`POST/DELETE
 * /api/v1/segments/saved`), so for a viewer the Save chip and the delete
 * gesture DO NOT EXIST — they are not disabled, they are absent.
 */
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { SavedSegmentChips } from "@/components/subscriber/SavedSegmentRow";
import { useSavedSegments } from "@/hooks/useSavedSegments";
import {
  useCreateSavedSegment,
  useDeleteSavedSegment,
} from "@/hooks/useSubscriberSavedSegmentWrites";
import { SaveSegmentSheet } from "@/components/subscriber/SaveSegmentSheet";
import { useState } from "react";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import type { SavedSegmentRow } from "@/lib/savedSegments";
import {
  buildSavedViewPredicate,
  deleteSegmentConfirmCopy,
  saveableViewProblem,
  savedViewSummary,
  type SavedViewState,
} from "@/lib/subscriberSavedSegmentDraft";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SubscribersSavedSegments({
  activeId,
  onApply,
  view,
  canEdit,
}: {
  activeId: string | null;
  onApply: (id: string, q: string, statusKey: string) => void;
  /** The SETTLED view — what "Save view" would bookmark. */
  view: SavedViewState;
  /** Editor+ with a live (non-gated, online) session. */
  canEdit: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const segments = useSavedSegments();
  const create = useCreateSavedSegment();
  const remove = useDeleteSavedSegment();
  const [saveOpen, setSaveOpen] = useState(false);
  const rows = segments.data ?? [];

  // Offer Save only for a view a bookmark can reproduce EXACTLY, and not for
  // one that came from an existing bookmark (activeId) — saving it again
  // would create a duplicate under a second name.
  const saveable =
    canEdit && activeId === null && saveableViewProblem(view) === null;

  const onDeleteRequest = async (segment: SavedSegmentRow) => {
    const copy = deleteSegmentConfirmCopy({
      name: segment.name,
      visibility: segment.visibility,
    });
    const ok = await confirm({
      title: copy.title,
      message: copy.message,
      confirmLabel: copy.confirmLabel,
      consequence: copy.consequence,
      destructive: true,
    });
    if (!ok) return;
    remove.mutate(segment.id, {
      onSuccess: () => {
        haptics.success();
        toast({ kind: "info", message: `Deleted “${segment.name}”.` });
      },
      onError: (e: unknown) => {
        haptics.error();
        toast({
          kind: "error",
          message:
            `Couldn't delete “${segment.name}”. ${e instanceof Error ? e.message : ""}`.trim(),
        });
      },
    });
  };

  // A failed bookmark load must not take the subscriber list down with it,
  // and an empty row is not worth a heading.
  if (segments.isError || (rows.length === 0 && !saveable)) return null;

  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
      <SavedSegmentChips
        segments={rows}
        activeId={activeId}
        onApply={onApply}
        onUnavailable={(reason) => toast({ kind: "info", message: reason })}
        {...(canEdit ? { onLongPress: (s) => void onDeleteRequest(s) } : {})}
        trailing={
          saveable ? (
            <Pressable
              onPress={() => {
                haptics.tap();
                setSaveOpen(true);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Save the current view as a segment. ${savedViewSummary(view)}`}
              hitSlop={6}
              // NativeWind v4: static style object only.
              style={{
                minHeight: 44,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 999,
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor: t.border,
                backgroundColor: t.surface,
                justifyContent: "center",
              }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("control"),
                  fontFamily: FONT.medium,
                }}
                numberOfLines={1}
              >
                + Save view
              </Text>
            </Pressable>
          ) : null
        }
      />

      <SaveSegmentSheet
        visible={saveOpen}
        viewSummary={savedViewSummary(view)}
        busy={create.isPending}
        submitError={
          create.error instanceof Error ? create.error.message : undefined
        }
        onClose={() => {
          if (!create.isPending) setSaveOpen(false);
        }}
        onSubmit={(input) => {
          const predicate = buildSavedViewPredicate(view);
          if (!predicate) return;
          create.mutate(
            { ...input, predicate },
            {
              onSuccess: () => {
                haptics.success();
                setSaveOpen(false);
                toast({
                  kind: "success",
                  message: `Saved “${input.name}”. It's in the strip above the list.`,
                });
              },
              onError: () => haptics.error(),
            },
          );
        }}
      />
    </View>
  );
}
