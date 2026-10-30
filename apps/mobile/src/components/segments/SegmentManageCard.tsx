/**
 * SegmentManageCard — the destructive manage affordance on the segment
 * detail (desktop anchor: pages/Segments.tsx "Delete segment" ConfirmModal).
 *
 * Withholding rules, in order:
 *  - BELOW EDITOR (DELETE /api/v1/segments/{id} is editor-floor in the
 *    routeauth manifest) the card renders nothing at all — unlike lists,
 *    there is no read-only management row to explain, so an empty card
 *    would only advertise an absence.
 *  - Offline / gated → hidden; the screen's gate notice already explains,
 *    and this write is ONLINE-ONLY (see api/segmentsManage.ts — deleting is
 *    irreversible, so it must never replay from a queue).
 *
 * Deleting is IRREVERSIBLE and takes the typed-confirm path: the operator
 * types the segment's name (ConfirmSheet confirmPhrase).
 */
import { Pressable, Text } from "react-native";
import { router } from "expo-router";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { Card, Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import { useDeleteSegment } from "@/hooks/useSegmentManage";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SegmentManageCard({
  segment,
  blocked,
}: {
  /** The loaded segment; the card renders nothing until it exists. */
  segment: { id: string; name: string } | null | undefined;
  /** The online gate is closed — the screen already says why. */
  blocked: boolean;
}) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const remove = useDeleteSegment();

  if (!segment) return null;
  if (blocked) return null;
  if (!canAccessMinimumRole("editor", gate.effectiveRole)) return null;

  const onDelete = () => {
    if (remove.isPending) return;
    void (async () => {
      const ok = await confirm({
        title: "Delete this segment?",
        message:
          "The rule, its snapshots, and every reference to it are removed. Subscribers themselves are not deleted.",
        confirmLabel: "Delete segment",
        destructive: true,
        confirmPhrase: segment.name,
        consequence: "Deleting a segment can't be undone.",
      });
      if (!ok) return;
      haptics.tap();
      remove.mutate(segment.id, {
        onSuccess: () => {
          haptics.success();
          toast({ kind: "success", message: `Deleted “${segment.name}”.` });
          router.replace("/(tabs)/segments");
        },
        onError: (error) => {
          haptics.error();
          toast({
            kind: "error",
            message:
              errorPresentation(error).message || "Couldn't delete the segment.",
          });
        },
      });
    })();
  };

  return (
    <Card accessibilityLabel="Segment management">
      <Label>Manage</Label>
      <Pressable
        onPress={onDelete}
        disabled={remove.isPending}
        accessibilityRole="button"
        accessibilityLabel="Delete this segment"
        accessibilityState={{ disabled: remove.isPending }}
        style={{
          paddingVertical: 12,
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.danger,
            ...typeStyle("body"),
            fontFamily: FONT.medium,
          }}
        >
          {remove.isPending ? "Deleting…" : "Delete segment"}
        </Text>
      </Pressable>
    </Card>
  );
}
