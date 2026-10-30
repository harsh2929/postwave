/**
 * AppLockOverlay — the visual half of the app lock.
 *
 * Split out of BiometricGate so the gate holds the state machine (arm,
 * AppState transitions, screen-capture protection) and this holds the screen.
 *
 * The "Sign out" action is not decoration: `authenticate()` resolves false on
 * lockout, cancel or any native error, and LocalAuthentication genuinely wedges
 * on some Android OEMs. Without an escape hatch the only way out of a locked
 * app is deleting it — and the SERVER-side session stays alive either way.
 * Every credible locked app (1Password, Slack, Signal) offers this.
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AppLockOverlay({
  biometricAvailable,
  workspaceName,
  signingOut,
  onUnlock,
  onSignOut,
}: {
  biometricAvailable: boolean;
  workspaceName: string;
  signingOut: boolean;
  onUnlock: () => void;
  onSignOut: () => void;
}) {
  const { t } = useTheme();
  const unlockLabel = biometricAvailable ? "Unlock with Face ID" : "Unlock";
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: t.bg,
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      accessibilityViewIsModal
    >
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: 20,
          backgroundColor: t.accentSubtle,
          borderWidth: 1,
          borderColor: t.border,
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 20,
        }}
      >
        {/* Padlock glyph — avoids an icon-font dependency. It stands in for
            an ICON inside a fixed 72x72 tile, so it is pinned against OS text
            scaling; the meaning reaches VoiceOver through the label. */}
        <Text
          allowFontScaling={false}
          style={{ fontSize: 30, color: t.accent }}
          accessibilityLabel="Locked"
        >
          {"\u{1F512}"}
        </Text>
      </View>

      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{
          color: t.fg,
          ...typeStyle("title"),
          fontFamily: FONT.display,
          textAlign: "center",
          marginBottom: 8,
        }}
      >
        Unlock Moosewave
      </Text>
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fgMuted,
          ...typeStyle("callout"),
          fontFamily: FONT.regular,
          textAlign: "center",
          marginBottom: 28,
          maxWidth: 320,
        }}
      >
        {/* Naming the workspace matters most here: the whole point of the lock
            is a shared or lost device. */}
        {workspaceName
          ? `${workspaceName} is protected. Authenticate with Face ID, Touch ID, or your device passcode to continue.`
          : "This workspace is protected. Authenticate with Face ID, Touch ID, or your device passcode to continue."}
      </Text>

      <Pressable
        onPress={onUnlock}
        accessibilityRole="button"
        accessibilityLabel={unlockLabel}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          paddingVertical: 12,
          paddingHorizontal: 24,
          borderRadius: 12,
          minHeight: 44,
          backgroundColor: t.accent,
          minWidth: 200,
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.accentFg,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {unlockLabel}
        </Text>
      </Pressable>

      <Pressable
        onPress={onSignOut}
        disabled={signingOut}
        accessibilityRole="button"
        accessibilityLabel="Sign out of this workspace"
        accessibilityState={{ disabled: signingOut, busy: signingOut }}
        style={{
          marginTop: 18,
          paddingVertical: 12,
          paddingHorizontal: 24,
          minHeight: 44,
          alignItems: "center",
          justifyContent: "center",
          opacity: signingOut ? 0.5 : 1,
        }}
      >
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fgMuted,
            ...typeStyle("callout"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </Text>
      </Pressable>
    </View>
  );
}
