/**
 * SubjectEvidencePanel — what has ACTUALLY worked on this list, per subject
 * attribute, over the last 180 days.
 *
 * GET /api/v1/subject-analyzer/buckets is `read:reports` at the mount site
 * (subject_analyzer.go:99) and `"session_minimum_role": "viewer"` in
 * routeauth/manifest.json, so this is the half of the Subject Lab that every
 * signed-in member may read — which is why it is a separate panel from the
 * admin-only scorer rather than a section inside it.
 *
 * The rollup is an average of per-campaign open rates within a bucket. That is
 * an observational comparison, not an experiment: a workspace that only sends
 * short subjects during sales will find "short subjects win". The panel says
 * how many campaigns each row rests on and refuses to draw a conclusion from a
 * bucket thinner than the scorer's own n>=5 confidence floor.
 */
import { Text, View } from "react-native";

import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Pill } from "@/components/Pill";
import { SkeletonCard } from "@/components/Skeleton";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useSubjectBuckets } from "@/hooks/useSubjectLab";
import {
  subjectBucketTakeaway,
  type SubjectBucketGroup,
} from "@/lib/subjectLab";

export function SubjectEvidencePanel({ offline }: { offline: boolean }) {
  const { t } = useTheme();
  const query = useSubjectBuckets({ enabled: !offline });
  const reading = query.data ?? null;

  return (
    <Card style={{ gap: 10 }}>
      <Text
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "500",
          fontFamily: FONT.medium,
        }}
      >
        What works for your list
      </Text>

      {offline ? (
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgMuted,
            ...typeStyle("label"),
            fontFamily: FONT.regular,
          }}
        >
          Reconnect to read your subject-line history.
        </Text>
      ) : query.isLoading ? (
        <SkeletonCard lines={3} />
      ) : query.isError ? (
        <ErrorState
          compact
          error={query.error}
          message="Couldn't read your subject-line history."
          onRetry={() => void query.refetch()}
        />
      ) : !reading || reading.groups.length === 0 ? (
        <EmptyState
          title="Nothing measured yet"
          description="Moosewave compares your own sent campaigns by subject-line shape. Once a few have gone out with open tracking, the patterns show up here."
        />
      ) : (
        <View style={{ gap: 14 }}>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {`${plural(reading.campaignsTotal, "campaign")} with open data over the last ${
              reading.windowDays ?? 180
            } days.`}
          </Text>
          {reading.insufficient ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.warning,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              That is too little history to read as a pattern. Treat everything
              below as an anecdote until you have sent more.
            </Text>
          ) : null}
          {/* The null check guards `reading`, not its groups array. */}
          {(Array.isArray(reading.groups) ? reading.groups : []).map((group) => (
            <BucketGroup key={group.attribute} group={group} />
          ))}
        </View>
      )}
    </Card>
  );
}

function BucketGroup({ group }: { group: SubjectBucketGroup }) {
  const { t } = useTheme();
  const takeaway = subjectBucketTakeaway(group);
  return (
    <View style={{ gap: 6 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fg,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        {group.question}
      </Text>
      {/* A row field off the wire: guard it, not just its parent. */}
      {(Array.isArray(group.rows) ? group.rows : []).map((row) => (
        <View
          key={row.key}
          accessible
          accessibilityLabel={`${row.label}: ${row.openLabel} open rate, ${row.clickLabel} click rate, across ${plural(
            row.campaigns,
            "campaign",
          )}.`}
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
        >
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.regular,
              flex: 1,
            }}
            numberOfLines={1}
          >
            {row.label}
          </Text>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fg,
              ...typeStyle("bodySmall"),
              fontFamily: FONT.semibold,
              fontVariant: ["tabular-nums"],
            }}
          >
            {row.openLabel}
          </Text>
          <Pill label={`n=${row.campaigns}`} tone="neutral" size="sm" />
        </View>
      ))}
      {takeaway ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {takeaway}
        </Text>
      ) : null}
    </View>
  );
}
