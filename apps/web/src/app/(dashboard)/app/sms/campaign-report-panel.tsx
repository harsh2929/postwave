import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { asRoute } from "@/lib/typed-routes";
import {
  listSmsCampaignVariants,
  type SmsCampaignReport,
  type SmsCampaignVariantStat,
} from "@/lib/sms-api";
import {
  formatDateTime,
  formatMicrosAggregate,
  formatPercent,
} from "./page-helpers";

// SMS-036: self-fetching per-variant A/B results. Renders nothing for
// single-body campaigns (empty variant list).
function SmsVariantResults({ campaignId }: { campaignId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error" }
    | { kind: "ready"; variants: SmsCampaignVariantStat[] }
  >({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    listSmsCampaignVariants(campaignId, controller.signal)
      .then((variants) => {
        if (!controller.signal.aborted) setState({ kind: "ready", variants });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: "error" });
      });
    return () => {
      controller.abort();
    };
  }, [attempt, campaignId]);

  if (state.kind === "loading") {
    return (
      <p
        role="status"
        className="mt-4 rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground"
      >
        Loading A/B variant results…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <div
        role="alert"
        className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
      >
        <span>
          A/B variant results could not be verified. This campaign has not been
          treated as a single-body campaign.
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Retry
        </Button>
      </div>
    );
  }
  const variants = state.variants;
  if (variants.length === 0) return null;
  // The winning variant by send-success is the highest sent count.
  const topSent = Math.max(...variants.map((v) => v.sent));
  return (
    <div className="mt-4 rounded-md border bg-background">
      <div className="border-b px-3 py-2 text-sm font-medium">
        A/B variant results
      </div>
      <div className="divide-y">
        {variants.map((v) => (
          <div
            key={v.variant}
            className="grid gap-2 px-3 py-2 text-xs sm:grid-cols-[auto_1fr] sm:items-center"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium">Variant {v.variant}</span>
              {v.sent === topSent && topSent > 0 ? (
                <span className="rounded bg-success-subtle px-1.5 py-0.5 text-success-emphasis">
                  Leading
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 tabular-nums text-muted-foreground sm:justify-end">
              <span>{v.total} assigned</span>
              <span>{v.sent} sent</span>
              <span>{v.failed} failed</span>
              <span>{v.blocked} blocked</span>
              <span>{v.segments} segments</span>
              <span>{formatMicrosAggregate(v.cost_micros)}</span>
            </div>
          </div>
        ))}
      </div>
      <p className="px-3 py-2 text-xs text-muted-foreground">
        Split is by send success; delivery/click winner automation is not yet
        wired.
      </p>
    </div>
  );
}

export function CampaignReportPanel({
  dispatchAvailable = true,
  report,
  onRetryFailed,
  retrying,
}: {
  dispatchAvailable?: boolean;
  report: SmsCampaignReport;
  onRetryFailed?: () => void | Promise<void>;
  retrying?: boolean;
}) {
  const failedCount = report.failed + report.undelivered;
  const deliveryRate = report.sent > 0 ? report.delivered / report.sent : 0;
  const clickRate = report.delivered > 0 ? report.clicks / report.delivered : 0;
  const metrics = [
    ["Queued", report.queued],
    ["Sending", report.sending],
    ["Sent", report.sent],
    ["Delivered", report.delivered],
    ["Blocked", report.blocked],
    ["Failed", report.failed + report.undelivered],
    ["Cancelled", report.cancelled],
    ["Clicks", report.clicks],
    ["Clickers", report.unique_clickers],
  ] as const;
  const topLinks = report.link_clicks ?? [];
  const recentClicks = report.recent_clicks ?? [];

  return (
    <div className="mt-3 rounded-md bg-muted/40 p-3">
      <div className="grid gap-2 sm:grid-cols-4">
        {metrics.map(([label, value]) => (
          <div key={label} className="rounded-md border bg-background p-2">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-lg font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-4">
        <div>Recipients: {report.recipients}</div>
        <div>Segments: {report.segments}</div>
        <div>Delivery rate: {formatPercent(deliveryRate)}</div>
        <div>Click rate: {formatPercent(clickRate)}</div>
        <div>Estimated cost: {formatMicrosAggregate(report.cost_micros)}</div>
      </div>
      {onRetryFailed && failedCount > 0 ? (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning-emphasis">
          <span>
            {failedCount.toLocaleString()} recipient
            {failedCount === 1 ? "" : "s"} failed or went undelivered.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="bg-background"
            disabled={!dispatchAvailable || retrying}
            onClick={() => void onRetryFailed()}
          >
            {retrying ? "Re-queuing…" : "Retry failed & undelivered"}
          </Button>
        </div>
      ) : null}
      {topLinks.length > 0 || recentClicks.length > 0 ? (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {topLinks.length > 0 ? (
            <div className="rounded-md border bg-background">
              <div className="border-b px-3 py-2 text-sm font-medium">
                Top links
              </div>
              <div className="divide-y">
                {topLinks.slice(0, 5).map((link) => (
                  <div
                    key={link.url}
                    className="grid gap-2 px-3 py-2 text-xs sm:grid-cols-[1fr_auto]"
                  >
                    <div className="min-w-0 break-all text-muted-foreground">
                      {link.url}
                    </div>
                    <div className="flex items-center gap-3 text-right tabular-nums">
                      <span>{link.clicks} clicks</span>
                      <span>{link.unique_clickers} people</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {recentClicks.length > 0 ? (
            <div className="rounded-md border bg-background">
              <div className="border-b px-3 py-2 text-sm font-medium">
                Recent clicks
              </div>
              <div className="divide-y">
                {recentClicks.slice(0, 5).map((click) => (
                  <div
                    key={`${click.phone_e164}-${click.clicked_at}-${click.url}`}
                    className="grid gap-1 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <Link
                        href={asRoute(
                          `/app/subscribers?q=${encodeURIComponent(click.phone_e164)}`,
                        )}
                        className="font-medium tabular-nums text-primary underline-offset-2 hover:underline"
                        title="Find this subscriber"
                      >
                        {click.phone_e164}
                      </Link>
                      <span className="text-muted-foreground">
                        {formatDateTime(click.clicked_at)}
                      </span>
                    </div>
                    <div className="min-w-0 break-all text-muted-foreground">
                      {click.url}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <SmsVariantResults campaignId={report.campaign.id} />
    </div>
  );
}
