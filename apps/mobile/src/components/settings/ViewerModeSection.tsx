/**
 * ViewerModeSection — the mobile half of "preview as viewer".
 *
 * Desktop both toggles this (AccountMenu) and badges it (TopBar). Mobile parsed
 * `viewer_mode` off /me, stored it on the session profile, and read it nowhere:
 * an admin who left the preview on from desktop opened a silently read-only app
 * with no explanation and no way back. This is the control; the persistent
 * badge lives in ScreenHeaderStatus so it is visible from every screen.
 *
 * The gate rules (including "always offer the exit") are pure and tested in
 * src/lib/viewerModePolicy.ts.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { setViewerMode } from "@/api/viewerMode";
import { Pill } from "@/components/Pill";
import { SettingsSwitchRow } from "@/components/settings/FormControls";
import {
  Card,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { useToast } from "@/components/Toast";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  VIEWER_BADGE_LABEL,
  viewerModeFailureMessage,
  viewerModeGate,
  viewerModeToggleMessage,
} from "@/lib/viewerModePolicy";
import { useAuthStore } from "@/store/auth";

export function ViewerModeSection() {
  const { t } = useTheme();
  const { toast } = useToast();
  const mode = useAuthStore((s) => s.mode);
  const session = useAuthStore((s) => s.session);
  const refreshSessionFromServer = useAuthStore(
    (s) => s.refreshSessionFromServer,
  );
  const [busy, setBusy] = useState(false);

  const gate = viewerModeGate({
    mode,
    viewerMode: Boolean(session?.viewerMode),
    canUseViewerMode: Boolean(session?.canUseViewerMode),
  });
  if (gate.kind === "hidden") return null;

  async function onToggle(next: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await setViewerMode(next, next ? "viewer" : undefined);
      if (res.error) {
        // Toast already fires haptics.error() for kind "error"; adding another
        // here would double-buzz.
        toast({
          kind: "error",
          message: viewerModeFailureMessage(res.error.status),
        });
        return;
      }
      // The override lives on the SERVER session, so the local profile is now
      // stale by definition. Re-read /me rather than optimistically flipping a
      // local flag: guessing here would leave the badge and the actual
      // permission set disagreeing, which is the exact failure this closes.
      await refreshSessionFromServer();
      if (next) haptics.warning();
      toast({
        kind: next ? "warning" : "success",
        message: viewerModeToggleMessage(next),
      });
    } catch {
      toast({
        kind: "warning",
        message:
          "Viewer preview changed on the server, but this device couldn't re-read your permissions. Pull to refresh.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SectionHeader
        anchor="viewer-preview"
        title="Viewer preview"
        subtitle="See the workspace exactly as a read-only viewer does, without signing out."
      />
      <Card>
        <SettingsSwitchRow
          label="Preview as viewer"
          hint="Applies to this sign-in session only. Your real role is unchanged."
          value={gate.active}
          onValueChange={(next) => void onToggle(next)}
          disabled={busy}
        />
        {gate.active ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 }}>
            <Pill label={VIEWER_BADGE_LABEL} tone="warning" />
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                flex: 1,
                fontFamily: FONT.regular,
              }}
            >
              {gate.exitOnly
                ? "Turn this off to restore your usual permissions."
                : "Every write control is hidden while this is on."}
            </Text>
          </View>
        ) : null}
      </Card>
    </>
  );
}
