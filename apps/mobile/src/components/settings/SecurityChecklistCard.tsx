/**
 * SecurityChecklistCard — "is this account actually protected?", answered once.
 *
 * The app already knew every part of the answer and never said it: two-factor
 * and email verification arrive on /me, and the app-lock preference is a local
 * read. They lived in three separate controls further down this screen, so the
 * user had to visit each one and hold the result in their head.
 *
 * IT STAYS HONEST WHILE YOU USE IT. AppLockSection is rendered on this same
 * screen, below this card. Reading the preference once on mount would leave the
 * summary contradicting a switch the user just flipped, so this subscribes to
 * the committed preference change rather than polling or re-mounting.
 *
 * Scoring and copy are pure and tested in src/lib/securityChecklist.ts.
 *
 * NativeWind v4: static style objects only — a function-style Pressable/View
 * silently drops layout.
 */
import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import {
  Card,
  SectionHeader,
} from "@/components/settings/SettingsScreenPrimitives";
import {
  canAuthenticate,
  getBiometricLockEnabled,
  subscribeBiometricLockPreference,
} from "@/lib/biometric";
import { FONT } from "@/lib/fonts";
import {
  checklistScore,
  checklistSummary,
  securityChecklist,
  type SecurityProtection,
} from "@/lib/securityChecklist";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

/** Glyph + word + colour — three cues, so none of them is load-bearing alone. */
const STATUS_GLYPH = { on: "✓", off: "○", unavailable: "–" } as const;
const STATUS_WORD = { on: "On", off: "Off", unavailable: "Unavailable" } as const;

function ProtectionRow({
  item,
  first,
}: {
  item: SecurityProtection;
  first: boolean;
}) {
  const { t } = useTheme();
  const tone =
    item.status === "on"
      ? t.success
      : item.status === "off"
        ? t.warning
        : t.fgSubtle;

  return (
    <View
      // One node carries the whole row so VoiceOver reads the protection, its
      // state and the next action as a single phrase instead of three orphans.
      accessible
      accessibilityRole="text"
      accessibilityLabel={item.spoken}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingTop: first ? 0 : 10,
        marginTop: first ? 0 : 10,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: t.border,
      }}
    >
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no"
        // Purely decorative: a ✓ / ○ / – standing in for an icon inside a
        // 16pt-wide gutter, already hidden from the screen reader and already
        // said in words by STATUS_WORD beside it. Scaling it would only push
        // the label out of a column that cannot widen.
        allowFontScaling={false}
        style={{
          color: tone,
          fontSize: 14,
          lineHeight: 20,
          width: 16,
          textAlign: "center",
          fontFamily: FONT.semibold,
        }}
      >
        {STATUS_GLYPH[item.status]}
      </Text>
      <View style={{ flex: 1 }}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              flexShrink: 1,
              fontFamily: FONT.semibold,
            }}
          >
            {item.label}
          </Text>
          <Text
            // Status word pinned to the right of the label's row.
            {...typeCap("badge")}
            style={{
              color: tone,
              ...typeStyle("badge"),
              fontFamily: FONT.semibold,
            }}
          >
            {STATUS_WORD[item.status]}
          </Text>
        </View>
        {item.action ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              marginTop: 3,
              fontFamily: FONT.regular,
            }}
          >
            {item.action}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function SecurityChecklistCard() {
  const { t } = useTheme();
  const mode = useAuthStore((s) => s.mode);
  const session = useAuthStore((s) => s.session);
  const [appLockEnabled, setAppLockEnabled] = useState(false);
  const [appLockCapable, setAppLockCapable] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([getBiometricLockEnabled(), canAuthenticate()]).then(
      ([enabled, capable]) => {
        if (!active) return;
        setAppLockEnabled(enabled);
        setAppLockCapable(capable);
      },
    );
    // AppLockSection is rendered further down THIS screen; without this the
    // summary would still say "2 of 3" after the user turned app lock on.
    const unsubscribe = subscribeBiometricLockPreference((next) => {
      if (active) setAppLockEnabled(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  // API-key mode has no human identity: there is no /me, so two-factor and
  // email verification are not facts about anyone. Rendering an unanswerable
  // checklist would be worse than rendering none.
  if (mode !== "session" || !session) return null;

  const items = securityChecklist({
    totpEnabled: session.totpEnabled,
    emailVerified: session.emailVerified,
    appLockEnabled,
    appLockCapable,
  });
  const score = checklistScore(items);
  const summary = checklistSummary(score);

  return (
    <>
      <SectionHeader
        title="Account protection"
        subtitle="What is protecting this account right now, and what is not."
      />
      <Card>
        <View style={{ marginBottom: 12 }}>
          <Text
            accessibilityRole="header"
            // Card headline.
            {...typeCap("heading")}
            style={{
              color: score.complete ? t.success : t.fg,
              ...typeStyle("heading"),
              fontFamily: FONT.semibold,
            }}
          >
            {summary}
          </Text>
          {score.complete ? null : (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                marginTop: 3,
                fontFamily: FONT.regular,
              }}
            >
              Each unfinished item names the control that turns it on.
            </Text>
          )}
        </View>
        {items.map((item, index) => (
          <ProtectionRow key={item.key} item={item} first={index === 0} />
        ))}
      </Card>
    </>
  );
}
