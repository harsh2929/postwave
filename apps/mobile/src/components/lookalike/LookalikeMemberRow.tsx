/**
 * LookalikeMemberRow — one ranked person, and WHY the model picked them.
 *
 * A rank and an address alone are unfalsifiable: they tell an operator the
 * model has an opinion without letting them judge it. The four numbers the
 * scorer actually used are on the wire in `subscriber_lookalike_members.features`
 * (subscribers/lookalike.go:182-196), so this row shows them.
 *
 * WHAT THE FEATURE KEYS MEAN, from `vectorize` (predictive/similarity.go:66-81),
 * because two of the four are not what their names suggest:
 *   - `engagement` is `engagement_score / 100`, so it is a share in [0,1].
 *   - `retention` is `1 - churn_score/100`. There is NO retention column: it is
 *     INVERTED CHURN, so a high figure means "unlikely to leave", and calling it
 *     anything else would misattribute a stored value.
 *   - `domain:<host>` and `source:<name>` are one-hot and are emitted ONLY when
 *     the SEED itself exhibits that value. Their ABSENCE therefore does not mean
 *     the person has no email domain — it means their domain is not one the seed
 *     shares. That distinction is why this row says "shared with the seed"
 *     rather than printing the domain as a property of the person.
 *
 * The similarity score is rendered to four decimals because that is the column's
 * real precision — `roundLookalikeScore` clamps into numeric(5,4)
 * (lookalike.go:449-456) — and rounding it to a percentage on screen would
 * invent agreement between two members that the stored values do not have.
 */
import { memo } from "react";
import { Text, useWindowDimensions, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import { EMDASH, num, percent } from "@/lib/format";
import { bandOf, type LookalikeMember } from "@/lib/lookalikeAudiences";
import { useTheme } from "@/lib/theme";
import { maxLinesAtScale, typeCap, typeStyle } from "@/lib/typeScale";

const BAND_PILL = {
  high: { label: "Strong", tone: "success" as const },
  medium: { label: "Moderate", tone: "warning" as const },
  low: { label: "Weak", tone: "danger" as const },
};

function LookalikeMemberRowImpl({ member }: { member: LookalikeMember }) {
  const { t } = useTheme();
  const { fontScale } = useWindowDimensions();
  const band = bandOf(member.similarityScore);
  const pill = band ? BAND_PILL[band] : null;
  const score =
    member.similarityScore === null
      ? EMDASH
      : member.similarityScore.toFixed(4);

  const shared: string[] = [];
  if (member.matchedDomain) shared.push(`domain ${member.matchedDomain}`);
  if (member.matchedSource) shared.push(`signup via ${member.matchedSource}`);

  return (
    <View
      accessible
      accessibilityLabel={`Rank ${
        member.rank === null ? "unknown" : num(member.rank)
      }. ${member.email || "No address on record"}. Similarity ${score}${
        pill ? `, a ${pill.label.toLowerCase()} match` : ""
      }. Engagement ${
        member.engagement === null ? "not recorded" : percent(member.engagement, { digits: 0 })
      }, retention ${
        member.retention === null ? "not recorded" : percent(member.retention, { digits: 0 })
      }.${shared.length > 0 ? ` Shares ${shared.join(" and ")} with the seed.` : ""}`}
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 4,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          numberOfLines={maxLinesAtScale(1, fontScale)}
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.medium,
            flexShrink: 1,
          }}
        >
          {member.rank === null ? EMDASH : `#${num(member.rank)}`}{" "}
          {member.email || "No address on record"}
        </Text>
        {pill ? <Pill label={pill.label} tone={pill.tone} size="sm" /> : null}
      </View>

      <Text
        numberOfLines={maxLinesAtScale(2, fontScale)}
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Similarity {score} {EMDASH} engagement{" "}
        {member.engagement === null
          ? EMDASH
          : percent(member.engagement, { digits: 0 })}{" "}
        {EMDASH} retention{" "}
        {member.retention === null
          ? EMDASH
          : percent(member.retention, { digits: 0 })}
      </Text>

      {shared.length > 0 ? (
        <Text
          numberOfLines={maxLinesAtScale(2, fontScale)}
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          Shares {shared.join(" and ")} with the seed
        </Text>
      ) : null}
    </View>
  );
}

export const LookalikeMemberRow = memo(LookalikeMemberRowImpl);
