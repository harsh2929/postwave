/**
 * SendingKillSwitchCard — hold, or release, all email for the workspace.
 *
 * The most time-critical verb in the product, and it had no mobile client at all
 * (VERB#1): a campaign going out with the wrong link, a compromised key or a
 * provider incident are precisely the moments when nobody is at a desk, and the
 * phone could only READ /api/v1/settings/sending/status. That is finding MAP#74 —
 * "every urgent verb was desktop-only" — in its purest form.
 *
 * Three rules, each of which the server's own contract dictates:
 *
 *  1. A VIEWER SEES THE STATE, ONLY AN ADMIN CHANGES IT. GET /sending/controls is
 *     ScopeReadReports and the two POSTs are ScopeAdmin
 *     (sending_forms_routes.go:56-59). Hiding the state from a viewer would leave
 *     them filing a bug about a campaign that "isn't going out".
 *  2. NEVER SAY "STOPPED". The flag gates FUTURE sends; it makes no claim about a
 *     batch already handed to the provider. Overstating it would have the operator
 *     stop looking.
 *  3. A REASON IS REQUIRED even though the server allows an empty one. A
 *     workspace-wide halt that survives into the next shift with no note is an
 *     incident nobody can hand over — and the response carries pause_reason /
 *     pause_changed_by exactly so it can be read back.
 */
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { useConfirm } from "@/components/ConfirmSheet";
import { Pill } from "@/components/Pill";
import { useToast } from "@/components/Toast";
import { settingsInputStyle } from "@/components/settings/FormControls";
import {
  useSendingControls,
  useSetSendingPaused,
} from "@/hooks/useSendingKillSwitch";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { keyboardChain } from "@/lib/keyboardChain";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  KILL_SWITCH_REASON_MAX,
  killSwitchConfirmCopy,
  killSwitchReasonUsable,
  sendingControlSummary,
} from "@/lib/sendingKillSwitch";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function SendingKillSwitchCard({
  effectiveRole,
}: {
  effectiveRole: string | null;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const confirm = useConfirm();
  const controls = useSendingControls();
  const setPaused = useSetSendingPaused();
  const [reason, setReason] = useState("");

  const control = controls.data;
  if (!control) return null;

  const mayChange = canAccessMinimumRole("admin", effectiveRole);
  const copy = killSwitchConfirmCopy(control.paused);
  // Resuming needs no justification; halting a workspace does.
  const reasonOk = control.paused || killSwitchReasonUsable(reason);
  const canSubmit = mayChange && reasonOk && !setPaused.isPending;

  const onPress = async () => {
    haptics.tap();
    const ok = await confirm({
      title: copy.title,
      message: copy.body,
      confirmLabel: copy.confirmLabel,
      destructive: !control.paused,
      // Spread rather than `undefined`: exactOptionalPropertyTypes distinguishes
      // "absent" from "present and undefined".
      ...(control.paused
        ? {}
        : {
            consequence:
              "Every campaign, automation and transactional send in this workspace.",
          }),
    });
    if (!ok) return;
    setPaused.mutate(
      { paused: !control.paused, reason },
      {
        onSuccess: (next) => {
          setReason("");
          toast({
            kind: next.paused ? "warning" : "success",
            message: next.paused
              ? "Email sending is held for the workspace."
              : "Email sending resumed.",
          });
        },
        onError: (err) =>
          toast({
            kind: "error",
            message:
              err instanceof Error && err.message
                ? err.message
                : "Couldn't change the sending control.",
          }),
      },
    );
  };

  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        marginTop: 12,
        paddingTop: 12,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("body")}
          style={{ color: t.fg, ...typeStyle("body"), fontFamily: FONT.semibold }}
        >
          Workspace sending
        </Text>
        <Pill
          label={control.paused ? "Held" : "Active"}
          tone={control.paused ? "warning" : "success"}
        />
      </View>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {sendingControlSummary(control)}
      </Text>
      {mayChange && !control.paused ? (
        <TextInput
          {...typeCap("body")}
          {...keyboardChain({ onSubmit: () => void onPress() })}
          value={reason}
          onChangeText={setReason}
          placeholder="Why are you holding sending?"
          placeholderTextColor={t.fgSubtle}
          maxLength={KILL_SWITCH_REASON_MAX}
          accessibilityLabel="Reason for holding all email sending"
          style={settingsInputStyle(t)}
        />
      ) : null}
      {mayChange ? (
        <Pressable
          onPress={() => void onPress()}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel={copy.confirmLabel}
          accessibilityState={{ disabled: !canSubmit }}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: canSubmit
                ? control.paused
                  ? t.accent
                  : t.danger
                : t.fgSubtle,
              ...typeStyle("control"),
              fontFamily: FONT.semibold,
            }}
          >
            {setPaused.isPending ? "Working…" : copy.confirmLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
