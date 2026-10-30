/**
 * CohortFunnelDetail — the per-cohort table under the funnel bars, and the
 * tag-audience filter that scopes it.
 *
 * The bars above answer "how many of everyone who ever joined went on to buy".
 * They cannot answer the question that actually changes a decision: "is the
 * cohort we acquired last month converting worse than the one before it".
 * Desktop has had that table since SUB-128 (CohortFunnelCard.tsx); the phone
 * had the aggregate only, because `parseSubscriberFunnel` counts the `cohorts`
 * array and throws it away.
 *
 * WHY IT OWNS ITS OWN QUERY. The screen's funnel query is unscoped and keeps
 * only `steps`, so this section has to fetch the payload anyway — and once the
 * audience filter exists it needs a query key that includes the audience.
 * Owning the query keeps the mount inside FunnelSection one line, and keeps a
 * failed tag catalogue (a different scope: `read:subscribers`) from taking the
 * funnel down with it.
 *
 * NOT A GRID. Five columns of numbers on a 390pt screen is four columns of
 * truncation. Each cohort is a block: the month and its signups on one line,
 * then one line per purchase stage carrying BOTH the count and the rate's own
 * denominator, because the two rates in this payload are measured against
 * different things (signups, then first-purchasers).
 *
 * NativeWind v4: every style object here is static (house rule 1); the only
 * Pressables are the ChipRow's own.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";

import { ChipRow } from "@/components/ChipRow";
import { QueryStates } from "@/components/QueryStates";
import { SkeletonCard } from "@/components/Skeleton";
import { fetchCohortFunnel } from "@/api/cohortFunnel";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useTagCatalogue } from "@/hooks/useTagCatalogue";
import {
  ALL_SUBSCRIBERS,
  COHORT_MATURITY_NOTE,
  audienceOptions,
  cohortCell,
  cohortFunnelEmptyCopy,
  cohortRate,
  cohortRowSpoken,
  cohortScopeSummary,
  type CohortFunnelRow,
  type CohortFunnelView,
} from "@/lib/cohortFunnel";
import { FONT } from "@/lib/fonts";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

const EMPTY_VIEW: CohortFunnelView = { rows: [], stages: [] };

export function CohortFunnelDetail({ months }: { months: number }) {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  const [audienceId, setAudienceId] = useState<string>(ALL_SUBSCRIBERS);

  const query = useQuery({
    queryKey: ["analytics-cohort-funnel", gate.tenantId, months, audienceId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    // Signup-month cohorts move once a month; re-running a twelve-cohort
    // commerce join on the screen's 5-minute window would cost a real query
    // for a figure that cannot have changed.
    staleTime: 60 * 60_000,
    queryFn: () => fetchCohortFunnel(months, audienceId),
  });

  // The tag catalogue is a DIFFERENT scope (`read:subscribers`, manifest) than
  // the funnel (`read:reports`), so a report-only session can read the table
  // and not the filter. That is a missing control, not a broken card: the
  // chips simply do not render, and the table stays scoped to everyone.
  const tags = useTagCatalogue();
  const options = audienceOptions(tags.data?.rows);
  const view = query.data ?? EMPTY_VIEW;
  const scopeLine = cohortScopeSummary(view, audienceId);

  return (
    <View style={{ marginTop: 4, gap: 10 }}>
      <Text
        accessibilityRole="header"
        {...typeCap("label")}
        style={{
          color: t.fg,
          fontFamily: FONT.bold,
          ...typeStyle("label"),
        }}
      >
        By signup cohort
      </Text>

      {options.length > 1 ? (
        <ChipRow
          accessibilityLabel="Scope the funnel to a tagged audience"
          options={options}
          value={audienceId}
          onChange={setAudienceId}
          paddingHorizontal={0}
        />
      ) : null}

      <QueryStates
        query={query}
        isEmpty={view.rows.length === 0}
        gate={gate}
        skeleton={<SkeletonCard lines={3} />}
        empty={{
          title: "No cohorts yet",
          description: cohortFunnelEmptyCopy(audienceId, months),
        }}
      >
        <View style={{ gap: 12 }}>
          {scopeLine ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                fontFamily: FONT.regular,
                ...typeStyle("caption"),
              }}
            >
              {scopeLine}
            </Text>
          ) : null}
          {view.rows.map((row) => (
            <CohortBlock key={row.label} row={row} t={t} />
          ))}
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontFamily: FONT.regular,
              ...typeStyle("caption"),
            }}
          >
            {COHORT_MATURITY_NOTE}
          </Text>
        </View>
      </QueryStates>
    </View>
  );
}

/** One cohort: the month and its signups, then one line per purchase stage. */
function CohortBlock({ row, t }: { row: CohortFunnelRow; t: ThemeTokens }) {
  return (
    <View
      accessible
      accessibilityLabel={cohortRowSpoken(row)}
      style={{
        borderTopWidth: 1,
        borderTopColor: t.borderSubtle,
        paddingTop: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 12,
        }}
      >
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            fontFamily: FONT.semibold,
            ...typeStyle("bodySmall"),
          }}
        >
          {row.label}
        </Text>
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgMuted,
            fontFamily: FONT.regular,
            ...typeStyle("caption"),
            fontVariant: ["tabular-nums"],
          }}
        >
          {cohortCell(row.signups)} signups
        </Text>
      </View>
      <StageLine
        t={t}
        label="First purchase"
        count={row.firstPurchases}
        rate={row.firstRatePct}
        denominator="of signups"
      />
      <StageLine
        t={t}
        label="Repeat purchase"
        count={row.repeatPurchases}
        rate={row.repeatRatePct}
        denominator="of first purchasers"
      />
    </View>
  );
}

/**
 * One stage line. The denominator travels with the rate because this payload
 * carries two rates measured against different populations, and a reader who
 * assumes both are against signups overstates the bottom of the funnel.
 */
function StageLine({
  t,
  label,
  count,
  rate,
  denominator,
}: {
  t: ThemeTokens;
  label: string;
  count: number | null;
  rate: number | null;
  denominator: string;
}) {
  return (
    <View
      // Decorative: the block's own accessibilityLabel already speaks every
      // number on this line, with its denominator.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: 12,
        marginTop: 4,
      }}
    >
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fg,
          fontFamily: FONT.regular,
          ...typeStyle("caption"),
          fontVariant: ["tabular-nums"],
        }}
      >
        {cohortCell(count)} · {cohortRate(rate)} {denominator}
      </Text>
    </View>
  );
}
