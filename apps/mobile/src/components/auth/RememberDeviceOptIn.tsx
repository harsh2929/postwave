/**
 * RememberDeviceOptIn — the AUTH#48 opt-in, on the TOTP challenge screen.
 *
 * ── IT IS OPT-IN, AND IT IS OFFERED IN ONE PLACE ONLY ──────────────────────
 * Trust is minted as a side effect of a SUCCESSFUL challenge and nowhere else:
 * you can only ask to skip the second factor immediately after passing it.
 * That coupling is the security property, so this control lives on the
 * challenge screen and has no route of its own.
 *
 * ── THE PHONE GUARDRAIL ────────────────────────────────────────────────────
 * The offer appears ONLY when `getBiometricLockEnabled()` is true. On a phone
 * with no app lock, "remember this device" means "anyone holding this handset
 * is past two-factor for six months" — the credential would be strictly worse
 * than the password it is meant to supplement. So an unlocked phone is not
 * offered the choice at all, rather than being offered it with a warning
 * nobody reads. The check is asynchronous and the control renders NOTHING
 * until it resolves: a control that appears and then vanishes is worse than
 * one that arrives a frame late.
 *
 * ── THE DURATIONS ARE NOT TYPED HERE ───────────────────────────────────────
 * 30 / 90 / 180, from `TRUST_DURATIONS`. The picker is BUILT from that tuple,
 * so it cannot drift from the server's rule, and there is deliberately no
 * "custom" affordance to build.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { announce } from "@/lib/a11y";
import { getBiometricLockEnabled } from "@/lib/biometric";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import {
  TRUST_DURATIONS,
  trustConsentLine,
  trustDurationLabel,
  type TrustDurationDays,
} from "@/lib/trustedDeviceContract";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface RememberDeviceOptInProps {
  remember: boolean;
  days: TrustDurationDays;
  onChange: (next: { remember: boolean; days: TrustDurationDays }) => void;
  /**
   * Set when the workspace refused the request (`device_trust_disabled`). The
   * control then explains itself instead of silently disappearing, because a
   * toggle that vanishes after you tick it reads as a bug.
   */
  disabledByWorkspace?: boolean | undefined;
  /** Test seam: skips the SecureStore read. */
  lockEnabledOverride?: boolean | undefined;
}

export function RememberDeviceOptIn({
  remember,
  days,
  onChange,
  disabledByWorkspace,
  lockEnabledOverride,
}: RememberDeviceOptInProps) {
  const { t } = useTheme();
  // undefined = still deciding. Rendering nothing while undefined is the point.
  const [lockEnabled, setLockEnabled] = useState<boolean | undefined>(
    lockEnabledOverride,
  );

  useEffect(() => {
    if (lockEnabledOverride !== undefined) {
      setLockEnabled(lockEnabledOverride);
      return;
    }
    let cancelled = false;
    void getBiometricLockEnabled()
      .then((enabled) => {
        if (!cancelled) setLockEnabled(enabled);
      })
      // A Keychain read failure must not offer the weaker option. Fail to the
      // SAFE side: no offer, full second factor every time.
      .catch(() => {
        if (!cancelled) setLockEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lockEnabledOverride]);

  if (lockEnabled !== true) return null;

  if (disabledByWorkspace) {
    return (
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 14,
        }}
      >
        This workspace doesn&apos;t allow remembering devices, so every sign-in
        asks for a code.
      </Text>
    );
  }

  return (
    <View style={{ marginTop: 18, gap: 8 }}>
      <Pressable
        onPress={() => {
          haptics.tap();
          const next = !remember;
          onChange({ remember: next, days });
          announce(
            next
              ? `This device will be remembered for ${trustDurationLabel(days)}`
              : "This device will not be remembered",
          );
        }}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: remember }}
        accessibilityLabel="Remember this device"
        accessibilityHint={trustConsentLine(days)}
        hitSlop={6}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: 44,
        }}
      >
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            borderWidth: 2,
            borderColor: remember ? t.accent : t.border,
            backgroundColor: remember ? t.accent : "transparent",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* A glyph, not a colour: the checked state has to survive
              colour-blindness and a greyscale screenshot. */}
          {remember ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.accentFg,
                ...typeStyle("caption"),
                fontFamily: FONT.semibold,
              }}
            >
              ✓
            </Text>
          ) : null}
        </View>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
            flexShrink: 1,
          }}
        >
          Remember this device
        </Text>
      </Pressable>

      {remember ? (
        <>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="How long to remember this device"
            style={{ flexDirection: "row", gap: 8 }}
          >
            {TRUST_DURATIONS.map((option) => {
              const selected = option === days;
              return (
                <Pressable
                  key={option}
                  onPress={() => {
                    haptics.tap();
                    onChange({ remember: true, days: option });
                    announce(`Remembered for ${trustDurationLabel(option)}`);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={trustDurationLabel(option)}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 10,
                    borderWidth: selected ? 2 : 1,
                    borderColor: selected ? t.accent : t.border,
                    backgroundColor: selected ? t.accentSubtle : "transparent",
                  }}
                >
                  <Text
                    {...typeCap("control")}
                    style={{
                      color: selected ? t.fg : t.fgMuted,
                      ...typeStyle("control"),
                      fontFamily: selected ? FONT.semibold : FONT.regular,
                    }}
                  >
                    {trustDurationLabel(option)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {/* Say what is being given up, in words, next to the control that
              gives it up. The numbers alone do not say it. */}
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {trustConsentLine(days)}
          </Text>
        </>
      ) : null}
    </View>
  );
}
