// SPDX-License-Identifier: AGPL-3.0-only
//
// RecipeApplyDialog — review one integration setup recipe
// (GET /api/v1/integrations/recipes/{id}) and prepare its setup plan
// (POST /api/v1/integrations/recipes/{id}/apply). Desktop parity:
// useIntegrationRecipeController openRecipeDetail / confirmRecipePreparation.
//
// Preparing a recipe creates NO automation: the server answers 202 with the
// owning surface's endpoint, the fields it needs and the next steps. The
// dialog renders exactly that and says so.
"use client";

import Link from "next/link";
import { useId } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/api";
import { resolveSetupPath } from "@/lib/integration-setup-path";
import {
  integrationsLifecycleApi,
  type IntegrationRecipe,
  type RecipeApplyResponse,
  type SetupStep,
} from "@/lib/integrations-lifecycle-api";
import { STALE } from "@/lib/query-keys";

import {
  ADMIN_REQUIRED_REASON,
  useIntegrationLifecycleAuthority,
} from "./use-integration-lifecycle-authority";

export type RecipeRef = Pick<IntegrationRecipe, "id" | "name" | "available">;

export const RECIPE_PLANNED_REASON =
  "This recipe is planned. Its blueprint is available for review, but setup can't be prepared yet.";

function TokenList({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <span className="text-muted-foreground">{label}:</span>
      {values.map((value) => (
        <Badge key={value} variant="outline">
          {value}
        </Badge>
      ))}
    </div>
  );
}

function StepList({ steps }: { steps: SetupStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="list-decimal space-y-1 pl-5 text-sm">
      {steps.map((step, index) => (
        <li key={`${step.title}-${index}`}>
          <span className="font-medium">{step.title}</span>
          {step.description ? (
            <span className="text-muted-foreground"> — {step.description}</span>
          ) : null}
          {step.required_fields.length > 0 ? (
            <span className="block text-xs text-muted-foreground">
              Needs {step.required_fields.join(", ")}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function PreparedPlan({ plan }: { plan: RecipeApplyResponse }) {
  const manage = resolveSetupPath(plan.manage_path);
  const delegated = plan.status === "delegated";
  return (
    <div role="status" className="space-y-2 rounded-md border p-3 text-sm">
      <p className="font-medium">
        {delegated
          ? "Setup plan ready — no automation was created"
          : `Not prepared: the server classifies this recipe as ${plan.status}`}
      </p>
      <p className="break-words text-muted-foreground">{plan.message}</p>
      {plan.delegated_to ? (
        <p className="text-xs text-muted-foreground">
          Owning endpoint: <code className="break-all">{plan.delegated_to}</code>
        </p>
      ) : null}
      <TokenList label="Fields to supply" values={plan.required_fields} />
      <StepList steps={plan.next_steps} />
      {delegated && manage ? (
        <Button asChild variant="link" size="sm" className="h-auto px-0">
          <Link href={manage.href}>Continue in {manage.label} →</Link>
        </Button>
      ) : null}
    </div>
  );
}

export function RecipeApplyDialog({
  recipe,
  open,
  onOpenChange,
}: {
  recipe: RecipeRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const authority = useIntegrationLifecycleAuthority();
  const withheldId = useId();
  const detail = useQuery({
    queryKey: [...authority.baseKey, "recipe-detail", recipe.id] as const,
    queryFn: ({ signal }) =>
      integrationsLifecycleApi.recipeDetail(recipe.id, { signal }),
    enabled: open && authority.identity !== null,
    staleTime: STALE.detail,
    retry: false,
  });
  const prepare = useMutation({
    mutationFn: async () => {
      const controller = new AbortController();
      await authority.beforeWrite(controller.signal);
      return integrationsLifecycleApi.applyRecipe(recipe.id, {
        signal: controller.signal,
      });
    },
  });

  const reviewed = detail.data?.recipe ?? null;
  // The freshly read recipe wins over the list row that opened the dialog.
  const available = reviewed ? reviewed.available : recipe.available;
  const withheld = !available
    ? RECIPE_PLANNED_REASON
    : authority.pending
      ? "Checking your workspace role…"
      : !authority.canAdmin
        ? ADMIN_REQUIRED_REASON
        : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && prepare.isPending) return;
        if (!next) prepare.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent aria-busy={prepare.isPending}>
        <DialogHeader>
          <DialogTitle>{reviewed?.name ?? recipe.name}</DialogTitle>
          <DialogDescription>
            Review the recipe blueprint, then prepare its setup plan. Preparing
            creates no automation; it returns the owning surface and the
            fields it needs.
          </DialogDescription>
        </DialogHeader>

        {detail.isPending && detail.fetchStatus !== "idle" ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading recipe…
          </p>
        ) : null}
        {detail.isError ? (
          <div role="alert" className="space-y-2 text-sm">
            <p className="text-destructive">
              {apiErrorMessage(
                detail.error,
                "The recipe could not be loaded. This is a failed request, not an empty recipe.",
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
          </div>
        ) : null}

        {reviewed ? (
          <div className="space-y-3 text-sm">
            <p className="break-words text-muted-foreground">
              {reviewed.summary}
            </p>
            <div className="flex flex-wrap gap-2">
              <Badge variant={reviewed.available ? "success" : "secondary"}>
                {reviewed.available ? "Ready" : "Planned"}
              </Badge>
              {reviewed.estimated_minutes > 0 ? (
                <Badge variant="outline">
                  ~{reviewed.estimated_minutes} min
                </Badge>
              ) : null}
              {detail.data?.source ? (
                <Badge variant="outline">From {detail.data.source.name}</Badge>
              ) : null}
              {detail.data?.target ? (
                <Badge variant="outline">To {detail.data.target.name}</Badge>
              ) : null}
            </div>
            <dl className="grid gap-1 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Trigger</dt>
                <dd className="break-words">
                  {reviewed.blueprint.trigger || "Not declared"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Destination</dt>
                <dd className="break-words">
                  {reviewed.blueprint.destination || "Not declared"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Moosewave surface</dt>
                <dd className="break-words">
                  {reviewed.blueprint.postwave_surface || "Not declared"}
                </dd>
              </div>
            </dl>
            <TokenList
              label="Scopes"
              values={reviewed.blueprint.required_scopes}
            />
            <TokenList
              label="Secrets (vault references)"
              values={reviewed.blueprint.required_secrets}
            />
            {reviewed.blueprint.field_mappings.length > 0 ? (
              <ul className="space-y-0.5 text-xs">
                {reviewed.blueprint.field_mappings.map((mapping) => (
                  <li key={`${mapping.source}-${mapping.target}`}>
                    <code>{mapping.source}</code> →{" "}
                    <code>{mapping.target}</code>
                    {mapping.required ? " (required)" : ""}
                  </li>
                ))}
              </ul>
            ) : null}
            <StepList steps={reviewed.steps} />
          </div>
        ) : null}

        {prepare.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {apiErrorMessage(
              prepare.error,
              `${recipe.name} setup could not be prepared.`,
            )}
          </p>
        ) : null}
        {prepare.data ? <PreparedPlan plan={prepare.data} /> : null}

        <DialogFooter className="items-start">
          {withheld ? (
            <p
              id={withheldId}
              className="text-xs text-muted-foreground sm:mr-auto sm:max-w-xs"
            >
              {withheld}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={prepare.isPending}
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          <Button
            type="button"
            disabled={withheld !== null || Boolean(prepare.data)}
            loading={prepare.isPending}
            aria-describedby={withheld ? withheldId : undefined}
            onClick={() => prepare.mutate()}
          >
            {prepare.data ? "Setup plan prepared" : "Prepare setup plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
