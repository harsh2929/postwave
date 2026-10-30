// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Named target-list picker (FORM-033): replaces the raw numeric-ID input with
// a Select populated from GET /api/v1/lists. Persists the selected list's
// numeric id (as a string, matching FormSettings.targetListId). Degrades to a
// numeric input if the lists endpoint is unavailable, so wiring never breaks.

import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { listLists } from "@/lib/forms-api";
import { qk, STALE } from "@/lib/query-keys";

export function TargetListPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string | undefined) => void;
}) {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  // The effective role, like every other reader of the catalogue: a list
  // created or deleted on /app/lists invalidates `base("lists", tenant,
  // effectiveRole)`, and a durable-role key would miss it for an elevated
  // session and keep offering a deleted list for the whole staleTime.
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;

  const listsQuery = useQuery({
    queryKey: qk.lists(tenantId, role),
    queryFn: listLists,
    enabled: meQuery.isFetched,
    staleTime: STALE.reference,
  });

  const lists = useMemo(() => Array.isArray(listsQuery.data) ? listsQuery.data : [], [listsQuery.data]);
  // If the persisted id isn't among the fetched lists, still show it as an
  // option so the selection isn't silently lost.
  const hasValue = value !== "";
  const knownValue = useMemo(
    () => lists.some((l) => String(l.id) === value),
    [lists, value],
  );

  if (listsQuery.isError) {
    return (
      <div>
        <Label htmlFor="target-list">Target list ID</Label>
        <Input
          id="target-list"
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder="42"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Couldn&apos;t load your lists — enter the numeric Listmonk list ID
          directly.
        </p>
      </div>
    );
  }

  return (
    <div>
      <Label htmlFor="target-list">Target list</Label>
      <Select
        id="target-list"
        value={value}
        onChange={(e) => onChange(e.target.value || undefined)}
        disabled={listsQuery.isPending}
      >
        <option value="">No list (don&apos;t auto-subscribe)</option>
        {hasValue && !knownValue ? (
          <option value={value}>List #{value}</option>
        ) : null}
        {lists.map((l) => (
          <option key={l.id} value={String(l.id)}>
            {l.name}
            {typeof l.subscriberCount === "number"
              ? ` (${l.subscriberCount.toLocaleString()})`
              : ""}
          </option>
        ))}
      </Select>
      <p className="mt-1 text-xs text-muted-foreground">
        Confirmed sign-ups are subscribed into this list.
      </p>
    </div>
  );
}
