// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  Eye,
  Filter,
  RefreshCw,
  ScanSearch,
  ShieldAlert,
} from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  GovernanceError,
  GovernanceLoading,
  GovernancePageHeader,
} from "@/components/governance/governance-ui";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { canReadAdminData } from "@/lib/admin-read-authority";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  listPiiFindings,
  getPiiScanConfig,
  piiFindingStatusLabel,
  piiFindingTypeLabel,
  piiReviewCommentContainsStrongPii,
  PII_DETECTION_TYPES,
  shortPiiFingerprint,
  type PiiDetectionType,
  type PiiFinding,
  type PiiFindingStatus,
  type PiiScanConfig,
} from "@/lib/pii-findings-api";
import { qk, STALE } from "@/lib/query-keys";

import { PiiFindingDialog } from "./pii-finding-dialog";
import { PiiScanConfigCard } from "./pii-scan-config-card";
import { describePiiError, statusBadgeVariant } from "./pii-findings-ui";

const PAGE_SIZE = 25;

type StatusFilter = PiiFindingStatus | "all";
type TypeFilter = PiiDetectionType | "all";

export function PiiFindingsClient() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>("pending");
  const [detectedType, setDetectedType] = useState<TypeFilter>("all");
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<PiiFinding | null>(null);

  const me = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const role = me.data?.viewer_mode
    ? "viewer"
    : me.data
      ? effectiveAuthRole(me.data)
      : null;
  const canAdmin = Boolean(me.isSuccess && canReadAdminData(me.data));
  const accessVerified = me.isSuccess && canAdmin;
  const tenantId = me.data?.tenant_id ?? "unverified";
  const userId = me.data?.user_id ?? "unverified";
  const viewerState = me.data?.viewer_mode ? "viewer-mode" : "durable-mode";
  const protectedBase = useMemo(
    () => ["pii-admin", tenantId, userId, role ?? "none", viewerState] as const,
    [role, tenantId, userId, viewerState],
  );
  const previousBaseRef = useRef<readonly unknown[] | null>(null);

  const findingsKey = useMemo(
    () => [
      ...protectedBase,
      "findings",
      status,
      detectedType,
      query,
      page,
      PAGE_SIZE,
    ],
    [detectedType, page, protectedBase, query, status],
  );
  const configKey = useMemo(
    () => [...protectedBase, "scan-config"] as const,
    [protectedBase],
  );

  useEffect(() => {
    const previous = previousBaseRef.current;
    if (previous && previous !== protectedBase) {
      void queryClient.cancelQueries({ queryKey: previous });
      queryClient.removeQueries({ queryKey: previous });
    }
    previousBaseRef.current = protectedBase;
    if (accessVerified) return;
    setSelected(null);
    setQueryDraft("");
    setQuery("");
    void queryClient.cancelQueries({ queryKey: protectedBase });
    queryClient.removeQueries({ queryKey: protectedBase });
  }, [accessVerified, protectedBase, queryClient]);

  const findings = useQuery({
    queryKey: findingsKey,
    queryFn: ({ signal }) =>
      listPiiFindings({
        ...(status === "all" ? {} : { status }),
        ...(detectedType === "all" ? {} : { detectedType }),
        ...(query ? { query } : {}),
        page,
        perPage: PAGE_SIZE,
        signal,
      }),
    enabled: accessVerified,
    placeholderData: keepPreviousData,
    staleTime: STALE.list,
  });
  const config = useQuery({
    queryKey: configKey,
    queryFn: ({ signal }) => getPiiScanConfig({ signal }),
    enabled: accessVerified,
    staleTime: STALE.detail,
  });

  const trimmedDraft = queryDraft.trim();
  const queryError =
    Array.from(trimmedDraft).length > 128
      ? "Search must be 128 characters or fewer."
      : /[\u0000-\u001f\u007f]/u.test(trimmedDraft)
        ? "Search cannot contain control characters."
        : piiReviewCommentContainsStrongPii(trimmedDraft)
          ? "Search cannot contain personal-data-shaped values. Use a field key, exact ID, or protected HMAC prefix."
          : null;

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (queryError) return;
    setPage(1);
    setQuery(trimmedDraft);
  }

  const refresh = async () => {
    await Promise.all([findings.refetch(), config.refetch()]);
  };

  if (me.isPending) {
    return (
      <PageShell className="max-w-7xl">
        <PageHeader refreshing={false} />
        <Card>
          <CardContent className="pt-6">
            <GovernanceLoading
              label="Verifying administrator access…"
              rows={4}
            />
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  if (me.isError) {
    return (
      <PageShell className="max-w-7xl">
        <PageHeader
          refreshing={me.isFetching}
          onRefresh={() => void me.refetch()}
        />
        <Card>
          <CardContent className="pt-6">
            <GovernanceError
              message="Could not verify your workspace role. Shadow-PII data was not requested."
              retrying={me.isFetching}
              onRetry={() => void me.refetch()}
            />
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  if (!canAdmin) {
    return (
      <PageShell className="max-w-7xl">
        <PageHeader refreshing={false} onRefresh={() => void me.refetch()} />
        <Alert variant="warning">
          <ShieldAlert aria-hidden />
          <AlertTitle>Admin access required</AlertTitle>
          <AlertDescription>
            Shadow-PII evidence and review controls are restricted to workspace
            owners and administrators. No findings or scanner configuration were
            requested for your effective {role ?? "unknown"} role.
          </AlertDescription>
        </Alert>
      </PageShell>
    );
  }

  const result = findings.data;
  const pages = result
    ? Math.max(1, Math.ceil(result.total / result.per_page))
    : 1;
  const refreshing = findings.isFetching || config.isFetching;

  return (
    <PageShell className="max-w-7xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <PageHeader refreshing={refreshing} onRefresh={() => void refresh()} />

      <Alert variant="warning">
        <ShieldAlert aria-hidden />
        <AlertTitle>Privacy-safe evidence only</AlertTitle>
        <AlertDescription>
          The matched value never leaves the scanner and is never shown here.
          Search covers field metadata, exact IDs, or a protected HMAC prefix.
          Decision comments must not contain subscriber data.
        </AlertDescription>
      </Alert>

      <PiiScanConfigCard
        identity={me.data ?? null}
        config={config.data}
        error={config.error}
        loading={config.isPending}
        refreshing={config.isFetching}
        onRetry={() => void config.refetch()}
        onUpdated={async (next: PiiScanConfig) => {
          queryClient.setQueryData(configKey, next);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: configKey }),
            queryClient.invalidateQueries({
              queryKey: protectedBase,
              exact: false,
            }),
          ]);
        }}
      />

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="flex items-center gap-2">
            <Filter className="size-5" aria-hidden /> Review queue
          </CardTitle>
          <CardDescription>
            Newest first. Filters run on privacy-safe server metadata and reset
            pagination to the first page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <form
            className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_12rem_12rem_auto] lg:items-end"
            aria-label="Filter Shadow-PII findings"
            onSubmit={applyFilters}
          >
            <div className="space-y-2">
              <Label htmlFor="pii-search">Safe metadata search</Label>
              <Input
                id="pii-search"
                value={queryDraft}
                maxLength={129}
                autoComplete="off"
                spellCheck={false}
                placeholder="Field key, exact UUID, or HMAC prefix"
                aria-describedby="pii-search-help"
                aria-invalid={Boolean(queryError)}
                onChange={(event) => setQueryDraft(event.currentTarget.value)}
              />
              <p
                id="pii-search-help"
                className={
                  queryError
                    ? "text-xs text-destructive-emphasis"
                    : "text-xs text-muted-foreground"
                }
              >
                {queryError ??
                  "Never searches subscriber names, addresses, or field values."}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="pii-status-filter">Status</Label>
              <Select
                id="pii-status-filter"
                value={status}
                onChange={(event) => {
                  setStatus(event.currentTarget.value as StatusFilter);
                  setPage(1);
                }}
              >
                <option value="all">All statuses</option>
                <option value="pending">Needs review</option>
                <option value="reviewed">Reviewed</option>
                <option value="dismissed">Dismissed</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="pii-type-filter">Detected type</Label>
              <Select
                id="pii-type-filter"
                value={detectedType}
                onChange={(event) => {
                  setDetectedType(event.currentTarget.value as TypeFilter);
                  setPage(1);
                }}
              >
                <option value="all">All types</option>
                {PII_DETECTION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {piiFindingTypeLabel(type)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={Boolean(queryError)}>
                Apply filters
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setStatus("pending");
                  setDetectedType("all");
                  setQueryDraft("");
                  setQuery("");
                  setPage(1);
                }}
              >
                Reset
              </Button>
            </div>
          </form>

          {findings.isPending ? (
            <GovernanceLoading label="Loading Shadow-PII findings…" rows={6} />
          ) : findings.isError ? (
            <QueueError
              error={findings.error}
              onRetry={() => void findings.refetch()}
            />
          ) : result?.items?.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <ScanSearch
                className="mx-auto size-8 text-muted-foreground"
                aria-hidden
              />
              <h3 className="mt-3 text-sm font-semibold">
                No findings match these filters
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                This is a verified empty result for the current page and filter,
                not a claim that the scanner covers data outside its stated
                boundary.
              </p>
            </div>
          ) : result ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  {result.total.toLocaleString()} matching finding
                  {result.total === 1 ? "" : "s"} · page{" "}
                  {result.page.toLocaleString()} of {pages.toLocaleString()}
                </p>
                {findings.isFetching ? (
                  <span
                    role="status"
                    className="flex items-center gap-1 text-xs text-muted-foreground"
                  >
                    <RefreshCw
                      className="size-3 animate-spin motion-reduce:animate-none"
                      aria-hidden
                    />
                    Refreshing verified data…
                  </span>
                ) : null}
              </div>
              <FindingTable items={result.items} onInspect={setSelected} />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Showing {result.items.length.toLocaleString()} of{" "}
                  {result.total.toLocaleString()} matching findings.
                </p>
                <div className="flex gap-2" aria-label="PII findings pages">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={result.page <= 1 || findings.isFetching}
                    onClick={() => setPage(result.page - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={result.page >= pages || findings.isFetching}
                    onClick={() => setPage(result.page + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <PiiFindingDialog
        identity={me.data ?? null}
        protectedBase={protectedBase}
        open={selected !== null}
        initialFinding={selected}
        onClose={() => setSelected(null)}
      />
    </PageShell>
  );
}

function PageHeader({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh?: () => void;
}) {
  return (
    <GovernancePageHeader
      icon={ShieldAlert}
      title="Shadow-PII findings"
      description="Admin-only queue for undeclared personal-data detections, immutable review receipts, and truthful scanner coverage."
      refreshLabel="Refresh PII findings and scanner configuration"
      refreshing={refreshing}
      onRefresh={onRefresh}
    />
  );
}

function QueueError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const failure = describePiiError(error);
  return (
    <Alert variant="destructive">
      <AlertTriangle aria-hidden />
      <AlertTitle>{failure.title}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{failure.message}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry queue
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function FindingTable({
  items,
  onInspect,
}: {
  items: PiiFinding[];
  onInspect: (finding: PiiFinding) => void;
}) {
  return (
    <TableContainer aria-label="Shadow-PII findings review queue">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Field evidence</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Confidence</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Detected</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((finding) => (
            <TableRow key={finding.id}>
              <TableCell className="min-w-52">
                <p className="break-all font-mono text-xs font-medium">
                  {finding.field_name}
                </p>
                <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                  {shortPiiFingerprint(finding.fingerprint)}
                </p>
              </TableCell>
              <TableCell>
                {piiFindingTypeLabel(finding.detected_type)}
              </TableCell>
              <TableCell className="tabular-nums">
                {Math.round(finding.confidence * 100)}%
              </TableCell>
              <TableCell>
                <Badge variant={statusBadgeVariant(finding.status)}>
                  {piiFindingStatusLabel(finding.status)}
                </Badge>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {formatWireTimestamp(finding.created_at, "Unknown time")}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onInspect(finding)}
                  aria-label={`Inspect ${piiFindingTypeLabel(finding.detected_type)} finding in field ${finding.field_name}`}
                >
                  <Eye aria-hidden /> Inspect
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
