/**
 * CampaignPerformanceSection — the post-send numbers.
 *
 * Three problems this fixes, all on the same block:
 *
 *  1. THE PHONE DISAGREED WITH THE DESK. The Go report ships nine `human_*`
 *     fields specifically because Apple Mail Privacy Protection inflates opens
 *     25–40%, and desktop's engagement toggle DEFAULTS to "human". Mobile
 *     rendered only the raw fields, so the same campaign showed a different
 *     open rate on the two clients. The toggle here defaults to Human to match
 *     — but ONLY when the server proves it actually stripped something. Those
 *     fields are always on the wire and are all zero unless the backend flag
 *     POSTWAVE_HUMAN_ENGAGEMENT is on (it is off by default), so defaulting to
 *     them blindly renders "0.0% open rate" for every sent campaign. The
 *     evidence gate lives in src/lib/campaignEngagement.ts and is tested there.
 *  2. A FAILED FETCH READ AS A PRODUCT LIMITATION. `report.isError || r == null`
 *     collapsed two different worlds into "Detailed report not available",
 *     with no retry — so a timeout looked like "your deployment has no
 *     analytics". useCampaignReport returns null ONLY for 404/405/501; every
 *     other failure now gets an ErrorState with a Retry.
 *  3. A DRAFT LOOKED BROKEN. An unsent campaign rendered four em-dash tiles
 *     followed by "Detailed report not available" — on the one screen where a
 *     new user most needs reassurance.
 */
import { useState } from "react";
import { Text, View } from "react-native";

import { ErrorState } from "@/components/ErrorState";
import { SegmentedControl } from "@/components/SegmentedControl";
import { StatCard } from "@/components/StatCard";
import { Card, StatRow } from "@/components/campaigns/CampaignDetailControls";
import {
  campaignCount,
  campaignRate,
  type CampaignRateScale,
} from "@/lib/campaignFormat";
import type { CampaignReport } from "@/hooks/useCampaigns";
import {
  effectiveEngagementMode,
  engagementCaption,
  engagementFigures,
  hasHumanEngagement,
  reportRates,
  type EngagementMode,
} from "@/lib/campaignEngagement";
import { exact } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

/**
 * GET /api/v1/campaigns/{id}/report builds every rate through
 * apps/api/internal/analytics/analytics.go:1460 `pct`, which ends
 * `/ float64(denom) * 100.0` — these arrive ALREADY SCALED. The list endpoint
 * one screen back ships 0..1 fractions instead, which is why the scale is
 * declared rather than guessed from magnitude: a report open_rate of 1.0 means
 * one percent, and used to render as "100.0%".
 */
const REPORT_RATE_SCALE: CampaignRateScale = "percent";

export interface CampaignPerformanceSectionProps {
  report: CampaignReport | null | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** True when the campaign has never sent — metrics do not exist yet. */
  isDraft: boolean;
}

