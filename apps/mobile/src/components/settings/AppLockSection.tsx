/**
 * AppLockSection — the App lock card, extracted from settings.tsx so the
 * grace-period control has somewhere to live.
 *
 * The lock used to be all-or-nothing: every trip out of the foreground cost a
 * fresh Face ID prompt on return, including the two-second hop to an
 * authenticator app to read a 2FA code — which is, for this product, the most
 * common reason anyone leaves the app at all.
 *
 * The picker only governs the RE-PROMPT. The privacy cover still drops on
 * every `inactive`/`background` transition at every setting, so the
 * app-switcher thumbnail is never workspace content. "Immediately" is the
 * default and preserves today's behaviour exactly: nobody who armed the lock
 * has it loosened without asking.
 */
import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import { Chip } from "@/components/Chip";
import { SettingsSwitchRow } from "@/components/settings/FormControls";
import {
  Card,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import { announce } from "@/lib/a11y";
import {
  APP_LOCK_GRACE_CHOICES,
  graceAccessibilityLabel,
  graceLabel,
  type AppLockGraceSeconds,
} from "@/lib/appLockGrace";
import {
  getAppLockGraceSeconds,
  setAppLockGraceSeconds,
} from "@/lib/biometric";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AppLockSection({
  biometricAvailable,
  appLockCapable,
  enabled,
  onToggle,
  onError,
}: {
  biometricAvailable: boolean;
  appLockCapable: boolean;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  /** Surfaces a Keychain write failure with the screen's own toast. */
  onError: (message: string) => void;
}) {
  const { t } = useTheme();
  const [grace, setGrace] = useState<AppLockGraceSeconds>(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getAppLockGraceSeconds().then((seconds) => {
      if (!cancelled) setGrace(seconds);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function pick(next: AppLockGraceSeconds): Promise<void> {
    if (saving || next === grace) return;
    setSaving(true);
    const previous = grace;
    // Optimistic, then reverted on a rejected write: a security control must
    // never keep showing a value the Keychain refused to store.
    setGrace(next);
    try {
      await setAppLockGraceSeconds(next);
      haptics.tap();
      announce(graceAccessibilityLabel(next));
    } catch {
      setGrace(previous);
      onError(
        "The unlock delay was not changed — your previous setting is still in effect.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <SectionHeader
        anchor="app-lock"
        title="App lock"
        subtitle="Require strong biometrics or your device passcode when the app returns to the foreground. Screen capture and task-switcher previews are protected, and widget metrics are disabled, while enabled."
      />
      <Card>
        <SettingsSwitchRow
          label={
            biometricAvailable
              ? "Require Face ID to unlock"
              : "Require device authentication"
          }
          hint="Requires device authentication when Moosewave returns to the foreground."
          value={enabled}
          onValueChange={onToggle}
          disabled={!appLockCapable}
        />
        {!appLockCapable ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              marginTop: 10,
              fontFamily: FONT.regular,
            }}
          >
            Set up Face ID, Touch ID, or a device passcode in your system
            settings to use the app lock.
          </Text>
        ) : null}

        {enabled && appLockCapable ? (
          <View style={{ marginTop: 14, gap: 8 }}>
            <Text
              accessibilityRole="header"
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                letterSpacing: 0.5,
                fontWeight: "600",
                fontFamily: FONT.semibold,
                textTransform: "uppercase",
              }}
            >
              Ask again
            </Text>
            <View
              style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
              accessibilityRole="radiogroup"
              accessibilityLabel="How soon to ask for authentication after leaving the app"
            >
              {APP_LOCK_GRACE_CHOICES.map((choice) => (
                <Chip
                  key={choice}
                  label={graceLabel(choice)}
                  active={grace === choice}
                  accessibilityLabel={graceAccessibilityLabel(choice)}
                  onPress={() => void pick(choice)}
                  disabled={saving}
                />
              ))}
            </View>
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              Moosewave&apos;s contents stay hidden the moment you leave, at
              every setting. A delay only decides how soon you are asked to
              authenticate again — useful when you switch to an authenticator
              app for a code. The delay never survives a restart.
            </Text>
          </View>
        ) : null}
      </Card>
    </>
  );
}
