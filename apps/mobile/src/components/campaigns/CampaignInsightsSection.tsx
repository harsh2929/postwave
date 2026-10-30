/**
 * CampaignInsightsSection — the analytics drilldowns the mobile report never
 * had.
 *
 * "How did it do?" stopped at four tiles on a phone. The gateway has always
 * answered six more questions per campaign, every one of which is exactly the
 * kind of thing an operator checks away from a desk:
 *
 *   Top links      GET /campaigns/{id}/link-report   — what people clicked
 *   Mail clients   GET /campaigns/{id}/devices       — where it rendered
 *   Countries      GET /campaigns/{id}/geography     — where it landed
 *   Bounces        GET /campaigns/{id}/bounces       — hard / soft / TRAP
 *   Goal           GET /campaigns/{id}/goal-results  — what it CAUSED
 *   Incremental    GET /campaigns/{id}/holdout/lift  — what it caused vs. not
 *   Activity       GET /audit?resource_type=campaign  — who touched it
 *   Health         GET /campaigns/{id}/health        — is it hurting the domain
 *   Unusual hours  GET /campaigns/{id}/anomalies     — did an hour break away
 *   Honesty        GET /campaigns/{id}/engagement    — how much to believe
 *   Hourly curve   GET /campaigns/{id}/timeseries    — how the send unfolded
 *   By locale      GET /campaigns/{id}/locale-report — which variant worked
 *
 * Bounces is the one that changes behaviour: the report tile shows a single
 * opaque number, and a spam-trap hit hiding inside it is the difference
 * between "some addresses were stale" and "this send damaged the sending
 * domain".
 *
 * Health and Unusual hours lead the section rather than trailing it: both are
 * purpose-built endpoints that, before this, had NO consumer on any client, and
 * both answer "should I stop and look at this?" — a question that has to come
 * before "which links got clicked?".
 *
 * Every card is collapsed until tapped and only then does its query run, so
 * the detail screen costs exactly what it did before.
 */
import { useCallback, useState } from "react";

import { SectionLabel } from "@/components/SectionLabel";
import {
  ActivityBody,
  BounceBody,
  GoalBody,
  HoldoutLiftBody,
} from "@/components/campaigns/CampaignInsightBodies";
import {
  CampaignInsightCard,
  InsightRankedList,
} from "@/components/campaigns/CampaignInsightCard";
import {
  CampaignAnomaliesCard,
  CampaignHealthCard,
} from "@/components/campaigns/CampaignHealthCards";
import { CampaignAISummaryCard } from "@/components/campaigns/CampaignAISummaryCard";
import { CampaignBenchmarkBody } from "@/components/campaigns/CampaignBenchmarkBody";
import { CampaignRepliesBody } from "@/components/campaigns/CampaignRepliesBody";
import { CampaignReplyIntentFilter } from "@/components/campaigns/CampaignReplyIntentFilter";
import { useCampaignActivity } from "@/hooks/useCampaignActivity";
import { useCampaignAiSummary } from "@/hooks/useCampaignAiSummary";
import { useCampaignReplies } from "@/hooks/useCampaignReplies";
import { ReplyClassifySection } from "@/components/campaigns/ReplyClassifySheet";
import { VanityPathsCard } from "@/components/campaigns/VanityPathsCard";
import {
  useCampaignAnomalies,
  useCampaignHealth,
} from "@/hooks/useCampaignHealth";
import {
  useCampaignInsight,
  type CampaignInsightKey,
} from "@/hooks/useCampaignInsight";
import {
  CampaignEngagementOverTimeCard,
  CampaignLocaleReportCard,
} from "@/components/campaigns/CampaignEngagementInsightCards";
import { CampaignHonestEngagementBody } from "@/components/campaigns/CampaignHonestEngagementBody";
import { readHonestEngagement } from "@/lib/campaignHonestEngagement";
import {
  linkRows,
  namedOpenRows,
  readBounces,
  readGoalResults,
  readHoldoutLift,
  type CampaignBounceCounts,
  type CampaignGoalResults,
  type CampaignHoldoutLift,
} from "@/lib/campaignInsights";
import { parseCampaignBenchmark } from "@/lib/campaignBenchmark";
import { readCampaignReplies } from "@/lib/campaignReplies";
import { useTheme } from "@/lib/theme";

export interface CampaignInsightsSectionProps {
  campaignId: string;
  /** Hidden entirely for a campaign that has never sent — there is no data. */
  hasSent: boolean;
  /**
   * Write access. Only the summary's regenerate needs it — every other card
   * here is a pure read — but regenerate triggers a paid model round trip, so
   * a viewer must not be offered it.
   */
  canMutate: boolean;
  /** Why writes are unavailable, when they are. */
  mutateBlockedReason?: string | undefined;
}

