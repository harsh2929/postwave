/**
 * TotpGateFooter — the two escape hatches under the two-factor code field.
 *
 * Both exist because the code field alone is a dead end: an authenticator on a
 * lost phone needs the recovery-code path, and a user who reached this screen
 * as the wrong account (or who opened it from Settings and changed their mind)
 * needs a way out that is not force-quitting the app.
 *
 * The second action is genuinely two actions wearing one button: during
 * sign-in it abandons the half-built session ("Switch account"), while a
 * step-up from Settings is merely cancelled ("Cancel"). The caller decides
 * which, because only it knows why the gate was opened.
 */
import { Pressable, Text } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function TotpGateFooter({
  useRecovery,
  busy,
  securitySettingsStepUp,
  onToggleRecovery,
  onSwitchAccount,
}: {
  useRecovery: boolean;
  busy: boolean;
  /** True when the gate was opened to re-authenticate, not to sign in. */
  securitySettingsStepUp: boolean;
  onToggleRecovery: () => void;
  onSwitchAccount: () => void;
}) {
  const { t } = useTheme();
  return (
    <>
      <Pressable
        onPress={onToggleRecovery}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={
          useRecovery
            ? "Switch to authenticator code"
            : "Switch to a recovery code"
        }
        style={{
          marginTop: 14,
          alignItems: "center",
          minHeight: 44,
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.accent,
            ...typeStyle("bodySmall"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {useRecovery ? "Use authenticator code" : "Use a recovery code"}
        </Text>
      </Pressable>

      <Pressable
        onPress={onSwitchAccount}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={
          securitySettingsStepUp ? "Cancel verification" : "Switch account"
        }
        style={{
          marginTop: 12,
          alignItems: "center",
          padding: 8,
          minHeight: 44,
          justifyContent: "center",
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.semibold,
          }}
        >
          {securitySettingsStepUp ? "Cancel" : "Switch account"}
        </Text>
      </Pressable>
    </>
  );
}
