// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Radio } from "lucide-react";
import { isSafeResourceId } from "@postwave/route-map";

import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  describeInvestigationError,
  getAuditInvestigation,
} from "@/lib/audit-investigations-api";
import { qk, STALE } from "@/lib/query-keys";

import {
  AuditAccessGate,
  type AuditAccess,
} from "../_components/audit-access-gate";
import {
  InvestigationStatusBadge,
  confidenceBucket,
  confidencePercent,
  mitreTechniqueHref,
} from "../_components/investigation-status";
import {
  INVESTIGATION_POLL_INTERVAL_MS,
  useInvestigationStream,
  type InvestigationStreamMode,
} from "../_components/use-investigation-stream";

const LIST_HREF = "/app/settings/audit/investigations";

// The evidence viewer and the remediation plan render once the investigation
// itself has loaded and carry the evidence client and decision dialogs with
// them; splitting them keeps the route under the dashboard bundle budget
// without changing what reviewers see.
const InvestigationEvidenceViewer = dynamic(
  () =>
    import("./investigation-evidence-viewer").then(
      (module) => module.InvestigationEvidenceViewer,
    ),
  {
    loading: () => (
      <div
        className="grid gap-6 lg:grid-cols-[minmax(16rem,1fr)_2fr]"
        role="status"
        aria-label="Loading evidence"
      >
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
        <span className="sr-only">Loading evidence…</span>
      </div>
    ),
  },
);

const InvestigationRemediation = dynamic(
  () =>
    import("./investigation-remediation").then(
      (module) => module.InvestigationRemediation,
    ),
  {
    loading: () => (
      <div role="status" aria-label="Loading remediation plan">
        <Skeleton className="h-32 w-full" />
        <span className="sr-only">Loading remediation plan…</span>
      </div>
    ),
  },
);

/**
 * governance-35/36/37: one investigation — its evidence timeline, numbered
 * hypotheses with their cited rows, the proposed remediation plan, and the
 * whole-plan Approve / Reject decision, kept current by the server's SSE
 * feed (polling when that cannot connect).
 */
export default function AuditInvestigationDetailPage() {
  const params = useParams<{ id?: string }>();
  const rawId = typeof params?.id === "string" ? params.id : "";
  // The id is interpolated into API paths and a route; refuse anything that
  // is not a plain id rather than encoding around it.
  const id = isSafeResourceId(rawId) ? rawId : null;
  return (
    <AuditAccessGate title="Investigation">
      {(access) =>
        id ? (
          <InvestigationDetail id={id} access={access} />
        ) : (
          <InvalidInvestigationId />
        )
      }
    </AuditAccessGate>
  );
}

