// SPDX-License-Identifier: AGPL-3.0-only
//
// ConnectorDetailPanels — the server's own detail for one catalog integration
// (GET /api/v1/integrations/{slug}): connection evidence, the declared
// lifecycle verbs, health guidance (re-checkable via GET …/{slug}/health), the
// connector contract (re-readable via GET …/{slug}/contract), setup steps and
// recipes. Desktop parity: IntegrationDetailPanels LifecycleActionsPanel /
// ContractPanel / HealthPanel, fed by integrationsApi.detail.
"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiErrorMessage } from "@/lib/api";
import {
  integrationsLifecycleApi,
  type ConnectorContract,
  type HealthReport,
  type IntegrationRecipe,
} from "@/lib/integrations-lifecycle-api";
import { STALE } from "@/lib/query-keys";

import { IntegrationLifecycleActions } from "./integration-lifecycle-actions";
import { RecipeApplyDialog } from "./recipe-apply-dialog";
import { useIntegrationLifecycleAuthority } from "./use-integration-lifecycle-authority";

function tone(
  state: string,
): "success" | "warning" | "destructive" | "secondary" | "info" {
  const value = state.trim().toLowerCase();
  if (["healthy", "ok", "pass", "passed", "active", "connected"].includes(value))
    return "success";
  if (["error", "failed", "unhealthy", "fail"].includes(value))
    return "destructive";
  if (
    ["action_required", "needs_attention", "degraded", "warn", "warning"].includes(
      value,
    )
  )
    return "warning";
  if (value === "held" || value === "planned") return "secondary";
  return "info";
}

function humanize(value: string): string {
  return value ? value.replaceAll("_", " ") : "Not reported";
}

