// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { ChevronDown, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";
import {
  getAdvancedSegmentSchema,
  getAudienceInsights,
  type AdvancedSegmentSchemaResponse,
  type AudienceInsightsResponse,
} from "@/lib/mailchimp-compat-api";
import { whoami } from "@/lib/auth-api";
import { asRoute } from "@/lib/typed-routes";
import { base, STALE } from "@/lib/query-keys";
import {
  formatMetricValue,
  humanizeMetricKey,
  pluralize,
} from "@/lib/analytics-format";

import {
  entries,
  MetricBox,
  PanelEmpty,
  PanelError,
  PanelGridSkeleton,
} from "./product-panel-primitives";

export function ratingWidthPercent(count: number, largestCount: number) {
  if (count <= 0 || largestCount <= 0) return 0;
  return Math.min(100, Math.max(5, (count / largestCount) * 100));
}

/**
 * A ratings map is only "real" signal when at least one bucket has a count.
 * The API can return a zero-filled map (`{1..5: 0}`) on a low-data tenant,
 * which previously rendered five empty 0-bars instead of the fallback copy.
 */
export function hasRatingSignal(ratings: [string, number][]): boolean {
  return ratings.some(([, count]) => count > 0);
}

/**
 * Build a segment-builder link pre-seeded with a name + description describing
 * the clicked insight, so an audience insight becomes an actionable segment
 * draft in one click (ANL-031). The builder consumes `seedName`/`seedDescription`
 * and — when a `rule` is given — `seedField`/`seedComparator`/`seedValue`, so the
 * draft opens with the matching condition already applied (e.g. contact_rating
 * equals 4). The rule fields correspond to the segment predicate registry.
 */
function segmentSeedHref(
  name: string,
  description: string,
  rule?: { field: string; comparator: string; value: string },
): string {
  const params = new URLSearchParams({
    seedName: name,
    seedDescription: description,
  });
  if (rule) {
    params.set("seedField", rule.field);
    params.set("seedComparator", rule.comparator);
    params.set("seedValue", rule.value);
  }
  return `/app/subscribers/segments/new?${params.toString()}`;
}

