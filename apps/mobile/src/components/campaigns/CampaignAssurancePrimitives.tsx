import type { ReactNode } from "react";
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { Pill, type PillTone } from "@/components/Pill";
import { TextLink } from "@/components/TextLink";
import { shortAssuranceHash } from "@/lib/campaignAssurance";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function AssuranceShell({ children }: { children: ReactNode }) {
  return (
    <Card
      nativeID="campaign-assurance"
      accessibilityLabel="Campaign Assurance receipt"
      style={{ marginTop: 12, gap: 12 }}
    >
      {children}
    </Card>
  );
}

export function CardHeader({
  status,
  tone,
}: {
  status: string;
  tone: PillTone;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text
          {...typeCap("caption")}
          accessibilityRole="header"
          style={{
            color: t.fgMuted,
            ...typeStyle("caption"),
            fontFamily: FONT.semibold,
            letterSpacing: 0.6,
            textTransform: "uppercase",
          }}
        >
          Campaign Assurance
        </Text>
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            marginTop: 2,
          }}
        >
          Predicted Agent Comprehension
        </Text>
      </View>
      <Pill label={status} tone={tone} />
    </View>
  );
}

export function SourceRow({
  label,
  present,
  meaning,
  unavailableBucket = false,
}: {
  label: string;
  present: boolean;
  meaning: string;
  unavailableBucket?: boolean;
}) {
  const { t } = useTheme();
  const marker = unavailableBucket
    ? present
      ? "Present"
      : "None declared"
    : present
      ? "Present"
      : "Unavailable";
  return (
    <View
      accessible
      accessibilityLabel={`${label}. ${marker}. ${meaning}`}
      style={{
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 10,
        padding: 10,
        gap: 3,
      }}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("label")}
          style={{
            color: t.fg,
            ...typeStyle("label"),
            fontFamily: FONT.semibold,
          }}
        >
          {label}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: present ? t.success : t.warning,
            ...typeStyle("label"),
            fontFamily: FONT.semibold,
          }}
        >
          {marker}
        </Text>
      </View>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {meaning}
      </Text>
    </View>
  );
}

export function ReceiptValue({
  label,
  value,
  hash = false,
}: {
  label: string;
  value: string;
  hash?: boolean;
}) {
  const { t } = useTheme();
  return (
    <View accessible accessibilityLabel={`${label}: ${value}`}>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        selectable
        {...typeCap("label")}
        style={{
          color: t.fg,
          ...typeStyle("label"),
          fontFamily: FONT.medium,
        }}
      >
        {hash ? shortAssuranceHash(value) : value}
      </Text>
    </View>
  );
}

export function BodyText({
  children,
  color,
}: {
  children: ReactNode;
  color: string;
}) {
  return (
    <Text
      {...typeCap("label")}
      style={{ color, ...typeStyle("label"), fontFamily: FONT.regular }}
    >
      {children}
    </Text>
  );
}

export function FullReceiptLink({
  url,
  onPress,
}: {
  url: string | null;
  onPress: () => void;
}) {
  const { t } = useTheme();
  if (!url) return null;
  return (
    <TextLink
      onPress={onPress}
      accessibilityLabel="Review the full Campaign Assurance receipt on the web"
      textStyle={{ color: t.accent, fontFamily: FONT.semibold }}
    >
      Review full receipt on web
    </TextLink>
  );
}

/**
 * One assurance action, rendered the same way wherever it appears.
 *
 * The card offers at most one of start / cancel / re-run, and all three want the
 * identical affordance: accent text, a pending label, and disabled while in
 * flight. Three near-identical inline blocks is what pushed the card over its
 * complexity ceiling, and it also risked the three drifting apart.
 */
export function AssuranceActionLink({
  onPress,
  pending,
  label,
  pendingLabel,
  accessibilityLabel,
}: {
  onPress: () => void;
  pending: boolean;
  label: string;
  pendingLabel: string;
  accessibilityLabel: string;
}) {
  const { t } = useTheme();
  return (
    <TextLink
      onPress={onPress}
      disabled={pending}
      accessibilityLabel={accessibilityLabel}
      textStyle={{ color: t.accent, fontFamily: FONT.semibold }}
    >
      {pending ? pendingLabel : label}
    </TextLink>
  );
}

/**
 * The non-blocking findings line.
 *
 * Owns its own empty case so the card does not carry another ternary — that file
 * sits against its cyclomatic ceiling, and a component returning null is the
 * cheaper place to put the branch.
 */
export function AdvisoryLine({ summary }: { summary: string | null }) {
  const { t } = useTheme();
  if (!summary) return null;
  return <BodyText color={t.fgSubtle}>{summary}</BodyText>;
}
