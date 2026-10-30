// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// "Add these contacts to a list" — the import's optional destination.
//
// Importing a CSV used to leave the contacts in no list at all, so anyone
// importing an audience had to find them again in the directory and run a bulk
// Add to list; miss that second pass and the contacts sit outside every campaign
// that targets a list. The choice made here travels on the same PATCH as the
// column mapping (target_list_id), and the import writes the memberships itself.
//
// The catalogue read, its query key and its normalization are the ones every
// other list picker in the dashboard uses (listLists + qk.lists), so a list
// created or deleted elsewhere refreshes this menu too.

import { useQuery } from "@tanstack/react-query";

import { Select } from "@/components/ui/select";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { listLists } from "@/lib/forms-api";
import { pluralizeCount } from "@/lib/pluralize";
import { qk, STALE } from "@/lib/query-keys";

/** The chosen list: the id the API takes, and the name the wizard shows. */
export interface ImportTargetList {
  /** The list's engine id, as a string — what the catalogue rows carry. */
  id: string;
  name: string;
}

export function ImportTargetListStep({
  value,
  onChange,
  disabled = false,
}: {
  value: ImportTargetList | null;
  onChange: (next: ImportTargetList | null) => void;
  disabled?: boolean;
}) {
  const me = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const role = me.data ? effectiveAuthRole(me.data) : null;
  const listsQuery = useQuery({
    queryKey: qk.lists(me.data?.tenant_id ?? "anon", role),
    queryFn: listLists,
    enabled: me.isFetched,
    staleTime: STALE.reference,
  });
  const lists = Array.isArray(listsQuery.data) ? listsQuery.data : [];
  // A list chosen before the catalogue went stale stays selectable, so a slow
  // or failed refetch cannot silently drop the operator's choice.
  const chosenIsKnown =
    value === null || lists.some((list) => String(list.id) === value.id);

  return (
    <div className="rounded-md border bg-card p-3">
      <label
        htmlFor="import-target-list"
        className="text-sm font-medium"
      >
        Add these contacts to a list
      </label>
      <Select
        id="import-target-list"
        className="mt-2 w-full sm:w-72"
        aria-describedby="import-target-list-hint"
        value={value?.id ?? ""}
        disabled={disabled || listsQuery.isPending}
        onChange={(event) => {
          const id = event.target.value;
          if (!id) {
            onChange(null);
            return;
          }
          const picked = lists.find((list) => String(list.id) === id);
          onChange({ id, name: picked?.name ?? value?.name ?? "" });
        }}
      >
        <option value="">
          {listsQuery.isPending ? "Loading lists…" : "No list"}
        </option>
        {value !== null && !chosenIsKnown ? (
          <option value={value.id}>{value.name || `List ${value.id}`}</option>
        ) : null}
        {lists.map((list) => (
          <option key={list.id} value={String(list.id)}>
            {list.name}
            {typeof list.subscriberCount === "number"
              ? ` (${pluralizeCount(list.subscriberCount, "contact")})`
              : ""}
          </option>
        ))}
      </Select>
      <p id="import-target-list-hint" className="mt-2 text-xs text-muted-foreground">
        {listsQuery.isError
          ? "Your lists couldn’t be loaded, so the import can’t add contacts to one. Continue without a list, or retry after reloading — you can always add them from the contacts table afterwards."
          : lists.length === 0 && listsQuery.isSuccess
            ? "You don’t have any lists yet. Create one first if you want this import to join it; otherwise continue without a list."
            : "Optional. Every contact this import writes joins the list — the ones that already exist too. Leave it on “No list” to import without changing any list."}
      </p>
      {listsQuery.isError ? (
        <p role="status" className="sr-only">
          Lists unavailable.
        </p>
      ) : null}
    </div>
  );
}
