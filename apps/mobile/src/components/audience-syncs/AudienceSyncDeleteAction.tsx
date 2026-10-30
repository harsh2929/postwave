/**
 * AudienceSyncDeleteAction — "retire this sync", inside the detail sheet.
 *
 * ITS OWN COMPONENT, not more lines in AudienceSyncDetailSheet: the sheet is a
 * presentational surface that takes its data as props, and this control owns a
 * mutation, a confirm sheet, a toast and a role floor. Keeping them here leaves
 * the sheet's mount a single block, and lets a render test drive the destructive
 * path without standing up the whole screen.
 *
 * THE ROLE FLOOR IS READ HERE rather than passed down, exactly as
 * AudienceDestinationsPanel reads its own: `DELETE /{id}` is
 * `RequireScope(ScopeWriteSubscribers)` (sync_handlers.go:55) → owner, admin,
 * editor. That happens to be the same floor as run-now, but it is a DIFFERENT
 * route's floor, and deriving it from `canRun` would make a future server-side
 * split invisible here.
 *
 * WHY A VIEWER IS TOLD, rather than shown nothing: the sheet's existing notice
 * explains only why RUN NOW is missing. Silence about a second missing control
 * reads as "this build has no delete", which is a claim about the app rather
 * than about the reader's role.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useDeleteAudienceSync } from "@/hooks/useDeleteAudienceSync";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  deleteAlreadyGone,
  deleteSyncBlockedReason,
  deleteSyncCopy,
  deleteSyncErrorMessage,
  deleteSyncSuccessMessage,
} from "@/lib/audienceSyncDelete";
import {
  destinationTypeLabel,
  sourceLabel,
  type AudienceSync,
} from "@/lib/audienceSyncs";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

export interface AudienceSyncDeleteActionProps {
  sync: AudienceSync;
  /** Runs the ledger holds, for the confirm sheet. Null while unread. */
  runCount: number | null;
  online: boolean;
  /** Called after the server accepted the delete — the sheet closes. */
  onDeleted: () => void;
}

export function AudienceSyncDeleteAction(props: AudienceSyncDeleteActionProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const remove = useDeleteAudienceSync();
  const mayDelete = canAccessMinimumRole("editor", gate.effectiveRole, mode);
  const blocked = deleteSyncBlockedReason(props.online);

  if (!mayDelete) {
    return (
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Deleting a sync also needs an editor role, so this workspace keeps its
        run history where you can read it.
      </Text>
    );
  }

  const press = async () => {
    if (remove.isPending) return;
    const ok = await confirm(
      deleteSyncCopy({
        name: props.sync.name,
        destinationLabel: destinationTypeLabel(props.sync.destination.type),
        sourceLabel: sourceLabel(props.sync),
        runCount: props.runCount,
      }),
    );
    if (!ok) return;
    haptics.impact();
    try {
      await remove.mutateAsync({ syncId: props.sync.id });
      haptics.success();
      // No undo on the toast: the API has no route that restores a deleted
      // sync, so offering one would be a lie about what it can do.
      toast({
        kind: "success",
        message: deleteSyncSuccessMessage(props.sync.name),
      });
      props.onDeleted();
    } catch (error) {
      // An already-gone sync is the outcome that was wanted: close the sheet
      // and say so plainly rather than painting it as a failure.
      if (deleteAlreadyGone(error)) {
        toast({ kind: "info", message: deleteSyncErrorMessage(error) });
        props.onDeleted();
        return;
      }
      haptics.error();
      toast({ kind: "error", message: deleteSyncErrorMessage(error) });
    }
  };

  const disabled = remove.isPending || blocked !== null;
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        onPress={() => void press()}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={
          remove.isPending ? "Deleting the sync" : "Delete sync"
        }
        accessibilityHint="Removes this sync and its whole run history; nothing further is pushed to the destination"
        accessibilityState={{ disabled, busy: remove.isPending }}
        style={{
          minHeight: 48,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 12,
          backgroundColor: t.surface,
          borderWidth: 1,
          borderColor: disabled ? t.borderSubtle : t.danger,
        }}
      >
        <Text
          {...typeCap("control")}
          style={{
            color: disabled ? t.fgSubtle : t.danger,
            ...typeStyle("control"),
            fontFamily: FONT.semibold,
          }}
        >
          {remove.isPending ? "Deleting…" : "Delete sync"}
        </Text>
      </Pressable>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {blocked ??
          "The sync and every run it recorded are deleted together, and a sync that is mid-delivery is refused until its run finishes."}
      </Text>
    </View>
  );
}
