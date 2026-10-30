// SPDX-License-Identifier: AGPL-3.0-only
//
// F12 — the human-engaged reach floor, on screen.
//
// The API, its OpenAPI contract, and two SDKs have carried this report for a
// while with nothing rendering it, so the number built to replace the open
// rate has been invisible to the people it was built for.
//
// The design rule here is the opposite of a normal metric card. A metric card
// wants one big confident number; this one is only honest as a RANGE, because
// the floor counts recipients we can prove were human and says nothing about
// the ones we could not classify. So the band is rendered at the same weight
// as the floor, the caveats sit above the numbers rather than in a footnote,
// and "no interaction" — usually the largest group — is shown rather than
// folded away to make the other three look like the whole population.

"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Download } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { whoami } from "@/lib/auth-api";
import {
  getHumanEngagedReach,
  humanEngagedReachExportURL,
  reachCaveats,
  reachHeadline,
  reachShare,
  REACH_UNAVAILABLE_MESSAGE,
  type HumanEngagedReach,
} from "@/lib/human-engaged-reach";
import { base, STALE } from "@/lib/query-keys";

const pct = (share: number) => `${(share * 100).toFixed(1)}%`;
const count = (value: number) => value.toLocaleString();

function Bucket({
  label,
  value,
  meaning,
  tone = "default",
}: {
  label: string;
  value: number;
  meaning: string;
  tone?: "default" | "muted";
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div
        className={
          tone === "muted"
            ? "text-lg font-medium text-muted-foreground tabular-nums"
            : "text-lg font-semibold tabular-nums"
        }
      >
        {count(value)}
      </div>
      <div className="text-sm font-medium">{label}</div>
      <p className="mt-1 text-xs text-muted-foreground">{meaning}</p>
    </div>
  );
}

function ReachBody({ report }: { report: HumanEngagedReach }) {
  const caveats = reachCaveats(report);
  const share = reachShare(report);
  const machine = Object.entries(report.machine_by_subtype).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <div className="space-y-6">
      {/* Above the numbers, not below them: a caveat under a headline figure is
          read after the figure has already been believed. */}
      {caveats.length > 0 ? (
        <div className="space-y-2" role="status">
          {caveats.map((caveat) => (
            <p
              key={caveat}
              className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
            >
              {caveat}
            </p>
          ))}
        </div>
      ) : null}

      <div>
        {/* The server's sentence, verbatim. It is generated from the same
            constants the computation used, so it cannot disagree with it. */}
        <p className="text-xl font-semibold">{reachHeadline(report)}</p>
        {share ? (
          <p className="mt-1 text-sm text-muted-foreground">
            {pct(share.floor)} of {count(report.provider_accepted_recipients)}{" "}
            accepted recipients, and at most {pct(share.upper)} once
            unclassified activity is included.
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing was delivered in this window, so there is no share to
            report.
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Bucket
          label="Human-classified signal"
          value={report.human_engaged_reach_floor}
          meaning="At least one interaction classified as human. This does not prove the message was read or understood."
        />
        <Bucket
          label="Unclassified"
          value={report.unknown_band}
          meaning="Might be human. We could not tell, so they are not counted above."
        />
        <Bucket
          label="Machine only"
          value={report.machine_only_recipients}
          meaning="Every interaction came from a scanner, proxy, or prefetcher."
        />
        <Bucket
          label="No interaction"
          value={report.no_interaction_recipients}
          tone="muted"
          meaning="Delivered, did nothing observable. Usually the largest group."
        />
      </div>

      {machine.length > 0 ? (
        <div>
          <h4 className="text-sm font-medium">What the machines were</h4>
          <ul className="mt-2 flex flex-wrap gap-2">
            {machine.map(([subtype, value]) => (
              <li key={subtype}>
                <Badge variant="secondary">
                  {subtype.replace(/_/g, " ")}: {count(value)}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-md border border-border bg-muted/30 p-3">
        <h4 className="text-sm font-medium">How this was measured</h4>
        <p className="mt-1 text-sm text-muted-foreground">
          {report.methodology}
        </p>
        {/* Version provenance is part of the deliverable, not debug output: a
            figure quoted externally has to be reproducible later, and that
            needs the exact classifier and configuration it came from. */}
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          classifier {report.classifier_version} · methodology{" "}
          {report.methodology_version} · registry {report.registry_version} ·
          config {report.configuration_hash.slice(0, 12)}
        </p>
      </div>
    </div>
  );
}

export function HumanEngagedReachPanel({
  campaignId,
  days = 30,
}: {
  campaignId?: string;
  days?: 7 | 30 | 90;
}) {
  const reportWindow = useMemo(() => {
    const until = new Date();
    return {
      since: new Date(until.getTime() - days * 86_400_000).toISOString(),
      until: until.toISOString(),
    };
  }, [days]);
  const me = useQuery({
    queryKey: ["auth-me"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = me.data?.tenant_id ?? "anon";
  const role = me.data?.role ?? null;

  const reach = useQuery({
    // Identity-scoped so a report never survives into another tenant's session.
    queryKey: [
      ...base("human-engaged-reach", tenantId, role),
      campaignId ?? "",
      reportWindow.since,
      reportWindow.until,
    ],
    queryFn: ({ signal }) =>
      getHumanEngagedReach({ ...reportWindow, campaignId, signal }),
    enabled: me.isSuccess && tenantId !== "anon" && role !== null,
    staleTime: STALE.dashboard,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Human-engaged reach</CardTitle>
        <CardDescription>
          Last {days} days. A lower bound from calibrated interaction
          classification. It does not prove a recipient read or understood the
          message; proxies, prefetchers, and security scanners can also generate
          opens and clicks.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {reach.isPending ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-7 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : reach.isError || !reach.data ? (
          // Fail loud. A blank or zeroed panel would read as "nobody engaged",
          // which is a different and much worse claim than "we could not load".
          <p role="alert" className="text-sm text-destructive">
            {reach.error instanceof Error && reach.error.message.trim() !== ""
              ? reach.error.message
              : REACH_UNAVAILABLE_MESSAGE}{" "}
            Do not read this as zero engagement — no released measurement was
            made.
          </p>
        ) : (
          <>
            <ReachBody report={reach.data} />
            <div className="mt-6 flex justify-end">
              <Button asChild variant="outline" size="sm">
                <a
                  href={humanEngagedReachExportURL(
                    reach.data.window_start,
                    reach.data.window_end,
                    reach.data.campaign_id,
                  )}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Export evidence
                </a>
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
