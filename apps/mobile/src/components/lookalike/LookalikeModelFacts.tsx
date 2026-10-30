/**
 * LookalikeModelFacts — what the model was built FROM, and the two facts about
 * it that are easiest to get wrong.
 *
 * Split from LookalikeDetailSheet so neither file grows past the 450-line
 * source budget, and because the seam is real: the sheet owns the frame and the
 * member reveal, this owns the standing description of the model.
 *
 * FACT ONE: THE POOLS ARE CAPPED, AND A CAPPED POOL IS A DIFFERENT AUDIENCE.
 * The seed sample stops at 20,000 members and the candidate scan at 50,000
 * subscribers (`LookalikeSeedSampleCap` / `LookalikeCandidatePoolCap`,
 * subscribers/lookalike.go:52-59), both as bare SQL LIMITs with no ordering. In
 * a workspace larger than either, people were never scored at all — and nothing
 * else in the product says so. Only an EXACT match on the cap is reported here;
 * lib/lookalikeHealth explains why anything short of exact cannot be
 * distinguished from a workspace that simply is that size.
 *
 * FACT TWO: "EXPORTED" DOES NOT MEAN DELIVERED. `exported_destination_id` is
 * written by `ExportLookalike`, whose own comment is unambiguous: "It does not
 * start provider delivery; operators use the audience-sync workflow for that
 * separate, observable action" (lookalike.go:322-324). So this panel says the
 * audience is ASSOCIATED with a destination and points at the surface where
 * delivery is actually observable, rather than letting a green "Exported" badge
 * imply an audience reached a platform when nothing has left the building.
 *
 * The destination is named by id, not by name: there is no destination lookup
 * on this surface, and inventing a friendly name for a uuid we did not resolve
 * would be worse than showing the uuid.
 */
import { Text, View } from "react-native";

import { FONT } from "@/lib/fonts";
import { date, EMDASH, num, plural, truncateMiddle } from "@/lib/format";
import { poolTruncation } from "@/lib/lookalikeHealth";
import {
  LOOKALIKE_CANDIDATE_POOL_CAP,
  LOOKALIKE_SEED_SAMPLE_CAP,
  type LookalikeAudience,
} from "@/lib/lookalikeAudiences";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function LookalikeModelFacts({
  audience,
  seedName,
  settled,
}: {
  audience: LookalikeAudience;
  seedName: string | null;
  settled: boolean;
}) {
  const { t } = useTheme();
  const caps = poolTruncation(audience);

  return (
    <View style={{ gap: 10 }}>
      {audience.error ? (
        <Text
          accessibilityLabel={`The server's reason this model did not build: ${audience.error}`}
          {...typeCap("bodySmall")}
          style={{
            color: t.danger,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {audience.error}
        </Text>
      ) : null}

      <FactLine
        label="Seed segment"
        value={seedName ?? "Not resolved"}
        spoken={
          seedName ??
          "The segments catalogue did not resolve this seed, so its name is unknown here."
        }
      />
      <FactLine
        label="Seed members"
        value={num(audience.seedCount)}
        spoken={
          audience.seedCount === null
            ? "The seed sample size was not recorded."
            : `${plural(audience.seedCount, "seed member")} fed the model.`
        }
      />
      <FactLine
        label="People scored"
        value={num(audience.candidateCount)}
        spoken={
          audience.candidateCount === null
            ? "How many people were scored was not recorded."
            : `${plural(
                audience.candidateCount,
                "non-seed subscriber",
              )} were scored against the seed.`
        }
      />
      <FactLine
        label="Matched"
        value={settled ? num(audience.memberCount) : EMDASH}
        spoken={
          settled
            ? `${plural(audience.memberCount, "person", "people")} ended up in this audience.`
            : "The matched count is not final while the model is unfinished."
        }
      />
      <FactLine
        label="Confidence floor"
        value={
          audience.confidenceThreshold === null
            ? "None"
            : String(audience.confidenceThreshold)
        }
        spoken={
          audience.confidenceThreshold === null
            ? "No confidence floor was set, so everyone the ranker scored was eligible regardless of how weakly they matched."
            : `Candidates below ${audience.confidenceThreshold} similarity were dropped.`
        }
      />
      <FactLine
        label="Built"
        value={audience.createdAt ? date(audience.createdAt) : EMDASH}
        spoken={
          audience.createdAt
            ? `Built ${date(audience.createdAt)}. Nothing re-runs it after that.`
            : "Its build date was not recorded."
        }
      />

      {caps.seedCapped ? (
        <Caution>
          The seed sample hit its {num(LOOKALIKE_SEED_SAMPLE_CAP)} ceiling, so
          the centroid was built from part of the seed segment rather than all
          of it.
        </Caution>
      ) : null}
      {caps.candidatesCapped ? (
        <Caution>
          The candidate pool hit its {num(LOOKALIKE_CANDIDATE_POOL_CAP)}{" "}
          ceiling, so subscribers beyond it were never scored and could not have
          been matched.
        </Caution>
      ) : null}

      <DestinationNote audience={audience} />

      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        {audience.featureDims.length > 0
          ? `Modelled on first-party signals only: ${audience.featureDims.join(", ")}. `
          : "Modelled on first-party signals only. "}
        No third-party cookies or data brokers are involved.
        {audience.dataUseNoticeVersion
          ? ` Data-use notice on record: ${audience.dataUseNoticeVersion}.`
          : ""}
      </Text>
    </View>
  );
}

/** The "exported" flag, described as what it actually is. */
function DestinationNote({ audience }: { audience: LookalikeAudience }) {
  const { t } = useTheme();
  if (!audience.exportedDestinationId) {
    return (
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Not associated with a destination. Delivering a modeled audience
        anywhere is the audience-syncs job, not this one.
      </Text>
    );
  }
  return (
    <Text
      accessibilityLabel={`This audience is associated with destination ${audience.exportedDestinationId}. Association is not delivery: nothing has been sent to that destination by this record alone.`}
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      Associated with destination {truncateMiddle(audience.exportedDestinationId)}
      . That association is not a delivery — nothing has been sent because of it.
      Check Audience syncs to see whether anything actually left.
    </Text>
  );
}

function Caution({ children }: { children: React.ReactNode }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.warning,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

function FactLine({
  label,
  value,
  spoken,
}: {
  label: string;
  value: string;
  spoken: string;
}) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${spoken}`}
      style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
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
          fontFamily: FONT.medium,
          flexShrink: 1,
          textAlign: "right",
        }}
      >
        {value}
      </Text>
    </View>
  );
}
