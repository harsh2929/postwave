/**
 * CampaignHealthCards — the two warning surfaces that had no consumer.
 *
 *   GET /api/v1/campaigns/{id}/health     — is this send hurting the domain?
 *   GET /api/v1/campaigns/{id}/anomalies  — did any hour behave unusually?
 *
 * Both are computed server-side for every send and, before this, neither was
 * read by ANY client in the campaigns cluster. "This send is bouncing eight
 * times your baseline" is the definitive glanceable insight, and it is exactly
 * what someone opens the app on a phone to find out.
 *
 * They ride the same collapsed-until-tapped card as the rest of Insights, so a
 * campaign screen still costs what it did before; a tap costs one request.
 *
 * Tone is never the only signal. Every badge carries a word and a glyph, and
 * each anomaly renders as a full sentence naming the metric, direction and
 * hour — the reading is in the text, and colour only reinforces it.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { CampaignInsightCard } from "@/components/campaigns/CampaignInsightCard";
import type {
  useCampaignAnomalies,
  useCampaignHealth,
} from "@/hooks/useCampaignHealth";
import {
  campaignAnomalyRows,
  campaignAnomalySummary,
  readCampaignHealth,
  type HealthTone,
} from "@/lib/campaignHealth";
import { FONT } from "@/lib/fonts";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

type HealthQuery = ReturnType<typeof useCampaignHealth>;
type AnomalyQuery = ReturnType<typeof useCampaignAnomalies>;

function toneColor(tone: HealthTone, t: ThemeTokens): string {
  if (tone === "danger") return t.danger;
  if (tone === "warning") return t.warning;
  if (tone === "good") return t.success;
  return t.fgMuted;
}

function pillTone(
  tone: HealthTone,
): "success" | "warning" | "danger" | "neutral" {
  if (tone === "danger") return "danger";
  if (tone === "warning") return "warning";
  if (tone === "good") return "success";
  return "neutral";
}

export function CampaignHealthCard({
  query,
  expanded,
  onToggle,
}: {
  query: HealthQuery;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTheme();
  const reading = readCampaignHealth(query.data ?? null);

  return (
    <CampaignInsightCard
      title="Deliverability health"
      caption="Whether this send is damaging your ability to reach an inbox at all — the one number worth interrupting a day for."
      expanded={expanded}
      onToggle={onToggle}
      loading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      empty={query.data == null}
      emptyMessage="This workspace doesn't expose per-campaign deliverability health."
    >
      <View style={{ gap: 8 }}>
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
          accessible
          accessibilityLabel={`${reading.badge}. ${reading.headline}${
            reading.scoreLine ? ` Score ${reading.scoreLine}.` : ""
          }`}
        >
          <Pill label={reading.badge} tone={pillTone(reading.tone)} />
          {reading.scoreLine ? (
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fgMuted,
                ...typeStyle("numeric"),
                fontFamily: FONT.medium,
                fontVariant: ["tabular-nums"],
              }}
            >
              {reading.scoreLine}
            </Text>
          ) : null}
        </View>
        <Text
          {...typeCap("label")}
          style={{
            color: toneColor(reading.tone, t),
            ...typeStyle("label"),
            fontFamily: FONT.medium,
          }}
        >
          {reading.headline}
        </Text>
        {reading.reasons.map((reason) => (
          <Text
            key={reason}
            {...typeCap("caption")}
            style={{
              color: t.fg,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {"• "}
            {reason}
          </Text>
        ))}
      </View>
    </CampaignInsightCard>
  );
}

export function CampaignAnomaliesCard({
  query,
  expanded,
  onToggle,
}: {
  query: AnomalyQuery;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTheme();
  const rows = campaignAnomalyRows(query.data ?? null);
  const summary = campaignAnomalySummary(rows, query.data?.truncated === true);

  return (
    <CampaignInsightCard
      title="Unusual hours"
      caption="Hours whose opens, clicks or unsubscribes broke away from this send's own baseline."
      expanded={expanded}
      onToggle={onToggle}
      loading={query.isLoading}
      error={query.error}
      onRetry={() => void query.refetch()}
      empty={query.data == null}
      emptyMessage="This workspace doesn't expose per-campaign anomaly detection."
    >
      <View style={{ gap: 10 }}>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {summary}
        </Text>
        {rows.map((row) => (
          <View
            key={row.id}
            accessible
            accessibilityLabel={
              row.multiple
                ? `${row.message} That is ${row.multiple} the baseline.`
                : row.message
            }
            style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}
          >
            {row.multiple ? (
              <Pill label={row.multiple} tone={pillTone(row.tone)} />
            ) : null}
            <Text
              {...typeCap("caption")}
              style={{
                color: toneColor(row.tone, t),
                ...typeStyle("caption"),
                flex: 1,
                fontFamily: FONT.medium,
              }}
            >
              {row.message}
            </Text>
          </View>
        ))}
      </View>
    </CampaignInsightCard>
  );
}
