// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AuditRow } from "@/lib/audit-api";
import {
  chunkEvidenceIds,
  describeInvestigationError,
  getAuditEventsByIds,
} from "@/lib/audit-investigations-api";
import { qk, STALE, type RoleKey } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

export interface EvidenceFailure {
  ids: number[];
  message: string;
  retry: () => void;
}

export interface EvidenceState {
  rows: Map<number, AuditRow>;
  loading: boolean;
  failures: EvidenceFailure[];
  /** Distinct ids asked for. */
  wanted: number;
}

/**
 * Every audit row an investigation cites, fetched once for the whole page
 * through the batch endpoint in ≤100-id chunks. A failed chunk is reported
 * with its own Retry and does not discard what the other chunks returned;
 * only a fully successful fetch that comes up short means rows are gone.
 */
export function useEvidenceRows(
  ids: readonly number[],
  tenantId: string,
  roleKey: RoleKey,
): EvidenceState {
  const chunks = useMemo(() => chunkEvidenceIds(ids), [ids]);
  const results = useQueries({
    queries: chunks.map((chunk) => ({
      queryKey: qk.audit(tenantId, roleKey, {
        surface: "audit-events",
        ids: chunk,
      }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getAuditEventsByIds(chunk, { signal }),
      staleTime: STALE.detail,
      retry: false,
    })),
  });

  const rows = new Map<number, AuditRow>();
  const failures: EvidenceFailure[] = [];
  let loading = false;
  results.forEach((result, index) => {
    const chunk = chunks[index] ?? [];
    if (result.isPending) loading = true;
    if (result.isError) {
      failures.push({
        ids: chunk,
        message: describeInvestigationError(
          result.error,
          "Could not load evidence rows.",
        ),
        retry: () => void result.refetch(),
      });
    }
    for (const row of Array.isArray(result.data) ? result.data : []) {
      rows.set(Number(row.id), row);
    }
  });
  return {
    rows,
    loading,
    failures,
    wanted: chunks.reduce((n, chunk) => n + chunk.length, 0),
  };
}

function actorLine(row: AuditRow): string {
  return `${row.actorLabel ?? "—"} · ${row.actorType}`;
}

/** Cited rows oldest-to-newest, the seed event marked. */
export function EvidenceTimeline({
  seedAuditId,
  evidence,
}: {
  seedAuditId: number;
  evidence: EvidenceState;
}) {
  if (evidence.loading && evidence.rows.size === 0) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading timeline…
      </p>
    );
  }
  const rows = [...evidence.rows.values()].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at),
  );
  const missing =
    evidence.failures.length === 0 && !evidence.loading
      ? Math.max(0, evidence.wanted - rows.length)
      : 0;
  return (
    <div className="space-y-3">
      {evidence.failures.map((failure) => (
        <Alert key={failure.ids.join(",")} variant="destructive">
          <AlertTitle>
            Couldn&apos;t load {failure.ids.length} of {evidence.wanted}{" "}
            evidence {evidence.wanted === 1 ? "row" : "rows"}
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span>{failure.message}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={failure.retry}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ))}
      {missing > 0 ? (
        <p className="text-sm text-muted-foreground">
          {missing} of {evidence.wanted} evidence{" "}
          {evidence.wanted === 1 ? "row is" : "rows are"} no longer in the audit
          log (retention-trimmed).
        </p>
      ) : null}
      {rows.length === 0 ? (
        evidence.failures.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No evidence rows cited.
          </p>
        ) : null
      ) : (
        <ol
          className="ml-1.5 space-y-3 border-l-2 border-border pl-4"
          data-testid="investigation-timeline"
        >
          {rows.map((row) => {
            const isSeed = Number(row.id) === seedAuditId;
            return (
              <li key={row.id} className="relative text-sm">
                <span
                  aria-hidden
                  className={cn(
                    "absolute -left-[1.45rem] top-1.5 h-3 w-3 rounded-full border-2 border-primary",
                    isSeed ? "bg-primary" : "bg-background",
                  )}
                />
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <RelativeTime iso={row.at} />
                  {isSeed ? <Badge variant="outline">seed</Badge> : null}
                </div>
                <div className="font-medium">{row.action}</div>
                <div className="text-xs text-muted-foreground">
                  {actorLine(row)}
                  {row.resourceId ? ` · ${row.resourceId}` : ""}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/** One cited row inside a hypothesis — the drill from claim to source. */
export function EvidenceCard({
  auditId,
  evidence,
}: {
  auditId: number;
  evidence: EvidenceState;
}) {
  const row = evidence.rows.get(auditId);
  const failure = evidence.failures.find((f) => f.ids.includes(auditId));
  return (
    <div
      className="rounded-md border border-l-4 border-l-primary p-3 text-sm"
      data-testid="investigation-evidence-card"
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-mono">#{auditId}</span>
        {row ? <RelativeTime iso={row.at} /> : null}
      </div>
      {row ? (
        <>
          <div className="mt-1 font-medium">{row.action}</div>
          <div className="text-xs text-muted-foreground">
            {actorLine(row)}
            {row.resourceId ? ` · resource ${row.resourceId}` : ""}
          </div>
          {row.ip ? (
            <div className="mt-0.5 font-mono text-xs text-muted-foreground">
              ip {row.ip}
            </div>
          ) : null}
        </>
      ) : failure ? (
        <p className="mt-1 text-xs text-destructive">{failure.message}</p>
      ) : evidence.loading ? (
        <p className="mt-1 text-xs text-muted-foreground">Loading audit row…</p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          Audit row #{auditId} is no longer in the audit log.
        </p>
      )}
    </div>
  );
}
