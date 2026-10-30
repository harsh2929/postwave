// SPDX-License-Identifier: AGPL-3.0-only
//
// Resource picker for flow fields that reference another entity by id
// (FLOW-009). Replaces the raw id text box with a native Select (platform
// type-ahead + mobile picker for free) populated from the entity's list API and
// showing the entity NAME, not the opaque id. Coupon pools remain explicitly
// release-held because their production inventory endpoint is not mounted.
"use client";

import { useId } from "react";
import { useQuery } from "@tanstack/react-query";

import { listSegments } from "@/lib/segments-api";
import { listCampaigns } from "@/lib/campaigns-api";
import { listLists } from "@/lib/forms-api";
import { listTemplates } from "@/lib/campaign-templates-api";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

import type { PickerEntity } from "./entity-picker-config";

export { PICKABLE_FIELDS } from "./entity-picker-config";
export type { PickerEntity } from "./entity-picker-config";

interface Option {
  id: string;
  name: string;
}

/** Upper bound on campaign rows pulled into the picker's <select>. */
const CAMPAIGN_OPTIONS_LIMIT = 200;

function usePickerOptions(entity: PickerEntity) {
  return useQuery<Option[]>({
    queryKey: ["flow-entity-picker", entity],
    // Coupon pool inventory is not a production capability. Keeping this
    // query disabled prevents the editor from turning the intentional hold
    // into a guaranteed-failing request and Retry loop.
    enabled: entity !== "coupon",
    queryFn: async () => {
      switch (entity) {
        case "segment": {
          const rows = await listSegments();
          return rows.map((s) => ({ id: s.id, name: s.name }));
        }
        case "list": {
          const rows = await listLists();
          return rows.map((l) => ({ id: String(l.id), name: l.name }));
        }
        case "coupon": {
          return [];
        }
        case "template": {
          const rows = await listTemplates();
          return rows.map((t) => ({ id: t.id, name: t.name }));
        }
        default: {
          // Bounded deliberately: with no limit the server falls through to its
          // 500-row ceiling and returns every campaign DOCUMENT (body_html,
          // MJML, blocks) to fill a dropdown that needs two strings per row.
          const rows = await listCampaigns({ limit: CAMPAIGN_OPTIONS_LIMIT });
          return rows.map((c) => ({ id: c.id, name: c.name }));
        }
      }
    },
    staleTime: 60_000,
  });
}

export function EntityPicker({
  entity,
  value,
  onChange,
  className,
  "aria-label": ariaLabel,
  disabled = false,
}: {
  entity: PickerEntity;
  value: string;
  onChange: (id: string) => void;
  className?: string;
  "aria-label"?: string;
  disabled?: boolean;
}) {
  const query = usePickerOptions(entity);
  const options = Array.isArray(query.data) ? query.data : [];
  const errorId = useId();
  const holdId = useId();

  if (entity === "coupon") {
    const displayValue = value.length > 96 ? `${value.slice(0, 93)}…` : value;
    return (
      <div className="space-y-2">
        <Select
          value={value}
          className={className}
          aria-label={ariaLabel}
          aria-describedby={holdId}
          disabled
          onChange={() => undefined}
        >
          <option value={value}>
            {value
              ? `Saved reference: ${displayValue}`
              : "Coupon pool selection is release-held"}
          </option>
        </Select>
        <p
          id={holdId}
          role="status"
          className="text-xs leading-5 text-muted-foreground"
        >
          Coupon-pool inventory and issuance are not mounted in production, so
          this field cannot be changed here.
          {value ? " The saved reference remains in this flow." : ""}
        </p>
      </div>
    );
  }
  // Keep a value that isn't in the fetched list (stale/legacy id) selectable so
  // the operator never silently loses the current reference.
  const hasValue = value !== "" && options.some((o) => o.id === value);
  const hasUsableValue = options.length > 0 || value !== "";

  return (
    <div className="space-y-1">
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={className}
        aria-label={ariaLabel}
        aria-busy={query.isFetching || undefined}
        aria-invalid={query.isError || undefined}
        aria-describedby={query.isError ? errorId : undefined}
        disabled={
          disabled || query.isLoading || (query.isError && !hasUsableValue)
        }
      >
        <option value="">
          {query.isLoading
            ? `Loading ${entity}s…`
            : query.isError
              ? `Could not load ${entity}s`
              : `— Select ${entity} —`}
        </option>
        {!hasValue && value ? (
          <option value={value}>{value} (not found)</option>
        ) : null}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
      {query.isError ? (
        <div
          id={errorId}
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 text-xs text-destructive"
        >
          <span>
            Could not {hasUsableValue ? "refresh" : "load"} {entity}s
            {hasUsableValue
              ? "; the available options may be incomplete."
              : "."}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-8"
            onClick={() => void query.refetch()}
            loading={query.isFetching}
          >
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}
