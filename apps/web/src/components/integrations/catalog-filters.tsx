// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalog posture: the workspace-state and customer-stack filters, plus the
// readiness / coverage / stack / recipe panels desktop's
// IntegrationsCatalogSurface renders from GET /api/v1/integrations/
// {connections,coverage,stacks,readiness,recipes}.
//
//   useCatalogPosture()     connections + stacks the filters join against
//   <CatalogFilters>        search · category · workspace state · stack
//   filterCatalogByPosture  (lib) the pure filter the page applies
//   <CatalogPosturePanels>  readiness (with Retry verification), coverage,
//                           stacks, recipes (each reviewable/preparable)
//
// A filter whose evidence failed to load is disabled with the reason, so a
// failed connections read never renders as "nothing needs attention".
"use client";

import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import {
  EMPTY_POSTURE_FILTER,
  integrationsLifecycleApi,
  type CatalogPostureFilter,
  type CustomerStack,
  type IntegrationConnection,
  type IntegrationRecipe,
  type WorkspaceStateFilter,
} from "@/lib/integrations-lifecycle-api";
import { STALE } from "@/lib/query-keys";

import { RecipeApplyDialog } from "./recipe-apply-dialog";
import { useIntegrationLifecycleAuthority } from "./use-integration-lifecycle-authority";

export interface CatalogPosture {
  connections: ReadonlyMap<string, IntegrationConnection>;
  stacks: readonly CustomerStack[];
  connectionsLoading: boolean;
  stacksLoading: boolean;
  connectionsError: unknown;
  stacksError: unknown;
  retry: () => void;
}

export function useCatalogPosture(): CatalogPosture {
  const authority = useIntegrationLifecycleAuthority();
  const ready = authority.identity !== null;
  const connections = useQuery({
    queryKey: [...authority.baseKey, "posture-connections"] as const,
    queryFn: ({ signal }) =>
      integrationsLifecycleApi.connections(undefined, { signal }),
    enabled: ready,
    staleTime: STALE.list,
    retry: false,
  });
  const stacks = useQuery({
    queryKey: [...authority.baseKey, "posture-stacks"] as const,
    queryFn: ({ signal }) => integrationsLifecycleApi.stacks({ signal }),
    enabled: ready,
    staleTime: STALE.dashboard,
    retry: false,
  });
  const connectionMap = useMemo(() => {
    const map = new Map<string, IntegrationConnection>();
    if (connections.data) {
      for (const row of connections.data.items) map.set(row.slug, row);
    }
    return map;
  }, [connections.data]);
  return {
    connections: connectionMap,
    stacks: stacks.data ? stacks.data.stacks : [],
    connectionsLoading: connections.isPending,
    stacksLoading: stacks.isPending,
    connectionsError: connections.isError ? connections.error : null,
    stacksError: stacks.isError ? stacks.error : null,
    retry: () => {
      if (connections.isError) void connections.refetch();
      if (stacks.isError) void stacks.refetch();
    },
  };
}

const STATE_OPTIONS: { value: WorkspaceStateFilter; label: string }[] = [
  { value: "all", label: "All states" },
  { value: "connected", label: "Configured" },
  { value: "attention", label: "Needs attention" },
  { value: "available", label: "Ready to connect" },
  { value: "planned", label: "Planned" },
];

