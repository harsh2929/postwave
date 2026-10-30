// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { Activity, BarChart3, Languages, Link2 } from "lucide-react";

import { asRoute } from "@/lib/typed-routes";

import { CampaignDetailClientLoader } from "./campaign-detail-client-loader";

const DRILL_DOWN_LINK_CLASS =
  "inline-flex min-h-11 items-center gap-2 rounded-md border border-input px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-9";

/**
 * The campaign workspace, plus the entry points to its four drill-downs: the
 * analytics report (`./analytics`), the per-locale variant matrix
 * (`./translations`), activity & insights (`./activity` — performance,
 * AI summary, web version, feedback, replies, remix, audit trail), and UTM
 * tracking (`./utm` — this campaign's UTM override and link preview). The links
 * live on the route entry rather than inside the detail client so they are
 * present while the editor is still loading — each drill-down is reachable
 * even when the campaign body is not.
 */
export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <div className="mx-auto flex max-w-5xl flex-wrap justify-end gap-2 px-4 pt-4 sm:px-6 sm:pt-6 lg:px-8 lg:pt-8">
        <Link
          href={`/app/campaigns/${encodeURIComponent(id)}/translations`}
          className={DRILL_DOWN_LINK_CLASS}
        >
          <Languages className="h-4 w-4" aria-hidden />
          Languages
        </Link>
        <Link
          href={`/app/campaigns/${encodeURIComponent(id)}/analytics`}
          className={DRILL_DOWN_LINK_CLASS}
        >
          <BarChart3 className="h-4 w-4" aria-hidden />
          Analytics report
        </Link>
        <Link
          // A new route: typed-route generation has not seen it yet.
          href={asRoute(`/app/campaigns/${encodeURIComponent(id)}/activity`)}
          className={DRILL_DOWN_LINK_CLASS}
        >
          <Activity className="h-4 w-4" aria-hidden />
          Activity &amp; insights
        </Link>
        <Link
          // A new route: typed-route generation has not seen it yet.
          href={asRoute(`/app/campaigns/${encodeURIComponent(id)}/utm`)}
          className={DRILL_DOWN_LINK_CLASS}
        >
          <Link2 className="h-4 w-4" aria-hidden />
          UTM tracking
        </Link>
      </div>
      <CampaignDetailClientLoader />
    </>
  );
}
