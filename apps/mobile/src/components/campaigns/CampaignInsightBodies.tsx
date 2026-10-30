/**
 * CampaignInsightBodies — the four insight cards whose CONTENT is more than a
 * ranked list.
 *
 * Split out of CampaignInsightsSection, which had become one function long
 * enough to trip the source budget: the section's job is choosing which card is
 * open and wiring each to its lazily-enabled query, and that decision was
 * buried under two hundred lines of stat rows. Top links / mail clients /
 * countries stay inline there because they are a single <InsightRankedList/>.
 *
 * Nothing here fetches. Each body takes an already-computed reading from
 * lib/campaignInsights, so the interpretation stays testable in the node
 * environment and these components stay pure render.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { StatRow } from "@/components/campaigns/CampaignDetailControls";

import type { CampaignActivityRow } from "@/lib/campaignActivity";
import type {
  readBounces,
  readGoalResults,
  readHoldoutLift,
} from "@/lib/campaignInsights";
import { FONT } from "@/lib/fonts";
import type { ThemeTokens } from "@/lib/theme";
import { typeCap } from "@/lib/typeScale";

type BounceReading = ReturnType<typeof readBounces>;
type GoalReading = ReturnType<typeof readGoalResults>;
type LiftReading = ReturnType<typeof readHoldoutLift>;

export function BounceBody({
  reading,
  t,
}: {
  reading: BounceReading;
  t: ThemeTokens;
}) {
  return (
    <View>
      {reading.warning ? (
        <View
          accessible
          accessibilityLabel={reading.warning}
          style={{
            borderColor: t.danger,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 10,
            paddingVertical: 8,
            marginBottom: 10,
            flexDirection: "row",
            gap: 8,
            alignItems: "flex-start",
          }}
        >
          <Pill label="⚠ Trap" tone="danger" />
          <Text
            {...typeCap("caption")}
            style={{
              color: t.danger,
              fontSize: 11,
              lineHeight: 16,
              flex: 1,
              fontFamily: FONT.medium,
            }}
          >
            {reading.warning}
          </Text>
        </View>
      ) : null}
      {reading.rows.map((row, i) => (
        <View key={row.key}>
          <StatRow
            label={row.label}
            value={row.value}
            t={t}
            last={i === reading.rows.length - 1}
          />
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontSize: 10,
              lineHeight: 14,
              marginTop: -6,
              marginBottom: 6,
              fontFamily: FONT.regular,
            }}
          >
            {row.detail}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function GoalBody({
  reading,
  t,
}: {
  reading: GoalReading;
  t: ThemeTokens;
}) {
  return (
    <View>
      <Text
        {...typeCap("label")}
        style={{
          color: reading.configured ? t.fg : t.fgSubtle,
          fontSize: 12,
          lineHeight: 17,
          marginBottom: reading.rows.length > 0 ? 8 : 0,
          fontFamily: FONT.regular,
        }}
      >
        {reading.headline}
      </Text>
      {reading.rows.map((row, i) => (
        <StatRow
          key={row.key}
          label={row.label}
          value={row.value}
          t={t}
          last={i === reading.rows.length - 1}
        />
      ))}
    </View>
  );
}

export function ActivityBody({
  rows,
  t,
}: {
  rows: readonly CampaignActivityRow[];
  t: ThemeTokens;
}) {
  return (
    <View style={{ gap: 10 }}>
      {rows.map((row) => (
        <View
          key={row.key}
          accessible
          accessibilityLabel={`${row.label} by ${row.actor}, ${row.absolute}${
            row.redactedNote ? `. ${row.redactedNote}` : ""
          }`}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{ color: t.fg, fontSize: 13, fontFamily: FONT.medium }}
          >
            {row.label}
          </Text>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontSize: 11,
              marginTop: 1,
              fontFamily: FONT.regular,
            }}
          >
            {row.actor} · {row.relative}
            {row.redactedNote ? ` · ${row.redactedNote}` : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function HoldoutLiftBody({
  reading,
  t,
}: {
  reading: LiftReading;
  t: ThemeTokens;
}) {
  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginBottom: reading.rows.length > 0 ? 8 : 0,
        }}
      >
        {/* The pill carries a glyph as well as a tone: lift/no-lift is a
            finding, and a finding must never be colour-alone. */}
        {reading.badge ? (
          <Pill label={reading.badge.label} tone={reading.badge.tone} />
        ) : null}
        <Text
          {...typeCap("label")}
          style={{
            color: t.fg,
            fontSize: 12,
            lineHeight: 17,
            flex: 1,
            fontFamily: FONT.medium,
          }}
        >
          {reading.headline}
        </Text>
      </View>
      {reading.rows.map((row, i) => (
        <StatRow
          key={row.key}
          label={row.label}
          value={row.value}
          t={t}
          last={i === reading.rows.length - 1}
        />
      ))}
      {reading.caveat ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontSize: 10,
            lineHeight: 15,
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          {reading.caveat}
        </Text>
      ) : null}
    </View>
  );
}
