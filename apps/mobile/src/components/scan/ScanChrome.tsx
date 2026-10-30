/**
 * components/scan/ScanChrome — branded wrapper shared by all three states the
 * scanner can be in (permission unknown, permission refused, live camera).
 *
 * Extracted from app/(tabs)/scan.tsx when the torch pushed that route past its
 * source budget. Keeping ONE wrapper for all three states is the point: the
 * header and its back affordance must not move or disappear between them, so a
 * user who lands on the refused state can still get out of the screen.
 */
import { router } from "expo-router";

import { ScreenHeader } from "@/components/ScreenHeader";
import { useTheme } from "@/lib/theme";
import { SafeAreaView } from "react-native-safe-area-context";

export function ScanChrome({
  t,
  children,
}: {
  t: ReturnType<typeof useTheme>["t"];
  children: React.ReactNode;
}) {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Scan QR code"
        onBack={() => {
          if (router.canGoBack()) router.back();
          else router.replace("/(tabs)/more");
        }}
      />
      {children}
    </SafeAreaView>
  );
}
