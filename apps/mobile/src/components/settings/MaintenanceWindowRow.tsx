/**
 * MaintenanceWindowRow — one maintenance window: title, phase pill, range,
 * affected components, and (for an admin on a tenant-owned row) the
 * transitions the server allows from its current status.
 *
 * Cancel is soft on the server (status = cancelled, history kept) and is the
 * one destructive-looking verb, so it confirms; Start / Mark complete are a
 * single PATCH each. A platform-wide window renders read-only — it is not
 * this tenant's to change and the handler's UPDATE would touch nothing.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import {
  cancelMaintenanceWindow,
  setMaintenanceWindowStatus,
} from "@/api/maintenanceWindows";
import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import { transitionLabel } from "@/lib/direction";
import { FONT } from "@/lib/fonts";
import { dateTime } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import {
  maintenanceActionsFor,
  maintenanceErrorMessage,
  maintenancePhase,
  maintenancePhaseLabel,
  maintenancePhaseTone,
  type MaintenanceAction,
  type MaintenanceActionKey,
  type MaintenanceWindowView,
} from "@/lib/maintenanceWindows";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function MaintenanceWindowRow({
  window: w,
  canAdmin,
  first,
  onChanged,
}: {
  window: MaintenanceWindowView;
  canAdmin: boolean;
  first: boolean;
  /** Called after any successful write so the list re-reads. */
  onChanged: () => void;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<MaintenanceActionKey | null>(null);
  const phase = maintenancePhase(w);
  const phaseLabel = maintenancePhaseLabel(phase);
  const actions = maintenanceActionsFor(w, canAdmin);
  const range = transitionLabel(dateTime(w.startsAt), dateTime(w.endsAt));

  async function run(action: MaintenanceAction) {
    if (busy !== null) return;
    if (action.key === "cancel") {
      const ok = await confirm({
        title: `Cancel "${w.title}"?`,
        message: "The window stays in history as cancelled.",
        confirmLabel: "Cancel window",
        cancelLabel: "Keep it",
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(action.key);
    try {
      const res = action.status
        ? await setMaintenanceWindowStatus(w.id, action.status)
        : await cancelMaintenanceWindow(w.id);
      if (res.error) {
        haptics.error();
        toast({ kind: "error", message: maintenanceErrorMessage(res.error) });
        return;
      }
      haptics.success();
      toast({
        kind: "success",
        message:
          action.key === "cancel"
            ? `Cancelled "${w.title}".`
            : action.key === "start"
              ? `"${w.title}" is now in progress.`
              : `"${w.title}" marked complete.`,
      });
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  const spoken = [
    w.title,
    phaseLabel,
    range,
    w.description || null,
    w.components.length > 0 ? `Affects ${w.components.join(", ")}` : null,
    w.platform ? "Platform-wide, managed by Moosewave" : null,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <View
      // A container that is itself accessible swallows the buttons inside it,
      // so only an action-less row is read as one element.
      accessible={actions.length === 0}
      accessibilityLabel={spoken}
      style={{
        paddingVertical: 8,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: t.borderSubtle,
        gap: 3,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            flex: 1,
            fontFamily: FONT.semibold,
          }}
          numberOfLines={2}
        >
          {w.title}
        </Text>
        {/* Phase is never colour-alone: the pill carries the word. */}
        <Pill label={phaseLabel} tone={maintenancePhaseTone(phase)} />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {range}
      </Text>
      {w.description ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
          numberOfLines={3}
        >
          {w.description}
        </Text>
      ) : null}
      {w.components.length > 0 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
          numberOfLines={2}
        >
          Affects {w.components.join(", ")}
        </Text>
      ) : null}
      {w.platform ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          Platform-wide — managed by Moosewave.
        </Text>
      ) : null}
      {actions.length > 0 ? (
        <View style={{ flexDirection: "row", gap: 16, marginTop: 2 }}>
          {actions.map((action) => (
            <Pressable
              key={action.key}
              onPress={() => void run(action)}
              disabled={busy !== null}
              accessibilityRole="button"
              accessibilityLabel={`${action.label}: ${w.title}`}
              accessibilityState={{
                disabled: busy !== null,
                busy: busy === action.key,
              }}
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text
                {...typeCap("callout")}
                style={{
                  color: action.destructive ? t.danger : t.accent,
                  ...typeStyle("callout"),
                  fontFamily: FONT.semibold,
                  opacity: busy !== null && busy !== action.key ? 0.5 : 1,
                }}
              >
                {busy === action.key ? "Working…" : action.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}
