/**
 * FunnelTotalsCard — the whole workspace's save-offer funnel in four numbers.
 *
 * THE ONE THING THIS COMPONENT EXISTS TO GET RIGHT: an unavailable funnel
 * renders as em-dashes, never as zeros. The offers list and the funnel rollup
 * are separate reads (`Deps.List` / `Deps.Funnel`), so the funnel can fail
 * while the catalogue loads fine — and "0 shown / 0 accepted" is exactly what
 * a genuinely-unused offer looks like. The desktop hit this and fixed it the
 * same way (RetentionOffers.tsx:43, "funnelUnavailable"); a phone that
 * regressed it would tell an operator their save flow is dead when the truth
 * is that one request timed out.
 *
 * NativeWind v4: static style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { EMDASH, num, percent } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import type { RetentionFunnelTotals } from "@/lib/retentionOffers";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function FunnelTotalsCard({
  totals,
  onRetry,
}: {
  /** null = the funnel read did not land. NEVER pass a zeroed object for it. */
  totals: RetentionFunnelTotals | null;
  onRetry?: (() => void) | undefined;
}) {
  const { t } = useTheme();
  const outcomeConflict =
    totals !== null &&
    totals.accepted + totals.declined + totals.expired > totals.shown;
  const rate =
    totals && totals.shown > 0 && !outcomeConflict
      ? totals.accepted / totals.shown
      : null;

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Figure label="Shown" value={totals ? num(totals.shown) : EMDASH} />
        <Figure
          label="Accepted"
          value={totals ? num(totals.accepted) : EMDASH}
        />
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Figure
          label="Declined"
          value={totals ? num(totals.declined) : EMDASH}
        />
        <Figure label="Expired" value={totals ? num(totals.expired) : EMDASH} />
      </View>

      <Text
        {...typeCap("caption")}
        accessibilityLabel={
          totals === null
            ? "Acceptance rate unknown while the funnel is unavailable."
            : outcomeConflict
              ? "Acceptance rate unavailable because recorded outcomes exceed showings."
              : rate === null
              ? "No acceptance rate yet — no offer has been shown, so there is no denominator."
              : `Acceptance rate ${percent(rate)}, across ${num(totals.shown)} impressions.`
        }
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {totals === null
          ? `Acceptance rate ${EMDASH}`
          : outcomeConflict
            ? `Acceptance rate ${EMDASH} · outcome-count conflict`
            : rate === null
            ? `Acceptance rate ${EMDASH} · nothing shown yet`
            : `Acceptance rate ${percent(rate)} of ${num(totals.shown)} shown`}
      </Text>

      {totals === null ? (
        <View
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 10,
            gap: 8,
          }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
            }}
          >
            The funnel didn&apos;t load, so these counts are unknown — not zero.
            The offers below are from a separate read and are still accurate.
          </Text>
          {onRetry ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading the offer funnel"
              onPress={() => {
                haptics.tap();
                onRetry();
              }}
              style={{
                alignSelf: "flex-start",
                minHeight: 44,
                justifyContent: "center",
                paddingHorizontal: 14,
                borderRadius: 10,
                backgroundColor: t.bgSubtle,
                borderColor: t.borderSubtle,
                borderWidth: 1,
              }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: t.fg,
                  ...typeStyle("control"),
                  fontFamily: FONT.semibold,
                }}
              >
                Retry the funnel
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * One figure, grouped so VoiceOver reads "14 shown" as one fact. An em-dash is
 * unreadable aloud, so the spoken form says WHY the number is missing instead
 * of announcing a stray punctuation mark.
 */
function Figure({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={
        value === EMDASH ? `${label} unknown — not loaded` : `${value} ${label}`
      }
      style={{
        flex: 1,
        backgroundColor: t.bgSubtle,
        borderRadius: 10,
        padding: 12,
      }}
    >
      <Text
        {...typeCap("figure")}
        numberOfLines={1}
        style={{
          color: t.fg,
          fontSize: 18,
          lineHeight: 22,
          fontWeight: "700",
          fontFamily: FONT.bold,
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          marginTop: 2,
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
    </View>
  );
}