function InvalidInvestigationId() {
  return (
    <div className="max-w-3xl space-y-4">
      <header>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          Investigation
        </h2>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Not a valid investigation id</CardTitle>
          <CardDescription>
            Nothing was requested. Pick an investigation from the list.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link href={LIST_HREF}>All investigations</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function InvestigationDetail({
  id,
  access,
}: {
  id: string;
  access: AuditAccess;
}) {
  const queryClient = useQueryClient();
  const detailKey = useMemo(
    () =>
      qk.audit(access.tenantId, access.roleKey, {
        surface: "investigation",
        id,
      }),
    [access.tenantId, access.roleKey, id],
  );
  const listKey = useMemo(
    () =>
      qk.audit(access.tenantId, access.roleKey, { surface: "investigations" }),
    [access.tenantId, access.roleKey],
  );
  // A stream frame says the status moved; the persisted row is what we
  // render, so refetch rather than trust the frame.
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: detailKey });
  }, [queryClient, detailKey]);
  const stream = useInvestigationStream(id, refresh);

  const detailQuery = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => getAuditInvestigation(id, { signal }),
    staleTime: STALE.detail,
    retry: false,
    refetchInterval:
      stream.mode === "polling" ? INVESTIGATION_POLL_INTERVAL_MS : false,
  });
  const investigation = detailQuery.data;

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: detailKey });
    void queryClient.invalidateQueries({ queryKey: listKey });
  };

  if (detailQuery.isPending) {
    return (
      <div className="max-w-5xl space-y-4" role="status">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
        <span className="sr-only">Loading investigation…</span>
      </div>
    );
  }

  if (detailQuery.isError || !investigation) {
    return (
      <div className="max-w-3xl space-y-4">
        <header>
          <h2 className="font-display text-xl font-semibold tracking-tight">
            Investigation
          </h2>
        </header>
        <Card>
          <CardHeader>
            <CardTitle>Could not load this investigation</CardTitle>
            <CardDescription>
              {describeInvestigationError(
                detailQuery.error,
                "The investigation request failed.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={detailQuery.isFetching}
              onClick={() => void detailQuery.refetch()}
            >
              {detailQuery.isFetching ? "Retrying…" : "Retry"}
            </Button>
            <Button asChild variant="ghost">
              <Link href={LIST_HREF}>All investigations</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const percent = confidencePercent(investigation.confidence);
  const bucket = confidenceBucket(investigation.confidence);
  const findingCount = investigation.findings.length;
  const actionCount = investigation.proposed_actions.length;

  return (
    <div className="max-w-6xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-tight">
            Investigation · seed #{investigation.seed_audit_id}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Created <RelativeTime iso={investigation.created_at} /> ·{" "}
            {findingCount} {findingCount === 1 ? "hypothesis" : "hypotheses"} ·{" "}
            {actionCount} proposed {actionCount === 1 ? "action" : "actions"}
          </p>
        </div>
        <Button asChild type="button" variant="ghost" size="sm">
          <Link href={LIST_HREF}>
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
            All investigations
          </Link>
        </Button>
      </header>

      <Card>
        <CardContent className="flex flex-wrap items-start gap-6 pt-6">
          <div className="min-w-[15rem] flex-1 space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Confidence
            </p>
            <Progress value={percent} aria-label={`Confidence ${percent}%`} />
            <p className="text-sm" data-testid="investigation-confidence">
              {percent}% · {bucket}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Status
            </p>
            <InvestigationStatusBadge status={investigation.status} />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              MITRE ATT&amp;CK
            </p>
            <div className="flex flex-wrap gap-1.5">
              {investigation.mitre_techniques.length === 0 ? (
                <span className="text-sm text-muted-foreground">
                  None tagged.
                </span>
              ) : (
                investigation.mitre_techniques.map((technique) => {
                  const href = mitreTechniqueHref(technique);
                  return href ? (
                    <a
                      key={technique}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs underline-offset-2 hover:underline"
                    >
                      {technique}
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  ) : (
                    <code
                      key={technique}
                      className="rounded bg-muted px-1.5 py-0.5 text-xs"
                    >
                      {technique}
                    </code>
                  );
                })
              )}
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Live status
            </p>
            <StreamStatus mode={stream.mode} />
          </div>
        </CardContent>
      </Card>

      <InvestigationEvidenceViewer
        investigation={investigation}
        tenantId={access.tenantId}
        roleKey={access.roleKey}
      />

      <Card>
        <CardHeader>
          <CardTitle>Proposed remediation actions</CardTitle>
          <CardDescription>
            Every action requires human review. Approval records acceptance of
            the complete plan; Moosewave does not apply identity, key, token,
            MFA, or IP changes — carry approved actions out through your
            external operations workflow. Rejecting records the dismissal with
            the supplied reason.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <InvestigationRemediation
            id={id}
            investigation={investigation}
            isAdmin={access.capabilities.isAdmin}
            onDecided={invalidate}
          />
        </CardContent>
      </Card>

      {stream.events.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Live status log</CardTitle>
            <CardDescription>
              Status transitions as the server announced them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre
              className="max-h-52 overflow-auto rounded-md bg-muted p-3 font-mono text-xs"
              data-testid="investigation-stream-log"
            >
              {stream.events
                .map(
                  (event) =>
                    `[${event.ts ?? ""}] ${event.type}: ${event.message ?? event.status ?? ""}`,
                )
                .join("\n")}
            </pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

const STREAM_COPY: Record<InvestigationStreamMode, string> = {
  connecting: "Connecting to live updates…",
  live: "Live — status changes appear without a reload.",
  polling: `Live updates unavailable — re-checking every ${INVESTIGATION_POLL_INTERVAL_MS / 1000}s.`,
  closed: "Not connected.",
};

function StreamStatus({ mode }: { mode: InvestigationStreamMode }) {
  return (
    <p
      className="flex items-center gap-1.5 text-sm"
      data-stream-mode={mode}
      role="status"
    >
      <Radio
        className={
          mode === "live"
            ? "h-3.5 w-3.5 text-success-emphasis"
            : "h-3.5 w-3.5 text-muted-foreground"
        }
        aria-hidden
      />
      {STREAM_COPY[mode]}
    </p>
  );
}
