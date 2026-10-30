/**
 * ResultsCard (mobile) — one card per A/B variant. Mirrors the desktop
 * `apps/desktop/src/components/abtest/ResultsCard.tsx` shape, rendered
 * with RN primitives + the mobile theme tokens.
 *
 * The card stacks vertically on a phone (one card per row); the parent
 * still passes `isWinner` so the winning card gets a subtle accent tint.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import {
  campaignCount,
  campaignRate,
  type CampaignRateScale,
} from "@/lib/campaignFormat";
import { TINT_ALPHA, withAlpha } from "@/lib/color";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

/**
 * GET /api/v1/campaigns/{id}/ab-results returns `rate` as a 0..1 FRACTION —
 * apps/api/internal/abtests/handlers.go:451 computes
 * `hits / RecipientsCount` and assigns it straight through, despite naming the
 * local `ratePct`. A variant at half a percent used to render as 50%.
 */
const AB_RATE_SCALE: CampaignRateScale = "fraction";

export interface ResultsCardVariant {
  id: string;
  variant_index: number;
  variant_label?: string;
  subject?: string;
  sent: number;
  hits: number;
  rate: number;
  is_control: boolean;
}

export interface ResultsCardProps {
  variant: ResultsCardVariant;
  /** Human label for the metric (e.g. "Open rate"). */
  metricLabel: string;
  /** Highlights the card when this variant is the winner. */
  isWinner?: boolean;
}

export function ResultsCard({
  variant,
  metricLabel,
  isWinner,
}: ResultsCardProps) {
  const { t } = useTheme();
  const label = variant.variant_label ?? `Variant ${variant.variant_index + 1}`;
  return (
    <View
      style={{
        backgroundColor: isWinner ? withAlpha(t.accent, TINT_ALPHA) : t.surface,
        borderColor: isWinner ? t.accent : t.borderSubtle,
        borderWidth: 1,
        borderRadius: 16,
        padding: 14,
        gap: 10,
      }}
      accessibilityLabel={`${label} ${metricLabel} ${campaignRate(variant.rate, { scale: AB_RATE_SCALE })}`}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <Text
          {...typeCap("body")}
          style={{
            color: t.fg,
            fontSize: 15,
            fontWeight: "700",
            fontFamily: FONT.bold,
            flex: 1,
            // Tenant-authored variant labels can be RTL.
            writingDirection: "auto",
          }}
        >
          {label}
        </Text>
        {variant.is_control ? <Pill label="Control" tone="neutral" /> : null}
        {isWinner ? <Pill label="Winner" tone="success" /> : null}
      </View>
      {variant.subject ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            fontSize: 12,
            fontFamily: FONT.regular,
            writingDirection: "auto",
          }}
          numberOfLines={2}
        >
          {variant.subject}
        </Text>
      ) : (
        <Text
          {...typeCap("label")}
          style={{ color: t.fgSubtle, fontSize: 12, fontFamily: FONT.regular }}
        >
          (no subject)
        </Text>
      )}
      <View style={{ flexDirection: "row", gap: 16 }}>
        <View>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              fontSize: 10,
              letterSpacing: 0.5,
              fontWeight: "600",
              fontFamily: FONT.semibold,
              textTransform: "uppercase",
            }}
          >
            Sent
          </Text>
          <Text
            {...typeCap("mono")}
            style={{
              color: t.fg,
              fontSize: 14,
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
              marginTop: 2,
            }}
          >
            {campaignCount(variant.sent)}
          </Text>
        </View>
        <View>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              fontSize: 10,
              letterSpacing: 0.5,
              fontWeight: "600",
              fontFamily: FONT.semibold,
              textTransform: "uppercase",
            }}
          >
            Hits
          </Text>
          <Text
            {...typeCap("mono")}
            style={{
              color: t.fg,
              fontSize: 14,
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
              marginTop: 2,
            }}
          >
            {campaignCount(variant.hits)}
          </Text>
        </View>
      </View>
      <View>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            fontSize: 10,
            letterSpacing: 0.5,
            fontWeight: "600",
            fontFamily: FONT.semibold,
            textTransform: "uppercase",
          }}
        >
          {metricLabel}
        </Text>
        <Text
          {...typeCap("figure")}
          style={{
            color: isWinner ? t.accent : t.fg,
            fontSize: 26,
            fontWeight: "700",
            fontFamily: FONT.display,
            fontVariant: ["tabular-nums"],
            letterSpacing: -0.5,
            marginTop: 2,
          }}
        >
          {campaignRate(variant.rate, { scale: AB_RATE_SCALE })}
        </Text>
      </View>
    </View>
  );
}