export function CampaignInsightsSection({
  campaignId,
  hasSent,
  canMutate,
  mutateBlockedReason,
}: CampaignInsightsSectionProps) {
  const { t } = useTheme();
  type PanelKey =
    | CampaignInsightKey
    | "activity"
    | "health"
    | "anomalies"
    | "aiSummary"
    | "replies";
  const [open, setOpen] = useState<PanelKey | null>(null);
  const toggle = useCallback(
    (key: PanelKey) => setOpen((prev) => (prev === key ? null : key)),
    [],
  );

  const links = useCampaignInsight<unknown>("links", campaignId, {
    enabled: open === "links",
  });
  const devices = useCampaignInsight<unknown>("devices", campaignId, {
    enabled: open === "devices",
  });
  const geography = useCampaignInsight<unknown>("geography", campaignId, {
    enabled: open === "geography",
  });
  const bounces = useCampaignInsight<CampaignBounceCounts>(
    "bounces",
    campaignId,
    { enabled: open === "bounces" },
  );
  const goal = useCampaignInsight<CampaignGoalResults>("goal", campaignId, {
    enabled: open === "goal",
  });
  const benchmark = useCampaignInsight<unknown>("benchmark", campaignId, {
    enabled: open === "benchmark",
  });
  const lift = useCampaignInsight<CampaignHoldoutLift>(
    "holdoutLift",
    campaignId,
    { enabled: open === "holdoutLift" },
  );
  const engagement = useCampaignInsight<unknown>("engagement", campaignId, {
    enabled: open === "engagement",
  });
  const hourly = useCampaignInsight<unknown>("timeseries", campaignId, {
    enabled: open === "timeseries",
  });
  const localeReport = useCampaignInsight<unknown>("localeReport", campaignId, {
    enabled: open === "localeReport",
  });

  const activity = useCampaignActivity(campaignId, {
    enabled: open === "activity",
  });
  const health = useCampaignHealth(campaignId, { enabled: open === "health" });
  const anomalies = useCampaignAnomalies(campaignId, {
    enabled: open === "anomalies",
  });
  const aiSummary = useCampaignAiSummary(campaignId, {
    enabled: open === "aiSummary",
  });
  const replies = useCampaignReplies(campaignId, {
    enabled: open === "replies",
  });

  if (!hasSent) return null;

  const linkList = linkRows(links.data);
  const deviceList = namedOpenRows(devices.data, "client");
  const geoList = namedOpenRows(geography.data, "country");
  const bounceReading = readBounces(bounces.data);
  const goalReading = readGoalResults(goal.data);
  const benchmarkReading = parseCampaignBenchmark(benchmark.data);
  const liftReading = readHoldoutLift(lift.data);
  const repliesReading = readCampaignReplies(replies.data);
  const engagementReading = readHonestEngagement(engagement.data);

  return (
    <>
      <SectionLabel>Insights</SectionLabel>

      {/*
        First in the section, and deliberately above Health: it is the only
        card here that answers "how did it go?" in a sentence instead of a
        table, which on a phone is the whole point. The tables below stay for
        when the sentence prompts a question.
      */}
      <CampaignAISummaryCard
        state={aiSummary}
        expanded={open === "aiSummary"}
        onToggle={() => toggle("aiSummary")}
        canRegenerate={canMutate}
        {...(mutateBlockedReason ? { blockedReason: mutateBlockedReason } : {})}
      />

      <CampaignHealthCard
        query={health}
        expanded={open === "health"}
        onToggle={() => toggle("health")}
      />

      <CampaignAnomaliesCard
        query={anomalies}
        expanded={open === "anomalies"}
        onToggle={() => toggle("anomalies")}
      />

      {/* Beside Health and Anomalies rather than among the tables below: those
          three are the cards that pass a JUDGEMENT on the send. The baseline
          here is this workspace's own last 90 days, not a published industry
          average — the only comparison that means anything when every tenant's
          audience is different. */}
      <CampaignInsightCard
        title="Against your baseline"
        caption="How this campaign compares with this workspace's own recent sends."
        expanded={open === "benchmark"}
        onToggle={() => toggle("benchmark")}
        loading={benchmark.isLoading}
        error={benchmark.error}
        onRetry={() => void benchmark.refetch()}
        empty={benchmark.data == null}
        emptyMessage="This workspace doesn't expose campaign benchmarks."
      >
        <CampaignBenchmarkBody benchmark={benchmarkReading} t={t} />
      </CampaignInsightCard>

      {/* Beside the judgement cards on purpose: this is the one that says how
          much of the headline open rate to BELIEVE — the machine share, the
          AI-surfacing estimate with its confidence, and the conversions that
          arrived without any open at all. A reviewer sharing results from a
          phone needs the caveat in the same card as the number. */}
      <CampaignInsightCard
        title="Honest engagement"
        caption="How much of the open rate to believe: human vs raw opens, the machine share, and the AI-surfacing estimate."
        expanded={open === "engagement"}
        onToggle={() => toggle("engagement")}
        loading={engagement.isLoading}
        error={engagement.error}
        onRetry={() => void engagement.refetch()}
        empty={engagement.data == null}
        emptyMessage="This workspace doesn't expose the engagement trust panel."
      >
        <CampaignHonestEngagementBody view={engagementReading} t={t} />
      </CampaignInsightCard>

      <CampaignEngagementOverTimeCard
        query={hourly}
        expanded={open === "timeseries"}
        onToggle={() => toggle("timeseries")}
      />

      <CampaignInsightCard
        title="Top links"
        caption="The destinations recipients actually clicked, ranked."
        expanded={open === "links"}
        onToggle={() => toggle("links")}
        loading={links.isLoading}
        error={links.error}
        onRetry={() => void links.refetch()}
        empty={linkList.length === 0}
        emptyMessage="No link clicks have been recorded for this campaign."
      >
        <InsightRankedList rows={linkList} />
      </CampaignInsightCard>

      <CampaignInsightCard
        title="Mail clients"
        caption="Where the email was opened. Apple Mail counts include privacy-protection opens."
        expanded={open === "devices"}
        onToggle={() => toggle("devices")}
        loading={devices.isLoading}
        error={devices.error}
        onRetry={() => void devices.refetch()}
        empty={deviceList.length === 0}
        emptyMessage="No client information has been recorded for this campaign."
      >
        <InsightRankedList rows={deviceList} />
      </CampaignInsightCard>

      <CampaignInsightCard
        title="Countries"
        expanded={open === "geography"}
        onToggle={() => toggle("geography")}
        loading={geography.isLoading}
        error={geography.error}
        onRetry={() => void geography.refetch()}
        empty={geoList.length === 0}
        emptyMessage="No geography has been recorded for this campaign."
      >
        <InsightRankedList rows={geoList} />
      </CampaignInsightCard>

      {/* After Countries: both slice the same opens by a recipient attribute.
          CampaignTranslationsCard covers per-locale CONTENT and fallbacks;
          this is the per-locale PERFORMANCE those translations earned. */}
      <CampaignLocaleReportCard
        query={localeReport}
        expanded={open === "localeReport"}
        onToggle={() => toggle("localeReport")}
      />

      <CampaignInsightCard
        title="Bounce breakdown"
        caption="A hard bounce and a soft bounce demand different responses; the report tile shows only their sum."
        expanded={open === "bounces"}
        onToggle={() => toggle("bounces")}
        loading={bounces.isLoading}
        error={bounces.error}
        onRetry={() => void bounces.refetch()}
        empty={bounces.data == null || bounceReading.clean}
        emptyMessage="No bounces were recorded for this campaign."
      >
        <BounceBody reading={bounceReading} t={t} />
      </CampaignInsightCard>

      {/* Directly after the bounce breakdown: both read the inbound side of a
          send, and a reply is the one signal here written by a person. */}
      <CampaignInsightCard
        title="Replies"
        caption="What recipients wrote back. Newest first, most recent 50."
        expanded={open === "replies"}
        onToggle={() => toggle("replies")}
        loading={replies.isLoading}
        error={replies.error}
        onRetry={() => void replies.refetch()}
        empty={replies.data == null || repliesReading.empty}
        emptyMessage="No replies have been recorded for this campaign."
      >
        <CampaignRepliesBody reading={repliesReading} t={t} />
        {/* Chips over the id-bearing list (?intent=), so a 200-reply thread
            can be narrowed to just the questions. Viewer-scope. */}
        <CampaignReplyIntentFilter
          campaignId={campaignId}
          enabled={open === "replies"}
        />
        {/* The rollup above cannot address a reply; this reads the id-bearing
            list so intent can actually be set. */}
        <ReplyClassifySection campaignId={campaignId} />
      </CampaignInsightCard>

      <VanityPathsCard campaignId={campaignId} />

      <CampaignInsightCard
        title="Conversion goal"
        expanded={open === "goal"}
        onToggle={() => toggle("goal")}
        loading={goal.isLoading}
        error={goal.error}
        onRetry={() => void goal.refetch()}
        empty={goal.data == null}
        emptyMessage="This workspace doesn't expose campaign goal results."
      >
        <GoalBody reading={goalReading} t={t} />
      </CampaignInsightCard>

      <CampaignInsightCard
        title="Activity"
        caption="Who changed this campaign, and when."
        expanded={open === "activity"}
        onToggle={() => toggle("activity")}
        loading={activity.isLoading}
        error={activity.error}
        onRetry={() => void activity.refetch()}
        empty={(activity.data?.length ?? 0) === 0}
        emptyMessage="No recorded activity for this campaign yet."
      >
        <ActivityBody rows={Array.isArray(activity.data) ? activity.data : []} t={t} />
      </CampaignInsightCard>

      <CampaignInsightCard
        title="Incremental lift"
        caption="The difference between the group that received this and a randomly held-out group — what the send actually caused."
        expanded={open === "holdoutLift"}
        onToggle={() => toggle("holdoutLift")}
        loading={lift.isLoading}
        error={lift.error}
        onRetry={() => void lift.refetch()}
        empty={lift.data == null}
        emptyMessage="No holdout was configured for this campaign, so incremental lift can't be measured. Set one up on the web app before the next send."
      >
        <HoldoutLiftBody reading={liftReading} t={t} />
      </CampaignInsightCard>
    </>
  );
}