export function CatalogFilters({
  value,
  onChange,
  categories,
  posture,
  postureOnly = false,
}: {
  value: CatalogPostureFilter;
  onChange: (next: CatalogPostureFilter) => void;
  categories: readonly { key: string; label: string }[];
  posture: CatalogPosture;
  /**
   * The host page already owns search and category (e.g. the catalogue's URL
   * state): render only the workspace-state and customer-stack narrowing, and
   * let Reset clear only those, so the page never shows two search boxes.
   */
  postureOnly?: boolean;
}) {
  const id = useId();
  const connectionsUnavailable = Boolean(posture.connectionsError);
  const stacksUnavailable = Boolean(posture.stacksError);
  const active = [
    !postureOnly && value.query.trim() !== "",
    !postureOnly && value.category !== "",
    value.state !== "all",
    value.stack !== "",
  ].filter(Boolean).length;

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="space-y-3 rounded-lg border p-4"
    >
      <h2 id={`${id}-heading`} className="text-sm font-medium">
        {postureOnly ? "Filter by workspace posture" : "Filter integrations"}
      </h2>
      <div
        className={
          postureOnly
            ? "grid gap-3 sm:grid-cols-2"
            : "grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        }
      >
        {postureOnly ? null : (
          <>
            <div className="space-y-1">
              <Label htmlFor={`${id}-query`}>Search</Label>
              <Input
                id={`${id}-query`}
                type="search"
                value={value.query}
                placeholder="Providers, capabilities, sources"
                onChange={(event) =>
                  onChange({ ...value, query: event.target.value })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-category`}>Category</Label>
              <Select
                id={`${id}-category`}
                value={value.category}
                onChange={(event) =>
                  onChange({ ...value, category: event.target.value })
                }
              >
                <option value="">All categories</option>
                {categories.map((category) => (
                  <option key={category.key} value={category.key}>
                    {category.label}
                  </option>
                ))}
              </Select>
            </div>
          </>
        )}
        <div className="space-y-1">
          <Label htmlFor={`${id}-state`}>Workspace state</Label>
          <Select
            id={`${id}-state`}
            value={value.state}
            disabled={connectionsUnavailable || posture.connectionsLoading}
            aria-describedby={
              connectionsUnavailable ? `${id}-state-reason` : undefined
            }
            onChange={(event) =>
              onChange({
                ...value,
                state: event.target.value as WorkspaceStateFilter,
              })
            }
          >
            {STATE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          {connectionsUnavailable ? (
            <p id={`${id}-state-reason`} className="text-xs text-destructive">
              {apiErrorMessage(
                posture.connectionsError,
                "Connection evidence could not be loaded.",
              )}{" "}
              This filter is paused so a failed read is not shown as
              &ldquo;nothing configured&rdquo;.
            </p>
          ) : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-stack`}>Customer stack</Label>
          <Select
            id={`${id}-stack`}
            value={value.stack}
            disabled={stacksUnavailable || posture.stacksLoading}
            aria-describedby={
              stacksUnavailable ? `${id}-stack-reason` : undefined
            }
            onChange={(event) =>
              onChange({ ...value, stack: event.target.value })
            }
          >
            <option value="">All stacks</option>
            {posture.stacks.map((stack) => (
              <option key={stack.key} value={stack.key}>
                {stack.name}
              </option>
            ))}
          </Select>
          {stacksUnavailable ? (
            <p id={`${id}-stack-reason`} className="text-xs text-destructive">
              {apiErrorMessage(
                posture.stacksError,
                "Customer stacks could not be loaded.",
              )}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span aria-live="polite">
          {active === 0
            ? "No active filters"
            : `${active} active ${active === 1 ? "filter" : "filters"}`}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={active === 0}
          onClick={() =>
            onChange(
              postureOnly
                ? {
                    ...value,
                    state: EMPTY_POSTURE_FILTER.state,
                    stack: EMPTY_POSTURE_FILTER.stack,
                  }
                : EMPTY_POSTURE_FILTER,
            )
          }
        >
          Reset filters
        </Button>
        {connectionsUnavailable || stacksUnavailable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={posture.retry}
          >
            Retry loading filters
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function FailedPanel({
  error,
  fallback,
  onRetry,
}: {
  error: unknown;
  fallback: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="space-y-2 text-sm">
      <p className="text-destructive">{apiErrorMessage(error, fallback)}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function CatalogPosturePanels() {
  const authority = useIntegrationLifecycleAuthority();
  const ready = authority.identity !== null;
  const [recipe, setRecipe] = useState<IntegrationRecipe | null>(null);

  const readiness = useQuery({
    queryKey: [...authority.baseKey, "posture-readiness"] as const,
    queryFn: ({ signal }) => integrationsLifecycleApi.readiness({ signal }),
    enabled: ready,
    staleTime: STALE.dashboard,
    retry: false,
  });
  const coverage = useQuery({
    queryKey: [...authority.baseKey, "posture-coverage"] as const,
    queryFn: ({ signal }) => integrationsLifecycleApi.coverage({ signal }),
    enabled: ready,
    staleTime: STALE.dashboard,
    retry: false,
  });
  const stacks = useQuery({
    queryKey: [...authority.baseKey, "posture-stacks"] as const,
    queryFn: ({ signal }) => integrationsLifecycleApi.stacks({ signal }),
    enabled: ready,
    staleTime: STALE.dashboard,
    retry: false,
  });
  const recipes = useQuery({
    queryKey: [...authority.baseKey, "posture-recipes"] as const,
    queryFn: ({ signal }) =>
      integrationsLifecycleApi.recipes(undefined, { signal }),
    enabled: ready,
    staleTime: STALE.list,
    retry: false,
  });
  const connections = useQuery({
    queryKey: [...authority.baseKey, "posture-connections"] as const,
    queryFn: ({ signal }) =>
      integrationsLifecycleApi.connections(undefined, { signal }),
    enabled: ready,
    staleTime: STALE.list,
    retry: false,
  });

  const attention = connections.data
    ? (connections.data.summary["health:action_required"] ?? 0) +
      (connections.data.summary["health:needs_attention"] ?? 0)
    : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle as="h2" className="text-base">
            Launch readiness
          </CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={readiness.isFetching}
            disabled={!ready}
            onClick={() => void readiness.refetch()}
          >
            Retry verification
          </Button>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {readiness.isError ? (
            <FailedPanel
              error={readiness.error}
              fallback="Readiness could not be verified. This is a failed request, not a passing check."
              onRetry={() => void readiness.refetch()}
            />
          ) : readiness.data ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={readiness.data.ready ? "success" : "warning"}>
                  {readiness.data.ready ? "Ready" : "Not ready"}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {readiness.data.issues.length} open issue
                  {readiness.data.issues.length === 1 ? "" : "s"}
                </span>
              </div>
              {readiness.data.public_claim ? (
                <p className="text-muted-foreground">
                  {readiness.data.public_claim}
                </p>
              ) : null}
              <ul className="space-y-1">
                {readiness.data.checks.map((check) => (
                  <li key={check.key} className="flex flex-wrap gap-2 text-xs">
                    <Badge
                      variant={
                        check.state === "pass" || check.state === "ready"
                          ? "success"
                          : "warning"
                      }
                    >
                      {check.state || "unknown"}
                    </Badge>
                    <span className="min-w-0 flex-1 break-words">
                      <span className="font-medium">{check.label}</span>
                      {check.message ? ` — ${check.message}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p role="status" className="text-muted-foreground">
              Verifying readiness…
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-base">
            Coverage
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {coverage.isError ? (
            <FailedPanel
              error={coverage.error}
              fallback="Coverage could not be loaded."
              onRetry={() => void coverage.refetch()}
            />
          ) : coverage.data ? (
            <>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="text-muted-foreground">Public entries</dt>
                  <dd className="font-medium">
                    {coverage.data.public_entries} of{" "}
                    {coverage.data.target_public_entries}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Native managed</dt>
                  <dd className="font-medium">
                    {coverage.data.native_managed} of{" "}
                    {coverage.data.target_native_managed}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Native verified</dt>
                  <dd className="font-medium">
                    {coverage.data.native_verified} of{" "}
                    {coverage.data.target_native_verified}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Bridge ready</dt>
                  <dd className="font-medium">{coverage.data.bridge_ready}</dd>
                </div>
              </dl>
              {coverage.data.priority_gaps.length > 0 ? (
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {coverage.data.priority_gaps.slice(0, 5).map((gap) => (
                    <li key={gap.slug}>
                      <span className="font-medium text-foreground">
                        {gap.name || gap.slug}
                      </span>{" "}
                      — {gap.reason}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {connections.isError
                  ? "Workspace connection counts are unavailable."
                  : connections.data
                    ? `${connections.data.summary.connected ?? 0} configured · ${attention} need attention`
                    : "Loading workspace connections…"}
              </p>
            </>
          ) : (
            <p role="status" className="text-muted-foreground">
              Loading coverage…
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-base">
            Customer stacks
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {stacks.isError ? (
            <FailedPanel
              error={stacks.error}
              fallback="Customer stacks could not be loaded."
              onRetry={() => void stacks.refetch()}
            />
          ) : stacks.data ? (
            <>
              <p className="text-xs text-muted-foreground">
                {stacks.data.covered_stacks} of {stacks.data.total_stacks}{" "}
                stacks covered ({stacks.data.covered_pct}% · target{" "}
                {stacks.data.target_coverage_pct}%)
              </p>
              <ul className="space-y-1">
                {stacks.data.stacks.map((stack) => (
                  <li key={stack.key} className="flex flex-wrap gap-2 text-xs">
                    <span className="font-medium">{stack.name}</span>
                    <Badge variant="outline">{stack.status}</Badge>
                    <span className="text-muted-foreground">
                      {stack.required_covered}/{stack.required_total} required
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p role="status" className="text-muted-foreground">
              Loading stacks…
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-base">
            Recipes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {recipes.isError ? (
            <FailedPanel
              error={recipes.error}
              fallback="Recipes could not be loaded."
              onRetry={() => void recipes.refetch()}
            />
          ) : recipes.data ? (
            <>
              <p className="text-xs text-muted-foreground">
                {recipes.data.summary.available ?? 0} ready of{" "}
                {recipes.data.summary.total ?? recipes.data.items.length}
              </p>
              <ul className="space-y-1">
                {recipes.data.items.slice(0, 8).map((candidate) => (
                  <li
                    key={candidate.id}
                    className="flex flex-wrap items-center justify-between gap-2"
                  >
                    <span className="min-w-0 flex-1 break-words text-xs">
                      {candidate.name}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setRecipe(candidate)}
                    >
                      Review recipe
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p role="status" className="text-muted-foreground">
              Loading recipes…
            </p>
          )}
        </CardContent>
      </Card>

      {recipe ? (
        <RecipeApplyDialog
          recipe={recipe}
          open
          onOpenChange={(next) => {
            if (!next) setRecipe(null);
          }}
        />
      ) : null}
    </div>
  );
}
