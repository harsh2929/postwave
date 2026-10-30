// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery } from "@tanstack/react-query";
import { Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { apiErrorMessage } from "@/lib/api";
import type { AudienceList } from "@/lib/lists-api";
import { listKeys, STALE, type RoleKey } from "@/lib/query-keys";

export function ListOverviewTab({
  list,
  tenantId,
  roleKey,
  onOpenMembers,
}: {
  list: AudienceList;
  tenantId: string;
  roleKey: RoleKey;
  onOpenMembers: () => void;
}) {
  // One-row page: only the server-side total is wanted here.
  const count = useQuery({
    queryKey: listKeys.members(tenantId, roleKey, list.id, "count"),
    // Loaded on demand: the lists API module stays off the eager route graph.
    queryFn: async ({ signal }) => {
      const { listMembers } = await import("@/lib/lists-api");
      return listMembers(list.id, { page: 1, perPage: 1 }, signal);
    },
    staleTime: STALE.detail,
  });

  return (
    <div className="space-y-4">
      <section
        aria-label="List summary"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Stat
          label="Members"
          value={
            count.isPending ? (
              <span className="text-muted-foreground">…</span>
            ) : count.isError ? (
              <span className="text-sm font-normal text-destructive">
                {apiErrorMessage(count.error, "Unavailable")}
              </span>
            ) : (
              count.data.total.toLocaleString()
            )
          }
        />
        <Stat label="Visibility" value={list.type} />
        <Stat label="Opt-in" value={list.optin} />
        <Stat
          label="Tags"
          value={list.tags.length ? list.tags.join(", ") : "None"}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-base">
            Description
          </CardTitle>
          <CardDescription>
            Shown to operators in the dashboard; public lists also surface it on
            hosted preference pages.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {list.description || (
            <span className="text-muted-foreground">No description</span>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-base">
            Identity
          </CardTitle>
          <CardDescription>
            The engine id addresses catalogue and update routes; the Moosewave
            UUID addresses membership and analytics.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <Field label="Engine id" value={String(list.id)} />
          <Field
            label="Moosewave UUID"
            value={list.postwave_uuid ?? "Not mapped"}
          />
        </CardContent>
      </Card>

      <Button type="button" variant="outline" onClick={onOpenMembers}>
        <Users aria-hidden className="size-4" /> Browse members
      </Button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <div className="mt-2 break-words text-lg font-semibold tabular-nums">
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 break-all font-mono text-xs">{value}</p>
    </div>
  );
}