export function CampaignPerformanceSection({
  report,
  loading,
  error,
  onRetry,
  isDraft,
}: CampaignPerformanceSectionProps) {
  const { t } = useTheme();
  // Default "human" so this client agrees with the desktop by default. The
  // PREFERENCE is what the toggle writes; what actually gets rendered is the
  // effective mode, which falls back to raw when the server shipped no
  // stripped counts (see src/lib/campaignEngagement.ts).
  const [preferredMode, setPreferredMode] = useState<EngagementMode>("human");

  const sectionLabel = (
    <Text
      {...typeCap("caption")}
      accessibilityRole="header"
      style={{
        color: t.fgMuted,
        fontSize: 11,
        letterSpacing: 0.6,
        fontWeight: "600",
        fontFamily: FONT.semibold,
        textTransform: "uppercase",
        marginTop: 20,
        marginBottom: 8,
      }}
    >
      Performance
    </Text>
  );

  // An unsent draft has no metrics — say so once, plainly.
  if (isDraft && !report && !loading) {
    return (
      <>
        {sectionLabel}
        <Card>
          <Text
            {...typeCap("bodySmall")}
            style={{
              color: t.fgMuted,
              fontSize: 13,
              lineHeight: 19,
              fontFamily: FONT.regular,
            }}
          >
            Performance metrics appear after the campaign sends.
          </Text>
        </Card>
      </>
    );
  }

  // A real failure is not "this feature doesn't exist". Give it a retry.
  if (error) {
    return (
      <>
        {sectionLabel}
        <ErrorState
          compact
          error={error}
          message="Couldn't load this campaign's report."
          onRetry={onRetry}
        />
      </>
    );
  }

  const human = hasHumanEngagement(report);
  const mode = effectiveEngagementMode(report, preferredMode);
  const e = engagementFigures(report, mode);
  // Click-to-open, bounce rate and unsubscribe rate were on the wire and typed
  // on `CampaignReport` but rendered nowhere on the phone, so the desk showed
  // three numbers the phone did not. `reportRates` reconstructs the server's
  // own denominator guards, so a rate the server could not compute reads as an
  // em-dash rather than as a confident 0.0%.
  const rates = reportRates(report, e);

  return (
    <>
      {sectionLabel}

      {human ? (
        <View style={{ marginBottom: 8 }}>
          <SegmentedControl<EngagementMode>
            options={[
              { value: "human", label: "Human" },
              { value: "raw", label: "Raw" },
            ]}
            value={mode}
            onChange={setPreferredMode}
            accessibilityLabel="Engagement measurement"
          />
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              fontSize: 11,
              lineHeight: 15,
              marginTop: 6,
              fontFamily: FONT.regular,
            }}
          >
            {engagementCaption(report, mode)}
          </Text>
        </View>
      ) : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <View style={{ flexBasis: "48%", flexGrow: 1 }}>
          <StatCard
            label="Sent"
            value={campaignCount(report?.sent)}
            exact={exact(report?.sent, "sent")}
            loading={loading}
          />
        </View>
        <View style={{ flexBasis: "48%", flexGrow: 1 }}>
          <StatCard
            label="Open rate"
            value={campaignRate(e.openRate, { scale: REPORT_RATE_SCALE })}
            loading={loading}
          />
        </View>
        <View style={{ flexBasis: "48%", flexGrow: 1 }}>
          <StatCard
            label="Click rate"
            value={campaignRate(e.clickRate, { scale: REPORT_RATE_SCALE })}
            loading={loading}
          />
        </View>
        <View style={{ flexBasis: "48%", flexGrow: 1 }}>
          <StatCard
            label="Bounces"
            value={campaignCount(report?.bounces)}
            exact={exact(report?.bounces, "bounces")}
            loading={loading}
          />
        </View>
      </View>

      {report ? (
        <View
          style={{
            backgroundColor: t.surface,
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 4,
            marginTop: 8,
          }}
        >
          <StatRow
            label="Delivered"
            value={campaignCount(report.delivered)}
            t={t}
          />
          <StatRow
            label={mode === "human" ? "Unique opens (human)" : "Unique opens"}
            value={campaignCount(e.uniqueOpens)}
            t={t}
          />
          <StatRow
            label={mode === "human" ? "Unique clicks (human)" : "Unique clicks"}
            value={campaignCount(e.uniqueClicks)}
            t={t}
          />
          <StatRow
            label="Unsubscribes"
            value={campaignCount(report.unsubscribes)}
            t={t}
          />
          <StatRow
            label="Complaints"
            value={campaignCount(report.complaints)}
            t={t}
          />
          {/* The three rates the report has always carried and the phone has
              never shown. Click-to-open sits first because it is the only one
              of the three that measures the CONTENT rather than the list: a
              campaign with a weak subject and a strong body has a low open
              rate and a high click-to-open. */}
          <StatRow
            label={
              mode === "human" ? "Click-to-open (human)" : "Click-to-open"
            }
            value={campaignRate(rates.clickToOpen, {
              scale: REPORT_RATE_SCALE,
            })}
            t={t}
          />
          <StatRow
            label="Bounce rate"
            value={campaignRate(rates.bounce, { scale: REPORT_RATE_SCALE })}
            t={t}
          />
          <StatRow
            label="Unsubscribe rate"
            value={campaignRate(rates.unsub, { scale: REPORT_RATE_SCALE })}
            t={t}
            last
          />
        </View>
      ) : null}

      {!loading && !report ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontSize: 11,
            marginTop: 8,
            fontFamily: FONT.regular,
          }}
        >
          Detailed reporting isn&apos;t available on this workspace.
        </Text>
      ) : null}
    </>
  );
}
