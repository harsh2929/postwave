/**
 * CampaignListEmpty — the loading / offline / empty / error ladder for the
 * campaign list, in the one order that is correct.
 *
 *   1. ERROR wins over empty. A failed load is never "nothing here".
 *   2. FIRST LOAD shows a skeleton, not the literal string "Loading…".
 *   3. OFFLINE-with-no-cache is its own message; nothing is broken.
 *   4. A filter that may still have matches on unfetched pages shows a
 *      skeleton — but only while the bounded auto-pager is still working.
 *   5. EMPTY only once a fetch genuinely succeeded and returned nothing, and
 *      the workspace-level empty state offers a CTA that actually creates
 *      something (it used to route back to this same screen).
 */
import type { ReactElement } from "react";

import { EMPTY_STATES } from "@postwave/onboarding-schema";

import { CachedSessionNotice } from "@/components/CachedSessionNotice";
import type { CachedSessionNoticeContent } from "@/components/CachedSessionNotice";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { SkeletonList } from "@/components/Skeleton";
import type { CampaignStatusFilter } from "@/lib/campaignStatusFilter";

export interface CampaignListEmptyProps {
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  firstLoad: boolean;
  gateNotice: CachedSessionNoticeContent | null;
  filter: CampaignStatusFilter;
  query: string;
  /** True while the bounded auto-pager is still looking for matches. */
  draining: boolean;
  /** True when the auto-pager stopped at its ceiling with nothing found. */
  capped: boolean;
  autoPageLimit: number;
  onLoadMore: () => void;
  canCreate: boolean;
  onCreate: () => void;
}

const CAMPAIGNS_EMPTY_STATE = EMPTY_STATES["campaigns"];

function filterNoun(filter: CampaignStatusFilter): string {
  return filter === "attention"
    ? "campaigns needing attention"
    : `${filter} campaigns`;
}

export function CampaignListEmpty(props: CampaignListEmptyProps): ReactElement {
  if (props.isError) {
    return <ErrorState error={props.error} onRetry={props.onRetry} />;
  }
  if (props.firstLoad) {
    return <SkeletonList rows={6} />;
  }
  if (props.gateNotice) {
    return <CachedSessionNotice notice={props.gateNotice} />;
  }
  if (props.draining) {
    return <SkeletonList rows={3} />;
  }
  if (props.capped) {
    return (
      <EmptyState
        title={`No ${filterNoun(props.filter)} in the first ${props.autoPageLimit} pages`}
        description="There are more campaigns to search. Load the next pages, or narrow the search instead."
        cta={{ label: "Load more results", onPress: props.onLoadMore }}
      />
    );
  }
  if (props.filter !== "all" || props.query.trim().length > 0) {
    return (
      <EmptyState
        title={
          props.query.trim()
            ? `No campaigns match "${props.query.trim()}"`
            : `No ${filterNoun(props.filter)}`
        }
        description="Try a different status or clear the search to see everything."
      />
    );
  }
  // This is the one shared list CTA whose mobile route performs the verb it
  // names: `campaigns.new` arrives as `?new=1`, and the campaigns screen opens
  // its native create sheet. Keep the rich CTA behind the same mutation gate
  // as the header action so a viewer never receives a control that will 403.
  if (props.canCreate && CAMPAIGNS_EMPTY_STATE) {
    return <EmptyState content={CAMPAIGNS_EMPTY_STATE} />;
  }
  return (
    <EmptyState
      title="No campaigns yet"
      description="Create your first campaign, add a body on the web app, then send it from here."
      {...(props.canCreate
        ? { cta: { label: "Create a campaign", onPress: props.onCreate } }
        : {})}
    />
  );
}
