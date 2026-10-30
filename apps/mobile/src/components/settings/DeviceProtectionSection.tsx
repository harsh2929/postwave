/**
 * DeviceProtectionSection — the two device-scoped privacy controls that used
 * to be declared inline on app/(tabs)/settings.tsx: the biometric App lock,
 * and the iOS widget's workspace-metrics opt-in.
 *
 * They are ONE responsibility, not two adjacent ones. Arming the lock revokes
 * the widget opt-in — a home-screen widget renders outside the in-app gate —
 * so the two controls share their state, the in-flight guard, the mount-time
 * reconciliation and the cleanup disclosure. Splitting them across a screen
 * and a component would have left that coupling implicit.
 *
 * Moved wholesale: same effects, same guards, same copy, same order. The
 * screen mounts it where the App lock card already stood.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Alert, Platform, Text } from "react-native";

import { useToast } from "@/components/Toast";
import { AppLockSection } from "@/components/settings/AppLockSection";
import { SettingsSwitchRow } from "@/components/settings/FormControls";
import {
  Card,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { TRUSTED_DEVICES_QUERY_KEY } from "@/hooks/useTrustedDevices";
import {
  authenticate as authenticateBiometric,
  canAuthenticate,
  getBiometricLockEnabled,
  isBiometricAvailable,
  setBiometricLockEnabled,
} from "@/lib/biometric";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { revokeThisDeviceTrust } from "@/lib/trustedDeviceRevoke";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  getWidgetMetricsEnabled,
  setWidgetMetricsEnabled,
} from "@/lib/widgetData";
import { useAuthStore } from "@/store/auth";

export function DeviceProtectionSection() {
  const { t } = useTheme();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [biometricLock, setBiometricLock] = useState(false);
  const [widgetMetricsEnabled, setWidgetMetricsEnabledState] = useState(false);
  const [appLockCapable, setAppLockCapable] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  // In-flight guard: enabling runs an OS prompt, so a second tap mid-prompt
  // would stack sheets / desync the switch.
  const biometricBusyRef = useRef(false);

  useEffect(() => {
    setWidgetMetricsEnabledState(getWidgetMetricsEnabled());
    void Promise.all([
      getBiometricLockEnabled(),
      canAuthenticate(),
      isBiometricAvailable(),
    ]).then(([enabled, canAuth, bioAvailable]) => {
      setAppLockCapable(canAuth);
      setBiometricAvailable(bioAvailable);
      // If all device-owner authentication went away, reflect OFF even
      // if a stale pref says on. Passcode-only devices remain capable.
      const lockIsArmed = enabled && canAuth;
      setBiometricLock(lockIsArmed);
      if (lockIsArmed) {
        // Defence in depth for upgrades from versions that could leave a
        // widget opted in while app lock was already enabled.
        const widgetCleared = setWidgetMetricsEnabled(false);
        setWidgetMetricsEnabledState(
          widgetCleared ? false : getWidgetMetricsEnabled(),
        );
        if (!widgetCleared) {
          // DELIBERATELY still a blocking Alert. Everything else on this
          // screen moved to toasts, but this one says workspace metrics may
          // still be readable from a home-screen widget outside the app lock.
          // A 4-second toast the user can scroll past is the wrong weight for
          // a disclosure the user has to act on.
          Alert.alert(
            "Widget cleanup needs a retry",
            "App lock is active, but Moosewave could not verify removal of an older widget snapshot. Unlock the device and reopen Settings before sharing it.",
          );
        }
      }
    });
  }, []);

  /**
   * Retire this phone's remembered-device trust now that the lock it was
   * granted under is off (see lib/trustedDeviceRevoke). Runs AFTER the disarm
   * is committed and is never awaited by it: a slow or offline network must
   * not hold the switch, and a failure must not reach the toggle's catch,
   * which would flip the switch back ON over a preference already stored OFF.
   * A failure is told instead — the user can finish the job by hand.
   */
  async function retireThisDeviceTrust(): Promise<void> {
    const { baseUrl, mode } = useAuthStore.getState();
    // Trust records belong to cookie sessions. An API key has none, and the
    // session-only routes would 401 into a false "can still sign in" warning.
    if (mode !== "session") return;
    const outcome = await revokeThisDeviceTrust(baseUrl);
    if (outcome === "none") return;
    // The Remembered devices card sits on this same screen.
    void queryClient.invalidateQueries({
      queryKey: [TRUSTED_DEVICES_QUERY_KEY],
    });
    if (outcome === "failed") {
      toast({
        kind: "warning",
        message:
          "App lock is off, but this phone can still sign in without a two-factor code. Forget it under Remembered devices when you're back online.",
      });
    }
  }

  async function toggleBiometricLock(next: boolean) {
    if (biometricBusyRef.current) return;
    biometricBusyRef.current = true;
    const previous = biometricLock;
    try {
      if (next) {
        // Confirm the user can actually pass the prompt BEFORE persisting,
        // so we never enable a lock they can't satisfy (which would brick
        // the app behind the gate on next launch).
        const ok = await authenticateBiometric(
          "Confirm device authentication to enable lock",
        );
        if (!ok) {
          setBiometricLock(false);
          return;
        }
        // A home-screen widget lives outside the in-app gate. Revoke widget
        // disclosure before committing app lock so enabling the control can
        // never leave workspace metrics visible outside it.
        if (!setWidgetMetricsEnabled(false)) {
          throw new Error("Widget privacy cleanup failed");
        }
        setWidgetMetricsEnabledState(false);
        await setBiometricLockEnabled(true);
        setBiometricLock(true);
      } else {
        // The control used to be asymmetric in the direction that matters:
        // arming demanded a device-owner challenge, disarming demanded
        // nothing. So anyone who reached the handset while it was unlocked —
        // or inside the re-prompt grace window — could retire the lock
        // silently, along with everything that hangs off it (the widget
        // metrics refusal, and the "remember this device" offer that is only
        // made when the lock is on). Same challenge, both directions.
        //
        // What hangs off it is retired with it: this phone's remembered-device
        // trust was only ever granted because the lock was on, and it outlives
        // the session, so once the owner passes it is revoked too.
        //
        // A device that has lost ALL credentials can't answer this, but it
        // can't reach here either: the mount effect above already reports the
        // lock as OFF when canAuthenticate() is false.
        const ok = await authenticateBiometric(
          "Confirm device authentication to turn off lock",
        );
        if (!ok) {
          setBiometricLock(true);
          return;
        }
        await setBiometricLockEnabled(false);
        setBiometricLock(false);
        void retireThisDeviceTrust();
      }
    } catch {
      setBiometricLock(previous);
      toast({
        kind: "error",
        message:
          "App lock was not changed — your previous setting is still in effect.",
      });
    } finally {
      biometricBusyRef.current = false;
    }
  }

  function toggleWidgetMetrics(next: boolean) {
    if (next && biometricLock) {
      toast({
        kind: "warning",
        message:
          "Turn off App lock before showing workspace metrics outside Moosewave.",
      });
      return;
    }
    const committed = setWidgetMetricsEnabled(next);
    setWidgetMetricsEnabledState(getWidgetMetricsEnabled());
    if (!committed) {
      toast({
        kind: "error",
        message:
          "Widget setting was not changed — the private App Group update could not be verified.",
      });
    }
  }

  return (
    <>
      {/* App lock — biometric gate over the authenticated app. Card body
        lives in AppLockSection so the re-prompt delay has a home. */}
      <AppLockSection
        biometricAvailable={biometricAvailable}
        appLockCapable={appLockCapable}
        enabled={biometricLock}
        onToggle={(next) => void toggleBiometricLock(next)}
        onError={(message) => toast({ kind: "error", message })}
      />

      {Platform.OS === "ios" ? (
        <>
          <SectionHeader
            anchor="widget"
            title="iOS widget privacy"
            subtitle="Workspace metrics are hidden by default because widgets sit outside Moosewave's app lock."
          />
          <Card>
            <SettingsSwitchRow
              label="Show workspace metrics in widget"
              hint="Explicitly stores subscriber totals, open rate, sends, approvals, workspace name, and one connected store's all-time totals in the App Group for at most 12 hours. iOS marks these values privacy-sensitive for locked-device previews."
              value={widgetMetricsEnabled}
              onValueChange={toggleWidgetMetrics}
              disabled={biometricLock}
            />
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                marginTop: 10,
                fontFamily: FONT.regular,
              }}
            >
              Enabling App lock, signing out, or changing accounts revokes this
              opt-in and purges the widget snapshot.
            </Text>
          </Card>
        </>
      ) : null}
    </>
  );
}
