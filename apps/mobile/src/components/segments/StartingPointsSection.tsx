/**
 * StartingPointsSection — the "don't start from a blank box" catalogue on
 * the segments screen (desktop anchors: PresetSegmentGallery /
 * SegmentTemplateGallery / AISuggestionsSection on pages/Segments.tsx).
 *
 * Mobile folds the three sources into ONE list; each row seeds
 * DescribeAudienceSheet's compile→preview→save path via `onPick`, so a
 * tapped starting point still shows its rule and live size before anything
 * is saved — the same honesty gates as a typed description. (RFM predictive
 * segments, desktop's fourth gallery, already reach mobile on the analytics
 * screen and are deliberately not re-fetched here.)
 *
 * Collapsed by default and fetched only once opened: the AI-suggestions leg
 * runs live preview counts server-side, which nobody should pay for on
 * every visit to the catalogue.
 *
 * Honesty rules, both from lib/segmentStartingPoints:
 *  - one failed source is NAMED while the others render (failedSources);
 *  - the server's AI-processing disclosure (`notice`) renders verbatim
 *    whenever any AI suggestion is on screen.
 */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { Card, Label } from "@/components/subscriber/SubscriberDetailPrimitives";
import { useSegmentStartingPoints } from "@/hooks/useSegmentStartingPoints";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import type { StartingPointSource } from "@/lib/segmentStartingPoints";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const ROWS_SHOWN = 12;

const SOURCE_BADGE: Record<StartingPointSource, string> = {
  ai: "Suggested",
  preset: "Preset",
  template: "Template",
};

const SOURCE_FAILURE: Record<StartingPointSource, string> = {
  ai: "AI suggestions didn't load.",
  preset: "Preset segments didn't load.",
  template: "Segment templates didn't load.",
};

export function StartingPointsSection({
  onPick,
}: {
  /** Seeds the describe sheet with the tapped starting point. */
  onPick: (seed: { text: string; name: string }) => void;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const catalogue = useSegmentStartingPoints(open);

  const data = catalogue.data;
  const hasAiRows = (data?.items ?? []).some((row) => row.source === "ai");

  return (
    <Card accessibilityLabel="Starting points" style={{ marginBottom: 12 }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel="Starting points"
        accessibilityState={{ expanded: open }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Label>Starting points</Label>
        {/* The disclosure triangle is an ICON drawn as a glyph, not content:
            the expanded/collapsed state already reaches VoiceOver through the
            Pressable's `accessibilityState`, so it stays out of the a11y tree
            and out of Dynamic Type — an affordance arrow that grows to 3x
            beside a capped label is a rendering bug. */}
        <Text
          allowFontScaling={false}
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ color: t.fgSubtle, fontFamily: FONT.regular }}
        >
          {open ? "▾" : "▸"}
        </Text>
      </Pressable>

      {open ? (
        catalogue.isError ? (
          <ErrorState
            compact
            error={catalogue.error}
            onRetry={() => void catalogue.refetch()}
          />
        ) : !data ? (
          <Text
            {...typeCap("label")}
            style={{
              color: t.fgMuted,
              ...typeStyle("label"),
              fontFamily: FONT.regular,
              marginTop: 6,
            }}
          >
            Loading…
          </Text>
        ) : (
          <View>
            {data.failedSources.map((source) => (
              <Text
                key={source}
                {...typeCap("caption")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                  marginTop: 4,
                }}
              >
                {SOURCE_FAILURE[source]}
              </Text>
            ))}
            {hasAiRows && data.aiNotice ? (
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("caption"),
                  fontFamily: FONT.regular,
                  marginTop: 4,
                }}
              >
                {data.aiNotice}
              </Text>
            ) : null}
            {data.items.length === 0 ? (
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("label"),
                  fontFamily: FONT.regular,
                  marginTop: 6,
                }}
              >
                No starting points available for this workspace.
              </Text>
            ) : (
              data.items.slice(0, ROWS_SHOWN).map((row, i) => (
                <Pressable
                  key={row.key}
                  onPress={() => onPick({ text: row.seedText, name: row.seedName })}
                  accessibilityRole="button"
                  accessibilityLabel={`Start from ${row.name}`}
                  style={{
                    paddingVertical: 10,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: t.border,
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
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
                      {row.name}
                    </Text>
                    <Text
                      {...typeCap("caption")}
                      style={{
                        color: t.fgSubtle,
                        ...typeStyle("caption"),
                        fontFamily: FONT.regular,
                        marginStart: 8,
                      }}
                    >
                      {SOURCE_BADGE[row.source]}
                    </Text>
                  </View>
                  {row.description ? (
                    <Text
                      {...typeCap("caption")}
                      style={{
                        color: t.fgMuted,
                        ...typeStyle("caption"),
                        fontFamily: FONT.regular,
                      }}
                      numberOfLines={2}
                    >
                      {row.description}
                    </Text>
                  ) : null}
                  {row.size !== null ? (
                    <Text
                      {...typeCap("caption")}
                      style={{
                        color: t.fgSubtle,
                        ...typeStyle("caption"),
                        fontFamily: FONT.regular,
                      }}
                    >
                      {`about ${plural(row.size, "member")}`}
                    </Text>
                  ) : null}
                </Pressable>
              ))
            )}
          </View>
        )
      ) : null}
    </Card>
  );
}
