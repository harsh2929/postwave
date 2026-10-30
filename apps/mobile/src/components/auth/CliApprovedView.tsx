/**
 * CliApprovedView — the terminal state of the CLI device-approval flow.
 *
 * Kept a separate view rather than a banner on the form because approval is
 * irreversible: the key has been minted and the form's Authorize button must
 * not still be on screen. It re-lists the scopes the SERVER returned (not the
 * ones predicted before the tap) so the user can see what was actually issued.
 */
import { Pressable, ScrollView, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { CliScopeList } from "@/components/auth/CliScopeList";
import { ScreenHeader } from "@/components/ScreenHeader";
import type {
  AuthDeviceGrantKind,
  AuthDeviceIdentity,
} from "@/api/authSessions";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CliApprovedView({
  scopes,
  grantKind = "api_key",
  device,
  onDone,
}: {
  scopes: readonly string[];
  grantKind?: AuthDeviceGrantKind;
  device?: AuthDeviceIdentity;
  onDone: () => void;
}) {
  const { t } = useTheme();
  const sessionGrant = grantKind === "session";
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title={sessionGrant ? "Approve sign-in" : "Approve device"}
        onBack={onDone}
      />
      <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
        <Text
          accessibilityRole="header"
          {...typeCap("title")}
          style={{
            color: t.fg,
            fontFamily: FONT.semibold,
            ...typeStyle("title"),
          }}
        >
          {sessionGrant ? "Sign-in approved" : "Device approved"}
        </Text>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("body"),
          }}
        >
          {sessionGrant
            ? `${device?.device_label ?? "The other device"} can now finish signing in. You can close this screen.`
            : "Return to the device that showed this code — it now has a Moosewave API key with the permissions below."}
        </Text>
        {sessionGrant ? null : (
          <CliScopeList
            scopes={scopes}
            title="Permissions granted"
            emptyCopy="The server granted no permissions for this device."
          />
        )}
        <Pressable
          onPress={onDone}
          accessibilityRole="button"
          accessibilityLabel="Done"
          style={{
            marginTop: 6,
            backgroundColor: t.surface,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 12,
            paddingVertical: 14,
            minHeight: 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            {...typeCap("body")}
            style={{
              color: t.fg,
              fontFamily: FONT.medium,
              ...typeStyle("body"),
            }}
          >
            Done
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
