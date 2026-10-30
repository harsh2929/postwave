/**
 * api/cohortFunnel.ts — the per-cohort, audience-scoped read of
 * `GET /api/v1/analytics/subscribers/funnel` (viewer / `read:reports`,
 * analytics/handlers.go:526).
 *
 * The screen already fetches this endpoint once, unscoped, through
 * `useSubscriberFunnel` — but that parser keeps only the aggregate `steps`.
 * This call exists because the two things the phone could not do were both in
 * the half that parser drops: compare cohorts, and scope to a tagged audience.
 *
 * `checkedApiResult` so a failure REJECTS rather than resolving to an
 * undefined funnel: an empty cohort table and a failed request must not render
 * as the same screen.
 */
import { checkedApiResult, rawRequest } from "@/api/request";
import {
  cohortFunnelPath,
  parseCohortFunnel,
  type CohortFunnelView,
} from "@/lib/cohortFunnel";

export async function fetchCohortFunnel(
  months: number,
  audienceId: string,
): Promise<CohortFunnelView> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", cohortFunnelPath(months, audienceId)),
  );
  return parseCohortFunnel(res.data);
}
