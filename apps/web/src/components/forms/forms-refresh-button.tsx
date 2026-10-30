// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Explicit "Refresh" for the forms inventory (desktop Forms.tsx toolbar).
// Observes the SAME query the forms list reads, so one click re-issues
// GET /api/v1/forms and the list re-renders from the answer. The observer is
// disabled: it never fetches on its own, only when the operator asks.

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import { listForms } from "@/lib/forms-api";
import { base, qk, STALE } from "@/lib/query-keys";

/** The key forms-list-client.tsx reads the inventory under. */
export function formsListQueryKey(identity: MeResponse | null | undefined) {
  const tenantId = identity?.tenant_id ?? "anon";
  const role = identity ? effectiveAuthRole(identity) : null;
  return [
    ...base("forms", tenantId, role),
    identity?.user_id ?? "anon",
    identity?.viewer_mode === true,
    "list",
  ] as const;
}

type Outcome =
  | { kind: "idle" }
  | { kind: "ok"; count: number }
  | { kind: "error"; message: string };

export function FormsRefreshButton() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const formsQuery = useQuery({
    queryKey: formsListQueryKey(meQuery.data),
    queryFn: listForms,
    enabled: false,
    staleTime: STALE.list,
  });
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const refreshing = formsQuery.isFetching;

  async function refresh() {
    setOutcome({ kind: "idle" });
    const result = await formsQuery.refetch();
    if (result.error) {
      setOutcome({
        kind: "error",
        message: apiErrorMessage(result.error, "Could not refresh forms."),
      });
      return;
    }
    const rows = Array.isArray(result.data) ? result.data : [];
    setOutcome({ kind: "ok", count: rows.length });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void refresh()}
        disabled={!meQuery.isFetched || refreshing}
        aria-busy={refreshing}
      >
        <RefreshCw
          className={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
          aria-hidden
        />
        {refreshing ? "Refreshing…" : "Refresh"}
      </Button>
      <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
        {outcome.kind === "ok"
          ? `Refreshed · ${outcome.count.toLocaleString()} ${outcome.count === 1 ? "form" : "forms"}`
          : ""}
      </span>
      {outcome.kind === "error" ? (
        <span role="alert" className="text-xs text-destructive">
          {outcome.message}
        </span>
      ) : null}
    </div>
  );
}
