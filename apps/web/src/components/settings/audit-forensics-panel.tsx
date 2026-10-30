// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyTextButton } from "@/components/copy-text-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  auditExportJobDownloadPath,
  createAuditExportJob,
  getAuditAuthority,
  getAuditInclusionProof,
  getAuditStats,
  getLatestAuditCheckpoint,
  listAuditExportJobs,
  listAuditExportManifests,
  type AuditInclusionProof,
} from "@/lib/audit-operations-api";
import type { AuditFilters } from "@/lib/audit-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";
import { pluralizeCount } from "@/lib/pluralize";

export function AuditForensicsPanel({ filters }: { filters: AuditFilters }) {
  const queryClient = useQueryClient();
  const [active, setActive] = useState(false);
  const [proofId, setProofId] = useState("");
  const [proof, setProof] = useState<AuditInclusionProof | null>(null);
  const [proofBusy, setProofBusy] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);
  const [exportConfirmOpen, setExportConfirmOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportReceipt, setExportReceipt] = useState<string | null>(null);
  const [emailOnComplete, setEmailOnComplete] = useState(false);
  const [completionEmail, setCompletionEmail] = useState("");
  const filterKey = useMemo(
    () =>
      JSON.stringify([
        filters.actorType ?? "",
        filters.actorLabel ?? "",
        filters.action ?? "",
        filters.resourceType ?? "",
        filters.resourceId ?? "",
        filters.since ?? "",
      ]),
    [
      filters.action,
      filters.actorLabel,
      filters.actorType,
      filters.resourceId,
      filters.resourceType,
      filters.since,
    ],
  );
  const identityQuery = useQuery({
    queryKey: [...qk.authMe(), "audit-forensics-reauthorize"],
    queryFn: whoami,
    enabled: active,
    staleTime: 0,
    retry: false,
  });
  const tenantId = identityQuery.data?.tenant_id ?? "unverified";
  const role = identityQuery.data
    ? effectiveAuthRole(identityQuery.data)
    : null;
  const baseKey = useMemo(
    () => qk.settings(tenantId, role, "audit-forensics"),
    [role, tenantId],
  );
  const authorityQuery = useQuery({
    queryKey: [...baseKey, "authority"],
    queryFn: ({ signal }) => getAuditAuthority({ signal }),
    enabled: active && identityQuery.isSuccess,
    staleTime: 0,
    retry: false,
  });
  const canReadRaw =
    authorityQuery.data?.auditScopes?.includes("audit:read") === true &&
    authorityQuery.data.auditScopes.includes("audit:read_pii");
  const isAdmin = authorityQuery.data?.isAdmin === true;
  const canExportAsync =
    authorityQuery.data?.auditScopes?.includes("audit:execute_actions") === true;
  const statsQuery = useQuery({
    queryKey: [...baseKey, "stats", filterKey],
    queryFn: ({ signal }) =>
      getAuditStats(
        {
          actorType: filters.actorType,
          actorLabel: filters.actorLabel,
          action: filters.action,
          resourceType: filters.resourceType,
          resourceId: filters.resourceId,
          since: filters.since,
        },
        { signal },
      ),
    enabled: active && authorityQuery.isSuccess && canReadRaw,
    staleTime: STALE.list,
    retry: false,
  });
  const manifestsQuery = useQuery({
    queryKey: [...baseKey, "export-manifests"],
    queryFn: ({ signal }) => listAuditExportManifests(20, { signal }),
    enabled: active && authorityQuery.isSuccess && canReadRaw,
    staleTime: STALE.list,
    retry: false,
  });
  const exportJobsQuery = useQuery({
    queryKey: [...baseKey, "export-jobs"],
    queryFn: ({ signal }) => listAuditExportJobs(20, { signal }),
    enabled: active && authorityQuery.isSuccess && canReadRaw,
    staleTime: STALE.list,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some((job) =>
        ["pending", "in_progress"].includes(job.status),
      )
        ? 5_000
        : false,
  });
  const checkpointQuery = useQuery({
    queryKey: [...baseKey, "checkpoint"],
    queryFn: ({ signal }) => getLatestAuditCheckpoint({ signal }),
    enabled: active && authorityQuery.isSuccess && isAdmin,
    staleTime: STALE.reference,
    retry: false,
  });

  async function refresh(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: baseKey, exact: false });
  }

  async function requestProof(): Promise<void> {
    const id = Number(proofId);
    if (!Number.isSafeInteger(id) || id < 1 || proofBusy) return;
    setProofBusy(true);
    setProof(null);
    setProofError(null);
    try {
      const [freshIdentity, freshAuthority] = await Promise.all([
        whoami(),
        getAuditAuthority({ cache: "no-store" }),
      ]);
      if (
        freshIdentity.tenant_id !== identityQuery.data?.tenant_id ||
        freshIdentity.user_id !== identityQuery.data?.user_id ||
        effectiveAuthRole(freshIdentity) !== role ||
        !freshAuthority.isAdmin
      ) {
        throw new Error(
          "Workspace identity or proof authority changed. Reload before verifying evidence.",
        );
      }
      setProof(await getAuditInclusionProof(id));
    } catch (error) {
      setProofError(
        error instanceof Error
          ? error.message
          : "The inclusion proof could not be verified.",
      );
    } finally {
      setProofBusy(false);
    }
  }

  async function queueExport(): Promise<void> {
    if (exportBusy || !canExportAsync || filters.until) return;
    setExportBusy(true);
    setExportError(null);
    setExportReceipt(null);
    try {
      const [freshIdentity, freshAuthority] = await Promise.all([
        whoami(),
        getAuditAuthority({ cache: "no-store" }),
      ]);
      if (
        freshIdentity.tenant_id !== identityQuery.data?.tenant_id ||
        freshIdentity.user_id !== identityQuery.data?.user_id ||
        effectiveAuthRole(freshIdentity) !== role ||
        !freshAuthority.auditScopes.includes("audit:execute_actions")
      ) {
        throw new Error("authority_changed");
      }
      const job = await createAuditExportJob({
        actorType: filters.actorType,
        actorLabel: filters.actorLabel,
        action: filters.action,
        resourceType: filters.resourceType,
        resourceId: filters.resourceId,
        since: filters.since,
        emailOnComplete,
        ...(emailOnComplete ? { emailAddress: completionEmail.trim() } : {}),
      });
      setExportReceipt(
        `Export ${job.id} is queued${job.estimatedRows === undefined ? "" : ` for approximately ${pluralizeCount(job.estimatedRows, "row")}`}.`,
      );
      setExportConfirmOpen(false);
      setEmailOnComplete(false);
      setCompletionEmail("");
      await queryClient.invalidateQueries({
        queryKey: [...baseKey, "export-jobs"],
        exact: true,
      });
    } catch {
      setExportError(
        "The export job was not accepted. No background export receipt is being claimed.",
      );
    } finally {
      setExportBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Forensic verification</CardTitle>
          <CardDescription>
            Aggregate the server-supported active filters, inspect signed export
            manifests, and verify a row against a tenant Merkle checkpoint.
            Queries are scope-gated and deliberately bounded.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            if (active) void refresh();
            else setActive(true);
          }}
        >
          <RefreshCw aria-hidden />
          {active ? "Refresh forensics" : "Load forensics"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {!active ? (
          <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
            Forensic aggregation and proof inventory are loaded only on request.
          </div>
        ) : identityQuery.isPending || authorityQuery.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Binding forensic reads to the current workspace and audit scopes…
          </p>
        ) : identityQuery.isError || authorityQuery.isError ? (
          <Failure
            title="Forensic authority could not be verified"
            detail="No statistics, manifest, checkpoint, or proof is presented as current."
            onRetry={() => {
              void identityQuery.refetch();
              void authorityQuery.refetch();
            }}
          />
        ) : !canReadRaw ? (
          <Alert>
            <ShieldAlert aria-hidden />
            <AlertTitle>Raw audit forensics are held</AlertTitle>
            <AlertDescription>
              The mounted statistics and manifest routes require both
              <code> audit:read</code> and <code>audit:read_pii</code>. This
              session does not hold both, so the panel fails closed.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <section aria-labelledby="audit-filter-stats" className="space-y-3">
              <div>
                <h3 id="audit-filter-stats" className="font-medium">
                  Filtered evidence summary
                </h3>
                <p className="text-sm text-muted-foreground">
                  Counts use the same server-side actor, action, resource, and
                  start-time filters as the evidence table.
                </p>
              </div>
              {statsQuery.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Calculating filtered statistics…
                </p>
              ) : statsQuery.isError ? (
                <Failure
                  title="Filtered statistics could not be loaded"
                  detail="The table remains available; no count is inferred."
                  onRetry={() => void statsQuery.refetch()}
                />
              ) : statsQuery.data ? (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Stat
                    label="Matching events"
                    value={statsQuery.data.totalEvents.toLocaleString()}
                  />
                  <Stat
                    label="Most common action"
                    value={
                      statsQuery.data.topActions[0]?.label ?? "Verified empty"
                    }
                  />
                  <Stat
                    label="Most active actor type"
                    value={
                      statsQuery.data.byActorType[0]?.label ?? "Verified empty"
                    }
                  />
                </div>
              ) : null}
            </section>

            <section aria-labelledby="audit-async-export" className="space-y-4">
              <div>
                <h3 id="audit-async-export" className="font-medium">
                  Background CSV exports
                </h3>
                <p className="text-sm text-muted-foreground">
                  Queue a server-managed export for the current actor, action,
                  resource, and start-time filters. The newest 20 jobs are
                  shown; worker error details and completion-email addresses are
                  withheld.
                </p>
              </div>
              {!canExportAsync ? (
                <Alert>
                  <ShieldAlert aria-hidden />
                  <AlertTitle>Background export creation is held</AlertTitle>
                  <AlertDescription>
                    Job history remains readable, but queueing requires
                    <code> audit:execute_actions</code>.
                  </AlertDescription>
                </Alert>
              ) : filters.until ? (
                <Alert>
                  <ShieldAlert aria-hidden />
                  <AlertTitle>
                    End-bounded background export is unavailable
                  </AlertTitle>
                  <AlertDescription>
                    The mounted async-export contract has no end-time field.
                    Clear the “until” filter before queueing so this screen
                    never exports a broader time range than the one under
                    review.
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="space-y-3 rounded-lg border p-4">
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={emailOnComplete}
                      disabled={exportBusy}
                      onChange={(event) => {
                        setEmailOnComplete(event.target.checked);
                        setExportError(null);
                      }}
                    />
                    <span>Email me when this export completes.</span>
                  </label>
                  {emailOnComplete ? (
                    <div className="max-w-md space-y-1.5">
                      <Label htmlFor="audit-export-completion-email">
                        Completion email
                      </Label>
                      <Input
                        id="audit-export-completion-email"
                        type="email"
                        maxLength={254}
                        autoComplete="email"
                        value={completionEmail}
                        disabled={exportBusy}
                        onChange={(event) => {
                          setCompletionEmail(event.target.value);
                          setExportError(null);
                        }}
                        required
                      />
                    </div>
                  ) : null}
                  <Button
                    type="button"
                    disabled={
                      exportBusy ||
                      (emailOnComplete && !validEmail(completionEmail))
                    }
                    onClick={() => setExportConfirmOpen(true)}
                  >
                    Review background export
                  </Button>
                </div>
              )}
              <ConfirmDialog
                open={exportConfirmOpen}
                onOpenChange={setExportConfirmOpen}
                title="Queue this audit export?"
                description="The server will read every matching audit row for the supported current filters and prepare a confidential CSV. The job continues if this page closes."
                confirmLabel="Queue export"
                confirmationToken="EXPORT"
                onConfirm={queueExport}
              />
              {exportError ? (
                <Alert variant="destructive">
                  <AlertTriangle aria-hidden />
                  <AlertTitle>Background export did not start</AlertTitle>
                  <AlertDescription>{exportError}</AlertDescription>
                </Alert>
              ) : null}
              {exportReceipt ? (
                <Alert>
                  <CheckCircle2 aria-hidden />
                  <AlertTitle>Export receipt verified</AlertTitle>
                  <AlertDescription aria-live="polite">
                    {exportReceipt}
                  </AlertDescription>
                </Alert>
              ) : null}
              {exportJobsQuery.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading background export jobs…
                </p>
              ) : exportJobsQuery.isError ? (
                <Failure
                  title="Background export history could not be loaded"
                  detail="A failed request is not shown as an empty job history."
                  onRetry={() => void exportJobsQuery.refetch()}
                />
              ) : exportJobsQuery.data?.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  Verified empty: no background audit export jobs are recorded.
                </p>
              ) : (
                <TableContainer>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Job</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Progress</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead className="text-right">Result</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {exportJobsQuery.data?.map((job) => (
                        <TableRow key={job.id}>
                          <TableCell>
                            <code className="text-xs">{job.id}</code>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                job.status === "completed"
                                  ? "success"
                                  : job.status === "failed"
                                    ? "destructive"
                                    : "warning"
                              }
                            >
                              {job.status.replace("_", " ")}
                            </Badge>
                            {job.hasError ? (
                              <span className="ml-2 text-xs text-destructive-emphasis">
                                details withheld
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <div className="min-w-36 space-y-1">
                              <progress
                                className="h-2 w-full"
                                max={Math.max(job.estimatedRows ?? 0, 1)}
                                value={Math.min(
                                  job.exportedRows,
                                  Math.max(job.estimatedRows ?? 0, 1),
                                )}
                                aria-label={`Export ${job.id} progress`}
                              />
                              <div className="text-xs text-muted-foreground">
                                {job.exportedRows.toLocaleString()}
                                {job.estimatedRows !== undefined
                                  ? ` / ~${job.estimatedRows.toLocaleString()}`
                                  : ""}{" "}
                                rows · {formatBytes(job.totalBytes)}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>{formatTime(job.createdAt)}</TableCell>
                          <TableCell className="text-right">
                            {job.status === "completed" ? (
                              <Button asChild variant="outline" size="sm">
                                <a
                                  href={auditExportJobDownloadPath(job.id)}
                                  download={`audit-export-${job.id}.csv`}
                                >
                                  Download CSV
                                </a>
                              </Button>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </section>

            <section
              aria-labelledby="audit-export-manifests"
              className="space-y-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 id="audit-export-manifests" className="font-medium">
                    Signed export manifests
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Newest 20 only. A manifest appears after a CSV export with
                    manifest recording finishes.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void manifestsQuery.refetch()}
                >
                  Check for completed export
                </Button>
              </div>
              {manifestsQuery.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading export manifests…
                </p>
              ) : manifestsQuery.isError ? (
                <Failure
                  title="Export manifests could not be loaded"
                  detail="A failed request is not shown as an empty export history."
                  onRetry={() => void manifestsQuery.refetch()}
                />
              ) : manifestsQuery.data?.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  Verified empty: no signed export manifest is recorded.
                </p>
              ) : (
                <TableContainer>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Export</TableHead>
                        <TableHead>Rows</TableHead>
                        <TableHead>Audit range</TableHead>
                        <TableHead>Proof</TableHead>
                        <TableHead>Completed</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {manifestsQuery.data?.map((manifest) => (
                        <TableRow key={manifest.exportId}>
                          <TableCell>
                            <code className="text-xs">{manifest.exportId}</code>
                          </TableCell>
                          <TableCell>
                            {manifest.rowCount.toLocaleString()}
                          </TableCell>
                          <TableCell>
                            {manifest.fromAuditId}–{manifest.toAuditId}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                manifest.hasSignature ? "success" : "warning"
                              }
                            >
                              {manifest.hasSignature ? "signed" : "unsigned"}
                            </Badge>
                            {manifest.signatureKid ? (
                              <div className="mt-1 text-xs text-muted-foreground">
                                key {manifest.signatureKid}
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            {formatTime(manifest.createdAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </section>

            <section
              aria-labelledby="audit-proof-verification"
              className="space-y-4"
            >
              <div>
                <h3 id="audit-proof-verification" className="font-medium">
                  Merkle inclusion proof
                </h3>
                <p className="text-sm text-muted-foreground">
                  Proof endpoints are admin-only. Enter a positive audit row ID;
                  the response must bind back to that exact ID.
                </p>
              </div>
              {!isAdmin ? (
                <Alert>
                  <ShieldAlert aria-hidden />
                  <AlertTitle>Proof retrieval is admin-only</AlertTitle>
                  <AlertDescription>
                    The server mounts checkpoint and inclusion-proof routes
                    behind its admin scope, so no proof control is offered for
                    this session.
                  </AlertDescription>
                </Alert>
              ) : (
                <>
                  {checkpointQuery.isPending ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      Loading latest checkpoint…
                    </p>
                  ) : checkpointQuery.isError ? (
                    <Failure
                      title="Latest checkpoint is unavailable"
                      detail="A row may exist before the periodic root covers it. Retry after the next checkpoint cycle."
                      onRetry={() => void checkpointQuery.refetch()}
                    />
                  ) : checkpointQuery.data ? (
                    <dl className="grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-3">
                      <Fact
                        label="Tree size"
                        value={checkpointQuery.data.treeSize.toLocaleString()}
                      />
                      <Fact
                        label="Up to audit ID"
                        value={checkpointQuery.data.uptoAuditId.toLocaleString()}
                      />
                      <Fact
                        label="Anchored"
                        value={formatTime(checkpointQuery.data.anchoredAt)}
                      />
                      <div className="sm:col-span-3">
                        <dt className="text-xs text-muted-foreground">
                          Root hash
                        </dt>
                        <dd className="mt-1 flex min-w-0 items-center gap-1">
                          <code className="min-w-0 break-all text-xs">
                            {checkpointQuery.data.rootHash}
                          </code>
                          <CopyTextButton
                            value={checkpointQuery.data.rootHash}
                            label="Copy root hash"
                            copiedLabel="Copied"
                            variant="ghost"
                            toastOnCopy={false}
                          />
                        </dd>
                      </div>
                    </dl>
                  ) : null}
                  <form
                    className="flex flex-col gap-3 sm:flex-row sm:items-end"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void requestProof();
                    }}
                  >
                    <div className="flex-1 space-y-1.5">
                      <Label htmlFor="audit-proof-id">Audit row ID</Label>
                      <Input
                        id="audit-proof-id"
                        type="number"
                        min={1}
                        step={1}
                        value={proofId}
                        disabled={proofBusy}
                        onChange={(event) => {
                          setProofId(event.target.value);
                          setProof(null);
                          setProofError(null);
                        }}
                        required
                      />
                    </div>
                    <Button
                      type="submit"
                      loading={proofBusy}
                      disabled={proofBusy || !validPositiveId(proofId)}
                    >
                      Verify inclusion
                    </Button>
                  </form>
                  {proofError ? (
                    <Alert variant="destructive">
                      <AlertTriangle aria-hidden />
                      <AlertTitle>Inclusion proof was not verified</AlertTitle>
                      <AlertDescription>{proofError}</AlertDescription>
                    </Alert>
                  ) : null}
                  {proof ? (
                    <Alert>
                      <CheckCircle2 aria-hidden />
                      <AlertTitle>
                        Proof receipt bound to audit #{proof.leafId}
                      </AlertTitle>
                      <AlertDescription>
                        <div className="space-y-2">
                          <p>
                            Tree size {proof.treeSize.toLocaleString()} ·{" "}
                            {proof.auditPath.length} path hash
                            {proof.auditPath.length === 1 ? "" : "es"} ·
                            anchored {formatTime(proof.anchoredAt)}.
                          </p>
                          <p>
                            <Badge
                              variant={
                                proof.rootSignature ? "success" : "warning"
                              }
                            >
                              {proof.rootSignature
                                ? "signed root"
                                : "root has no signature"}
                            </Badge>
                            {proof.rootKid ? ` key ${proof.rootKid}` : ""}
                          </p>
                          <div>
                            <span className="text-xs text-muted-foreground">
                              Leaf hash
                            </span>
                            <code className="mt-1 block break-all rounded bg-muted p-2 text-xs">
                              {proof.leafHash}
                            </code>
                          </div>
                          <div>
                            <span className="text-xs text-muted-foreground">
                              Root hash
                            </span>
                            <code className="mt-1 block break-all rounded bg-muted p-2 text-xs">
                              {proof.rootHash}
                            </code>
                          </div>
                        </div>
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Failure({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertTriangle aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{detail}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={onRetry}
        >
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-lg font-semibold">{value}</p>
    </div>
  );
}
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}
function validPositiveId(value: string): boolean {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0;
}
function validEmail(value: string): boolean {
  return /^[^@\s]{1,64}@[^@\s]{1,189}$/u.test(value.trim());
}
function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${(value / 1_073_741_824).toFixed(2)} GB`;
}
function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}
