// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Custom-field governance caps (desktop reference:
 * components/settings/CustomFieldGovernance.tsx — "Configure limits").
 *
 * Renders the effective caps against live usage and, for owners/admins, an
 * inline editor that PUTs only the caps that changed. Everyone else sees the
 * usage read-only with the reason, never a 403 surprise: the PUT is mounted
 * behind the admin scope (customfields.MountSettingsRoutes).
 *
 * Self-contained so it can be mounted by the custom-fields settings page with
 * that page's identity and query-key base.
 */

import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import {
  getCustomFieldLimits,
  MAX_CUSTOM_FIELD_CAP,
  updateCustomFieldLimits,
  type CustomFieldLimits,
  type CustomFieldLimitsUpdate,
} from "@/lib/custom-field-limits-api";
import { STALE } from "@/lib/query-keys";

/** Usage fraction at which a bar reads as "near limit" (desktop parity). */
const WARN_FRACTION = 0.9;

export function canManageCustomFieldLimits(
  identity: MeResponse | null | undefined,
): boolean {
  if (!identity || identity.viewer_mode === true) return false;
  const role = effectiveAuthRole(identity);
  return role === "owner" || role === "admin";
}

/** A whole number ≥ 0 within the column's range, or null when it is not. */
function parseCap(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value <= MAX_CUSTOM_FIELD_CAP
    ? value
    : null;
}

