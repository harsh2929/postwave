/**
 * InboundRouteEnabledControl — the off switch for the selected routing rule,
 * with the row moving on tap and moving back on failure.
 *
 * Verbs, confirm gate and toasts come from lib/inboundRouteToggle. The
 * mutation underneath is the projected write in hooks/useInboundRouteEnabled,
 * so `route.enabled` — and with it the verb below, the "switched off" note
 * above it and the live/off pill on the rule's row — flips the moment the tap
 * lands, and flips back carrying the server's sentence if the PATCH fails.
 *
 * HISTORY. A non-projected sibling (InboundRouteToggleAction, on the plain
 * useToggleInboundRoute mutation) was kept beside this one for a while as the
 * decided-against alternative: it left the row disagreeing with the control
 * for one round trip after its own success toast. Nothing ever mounted it,
 * so it and its hook were removed rather than carried as dead code with a
 * live test.
 */
import { ActivityIndicator, Pressable, Text } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { useSetInboundRouteEnabled } from "@/hooks/useInboundRouteEnabled";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { rollbackNotice } from "@/lib/inboundRouteOptimistic";
import { disableConfirmCopy, toggleVerb } from "@/lib/inboundRouteToggle";
import type { InboundRoute } from "@/lib/inboundRoutes";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function InboundRouteEnabledControl({ route }: { route: InboundRoute }) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const setEnabled = useSetInboundRouteEnabled();

  const verb = toggleVerb(route.enabled);
  const busy = setEnabled.isPending;

  const onPress = async () => {
    if (busy) return;
    haptics.tap();
    const next = !route.enabled;
    if (!next) {
      const copy = disableConfirmCopy(route);
      const ok = await confirm({
        title: copy.title,
        message: copy.message,
        confirmLabel: "Switch off",
        destructive: true,
        consequence: copy.consequence,
      });
      if (!ok) return;
    }
    // `verb` was read before the projection flips `route.enabled`, so both
    // toasts describe the direction that was actually attempted.
    setEnabled.mutate(
      { route, enabled: next },
      {
        onSuccess: () => {
          haptics.success();
          toast({ kind: "success", message: verb.successToast });
        },
        onError: (err) => {
          haptics.error();
          toast({ kind: "error", message: rollbackNotice(err, next) });
        },
      },
    );
  };

  return (
    <Pressable
      onPress={() => void onPress()}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={verb.accessibilityLabel}
      accessibilityHint={
        route.enabled
          ? "The rule is on and matching inbound mail."
          : "The rule is off and matching nothing. Its history is kept."
      }
      accessibilityState={{ disabled: busy, busy }}
      style={{
        borderColor: route.enabled ? t.danger : t.border,
        borderWidth: 1,
        borderRadius: 12,
        minHeight: 44,
        marginBottom: 10,
        paddingHorizontal: 14,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: 8,
        backgroundColor: t.surface,
        opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? (
        <ActivityIndicator
          size="small"
          color={route.enabled ? t.danger : t.fgMuted}
        />
      ) : null}
      <Text
        {...typeCap("control")}
        style={{
          color: route.enabled ? t.danger : t.fg,
          ...typeStyle("control"),
          fontFamily: FONT.semibold,
        }}
      >
        {busy ? "Switching…" : verb.label}
      </Text>
    </Pressable>
  );
}
