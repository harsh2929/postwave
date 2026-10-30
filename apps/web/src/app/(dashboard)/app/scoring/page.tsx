// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tags } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import { ScoringRulesCard } from "@/components/subscribers/ScoringRulesCard";
import { whoami } from "@/lib/auth-api";
import { base, STALE } from "@/lib/query-keys";
import {
  effectiveWeights,
  getScoringConfig,
  getTagTaxonomy,
  listSubscriptionTypes,
} from "@/lib/scoring-taxonomy-api";
import {
  EngagementEmpty,
  EngagementIdentityGate,
  EngagementLoading,
  EngagementPageHeader,
  EngagementQueryError,
  EngagementSurface,
} from "../_engagement/engagement-ui";

// The UTM templates editor is the last surface on the page and brings its own
// API client and preview, so it loads after first paint and the route's
// initial JavaScript keeps headroom under the bundle budget.
const UtmTemplatesEditor = dynamic(
  () =>
    import("@/components/campaigns/utm-templates-editor").then(
      (module) => module.UtmTemplatesEditor,
    ),
  {
    loading: () => <EngagementLoading label="Loading UTM templates" rows={3} />,
  },
);

export default function ScoringPage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const canLoad = Boolean(meQuery.data);
  const keyBase = useMemo(
    () =>
      base(
        "scoring-taxonomy",
        meQuery.data?.tenant_id ?? "pending",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  // Named because the rules editor below observes the same key: one fetch,
  // and a save from the editor updates the weights shown here.
  const scoringKey = useMemo(() => [...keyBase, "scoring"], [keyBase]);
  const scoring = useQuery({
    queryKey: scoringKey,
    queryFn: getScoringConfig,
    staleTime: STALE.reference,
    enabled: canLoad,
  });
  const taxonomy = useQuery({
    queryKey: [...keyBase, "taxonomy"],
    queryFn: getTagTaxonomy,
    staleTime: STALE.list,
    enabled: canLoad,
  });
  const types = useQuery({
    queryKey: [...keyBase, "subscription-types"],
    queryFn: listSubscriptionTypes,
    staleTime: STALE.reference,
    enabled: canLoad,
  });

  const config = scoring.data;
  const weights = config ? effectiveWeights(config) : [];
  const tags = Array.isArray(taxonomy.data) ? taxonomy.data : [];
  const typeRows = Array.isArray(types.data) ? types.data : [];
  const labels = new Map(
    (config?.event_catalog ?? []).map((event) => [event.event_type, event]),
  );

  return (
    <PageShell className="max-w-6xl">
      <EngagementPageHeader
        eyebrow="Audience intelligence"
        title="Scoring and tags"
        description="Understand the weights moving subscriber scores, the taxonomy describing your audience, and the subscription and attribution rules around it."
        icon={<Tags aria-hidden />}
      />

      <EngagementIdentityGate
        pending={meQuery.isPending}
        error={meQuery.isError || !meQuery.data}
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      >
        <EngagementSurface
          id="sc-weights"
          title="Effective score weights"
          description="While any custom rule is saved, the custom rules are the whole score; the built-in weights apply only when none are."
        >
          {scoring.isPending ? (
            <EngagementLoading
              label="Loading effective score weights"
              rows={5}
            />
          ) : scoring.isError ? (
            <EngagementQueryError
              title="Scoring rules could not be loaded"
              description="The effective score cannot be reconstructed from a partial or failed rules response."
              retrying={scoring.isFetching}
              onRetry={() => void scoring.refetch()}
            />
          ) : !config || weights.length === 0 ? (
            <EngagementEmpty
              title="No score events are configured"
              description="Neither built-in weights nor workspace overrides were returned. Subscriber activity is not being represented as scored here."
            />
          ) : (
            <>
              <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
                {config.rules.length === 0
                  ? `No workspace overrides. All ${config.defaults.length.toLocaleString()} built-in weights below remain in force.`
                  : `${config.rules.length.toLocaleString()} custom rule${config.rules.length === 1 ? " is" : "s are"} in force. The built-in weights are not applied while any custom rule exists, so every other event scores zero.`}
                {config.window_days
                  ? ` Activity is scored over ${config.window_days.toLocaleString()} days.`
                  : ""}
              </p>
              <ul
                className="grid gap-3 sm:grid-cols-2"
                aria-label="Effective score weights"
              >
                {weights.map((weight) => {
                  const event = labels.get(weight.event_type);
                  const overridden = config.rules.some(
                    (rule) => rule.event_type === weight.event_type,
                  );
                  return (
                    <li
                      key={weight.event_type}
                      className="flex min-w-0 items-start justify-between gap-4 rounded-lg border bg-background/60 p-3"
                    >
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium capitalize">
                          {event?.label ||
                            weight.event_type.replace(/_/gu, " ")}
                        </p>
                        <p className="mt-1 text-xs capitalize text-muted-foreground">
                          {overridden
                            ? "Workspace override"
                            : "Built-in default"}
                          {event?.category
                            ? ` · ${event.category.replace(/_/gu, " ")}`
                            : ""}
                        </p>
                      </div>
                      <span
                        className="shrink-0 rounded-full border px-2.5 py-1 text-sm font-semibold tabular-nums"
                        aria-label={`${weight.weight >= 0 ? "adds" : "subtracts"} ${Math.abs(weight.weight)} points`}
                      >
                        {weight.weight > 0
                          ? `+${weight.weight}`
                          : weight.weight}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </EngagementSurface>

        <EngagementSurface
          id="sc-rules"
          title="Lead-scoring rules"
          description="Add, remove and weight the events behind subscriber scores. Saves are reviewed and version-checked."
        >
          <ScoringRulesCard
            identity={meQuery.data ?? null}
            queryKey={scoringKey}
          />
        </EngagementSurface>

        <div className="grid gap-6 lg:grid-cols-2">
          <EngagementSurface
            id="sc-tags"
            title="Tag taxonomy"
            description="Declared and observed tags, including registered tags that currently have no subscribers."
          >
            {taxonomy.isPending ? (
              <EngagementLoading label="Loading tag taxonomy" rows={4} />
            ) : taxonomy.isError ? (
              <EngagementQueryError
                title="Tag taxonomy could not be loaded"
                description="A failed taxonomy request is not being represented as an audience with no tags."
                retrying={taxonomy.isFetching}
                onRetry={() => void taxonomy.refetch()}
              />
            ) : tags.length === 0 ? (
              <EngagementEmpty
                title="No tags yet"
                description="The taxonomy request completed successfully and returned no declared or observed tags."
              />
            ) : (
              <ul
                className="divide-y rounded-lg border"
                aria-label="Tag taxonomy"
              >
                {tags.map((tag, index) => (
                  <li
                    key={`${tag.tag}:${index}`}
                    className="flex min-w-0 items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">
                        {tag.tag || `Unnamed tag ${index + 1}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {tag.registered
                          ? "Registered"
                          : "Observed, not registered"}
                      </p>
                    </div>
                    <span className="shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                      {tag.subscribers.toLocaleString()} subscriber
                      {tag.subscribers === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </EngagementSurface>

          <EngagementSurface
            id="sc-types"
            title="Subscription types"
            description="The consent categories subscribers can hold across channels."
          >
            {types.isPending ? (
              <EngagementLoading label="Loading subscription types" />
            ) : types.isError ? (
              <EngagementQueryError
                title="Subscription types could not be loaded"
                description="The available consent vocabulary is unknown until this request succeeds."
                retrying={types.isFetching}
                onRetry={() => void types.refetch()}
              />
            ) : typeRows.length === 0 ? (
              <EngagementEmpty
                title="No subscription types returned"
                description="This build did not advertise a subscription-type vocabulary."
              />
            ) : (
              <ul className="space-y-3" aria-label="Subscription types">
                {typeRows.map((type, index) => (
                  <li
                    key={type.id || index}
                    className="rounded-lg border bg-background/60 p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="break-words text-sm font-medium">
                        {type.name}
                      </p>
                      <span className="rounded-full border px-2 py-0.5 text-xs capitalize text-muted-foreground">
                        {type.channel || "all channels"}
                      </span>
                    </div>
                    {type.description ? (
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {type.description}
                      </p>
                    ) : null}
                    <p className="mt-2 text-xs text-muted-foreground">
                      {type.is_default ? "Default" : "Optional"}
                      {type.is_internal
                        ? " · Internal"
                        : " · Subscriber-visible"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </EngagementSurface>
        </div>

        <EngagementSurface
          id="sc-utm"
          title="UTM templates"
          description="Attribution parameters appended to campaign links at send time. A campaign's own override wins over the workspace default; a value already on a link is never overwritten."
        >
          <UtmTemplatesEditor identity={meQuery.data ?? null} />
        </EngagementSurface>
      </EngagementIdentityGate>
    </PageShell>
  );
}
