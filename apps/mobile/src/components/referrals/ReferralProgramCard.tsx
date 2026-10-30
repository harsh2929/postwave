/**
 * The programme card — what the referral scheme is configured to give away.
 *
 * Three distinct states, and conflating any two of them would mislead:
 *
 *   loading   → skeleton-ish line, never "no programme".
 *   none      → "No referral programme configured." This is a 404 from
 *               /referral-programs/current and it is a legitimate resting
 *               state, so it must not render as an error.
 *   configured→ tiers, referee reward, verification window, expiry.
 *
 * Editing the programme is POST /api/v1/referral-programs — offered to admin
 * sessions since the desktop-parity pass via the Edit affordance (`onEdit`),
 * which opens ReferralProgramEditSheet. Below the admin floor the card stays
 * read-only and says so; the note names the role rule, not a client excuse.
 *
 * The A/B split, when the workspace has one, is shown here rather than in its
 * own card: a variant is a per-arm override of the milestones printed directly
 * above it, and separating the two would invite reading the tier list as the
 * whole truth.
 *
 * NativeWind v4: static style objects only.
 */
import { Pressable, Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { num } from "@/lib/format";
import {
  REFERRAL_PROGRAM_READ_ONLY_NOTE,
  programSummaryLine,
  variantSummaryLine,
  type ReferralProgram,
  type ReferralVariant,
} from "@/lib/referrals";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface ReferralProgramCardProps {
  program: ReferralProgram | null;
  loading: boolean;
  /**
   * Undefined while the variants read is in flight or failed — distinct from an
   * empty array, which means "the workspace has no A/B arms". Neither renders a
   * line, but only the empty array is an answer.
   */
  variants?: readonly ReferralVariant[] | undefined;
  /**
   * Admin-only entry to the programme editor. Null/undefined below the floor
   * (or offline) — the affordance is withheld, never disabled.
   */
  onEdit?: (() => void) | null;
}

export function ReferralProgramCard({
  program,
  loading,
  variants,
  onEdit = null,
}: ReferralProgramCardProps) {
  const { t } = useTheme();
  const summary = loading
    ? "Reading the current programme…"
    : programSummaryLine(program);
  const variantLine = variantSummaryLine(variants);
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: 12,
        marginHorizontal: 16,
        marginTop: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <Text
          {...typeCap("label")}
          accessibilityRole="header"
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.semibold,
          }}
        >
          Programme
        </Text>
        {onEdit && !loading ? (
          <Pressable
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityLabel={
              program
                ? "Edit the referral programme"
                : "Create a referral programme"
            }
            hitSlop={8}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("callout")}
              style={{
                color: t.accent,
                ...typeStyle("callout"),
                fontFamily: FONT.semibold,
              }}
            >
              {program ? "Edit" : "Create"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Text
        {...typeCap("body")}
        style={{
          color: t.fg,
          ...typeStyle("body"),
          marginTop: 4,
          fontFamily: FONT.regular,
        }}
      >
        {summary}
      </Text>

      {/* The optional chain guards `program`, not `milestones`. */}
      {(Array.isArray(program?.milestones) ? program.milestones : []).map((milestone) => (
        <View
          key={`${milestone.count}-${milestone.rewardLabel}`}
          accessible
          accessibilityLabel={`${num(milestone.count)} referrals unlocks ${milestone.rewardLabel}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            marginTop: 8,
          }}
        >
          <Text
            {...typeCap("numeric")}
            style={{
              color: t.accent,
              ...typeStyle("numeric"),
              fontWeight: "700",
              fontFamily: FONT.bold,
              minWidth: 34,
            }}
          >
            {num(milestone.count)}
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              flexShrink: 1,
              fontFamily: FONT.regular,
            }}
          >
            {milestone.rewardLabel}
            {milestone.rewardKind ? ` · ${milestone.rewardKind}` : ""}
          </Text>
        </View>
      ))}

      {program?.refereeRewardLabel ? (
        <Detail label="Referee reward" value={program.refereeRewardLabel} />
      ) : null}
      {program?.verificationWindowDays !== undefined ? (
        <Detail
          label="Verification window"
          value={`${num(program.verificationWindowDays)} days`}
        />
      ) : null}
      {program?.expiresAt ? (
        <Detail label="Programme expires" value={program.expiresAt} />
      ) : null}
      {variantLine ? (
        <Detail label="Variant split" value={variantLine} />
      ) : null}

      {/* The read-only note is a role fact, so it only renders when the edit
          affordance is genuinely absent for this session. */}
      {onEdit ? null : (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            marginTop: 10,
            fontFamily: FONT.regular,
          }}
        >
          {REFERRAL_PROGRAM_READ_ONLY_NOTE}
        </Text>
      )}
    </View>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{ marginTop: 8 }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {value}
      </Text>
    </View>
  );
}
