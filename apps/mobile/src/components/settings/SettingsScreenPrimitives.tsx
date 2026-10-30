import type { ReactNode } from "react";
import { Text, useWindowDimensions, View } from "react-native";

import { Card as SharedCard } from "@/components/Card";
import { SectionLabel } from "@/components/SectionLabel";
import { useSettingsAnchorLayout } from "@/components/settings/SettingsAnchors";
import { FONT } from "@/lib/fonts";
import { date } from "@/lib/format";
import { FIELD_LABEL_TEXT } from "@/lib/shellStyleTokens";
import { useTheme } from "@/lib/theme";
import {
  fontSizeFor,
  maxLinesAtScale,
  typeCap,
  typeStyle,
} from "@/lib/typeScale";

type ThemeTokens = ReturnType<typeof useTheme>["t"];

export function Row({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingVertical: 6,
        gap: 12,
      }}
    >
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          flexShrink: 1,
          textAlign: "right",
          fontFamily: FONT.regular,
        }}
        // A value that is one line at the default size — an origin, a plan
        // name, an email — should spend a second line rather than truncate to
        // nothing once the user raises the OS text size.
        numberOfLines={maxLinesAtScale(1, fontScale)}
      >
        {value && value.trim() ? value : "—"}
      </Text>
    </View>
  );
}

/**
 * Settings section heading.
 *
 * This used to be its OWN 11/600/0.6 uppercase Text with a 20/8 rhythm, four
 * pixels away from src/components/SectionLabel.tsx and from the More screen's
 * local factory — three near-miss definitions of one idea. It now delegates,
 * so the shell has a single heading style with a stated "compact" variant.
 */
export function SectionHeader({
  title,
  subtitle,
  anchor,
}: {
  title: string;
  subtitle?: string;
  /**
   * Key from src/lib/settingsIA.ts. When set, the heading reports its scroll
   * offset so the Settings index can jump to it. Omitted headings behave
   * exactly as before — no wrapper view, no layout change.
   */
  anchor?: string | undefined;
}) {
  const onLayout = useSettingsAnchorLayout(anchor);
  const label = (
    <SectionLabel compact {...(subtitle ? { subtitle } : {})}>
      {title}
    </SectionLabel>
  );
  if (!onLayout) return label;
  return <View onLayout={onLayout}>{label}</View>;
}

/** Settings card = the shared Card at its compact padding. */
export function Card({ children }: { children: ReactNode }) {
  return <SharedCard variant="compact">{children}</SharedCard>;
}

/**
 * The label above a control inside a card.
 *
 * Four settings components each declared this same uppercase 11px run with
 * their own margins — and two of them used a different letter-spacing. It is
 * one component now, with an `accessibilityRole="header"` so VoiceOver's rotor
 * can jump between the groups inside a long card.
 */
export function FieldLabel({
  children,
  marginBottom = 4,
}: {
  children: ReactNode;
  marginBottom?: number;
}) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      // `caption` and FIELD_LABEL_TEXT agree on 11pt; the token keeps weight
      // and tracking, the role adds leading and the Dynamic Type ceiling.
      {...typeCap("caption")}
      style={{
        ...typeStyle("caption"),
        ...FIELD_LABEL_TEXT,
        color: t.fgMuted,
        fontFamily: FONT.semibold,
        marginBottom,
      }}
    >
      {children}
    </Text>
  );
}

/**
 * A labelled control inside a card, with an optional line of help under it.
 *
 * The `hint` exists because desktop carries this copy in a hover tooltip
 * (apps/desktop/src/components/InlineHelp.tsx, six call sites in Settings
 * alone) and mobile carried none of it — the label alone had to answer "what
 * IS a tenant slug". A phone has no hover, so the help is rendered inline in
 * the same place `SettingsSwitchRow` and `MoreRow` already put theirs, rather
 * than growing a tap-to-reveal tooltip that duplicates an existing pattern.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  const { t } = useTheme();
  return (
    <View style={{ marginBottom: 12 }}>
      <FieldLabel {...(hint ? { marginBottom: 4 } : {})}>{label}</FieldLabel>
      {children}
      {hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function inputStyle(t: ThemeTokens) {
  return {
    backgroundColor: t.bgSubtle,
    borderColor: t.border,
    borderWidth: 1,
    color: t.fg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    // Size only — an explicit lineHeight mis-centres a TextInput's caret.
    fontSize: fontSizeFor("body"),
  } as const;
}

export function redactToken(token: string): string {
  const suffix = token.slice(-8);
  return suffix ? `...${suffix}` : "saved";
}

export function formatPrivacyLabel(value: string): string {
  const cleaned = (value ?? "").replace(/_/g, " ").trim();
  return cleaned || "unknown";
}

/** Guard against null/invalid due dates so we never render "Invalid Date". */
export function formatDueDate(value: string): string {
  // `date()` already answers absence and Invalid Date with an em-dash.
  return date(value);
}
