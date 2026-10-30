/**
 * ListManageActions — the manage affordances on the list detail Overview:
 * edit settings (desktop SettingsTab) and delete (desktop Lists.tsx
 * ConfirmModal), translated to a card of action rows + sheets.
 *
 * Withholding rules, in order:
 *  - BELOW EDITOR the card renders ONE caption instead of controls (both
 *    routes are editor-floor in the routeauth manifest; a disabled button
 *    would advertise an affordance the role cannot use).
 *  - NO CATALOGUE ROW (the detail was reached by a UUID deep link the
 *    catalogue page doesn't hold) → render nothing: the PATCH/DELETE
 *    handlers accept ONLY the Listmonk bigint id, so there is no honest
 *    request to offer.
 *  - Offline / gated → the parent's gate notice already explains; the card
 *    hides its controls rather than queueing (these writes are online-only —
 *    see api/listsManage.ts).
 *
 * Deleting is IRREVERSIBLE and takes the typed-confirm path: the operator
 * types the list's name (ConfirmSheet confirmPhrase).
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { Card, Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import { EditListSheet } from "@/components/lists/EditListSheet";
import { useDeleteList, useUpdateList } from "@/hooks/useListManage";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { ListOption } from "@/hooks/useListOptions";
import { forwardChevron } from "@/lib/direction";
import { errorPresentation } from "@/lib/errorCopy";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import {
  isListmonkBigintId,
  LIST_MANAGE_ROLE_CAPTION,
} from "@/lib/listSettingsForm";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ListManageActions({
  list,
  blocked,
}: {
  /** The catalogue row for this list; undefined while it hasn't loaded. */
  list: ListOption | undefined;
  /** The online gate is closed — the screen already says why. */
  blocked: boolean;
}) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const update = useUpdateList();
  const remove = useDeleteList();

  const canManage = canAccessMinimumRole("editor", gate.effectiveRole);

  // No bigint id, no honest request to offer (see file header).
  if (!list || !isListmonkBigintId(list.id)) return null;

  if (!canManage) {
    return (
      <Card accessibilityLabel="List management" style={{ marginBottom: 12 }}>
        <Label>Manage</Label>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
            marginTop: 6,
          }}
        >
          {LIST_MANAGE_ROLE_CAPTION}
        </Text>
      </Card>
    );
  }

  if (blocked) return null;

  const onDelete = () => {
    if (remove.isPending) return;
    void (async () => {
      const ok = await confirm({
        title: "Delete this list?",
        message:
          "The list and its membership records are removed everywhere. Subscribers themselves are not deleted.",
        confirmLabel: "Delete list",
        destructive: true,
        confirmPhrase: list.name,
        consequence: "Deleting a list can't be undone.",
      });
      if (!ok) return;
      haptics.tap();
      remove.mutate(list.id, {
        onSuccess: () => {
          haptics.success();
          toast({ kind: "success", message: `Deleted “${list.name}”.` });
          router.replace("/(tabs)/lists");
        },
        onError: (error) => {
          haptics.error();
          toast({
            kind: "error",
            message:
              errorPresentation(error).message || "Couldn't delete the list.",
          });
        },
      });
    })();
  };

  const rowStyle = {
    paddingVertical: 12,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
  };

  return (
    <Card accessibilityLabel="List management" style={{ marginBottom: 12 }}>
      <Label>Manage</Label>
      <Pressable
        onPress={() => setEditOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Edit list settings"
        style={rowStyle}
      >
        <Text
          {...typeCap("body")}
          style={{ color: t.fg, ...typeStyle("body"), fontFamily: FONT.medium }}
        >
          Edit settings
        </Text>
        {/* The drill-in affordance. It comes from lib/direction so it points
          at the leading edge once the layout mirrors, and it is held out of
          the a11y tree because the Pressable's own label already says where
          the row goes. `allowFontScaling={false}` is right here for the same
          reason it is on every other chevron in the app: an affordance glyph
          that grows to 3x beside a capped label is a rendering bug, not an
          accommodation. */}
        <Text
          allowFontScaling={false}
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ color: t.fgSubtle, fontFamily: FONT.regular }}
        >
          {forwardChevron()}
        </Text>
      </Pressable>
      <View style={{ height: 1, backgroundColor: t.border }} />
      <Pressable
        onPress={onDelete}
        disabled={remove.isPending}
        accessibilityRole="button"
        accessibilityLabel="Delete this list"
        accessibilityState={{ disabled: remove.isPending }}
        style={rowStyle}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.danger,
            ...typeStyle("body"),
            fontFamily: FONT.medium,
          }}
        >
          {remove.isPending ? "Deleting…" : "Delete list"}
        </Text>
      </Pressable>

      <EditListSheet
        visible={editOpen}
        original={{
          name: list.name,
          description: list.description,
          type: list.type,
          optin: list.optin,
        }}
        submitting={update.isPending}
        onClose={() => setEditOpen(false)}
        onSubmit={(patch) => {
          update.mutate(
            { id: list.id, patch },
            {
              onSuccess: () => {
                haptics.success();
                setEditOpen(false);
                toast({ kind: "success", message: "List settings saved." });
              },
              onError: (error) => {
                haptics.error();
                toast({
                  kind: "error",
                  message:
                    errorPresentation(error).message ||
                    "Couldn't save the list settings.",
                });
              },
            },
          );
        }}
      />
    </Card>
  );
}
