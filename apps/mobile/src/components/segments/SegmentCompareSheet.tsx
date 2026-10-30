/**
 * SegmentCompareSheet — pick 2–5 segments, see how they overlap and how
 * they perform (desktop anchors: pages/Segments.tsx SegmentOverlapCard +
 * "Compare audiences" / segmentPnlClient.ts).
 *
 * Both reads are viewer-floor; the sheet is READ-ONLY by scope call —
 * holdout config (POST/DELETE /segments/{id}/holdout) stays on desktop.
 *
 * Selection policy lives in lib/segmentCompareRows.compareSelection and
 * mirrors the server's own bounds (2..5 ids), so the sheet can never fire a
 * guaranteed 400: the queries stay structurally disabled until the
 * selection is valid, and a sixth checkbox is refused rather than sent.
 *
 * Overlap is pairwise, so it renders only while EXACTLY two are selected —
 * with three or more the P&L table still compares, and the overlap card
 * says why it went away instead of silently vanishing.
 *
 * A missing net contribution renders as "no cost config", never as zero —
 * the server distinguishes "unprofitable" from "not configured" and so do we.
 */
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { KeyboardFormSheet } from "@/components/KeyboardFormSheet";
import { Card, Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import { useSegmentOverlap, useSegmentPnlCompare } from "@/hooks/useSegmentCompare";
import type { MobileSegment } from "@/api/segments";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import {
  COMPARE_MAX_SEGMENTS,
  compareSelection,
  formatCents,
} from "@/lib/segmentCompareRows";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

function Caption({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
        marginTop: 4,
      }}
    >
      {children}
    </Text>
  );
}

export function SegmentCompareSheet({
  visible,
  onClose,
  segments,
}: {
  visible: boolean;
  onClose: () => void;
  /** The already-loaded catalogue rows; the sheet fetches nothing extra. */
  segments: readonly MobileSegment[];
}) {
  const { t } = useTheme();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const selection = compareSelection(selected);
  const overlap = useSegmentOverlap(selected);
  const pnl = useSegmentPnlCompare(selected);

  const nameOf = (id: string) =>
    segments.find((s) => s.id === id)?.name ?? `Segment ${id}`;

  const toggle = (id: string) => {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((v) => v !== id);
      // Refuse the sixth selection instead of letting the server 400.
      if (!compareSelection(current).canAddMore) return current;
      return [...current, id];
    });
  };

  const close = () => {
    setSelected([]);
    onClose();
  };

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={close}
      accessibilityLabel="Compare audiences"
    >
      <Text
        accessibilityRole="header"
        {...typeCap("title")}
        style={{ color: t.fg, ...typeStyle("title"), fontFamily: FONT.bold }}
      >
        Compare audiences
      </Text>
      <Caption>
        {`Pick two segments to see their overlap, up to ${COMPARE_MAX_SEGMENTS} to compare performance.`}
      </Caption>

      <ScrollView style={{ maxHeight: 220, marginTop: 12 }}>
        {segments.map((segment) => {
          const checked = selected.includes(segment.id);
          return (
            <Pressable
              key={segment.id}
              onPress={() => toggle(segment.id)}
              accessibilityRole="checkbox"
              accessibilityLabel={`Compare ${segment.name}`}
              accessibilityState={{ checked }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingVertical: 10,
                borderBottomWidth: 1,
                borderBottomColor: t.borderSubtle,
              }}
            >
              <Text
                // The box is a decorative glyph standing in for a checkbox
                // icon inside a fixed 24pt gutter: the checked state already
                // reaches VoiceOver from the row's accessibilityState, and
                // letting the glyph grow to 3x would push the name out of the
                // row it labels.
                allowFontScaling={false}
                aria-hidden
                style={{
                  color: checked ? t.accent : t.fgSubtle,
                  fontFamily: FONT.semibold,
                  width: 24,
                }}
              >
                {checked ? "☑" : "☐"}
              </Text>
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fg,
                  ...typeStyle("label"),
                  fontFamily: FONT.medium,
                  flexShrink: 1,
                }}
                numberOfLines={1}
              >
                {segment.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {selection.canOverlap ? (
        <Card accessibilityLabel="Audience overlap" style={{ marginTop: 12 }}>
          <Label>Overlap</Label>
          {overlap.isError ? (
            <ErrorState
              compact
              error={overlap.error}
              onRetry={() => void overlap.refetch()}
            />
          ) : overlap.data ? (
            <>
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fg,
                  ...typeStyle("label"),
                  fontFamily: FONT.medium,
                  marginTop: 6,
                }}
              >
                {`${plural(overlap.data.intersection, "shared member")} · ${Math.round(overlap.data.jaccard * 100)}% overlap`}
              </Text>
              <Caption>
                {`${overlap.data.aCount} and ${overlap.data.bCount} members respectively.`}
              </Caption>
            </>
          ) : (
            <Caption>Computing…</Caption>
          )}
        </Card>
      ) : selection.canCompare ? (
        <Caption>Overlap is pairwise — narrow to two segments to see it.</Caption>
      ) : null}

      {selection.canCompare ? (
        <Card accessibilityLabel="Performance comparison" style={{ marginTop: 12 }}>
          <Label>Performance</Label>
          {pnl.isError ? (
            <ErrorState
              compact
              error={pnl.error}
              onRetry={() => void pnl.refetch()}
            />
          ) : pnl.data ? (
            pnl.data.map((row, i) => (
              <View
                key={row.segmentId}
                style={{
                  paddingVertical: 8,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: t.border,
                }}
              >
                <Text
                  {...typeCap("label")}
                  style={{
                    color: t.fg,
                    ...typeStyle("label"),
                    fontFamily: FONT.semibold,
                  }}
                  numberOfLines={1}
                >
                  {nameOf(row.segmentId)}
                </Text>
                <Caption>
                  {`${plural(row.memberCount, "member")} · ${plural(row.conversions, "conversion")} · ${formatCents(row.revenueCents, row.currency)} revenue over ${plural(row.windowDays, "day")}`}
                </Caption>
                <Caption>
                  {`${row.unsubCount} unsubs · ${row.complaintCount} complaints · ${
                    row.netContributionCents === null
                      ? "net: no cost config"
                      : `net ${formatCents(row.netContributionCents, row.currency)}`
                  }`}
                </Caption>
              </View>
            ))
          ) : (
            <Caption>Comparing…</Caption>
          )}
        </Card>
      ) : null}
    </KeyboardFormSheet>
  );
}
