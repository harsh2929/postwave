// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * One connected store as the scope for per-integration commerce records.
 *
 * Recovery and Lifecycle both read everything under one integration, so they
 * share this: the store list (cached under the workspace's integrations key,
 * the same entry the catalog dialog fills), a selection that defaults to the
 * first store and repairs itself if the chosen store disappears, and the
 * select control that drives it. Switching stores only changes what is read;
 * it never creates or updates a record.
 */

import { useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import { commerceApi, type CommerceIntegration } from "@/lib/commerce-api";
import { integrationLabel } from "@/lib/commerce-lifecycle-helpers";
import { STALE } from "@/lib/query-keys";

import { commerceKeys, type CommerceWorkspaceContext } from "./commerce-context";
import { FieldHint } from "./commerce-primitives";

/**
 * The server's own sentence for a per-store route. NOT the catalogs reading
 * of a 404: on these routes a 404 is "integration not found" / "product not
 * found", which is precisely what the reader needs, and rendering the
 * catalogs sentence instead would blame the whole feature for a bad store id.
 */
export function storeRouteFailureMessage(error: unknown): string {
  return apiErrorMessage(error, "The request could not be completed.");
}

export interface StoreScope {
  query: UseQueryResult<CommerceIntegration[]>;
  /** null until the store list has settled (loaded or failed). */
  integrations: CommerceIntegration[] | null;
  selectedId: string;
  selected: CommerceIntegration | null;
  /** Heading/confirm name for the selected store. */
  label: string;
  select: (integrationId: string) => void;
}

export function useStoreScope(ctx: CommerceWorkspaceContext): StoreScope {
  const query = useQuery({
    queryKey: commerceKeys.integrations(ctx.scopeKey),
    queryFn: commerceApi.integrations,
    enabled: ctx.ready,
    staleTime: STALE.list,
  });
  const integrations = Array.isArray(query.data) ? query.data : null;
  const [choice, setChoice] = useState("");
  // Derived rather than effect-repaired, so a removed store never gets one
  // paint of its records before the selection moves on.
  const selectedId = integrations
    ? integrations.some((item) => item.id === choice)
      ? choice
      : (integrations[0]?.id ?? "")
    : "";
  const selected =
    integrations?.find((item) => item.id === selectedId) ?? null;
  return {
    query,
    integrations,
    selectedId,
    selected,
    label: selected ? integrationLabel(selected) : "selected store",
    select: setChoice,
  };
}

export function StoreScopeSelect({
  id,
  scope,
  disabled,
  help,
}: {
  id: string;
  scope: StoreScope;
  disabled?: boolean;
  help: string;
}) {
  const stores = scope.integrations;
  return (
    <div className="max-w-md space-y-1.5">
      <Label htmlFor={id}>Store</Label>
      <Select
        id={id}
        value={scope.selectedId}
        onChange={(event) => scope.select(event.target.value)}
        disabled={disabled || stores === null || stores.length === 0}
        aria-describedby={`${id}-hint`}
      >
        {stores === null ? (
          <option value="">
            {scope.query.isError
              ? "Connected stores could not be loaded"
              : "Loading connected stores…"}
          </option>
        ) : stores.length === 0 ? (
          <option value="">No connected store is available</option>
        ) : (
          stores.map((integration) => (
            <option key={integration.id} value={integration.id}>
              {integration.shop_domain || integration.provider} ·{" "}
              {integration.provider}
            </option>
          ))
        )}
      </Select>
      <FieldHint id={`${id}-hint`}>{help}</FieldHint>
    </div>
  );
}
