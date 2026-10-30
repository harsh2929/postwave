// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Microscope } from "lucide-react";
import { isSafeResourceId } from "@postwave/route-map";

import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  INVESTIGATION_LIST_LIMIT,
  describeInvestigationError,
  listAuditInvestigations,
} from "@/lib/audit-investigations-api";
import { qk, STALE } from "@/lib/query-keys";

import {
  AuditAccessGate,
  type AuditAccess,
} from "./_components/audit-access-gate";
import {
  InvestigationStatusBadge,
  confidencePercent,
} from "./_components/investigation-status";

/**
 * governance-34: the investigations the audit agent has drafted for this
 * workspace, newest first, each opening its own review page. Reads sit
 * behind the raw-audit gate because every investigation cites raw rows.
 */
export default function AuditInvestigationsPage() {
  return (
    <AuditAccessGate title="Investigations">
      {(access) => <InvestigationList access={access} />}
    </AuditAccessGate>
  );
}

function InvestigationList({ access }: { access: AuditAccess }) {
  const listQuery = useQuery({
    queryKey: qk.audit(access.tenantId, access.roleKey, {
      surface: "investigations",
    }),
    queryFn: ({ signal }) =>
      listAuditInvestigations({ limit: INVESTIGATION_LIST_LIMIT }, { signal }),
    staleTime: STALE.list,
    // A 503 from an unconfigured agent is an answer, not a blip: show it now
    // rather than after three silent retries.
    retry: false,
  });
  const items = Array.isArray(listQuery.data) ? listQuery.data : [];

  return (
    <div className="max-w-5xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-tight">
            Investigations
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Hypotheses and remediation plans the audit agent drafted from audit
            evidence. Every plan needs a human decision; Moosewave never applies
            one on its own.
          </p>
        </div>
        <Button asChild type="button" variant="ghost" size="sm">
          <Link href="/app/settings/audit">
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
            Audit log
          </Link>
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Recent investigations</CardTitle>
          <CardDescription>
            {listQuery.isSuccess
              ? `${items.length} ${items.length === 1 ? "investigation" : "investigations"} shown, newest first (up to ${INVESTIGATION_LIST_LIMIT}).`
              : `Newest first, up to ${INVESTIGATION_LIST_LIMIT}.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {listQuery.isPending ? (
            <div className="space-y-2 p-4" role="status">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <span className="sr-only">Loading investigations…</span>
            </div>
          ) : listQuery.isError ? (
            // Distinct from the empty state: a refused or failed request must
            // not read as "no investigations" on a security-response surface.
            <div className="p-4">
              <Alert variant="destructive">
                <AlertTitle>Could not load investigations</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center gap-2">
                  <span>
                    {describeInvestigationError(
                      listQuery.error,
                      "The investigations request failed.",
                    )}{" "}
                    This is a failed request, not an empty list.
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={listQuery.isFetching}
                    onClick={() => void listQuery.refetch()}
                  >
                    {listQuery.isFetching ? "Retrying…" : "Retry"}
                  </Button>
                </AlertDescription>
              </Alert>
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Microscope}
              title="No investigations yet"
              description="An investigation is started from a single audit event by an operator with audit:execute_actions. None has been run in this workspace."
            />
          ) : (
            <TableContainer className="border-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Seed event</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead>Hypotheses</TableHead>
                    <TableHead>Proposed actions</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Open</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((investigation) => {
                    // Ids come off the wire; one that is not a safe route
                    // segment is shown but not linked (no dead or rewritten
                    // routes), the same rule the audit log applies.
                    const href = isSafeResourceId(investigation.id)
                      ? (`/app/settings/audit/investigations/${investigation.id}` as const)
                      : null;
                    return (
                      <TableRow
                        key={investigation.id}
                        className="hover:bg-muted/20"
                        data-testid="investigation-row"
                      >
                        <TableCell className="font-mono text-xs">
                          #{investigation.seed_audit_id}
                        </TableCell>
                        <TableCell>
                          <InvestigationStatusBadge
                            status={investigation.status}
                          />
                        </TableCell>
                        <TableCell>
                          {confidencePercent(investigation.confidence)}%
                        </TableCell>
                        <TableCell>{investigation.findings.length}</TableCell>
                        <TableCell>
                          {investigation.proposed_actions.length}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          <RelativeTime iso={investigation.created_at} />
                        </TableCell>
                        <TableCell className="text-right">
                          {href ? (
                            <Button asChild variant="ghost" size="sm">
                              <Link
                                href={href}
                                aria-label={`Open investigation for audit event ${investigation.seed_audit_id}`}
                              >
                                Open
                              </Link>
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              Not addressable
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
