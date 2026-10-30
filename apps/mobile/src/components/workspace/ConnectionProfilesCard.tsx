/**
 * ConnectionProfilesCard — the More-screen entry point to multiple servers.
 *
 * Desktop keeps this in the workspace menu (WorkspaceMenu.tsx:282); mobile
 * keeps it directly under the identity card, beside the workspace switcher it
 * is often confused with. They are NOT the same control and the subtitle says
 * so:
 *
 *   WorkspaceSwitcher   — other tenants THIS EMAIL belongs to on THIS server.
 *                         Server-side session exchange, no re-authentication.
 *   ConnectionProfiles  — other SERVERS this device knows about. A different
 *                         origin, a different account database: sign-out and
 *                         sign-in, every time.
 *
 * Unlike the workspace switcher, this control never hides itself. Hiding at
 * one profile would be the obvious thing and is exactly wrong: with no visible
 * control there is no way to ADD the second server, so the feature would exist
 * only for people who already had it.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { ConnectionProfilesSheet } from "@/components/workspace/ConnectionProfilesSheet";
import { useConnectionProfiles } from "@/hooks/useConnectionProfiles";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function ConnectionProfilesCard() {
  const { t } = useTheme();
  const controller = useConnectionProfiles();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<View>(null);
  const count = controller.state.profiles.length;

  return (
    <View style={{ marginHorizontal: 12, marginTop: -12, marginBottom: 24 }}>
      <Pressable
        ref={triggerRef}
        onPress={() => {
          haptics.tap();
          setOpen(true);
        }}
        accessibilityRole="button"
        accessibilityLabel={
          controller.ready
            ? `Server connections, ${count} saved`
            : "Server connections"
        }
        accessibilityHint="Add, switch between or remove the Moosewave servers this device connects to"
        style={{
          minHeight: 48,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.borderSubtle,
          backgroundColor: t.surface,
          paddingHorizontal: 14,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            fontFamily: FONT.semibold,
            ...typeStyle("body"),
          }}
        >
          Server connections
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            fontFamily: FONT.regular,
            ...typeStyle("label"),
          }}
        >
          {controller.ready ? count : "…"}
        </Text>
      </Pressable>
      <ConnectionProfilesSheet
        visible={open}
        onClose={() => setOpen(false)}
        returnFocusRef={triggerRef}
        controller={controller}
      />
    </View>
  );
}
