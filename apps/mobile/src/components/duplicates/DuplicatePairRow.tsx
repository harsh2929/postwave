/**
 * DuplicatePairRow — one candidate pair in the review queue.
 *
 * The row leads with the two ADDRESSES, because they are what a person
 * recognises, and puts the server's reason directly under them: the manifest
 * is deterministic (subscriber_dedupe.go:5-8), so every pair has a stated
 * reason and hiding it behind a tap would turn a reviewable decision into a
 * guess.
 *
 * A row that the server will refuse says so IN THE ROW rather than only on the
 * button, and never by colour alone — "Stale" is a word, and the spoken label
 * carries the whole sentence.
 *
 * NativeWind v4: static Pressable style objects only — a function style
 * silently drops layout.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { percent } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  evidenceLabel,
  pairKey,
  type DuplicatePair,
} from "@/lib/duplicateScan";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface DuplicatePairRowProps {
  pair: DuplicatePair;
  selected: boolean;
  /** Set once this exact pair has been merged in this session. */
  merged: boolean;
  onSelect: (key: string) => void;
}

export function DuplicatePairRow({
  pair,
  selected,
  merged,
  onSelect,
}: DuplicatePairRowProps) {
  const { t } = useTheme();
  const key = pairKey(pair);
  const label = evidenceLabel(pair.kind);
  const confidence =
    pair.confidence === null ? "" : percent(pair.confidence, { digits: 0 });
  const primary = pair.primaryEmail || "Address withheld";
  const duplicate = pair.duplicateEmail || "Address withheld";

  const spoken = [
    `${primary} and ${duplicate}`,
    label,
    confidence ? `${confidence} confidence` : "confidence not reported",
    merged
      ? "already merged in this session"
      : pair.stale
        ? "stale, changed since the scan"
        : "",
    selected ? "selected" : "",
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint="Opens the merge plan for this pair"
      accessibilityState={{ selected, disabled: merged }}
      disabled={merged}
      onPress={() => {
        haptics.tap();
        onSelect(key);
      }}
      style={{
        minHeight: 44,
        backgroundColor: selected ? t.surfaceElevated : t.surface,
        borderColor: selected ? t.accent : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        gap: 8,
        opacity: merged ? 0.6 : 1,
      }}
    >
      <View style={{ gap: 2 }}>
        <Text
          {...typeCap("body")}
          numberOfLines={1}
          style={{
            color: t.fg,
            ...typeStyle("body"),
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {primary}
        </Text>
        <Text
          {...typeCap("body")}
          numberOfLines={1}
          style={{
            color: t.fgMuted,
            ...typeStyle("body"),
            fontFamily: FONT.regular,
          }}
        >
          {duplicate}
        </Text>
      </View>

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {pair.evidence[0]?.reason || "The server did not state a reason."}
      </Text>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Pill label={label} tone="neutral" accessibilityLabel={`Matched on: ${label}`} />
        <Pill
          label={confidence || "Confidence —"}
          tone={pair.confidence !== null && pair.confidence >= 0.95 ? "info" : "neutral"}
          accessibilityLabel={
            confidence
              ? `Server confidence ${confidence}`
              : "The server did not report a confidence for this pair"
          }
        />
        {merged ? (
          <Pill
            label="Merged"
            tone="success"
            accessibilityLabel="Merged in this session"
          />
        ) : pair.stale ? (
          <Pill
            label="Stale"
            tone="warning"
            accessibilityLabel="Stale — one of these records changed after the scan"
          />
        ) : null}
      </View>
    </Pressable>
  );
}
