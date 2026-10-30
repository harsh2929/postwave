/**
 * AttributionVerdictCard — how much money the window holds and how much of it
 * the server could tie to a campaign.
 *
 * The judgement is in `lib/attributionVerdict` (pure, node-tested); this
 * component paints it and adds the three figures.
 *
 * WHY THERE IS NO "AVERAGE ORDER VALUE" HERE. It is the obvious fourth tile and
 * it would be a fabrication: `revenue_cents` is filtered to the dominant
 * currency while `conversions` counts every conversion including other
 * currencies and non-monetary ones (attribution.go:518-530). The two figures
 * have different denominators, so their quotient is not a number this backend
 * can support and it is not shown.
 *
 * WHY THE ATTRIBUTED SHARE CAN BE AN EM-DASH. A window with conversions but no
 * money has no dominant-currency revenue, and a share of nothing is undefined
 * rather than 0% — `attributionCoverage` returns null and the tile says so.
 */
import { Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import {
  attributionCoverage,
  centsToUnits,
  type AttributionTone,
  type AttributionVerdict,
} from "@/lib/attributionVerdict";
import type { CampaignAttribution } from "@/lib/conversionAttribution";
import { EMDASH, money, num, percent } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const TONE_PILL: Readonly<Record<AttributionTone, PillTone>> = {
  ok: "success",
  warn: "warning",
  idle: "neutral",
};

/** The word, so the state survives greyscale and colour-blindness. */
const TONE_WORD: Readonly<Record<AttributionTone, string>> = {
  ok: "attributed",
  warn: "mostly unattributed",
  idle: "nothing to attribute",
};

interface Figure {
  label: string;
  value: string;
  spoken: string;
}

function figures(data: CampaignAttribution | null): Figure[] {
  if (!data || !data.hasMonetary) {
    return [
      { label: "Attributed", value: EMDASH, spoken: "Attributed revenue, not measured — this window holds no monetary conversion" },
      { label: "Unattributed", value: EMDASH, spoken: "Unattributed revenue, not measured" },
      { label: "Share attributed", value: EMDASH, spoken: "Share attributed, undefined — there is no revenue to divide" },
    ];
  }
  const coverage = attributionCoverage(data);
  const code = data.currency || "USD";
  const attributed = money(centsToUnits(coverage.attributedCents), code, { cents: true });
  const unattributed = money(centsToUnits(coverage.unattributedCents), code, { cents: true });
  return [
    {
      label: "Attributed",
      value: attributed,
      spoken: `Attributed revenue ${attributed}, tied to a campaign`,
    },
    {
      label: "Unattributed",
      value: unattributed,
      spoken: `Unattributed revenue ${unattributed}, reported separately and never folded into a campaign`,
    },
    {
      label: "Share attributed",
      value:
        coverage.attributedShare === null
          ? EMDASH
          : percent(coverage.attributedShare),
      spoken:
        coverage.attributedShare === null
          ? "Share attributed, undefined — there is no revenue to divide"
          : `${percent(coverage.attributedShare)} of ${code} revenue is tied to a campaign`,
    },
  ];
}

export function AttributionVerdictCard({
  verdict,
  data,
}: {
  verdict: AttributionVerdict;
  data: CampaignAttribution | null;
}) {
  const { t } = useTheme();
  const rows = figures(data);
  const conversions = data?.provenance.total ?? null;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginBottom: 12,
        gap: 12,
      }}
    >
      <View accessible accessibilityLabel={`${verdict.headline}. ${verdict.detail}`}>
        <Pill label={TONE_WORD[verdict.tone]} tone={TONE_PILL[verdict.tone]} />
        <Text
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            marginTop: 8,
            fontWeight: "600",
            fontFamily: FONT.semibold,
          }}
        >
          {verdict.headline}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("label"),
            marginTop: 6,
            fontFamily: FONT.regular,
          }}
        >
          {verdict.detail}
        </Text>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {rows.map((row) => (
          <View
            key={row.label}
            accessible
            accessibilityLabel={row.spoken}
            style={{ minWidth: 110, flexGrow: 1, flexBasis: "30%" }}
          >
            <Text
              {...typeCap("badgeSmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("badgeSmall"),
                letterSpacing: 0.6,
                textTransform: "uppercase",
                fontFamily: FONT.semibold,
              }}
            >
              {row.label}
            </Text>
            <Text
              {...typeCap("numeric")}
              style={{
                color: t.fg,
                ...typeStyle("numeric"),
                marginTop: 2,
                fontVariant: ["tabular-nums"],
                fontFamily: FONT.semibold,
              }}
              numberOfLines={1}
              adjustsFontSizeToFit
            >
              {row.value}
            </Text>
          </View>
        ))}
      </View>

      {conversions !== null ? (
        <Text
          accessible
          accessibilityLabel={`${num(conversions)} conversions were reported in this window, counting every currency and every conversion with no monetary value.`}
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          {num(conversions)} conversions reported — every currency, including
          those with no monetary value.
        </Text>
      ) : null}
    </View>
  );
}