function Tokens({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {values.length === 0 ? (
        <p className="text-xs text-muted-foreground">None declared.</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {values.map((value) => (
            <Badge key={value} variant="outline">
              {value}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function HealthPanel({ health }: { health: HealthReport }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={tone(health.state)}>{humanize(health.state)}</Badge>
        {health.severity ? (
          <span className="text-xs text-muted-foreground">
            Severity {humanize(health.severity)}
          </span>
        ) : null}
        {health.monitoring_surface ? (
          <span className="text-xs text-muted-foreground">
            Monitored in {health.monitoring_surface}
          </span>
        ) : null}
      </div>
      <p className="break-words">{health.message || "No health message."}</p>
      {health.docs_url ? (
        <a
          href={health.docs_url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-sm text-primary hover:underline"
        >
          Open health guidance
        </a>
      ) : null}
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">
          Health checks ({health.checks.length})
        </p>
        {health.checks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No health checks were returned. Overall health cannot substitute
            for check-level evidence.
          </p>
        ) : (
          <ul className="space-y-1">
            {health.checks.map((check) => (
              <li key={check.key} className="flex flex-wrap items-start gap-2">
                <Badge variant={tone(check.state)}>{humanize(check.state)}</Badge>
                <span className="min-w-0 flex-1 break-words">
                  <span className="font-medium">{check.label || check.key}</span>
                  {check.message ? ` — ${check.message}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <dl className="grid gap-1 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Retry mode</dt>
          <dd>{humanize(health.retry_policy.mode)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Maximum attempts</dt>
          <dd>
            {health.retry_policy.max_attempts > 0
              ? health.retry_policy.max_attempts
              : "Unknown"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Backoff</dt>
          <dd>{humanize(health.retry_policy.backoff)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Dead-letter handling</dt>
          <dd>{humanize(health.retry_policy.dead_letter)}</dd>
        </div>
      </dl>
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">
          Recent operation history ({health.sync_history.length})
        </p>
        {health.sync_history.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No recent operation history was returned. A successful run must not
            be inferred.
          </p>
        ) : (
          <ol className="space-y-1">
            {health.sync_history.map((entry, index) => (
              <li
                key={`${entry.action}-${entry.at ?? "unknown"}-${index}`}
                className="text-xs"
              >
                <span className="font-medium">{humanize(entry.action)}</span>{" "}
                <Badge variant={tone(entry.status)}>
                  {humanize(entry.status)}
                </Badge>{" "}
                {entry.at ? <RelativeTime iso={entry.at} /> : "time unknown"}
                {entry.message ? ` — ${entry.message}` : ""}
                {entry.error ? (
                  <span className="block text-destructive">{entry.error}</span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function ContractPanel({ contract }: { contract: ConnectorContract }) {
  const assurance = contract.native_verified
    ? "API-verified native contract"
    : contract.native_managed
      ? "Native foundation — verification incomplete"
      : "Delegated or planned contract";
  return (
    <div className="space-y-3 text-sm">
      <p className="font-medium">{assurance}</p>
      {contract.public_claim ? (
        <blockquote className="border-l-2 pl-3 text-muted-foreground">
          {contract.public_claim}
        </blockquote>
      ) : null}
      <dl className="grid gap-1 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Owner</dt>
          <dd>{humanize(contract.owner)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Implementation depth</dt>
          <dd>{humanize(contract.implementation_depth)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Setup surface</dt>
          <dd className="break-words">{contract.setup_surface || "Not reported"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Credential storage</dt>
          <dd className="break-words">
            {contract.credential_storage || "Not reported"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Secret policy</dt>
          <dd className="break-words">{contract.secret_policy || "Not reported"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Rate-limit policy</dt>
          <dd className="break-words">
            {contract.rate_limit_policy || "Not reported"}
          </dd>
        </div>
      </dl>
      <div className="grid gap-3 sm:grid-cols-2">
        <Tokens label="Authentication modes" values={contract.auth_modes} />
        <Tokens label="Required scopes" values={contract.required_scopes} />
        <Tokens label="Declared lifecycle" values={contract.lifecycle_actions} />
        <Tokens label="Data objects" values={contract.data_objects} />
        <Tokens label="Event topics" values={contract.event_topics} />
        <Tokens label="Compliance gates" values={contract.compliance_gates} />
      </div>
    </div>
  );
}

export function ConnectorDetailPanels({
  slug,
  onChanged,
}: {
  slug: string;
  onChanged?: () => void | Promise<void>;
}) {
  const queryClient = useQueryClient();
  const authority = useIntegrationLifecycleAuthority();
  const [healthRequested, setHealthRequested] = useState(false);
  const [contractRequested, setContractRequested] = useState(false);
  const [recipe, setRecipe] = useState<IntegrationRecipe | null>(null);
  const ready = authority.identity !== null;

  const detailKey = [...authority.baseKey, "lifecycle-detail", slug] as const;
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => integrationsLifecycleApi.detail(slug, { signal }),
    enabled: ready && slug.length > 0,
    staleTime: STALE.detail,
    retry: false,
  });
  const health = useQuery({
    queryKey: [...authority.baseKey, "lifecycle-health", slug] as const,
    queryFn: ({ signal }) => integrationsLifecycleApi.health(slug, { signal }),
    enabled: ready && healthRequested,
    staleTime: 0,
    retry: false,
  });
  const contract = useQuery({
    queryKey: [...authority.baseKey, "lifecycle-contract", slug] as const,
    queryFn: ({ signal }) => integrationsLifecycleApi.contract(slug, { signal }),
    enabled: ready && contractRequested,
    staleTime: 0,
    retry: false,
  });

  if (authority.pending || (detail.isPending && detail.fetchStatus !== "idle")) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading connector detail…
      </p>
    );
  }
  if (authority.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {apiErrorMessage(
          authority.error,
          "Moosewave could not verify the current workspace identity.",
        )}
      </p>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <Card role="alert" className="border-destructive/40 bg-destructive/5">
        <CardContent className="space-y-3 p-5 text-sm">
          <p className="text-destructive">
            {apiErrorMessage(
              detail.error,
              "Connector detail could not be loaded. This is a failed request, not an integration with nothing configured.",
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void detail.refetch()}
          >
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const data = detail.data;
  const shownHealth = health.data ?? data.health;
  const shownContract = contract.data ?? data.contract;
  const connection = data.connection;

  const refreshAfterChange = async () => {
    await queryClient.invalidateQueries({ queryKey: detailKey, exact: true });
    if (healthRequested) {
      await queryClient.invalidateQueries({
        queryKey: [...authority.baseKey, "lifecycle-health", slug],
        exact: true,
      });
    }
    await onChanged?.();
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-base">
            Connection & lifecycle
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={tone(connection.status)}>
              {humanize(connection.status)}
            </Badge>
            <Badge variant={tone(connection.health_state)}>
              {humanize(connection.health_state)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {connection.last_sync_at ? (
                <>
                  last synced <RelativeTime iso={connection.last_sync_at} />
                </>
              ) : (
                "never synced"
              )}
            </span>
          </div>
          {connection.health_message ? (
            <p className="break-words text-muted-foreground">
              {connection.health_message}
            </p>
          ) : null}
          {connection.last_error ? (
            <p className="break-words text-xs text-destructive">
              {connection.last_error}
            </p>
          ) : null}
          <IntegrationLifecycleActions
            item={data.item}
            actions={data.lifecycle_actions}
            connection={connection}
            onChanged={refreshAfterChange}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle as="h2" className="text-base">
            Health, outages & recovery
          </CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={health.isFetching}
            onClick={() => {
              if (healthRequested) void health.refetch();
              else setHealthRequested(true);
            }}
          >
            Re-check health
          </Button>
        </CardHeader>
        <CardContent>
          {health.isError ? (
            <p role="alert" className="mb-3 text-sm text-destructive">
              {apiErrorMessage(
                health.error,
                "Health could not be re-checked. The report below is the earlier one.",
              )}
            </p>
          ) : null}
          <HealthPanel health={shownHealth} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle as="h2" className="text-base">
            Connector contract
          </CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={contract.isFetching}
            onClick={() => {
              if (contractRequested) void contract.refetch();
              else setContractRequested(true);
            }}
          >
            Re-read contract
          </Button>
        </CardHeader>
        <CardContent>
          {contract.isError ? (
            <p role="alert" className="mb-3 text-sm text-destructive">
              {apiErrorMessage(
                contract.error,
                "The contract could not be re-read. The one below is the earlier read.",
              )}
            </p>
          ) : null}
          <ContractPanel contract={shownContract} />
        </CardContent>
      </Card>

      {data.setup.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle as="h2" className="text-base">
              Setup guide
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {data.setup.map((step, index) => (
                <li key={`${step.title}-${index}`}>
                  <span className="font-medium">{step.title}</span>
                  {step.description ? (
                    <span className="text-muted-foreground">
                      {" "}
                      — {step.description}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-base">
            Setup recipes
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.recipes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No recipes are published for this integration.
            </p>
          ) : (
            <ul className="space-y-2">
              {data.recipes.map((candidate) => (
                <li
                  key={candidate.id}
                  className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">{candidate.name}</p>
                    <p className="break-words text-xs text-muted-foreground">
                      {candidate.summary}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge
                      variant={candidate.available ? "success" : "secondary"}
                    >
                      {candidate.available ? "Ready" : "Planned"}
                    </Badge>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setRecipe(candidate)}
                    >
                      Review recipe
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
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