export function CustomFieldLimitsCard({
  identity,
  queryBase,
}: {
  identity: MeResponse | null | undefined;
  queryBase: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const limitsKey = [...queryBase, "limits"] as const;
  const maxId = useId();
  const searchableId = useId();
  const [editing, setEditing] = useState(false);
  const [draftMax, setDraftMax] = useState("");
  const [draftSearchable, setDraftSearchable] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const canManage = canManageCustomFieldLimits(identity);
  const limitsQuery = useQuery({
    queryKey: limitsKey,
    queryFn: ({ signal }) => getCustomFieldLimits(signal),
    enabled: Boolean(identity),
    staleTime: STALE.list,
  });
  const limits = limitsQuery.data;

  const save = useMutation({
    mutationFn: (input: CustomFieldLimitsUpdate) =>
      updateCustomFieldLimits(input),
    onSuccess: (next: CustomFieldLimits) => {
      queryClient.setQueryData(limitsKey, next);
      setEditing(false);
      setSaved(true);
    },
  });

  function beginEdit() {
    if (!limits || !canManage) return;
    setDraftMax(String(limits.max_custom_fields));
    setDraftSearchable(String(limits.max_searchable_fields));
    setInputError(null);
    setSaved(false);
    save.reset();
    setEditing(true);
  }

  function cancelEdit() {
    if (save.isPending) return;
    setEditing(false);
    setInputError(null);
    save.reset();
  }

  const parsedMax = parseCap(draftMax);
  const parsedSearchable = parseCap(draftSearchable);
  const dirty =
    editing &&
    limits !== undefined &&
    (draftMax.trim() !== String(limits.max_custom_fields) ||
      draftSearchable.trim() !== String(limits.max_searchable_fields));

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!limits || !canManage || save.isPending || !dirty) return;
    if (parsedMax === null) {
      setInputError(
        "Max total fields must be a whole number of 0 or more.",
      );
      return;
    }
    if (parsedSearchable === null) {
      setInputError(
        "Max searchable fields must be a whole number of 0 or more.",
      );
      return;
    }
    // Only changed caps are sent; the server keeps an omitted cap as it is.
    const input: CustomFieldLimitsUpdate = {};
    if (parsedMax !== limits.max_custom_fields) {
      input.max_custom_fields = parsedMax;
    }
    if (parsedSearchable !== limits.max_searchable_fields) {
      input.max_searchable_fields = parsedSearchable;
    }
    if (
      input.max_custom_fields === undefined &&
      input.max_searchable_fields === undefined
    ) {
      setEditing(false);
      return;
    }
    setInputError(null);
    save.mutate(input);
  }

  const belowUsage =
    limits !== undefined &&
    ((parsedMax !== null && parsedMax < limits.used_custom_fields) ||
      (parsedSearchable !== null &&
        parsedSearchable < limits.used_searchable_fields));

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0">
          <CardTitle className="text-base">Custom-field limits</CardTitle>
          <CardDescription className="mt-1">
            Workspace caps on custom-field definitions and how many may be
            searchable. Limits are enforced when new fields are created.
          </CardDescription>
        </div>
        {limits && canManage && !editing ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 shrink-0 sm:min-h-9"
            onClick={beginEdit}
          >
            <SlidersHorizontal aria-hidden />
            Configure limits
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {limitsQuery.isPending ? (
          <div role="status" aria-label="Loading custom-field limits">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="mt-3 h-10 w-full" />
          </div>
        ) : limitsQuery.isError || !limits ? (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="min-w-0 break-words text-destructive-emphasis">
              {apiErrorMessage(
                limitsQuery.error,
                "Custom-field limits could not be loaded. No usage is being inferred.",
              )}
            </span>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 shrink-0 sm:min-h-9"
              loading={limitsQuery.isFetching}
              onClick={() => void limitsQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <>
            <UsageBar
              label="Total fields"
              used={limits.used_custom_fields}
              max={limits.max_custom_fields}
            />
            <UsageBar
              label="Searchable fields"
              used={limits.used_searchable_fields}
              max={limits.max_searchable_fields}
            />

            {editing ? (
              <form className="space-y-3" onSubmit={onSubmit} noValidate>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={maxId}>Max total fields</Label>
                    <Input
                      id={maxId}
                      type="number"
                      min={0}
                      max={MAX_CUSTOM_FIELD_CAP}
                      step={1}
                      inputMode="numeric"
                      value={draftMax}
                      disabled={save.isPending}
                      aria-invalid={parsedMax === null}
                      onChange={(event) => setDraftMax(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={searchableId}>Max searchable fields</Label>
                    <Input
                      id={searchableId}
                      type="number"
                      min={0}
                      max={MAX_CUSTOM_FIELD_CAP}
                      step={1}
                      inputMode="numeric"
                      value={draftSearchable}
                      disabled={save.isPending}
                      aria-invalid={parsedSearchable === null}
                      onChange={(event) =>
                        setDraftSearchable(event.target.value)
                      }
                    />
                  </div>
                </div>
                {belowUsage ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    A cap below current usage keeps every existing field; new
                    fields are refused until usage drops under it.
                  </p>
                ) : null}
                {inputError || save.error ? (
                  <p
                    role="alert"
                    className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
                  >
                    {inputError ??
                      apiErrorMessage(
                        save.error,
                        "Custom-field limits could not be saved. Nothing was assumed to have changed.",
                      )}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    className="min-h-11 sm:min-h-9"
                    loading={save.isPending}
                    disabled={!dirty}
                  >
                    Save limits
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11 sm:min-h-9"
                    disabled={save.isPending}
                    onClick={cancelEdit}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : !canManage ? (
              <p className="text-xs text-muted-foreground">
                Only workspace owners and admins can change these limits.
              </p>
            ) : null}

            {saved && !editing ? (
              <p role="status" className="text-sm text-muted-foreground">
                Custom-field limits updated.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function UsageBar({
  label,
  used,
  max,
}: {
  label: string;
  used: number;
  max: number;
}) {
  // The server refuses a create once usage >= cap, so a cap of 0 is always
  // "at limit" — including with nothing used yet.
  const atLimit = used >= max;
  const percent = max > 0 ? Math.round((used / max) * 100) : 100;
  const width = max > 0 ? Math.min(used / max, 1) * 100 : 100;
  const nearLimit = !atLimit && used / max >= WARN_FRACTION;
  const state = atLimit ? " · at limit" : nearLimit ? " · near limit" : "";
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="ml-auto tabular-nums text-muted-foreground">
          {used.toLocaleString()} / {max.toLocaleString()}
          {max > 0 ? ` (${percent}%)` : ""}
        </span>
        {atLimit ? (
          <Badge variant="destructive">At limit</Badge>
        ) : nearLimit ? (
          <Badge variant="warning">Near limit</Badge>
        ) : null}
      </div>
      <div
        role="progressbar"
        aria-label={`${label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.max(0, Math.min(100, percent))}
        aria-valuetext={`${used} of ${max} fields used${state}`}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={
            atLimit
              ? "h-full bg-destructive"
              : nearLimit
                ? "h-full bg-warning"
                : "h-full bg-primary"
          }
          style={{ width: `${width.toFixed(1)}%` }}
        />
      </div>
    </div>
  );
}