const SEED_TILE =
  "block rounded-md text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function AudienceIntelligencePanel({
  className = "",
  collapsible = false,
}: {
  className?: string;
  /** Render a collapse toggle so the panel can't bury the list (SEG-020). */
  collapsible?: boolean;
}) {
  const me = useQuery({
    queryKey: ["auth-me"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = me.data?.tenant_id ?? "anon";
  const role = me.data?.role ?? null;

  const query = useQuery({
    queryKey: [...base("audience-intelligence", tenantId, role)],
    queryFn: async (): Promise<{
      insights: AudienceInsightsResponse;
      schema: AdvancedSegmentSchemaResponse;
    }> => {
      const [insights, schema] = await Promise.all([
        getAudienceInsights(),
        getAdvancedSegmentSchema(),
      ]);
      return { insights, schema };
    },
    staleTime: 5 * 60_000,
  });

  const insights = query.data?.insights ?? null;
  const schema = query.data?.schema ?? null;
  const error =
    query.error instanceof Error
      ? query.error.message
      : query.error
        ? "Could not load audience intelligence."
        : null;
  const loading = query.isPending;

  // Collapsed by default when collapsible, so the primary content (the
  // segments table) stays above the fold — especially on mobile.
  const [collapsed, setCollapsed] = useState(collapsible);

  const ratings = Object.entries(insights?.contact_ratings ?? {});
  const largestRatingCount = Math.max(0, ...ratings.map(([, count]) => count));
  const ratingsHaveSignal = hasRatingSignal(ratings);
  const dimensions = schema?.dimensions?.slice(0, 8) ?? [];
  const predictive = [
    ...entries(insights?.predictive_clv).slice(0, 4),
    ...entries(insights?.predicted_demographics).slice(0, 4),
  ];

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle>Audience intelligence</CardTitle>
            <CardDescription>
              Contact ratings, recorded event geography, commerce summaries,
              group/interest parity, and advanced segmentation breadth.
            </CardDescription>
          </div>
          {collapsible ? (
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              aria-expanded={!collapsed}
              aria-controls="audience-intelligence-body"
              className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {collapsed ? "Show" : "Hide"}
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${collapsed ? "" : "rotate-180"}`}
                aria-hidden
              />
            </button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent
        id="audience-intelligence-body"
        className="space-y-4"
        hidden={collapsed}
      >
        {error ? (
          <PanelError
            message={error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : null}
        {/* The grid needs data to be truthful: with none, its three cards say
            "No contact ratings yet", "No predictive data yet" and "No
            segmentation dimensions available yet" — three claims about the
            workspace that a failed read never established. On a failure the
            PanelError above stands alone; a failed refetch that still holds the
            last good response keeps rendering it beside the error. */}
        {loading ? (
          <PanelGridSkeleton cells={3} />
        ) : query.data ? (
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-md border p-3">
              <div className="text-sm font-medium">Contact ratings</div>
              <div className="mt-3 space-y-2">
                {ratingsHaveSignal ? (
                  ratings.map(([rating, count]) => (
                    <Link
                      key={rating}
                      href={asRoute(
                        segmentSeedHref(
                          `${rating}-${pluralize(rating, "star")} contacts`,
                          `Contacts rated ${rating} ${pluralize(rating, "star")} by engagement.`,
                          {
                            field: "contact_rating",
                            comparator: "equals",
                            value: rating,
                          },
                        ),
                      )}
                      className={`${SEED_TILE} space-y-1 px-1 py-0.5`}
                      title="Build a segment from this rating"
                    >
                      <div className="flex justify-between text-xs">
                        <span>
                          {rating} {pluralize(rating, "star")}
                        </span>
                        <span className="tabular-nums">
                          {count.toLocaleString()}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-muted">
                        <div
                          className="h-2 rounded-full bg-primary"
                          style={{
                            width: `${ratingWidthPercent(count, largestRatingCount)}%`,
                          }}
                        />
                      </div>
                    </Link>
                  ))
                ) : (
                  <PanelEmpty
                    title="No contact ratings yet"
                    hint="Ratings appear once campaign engagement is captured."
                  />
                )}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-sm font-medium">
                Commerce &amp; event geography
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Country figures count recorded campaign events, not people.
                Unknown means the event has no country. Commerce figures use
                paid orders.
              </p>
              <div className="mt-2 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
                {predictive.map(([key, value]) => (
                  <Link
                    key={key}
                    href={asRoute(
                      segmentSeedHref(
                        `${humanizeMetricKey(key)} cohort`,
                        `Seeded from the ${humanizeMetricKey(key)} insight (${formatMetricValue(key, value)}). Add a rule to refine this segment.`,
                      ),
                    )}
                    className={SEED_TILE}
                    title="Start a segment draft from this insight; add a matching rule"
                  >
                    <MetricBox
                      label={humanizeMetricKey(key)}
                      value={formatMetricValue(key, value)}
                    />
                  </Link>
                ))}
                {predictive.length === 0 ? (
                  <div className="col-span-full">
                    <PanelEmpty
                      title="No predictive data yet"
                      hint="Predictive fields are evidence-based only until enough commerce and engagement data exists."
                    />
                  </div>
                ) : null}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-sm font-medium">Advanced segmentation</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {dimensions.map((dimension) => (
                  <Tooltip
                    key={dimension.key}
                    label={
                      dimension.operators?.length
                        ? `${dimension.description} · operators: ${dimension.operators.join(", ")}`
                        : dimension.description
                    }
                  >
                    <Badge
                      variant="outline"
                      tabIndex={0}
                      className="cursor-help focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {dimension.label}
                    </Badge>
                  </Tooltip>
                ))}
                {dimensions.length === 0 ? (
                  <PanelEmpty title="No segmentation dimensions available yet" />
                ) : null}
              </div>
              {schema?.unsupported?.length ? (
                // Use semantic warning tokens (dark-mode-safe) instead of raw amber-* swatches.
                <div className="mt-3 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning-emphasis">
                  Unsupported: {schema.unsupported.slice(0, 4).join(", ")}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        <Button variant="outline" size="sm" asChild>
          <Link href="/app/subscribers/segments/new">
            <Users className="h-4 w-4" aria-hidden />
            New segment
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
