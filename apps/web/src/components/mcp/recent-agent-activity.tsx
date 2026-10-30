// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * A bounded, auto-refreshing view of the eight most recent recorded agent
 * calls, for the pages where someone is configuring an agent rather than
 * auditing one.
 *
 * WHY POLL RATHER THAN STREAM. The stream (`/api/v1/mcp/executions/stream`)
 * is the right tool when someone is watching. This strip sits beside a routine
 * editor, so it refreshes on an interval and stops when the tab is hidden —
 * a held-open EventSource behind an unattended tab costs a server goroutine
 * per viewer for information nobody is reading.
 *
 * DENIAL IS NOT AN ERROR, AND THE DIFFERENCE IS THE POINT. `/executions` is
 * owner/admin only. A 401/403 means "not for this role" — it must stop the
 * polling loop (retrying every few seconds changes nothing and buys log
 * noise) and offer an explicit "Check access again". Any other failure is
 * transient and keeps its "Retry now".
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage, isApiError } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import {
  formatMcpLatency,
  formatMcpTimestamp,
  listMcpExecutions,
  mcpStatusTone,
} from "@/lib/mcp-api";
import { base } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";

const POLL_MS = 15_000;
const MAX_ROWS = 8;

function isDenial(error: unknown): boolean {
  return isApiError(error) && (error.status === 401 || error.status === 403);
}

export function RecentAgentActivity({
  identity,
}: {
  identity: MeResponse | undefined;
}) {
  const role = identity ? effectiveAuthRole(identity) : null;
  const admin =
    identity !== undefined &&
    identity.viewer_mode !== true &&
    (role === "owner" || role === "admin");

  // Retrying a denial on a timer is noise, so a denial latches the loop off
  // until the operator explicitly asks again.
  const [accessCheck, setAccessCheck] = useState(0);
  const [denied, setDenied] = useState(false);

  const keyBase = useMemo(
    () =>
      base("mcp-recent", identity?.tenant_id ?? "anon", identity?.role ?? null),
    [identity?.role, identity?.tenant_id],
  );

  const recent = useQuery({
    queryKey: [...keyBase, accessCheck],
    queryFn: ({ signal }) =>
      listMcpExecutions({ include: "mcp", limit: MAX_ROWS }, signal),
    enabled: admin && !denied,
    refetchInterval: denied ? false : POLL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });

  useEffect(() => {
    if (isDenial(recent.error)) setDenied(true);
  }, [recent.error]);

  if (!admin) return null;

  const rows = Array.isArray(recent.data?.rows) ? recent.data.rows : [];

  return (
    <section
      aria-labelledby="recent-agent-activity-title"
      className="min-w-0 rounded-xl border bg-card p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            MCP receipt
          </p>
          <h2
            id="recent-agent-activity-title"
            className="mt-0.5 flex items-center gap-2 text-base font-semibold"
          >
            <History className="size-4" aria-hidden="true" />
            Recent agent activity
          </h2>
        </div>
        {!denied ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={asRoute("/app/agent-tools")}>Full history →</Link>
          </Button>
        ) : null}
      </header>

      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        While this page is visible, the last {MAX_ROWS} recorded self-identified
        npm-proxy calls are re-read about every {POLL_MS / 1_000} seconds. The
        recorder is best-effort and may be incomplete, so an empty list is not
        evidence that nothing ran.
      </p>

      {recent.isPending && !denied ? (
        <div role="status" aria-busy="true" className="mt-3 space-y-2">
          <span className="sr-only">Loading recent agent activity…</span>
          <Skeleton className="h-4 w-64 max-w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : denied ? (
        <div className="mt-3 rounded-lg border bg-muted/20 p-3">
          <p className="text-sm leading-6">
            {apiErrorMessage(
              recent.error,
              "Execution telemetry is available only to an effective owner or admin in this workspace.",
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => {
              setDenied(false);
              setAccessCheck((count) => count + 1);
            }}
          >
            Check access again
          </Button>
        </div>
      ) : recent.isError && rows.length === 0 ? (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3"
        >
          <p className="text-sm leading-6">
            {apiErrorMessage(
              recent.error,
              "Recent agent activity could not be read.",
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 bg-background"
            loading={recent.isFetching}
            onClick={() => void recent.refetch()}
          >
            Retry now
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed bg-muted/20 px-3 py-4 text-sm leading-5 text-muted-foreground">
          No recent agent call was returned for this workspace. New calls appear
          here after the next successful check.
        </p>
      ) : (
        <>
          {recent.isError ? (
            <p
              role="status"
              className="mt-3 text-xs leading-5 text-muted-foreground"
            >
              Showing the last rows that were read.{" "}
              {apiErrorMessage(
                recent.error,
                "The latest check did not complete.",
              )}
            </p>
          ) : null}
          <ul className="mt-3 divide-y rounded-lg border">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex min-w-0 flex-wrap items-center justify-between gap-2 p-3"
              >
                <div className="min-w-0">
                  <p className="min-w-0 break-all font-mono text-xs font-medium">
                    {row.toolName ?? `${row.method} ${row.path}`}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatMcpTimestamp(row.calledAt)} ·{" "}
                    {formatMcpLatency(row.latencyMs)}
                  </p>
                </div>
                <Badge variant={mcpStatusTone(row.statusCode)}>
                  {row.statusCode || "—"}
                </Badge>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
