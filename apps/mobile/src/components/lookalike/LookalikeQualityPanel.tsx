/**
 * LookalikeQualityPanel — how similar this audience actually is to its seed.
 *
 * THIS IS THE PANEL THE SURFACE EXISTS FOR. A lookalike's size is the number
 * everyone looks at and the number that says least: `Rank` keeps every
 * candidate above the confidence floor and truncates to the requested size
 * (predictive/similarity.go:148-179), so an audience built with NO floor —
 * which is the default, `confidence_threshold` is nullable — is padded out with
 * whoever was left. The similarity histogram is the only thing on the wire that
 * distinguishes a 5,000-person audience that resembles the seed from a
 * 5,000-person audience that mostly does not.
 *
 * THE BANDS ARE THE SERVER'S, NOT OURS. `lookalikeBands`
 * (subscribers/lookalike.go:419-432) buckets at 0.8 and 0.5 at CREATE time and
 * stores the counts in `payload.bands`. This panel re-labels them and computes
 * shares; it does not re-derive them, because the member rows those counts came
 * from are not on the wire unless someone asks for PII.
 *
 * A MISSING HISTOGRAM IS SAID OUT LOUD. `payload` is free-form jsonb, so a row
 * written by anything other than the current create path may carry no bands at
 * all. That renders as "not recorded", never as three zeroes — a zero-height
 * bar would read as "nobody matched well", which is a different and much worse
 * claim (house rule 8).
 *
 * Colours come only from lib/chartPalette, and every band carries its name, its
 * count and its share as text, so nothing here is carried by colour alone.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { chartPalette } from "@/lib/chartPalette";
import { num, percent, plural } from "@/lib/format";
import {
  bandTotals,
  filledToCeiling,
  isWeakMatch,
  shortfallOf,
} from "@/lib/lookalikeHealth";
import {
  LOOKALIKE_BAND_HIGH_MIN,
  LOOKALIKE_BAND_MEDIUM_MIN,
  type LookalikeAudience,
} from "@/lib/lookalikeAudiences";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const BAND_COPY = [
  {
    key: "high" as const,
    label: "Strong",
    detail: `similarity ${LOOKALIKE_BAND_HIGH_MIN} and above`,
    status: "good" as const,
  },
  {
    key: "medium" as const,
    label: "Moderate",
    detail: `${LOOKALIKE_BAND_MEDIUM_MIN} to ${LOOKALIKE_BAND_HIGH_MIN}`,
    status: "warning" as const,
  },
  {
    key: "low" as const,
    label: "Weak",
    detail: `below ${LOOKALIKE_BAND_MEDIUM_MIN}`,
    status: "critical" as const,
  },
];

export function LookalikeQualityPanel({
  audience,
  /** False while the model is unfinished: its numbers are not final yet. */
  settled,
}: {
  audience: LookalikeAudience;
  settled: boolean;
}) {
  const { t, theme } = useTheme();
  const palette = chartPalette(theme);
  const totals = bandTotals(audience);
  const weak = isWeakMatch(audience);

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        gap: 10,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.semibold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        Similarity to the seed
      </Text>

      {!settled ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          This model has not finished, so there is no final breakdown to show.
          Whatever counts exist on the row are provisional.
        </Text>
      ) : totals === null || totals.total === 0 ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          The similarity breakdown was not recorded for this model, so how close
          these people are to the seed is unknown. It is not zero — it is
          missing.
        </Text>
      ) : (
        <>
          {/* Decorative: every figure below is also carried as text. */}
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
              flexDirection: "row",
              height: 10,
              borderRadius: 5,
              overflow: "hidden",
              backgroundColor: t.bgSubtle,
            }}
          >
            {BAND_COPY.map((band) => {
              const value = totals[band.key];
              if (value <= 0) return null;
              return (
                <View
                  key={band.key}
                  style={{
                    flexGrow: value,
                    flexShrink: 1,
                    flexBasis: 0,
                    backgroundColor: palette.status[band.status],
                  }}
                />
              );
            })}
          </View>

          {BAND_COPY.map((band) => (
            <BandLine
              key={band.key}
              swatch={palette.status[band.status]}
              label={band.label}
              detail={band.detail}
              value={totals[band.key]}
              total={totals.total}
            />
          ))}

          {weak === true ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.warning,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              More than half of this audience scored below{" "}
              {LOOKALIKE_BAND_MEDIUM_MIN} similarity. Those people were kept
              because this model was built without a confidence floor, not
              because they resemble the seed.
            </Text>
          ) : null}
        </>
      )}

      {settled ? <SizeVerdict audience={audience} /> : null}
    </View>
  );
}

/** Whether the model filled the ask, fell short of it, or hit its ceiling. */
function SizeVerdict({ audience }: { audience: LookalikeAudience }) {
  const { t } = useTheme();
  const short = shortfallOf(audience);
  const filled = filledToCeiling(audience);

  if (short !== null) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.warning,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {plural(short.missing, "person", "people")} short of the{" "}
        {num(audience.sizeRequested)} asked for —{" "}
        {percent(short.share, { digits: 0 })} of the request went unfilled. The
        eligible pool ran out; the model did not choose to stop.
      </Text>
    );
  }
  if (filled) {
    return (
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        It filled the {num(audience.sizeRequested)} that were asked for exactly,
        which means it stopped at the ceiling — there may have been more
        eligible people it had no room for.
      </Text>
    );
  }
  return null;
}

function BandLine({
  swatch,
  label,
  detail,
  value,
  total,
}: {
  swatch: string;
  label: string;
  detail: string;
  value: number;
  total: number;
}) {
  const { t } = useTheme();
  const share = total > 0 ? value / total : 0;
  return (
    <View
      accessible
      accessibilityLabel={`${label}, ${detail}: ${plural(value, "member")}, ${percent(
        share,
        { digits: 0 },
      )} of this audience.`}
      style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
    >
      <View
        style={{
          width: 10,
          height: 10,
          borderRadius: 5,
          backgroundColor: swatch,
        }}
      />
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          flexShrink: 1,
        }}
      >
        {label} ({detail})
      </Text>
      <Text
        {...typeCap("numeric")}
        style={{
          color: t.fgMuted,
          ...typeStyle("numeric"),
          fontFamily: FONT.medium,
          // Logical, not physical: this pushes the figure to the TRAILING edge,
          // which mirrors with the row on an RTL locale.
          marginStart: "auto",
        }}
      >
        {num(value)} · {percent(share, { digits: 0 })}
      </Text>
    </View>
  );
}
