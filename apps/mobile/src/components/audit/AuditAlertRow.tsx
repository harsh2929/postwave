/**
 * AuditAlertRow — one audit-alert rule in the roster.
 *
 * A rule row has to answer, before any tap: is this detection watching, is it
 * actually delivering, what does it watch for, and where does it go. Everything
 * else (fire history, full narrowing criteria, the delivery error text) belongs
 * behind the tap.
 *
 * STATE IS NEVER COLOUR-ALONE. The pill carries the WORD ("Enabled" / "Paused"
 * / "Delivery failing") and the row's accessibility label carries the full
 * sentence from `healthPresentation().spoken`, because a pill is compacted by
 * definition and the compaction is exactly what a screen-reader user cannot
 * recover.
 *
 * ABSENCE IS NOT ZERO. A payload without a usable `fired_count` renders an
 * em-dash, not "0 fires" — "we did not receive a count" and "this rule has
 * never fired" are different facts, and on a detection roster the second one is
 * the alarming one.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout on this stack.
 */
import { memo } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";

import { Pill } from "@/components/Pill";
import { ruleAttention } from "@/lib/auditAlertPolicy";
import {
  channelDestination,
  channelLabel,
  healthPresentation,
  matchNarrowing,
  operatorSummary,
  ruleHealth,
  type AuditAlertRule,
} from "@/lib/auditAlertRules";
import { EMDASH, num, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

export interface AuditAlertRowProps {
  rule: AuditAlertRule;
  onPress: (rule: AuditAlertRule) => void;
  /** Dims the row while its toggle is in flight. */
  busy?: boolean | undefined;
  /** `Date.now()` from the screen's ticker, so "fired 3h ago" stays honest. */
  now?: number | undefined;
}

function AuditAlertRowImpl({ rule, onPress, busy, now }: AuditAlertRowProps) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const health = healthPresentation(ruleHealth(rule));
  const watches = operatorSummary(rule);
  const destination = channelDestination(rule);
  const channel = channelLabel(rule.channelKind);
  const narrowing = matchNarrowing(rule);
  const fired =
    rule.firedCount === null
      ? EMDASH
      : `${num(rule.firedCount)} ${rule.firedCount === 1 ? "fire" : "fires"}`;
  const last = rule.lastFiredAt
    ? relativeTime(rule.lastFiredAt, now === undefined ? {} : { now })
    : "never fired";
  // A rule that is enabled, delivering, and matching NOTHING is invisible to
  // the health pill by construction — that pill only knows `enabled` and
  // `last_error`. This is the row's second, quieter claim.
  const attention = ruleAttention(rule, now ?? Date.now());
  // The count line is compacted, so the label spells both halves out.
  const firedSpoken =
    rule.firedCount === null
      ? "Fire count unavailable"
      : `${rule.firedCount} ${rule.firedCount === 1 ? "fire" : "fires"} in total`;

  return (
    <Pressable
      onPress={() => onPress(rule)}
      disabled={busy === true}
      accessibilityRole="button"
      accessibilityState={{ disabled: busy === true, busy: busy === true }}
      accessibilityLabel={`${rule.name}. ${health.spoken}${
        attention ? ` ${attention.spoken}` : ""
      } ${watches}. Delivers to ${
        destination ? `${channel}, ${destination}` : channel
      }. ${firedSpoken}, last ${last}.`}
      accessibilityHint="Opens the rule to read its recent deliveries and pause or resume it"
      style={{
        backgroundColor: t.surface,
        borderColor: ruleHealth(rule) === "failing" ? t.danger : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 10,
        gap: 6,
        // 44pt is the touch-target floor; the row is taller in practice.
        minHeight: 44,
        opacity: busy === true ? 0.55 : 1,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          numberOfLines={maxLinesAtScale(1, fontScale)}
          {...typeCap("body")}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontFamily: FONT.semibold,
            flexShrink: 1,
          }}
        >
          {rule.name}
        </Text>
        <Pill label={health.label} tone={health.tone} />
      </View>

      {attention ? (
        <Pill
          label={attention.label}
          tone={attention.tone === "warning" ? "warning" : "neutral"}
          // The pill is compacted by definition; the sentence beside it is
          // what a screen-reader user would otherwise never recover. The row's
          // own label already carries it, so this one is hidden from the
          // accessibility tree by giving the row `accessible` semantics.
          accessibilityLabel={attention.spoken}
          style={{ alignSelf: "flex-start" }}
        />
      ) : null}

      <Text
        numberOfLines={maxLinesAtScale(2, fontScale)}
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {watches}
      </Text>

      {narrowing ? (
        <Text
          numberOfLines={maxLinesAtScale(1, fontScale)}
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {narrowing}
        </Text>
      ) : null}

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
        }}
      >
        <Pill label={channel} tone="neutral" />
        {rule.notifySlack ? <Pill label="+ Slack" tone="info" /> : null}
        <Text
          numberOfLines={maxLinesAtScale(1, fontScale)}
          // Dense: this line shares a wrapping row with two pills and is
          // pinned beside them, so it takes the dense ceiling.
          {...typeCap("numeric")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("numeric"),
            fontFamily: FONT.regular,
            flexShrink: 1,
          }}
        >
          {fired} · {last}
        </Text>
      </View>
    </Pressable>
  );
}

export const AuditAlertRow = memo(AuditAlertRowImpl);
