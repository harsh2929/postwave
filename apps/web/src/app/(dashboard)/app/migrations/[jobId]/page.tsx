// SPDX-License-Identifier: AGPL-3.0-only
//
// Migration detail page — the terminal state of the wizard and the entry
// point from the recent-migrations table. Shows:
//   - the verification report (collapsed by default)
//   - rollback section (only while inside the 7-day window)
//   - the last 5 audit_log entries scoped to this job
//
// Rollback uses a strong-confirmation dialog before kicking off the API call,
// then polls /rollback-status until the engine reports a terminal state.
"use client";

import Link from "next/link";
import {
  lazy,
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { sourceSessionStatus } from "@/lib/migration-source-session";
import { base, qk, STALE } from "@/lib/query-keys";
import {
  deltaImport,
  type CutoverEvidenceKey,
  recordCutoverEvidence,
  resumeMigrationJob,
  startShadowMonitor,
  startSourceEvents,
  stopShadowMonitor,
  stopSourceEvents,
  type SourceEventReviewInput,
  updateAutomationRebuild,
  updateMigrationJob,
  updateSourceEventReview,
} from "@/lib/migration-api";
import type { MigrationStreamDone } from "@/lib/migration-progress-api";
import { StatusBadge } from "./migration-detail-primitives";
import {
  SOURCE_LABELS,
  type AutomationRebuildItem,
  type AuditEntry,
  type MigrationJob,
  type PilotAcceptanceReport,
  type ShadowMonitorResponse,
  type SourceEventMonitorResponse,
  type VerificationReport,
} from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Breadcrumb } from "@/components/ui/breadcrumb";
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
import {
  localDateTimeMin,
  localTimezoneLabel,
} from "@/app/(dashboard)/app/campaigns/campaign-list-helpers";
import { Skeleton } from "@/components/ui/skeleton";
import { PageShell } from "@/components/dashboard/page-shell";
import { roleCanWrite } from "@/lib/use-admin-gate";
import {
  loadMigrationDetailData,
  loadMigrationPilotControls,
  smsReadinessCutoverEvidence,
} from "./migration-detail-data";

const PilotAcceptanceCard = lazy(() =>
  import("./pilot-acceptance-card").then((module) => ({
    default: module.PilotAcceptanceCard,
  })),
);

const ActiveCampaignSessionReconnectCard = lazy(() =>
  import("@/components/migration/activecampaign-session-reconnect-card").then(
    (module) => ({
      default: module.ActiveCampaignSessionReconnectCard,
    }),
  ),
);
const AuditCard = lazy(() =>
  import("./audit-card").then((module) => ({ default: module.AuditCard })),
);
const CancelledBanner = lazy(() =>
  import("../_error-banners").then((module) => ({
    default: module.CancelledBanner,
  })),
);
const ImportedDataLinks = lazy(() =>
  import("../_cross-links").then((module) => ({
    default: module.ImportedDataLinks,
  })),
);
const MigrationProgressView = lazy(() =>
  import("../_progress-view").then((module) => ({
    default: module.MigrationProgressView,
  })),
);
const SourceCleanupCard = lazy(() =>
  import("@/components/migration/source-cleanup-card").then((module) => ({
    default: module.SourceCleanupCard,
  })),
);
const OAuthSessionReconnectCard = lazy(() =>
  import("@/components/migration/oauth-session-reconnect-card").then(
    (module) => ({ default: module.OAuthSessionReconnectCard }),
  ),
);
const RollbackSection = lazy(() =>
  import("./rollback-section").then((module) => ({
    default: module.RollbackSection,
  })),
);
const SelectedAudienceScopeCard = lazy(() =>
  import("./selected-audience-scope-card").then((module) => ({
    default: module.SelectedAudienceScopeCard,
  })),
);
const VerificationReportCard = lazy(() =>
  import("./verification-report-card").then((module) => ({
    default: module.VerificationReportCard,
  })),
);

function PilotAcceptanceSkeleton() {
  return (
    <section
      aria-label="Pilot acceptance loading"
      className="min-h-56 animate-pulse rounded-md border bg-card"
    />
  );
}

function DeferredPanelFallback({ label }: { label: string }) {
  return (
    <section
      role="status"
      aria-busy="true"
      className="min-h-24 animate-pulse rounded-md border bg-card"
    >
      <span className="sr-only">Loading {label}</span>
    </section>
  );
}

export default function MigrationDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = use(params);
  return <DetailView jobId={jobId} />;
}

// MIGR-037: inline rename so two same-source/same-day attempts are
// distinguishable. Falls back to "{Source} migration" when unnamed.
function MigrationTitle({
  job,
  defaultTitle,
  canWrite,
  onSave,
}: {
  job: MigrationJob;
  defaultTitle: string;
  canWrite: boolean;
  onSave: (label: string) => Promise<MigrationJob | undefined>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(job.label ?? "");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  async function save() {
    if (!canWrite || savingRef.current) return;
    const label = value.trim();
    savingRef.current = true;
    setSaving(true);
    try {
      const updated = await onSave(label);
      if (!updated) return;
      setEditing(false);
      toast.success(label ? "Migration renamed." : "Name cleared.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the name.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={!canWrite || saving}
          maxLength={120}
          placeholder={defaultTitle}
          aria-label="Migration name"
          className="w-full sm:max-w-xs"
          autoFocus
        />
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={!canWrite || saving}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setValue(job.label ?? "");
            setEditing(false);
          }}
          disabled={!canWrite || saving}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-start gap-2">
      <h1 className="min-w-0 break-words font-display text-2xl font-semibold tracking-tight sm:text-3xl">
        {job.label || defaultTitle}
      </h1>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Rename migration"
        disabled={!canWrite}
        title={canWrite ? undefined : "Current admin access is required."}
        onClick={() => {
          setValue(job.label ?? "");
          setEditing(true);
        }}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function DetailView({ jobId }: { jobId: string }) {
  const queryClient = useQueryClient();
  const [job, setJob] = useState<MigrationJob | null>(null);
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [acceptance, setAcceptance] = useState<PilotAcceptanceReport | null>(
    null,
  );
  const [rebuilds, setRebuilds] = useState<AutomationRebuildItem[]>([]);
  const [shadow, setShadow] = useState<ShadowMonitorResponse | null>(null);
  const [sourceEvents, setSourceEvents] =
    useState<SourceEventMonitorResponse | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [detailSidecarErrors, setDetailSidecarErrors] = useState<
    Partial<Record<"report" | "audit", string>>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [pilotPending, setPilotPending] = useState<string | null>(null);
  // MIGR-038: optional off-peak schedule for the delta import.
  const [deltaScheduledFor, setDeltaScheduledFor] = useState("");
  const writeInFlightRef = useRef(false);
  const identityStampRef = useRef("anon");
  const previousIdentityScopeRef = useRef<{
    stamp: string;
    key: readonly unknown[];
  } | null>(null);
  const localScopeRef = useRef("");
  const cutoverSessionStatus = job
    ? sourceSessionStatus(
        job.source,
        job.source_session_expires_at ?? null,
        "cutover checks",
      )
    : { kind: "ok" as const, message: "" };

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data;
  const tenantId = identity?.tenant_id ?? "anon";
  const userId = identity?.user_id ?? "anon";
  const viewerMode = identity?.viewer_mode === true;
  const role = identity
    ? viewerMode
      ? "viewer"
      : effectiveAuthRole(identity)
    : null;
  const canAdmin = Boolean(
    meQuery.isSuccess && identity && !viewerMode && roleCanWrite(role),
  );
  const identityStamp = identity
    ? `${identity.user_id}\u0000${identity.tenant_id}\u0000${role ?? ""}\u0000${viewerMode}`
    : "anon";
  const verifiedIdentityStamp = canAdmin ? identityStamp : "unverified";
  identityStampRef.current = verifiedIdentityStamp;
  const detailScope = `${verifiedIdentityStamp}\u0000${jobId}`;
  const migrationBaseKey = useMemo(
    () => [...base("migrations", tenantId, role), userId, viewerMode] as const,
    [role, tenantId, userId, viewerMode],
  );
  const migrationDetailKey = useMemo(
    () => [...migrationBaseKey, "detail", jobId] as const,
    [jobId, migrationBaseKey],
  );
  const migrationPilotKey = useMemo(
    () => [...migrationBaseKey, "pilot-controls", jobId] as const,
    [jobId, migrationBaseKey],
  );
  const detailQuery = useQuery({
    queryKey: migrationDetailKey,
    queryFn: () => loadMigrationDetailData(jobId),
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.detail,
  });
  const pilotControlsQuery = useQuery({
    queryKey: migrationPilotKey,
    queryFn: () => loadMigrationPilotControls(jobId),
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.detail,
  });
  const pilotControlErrorEntries = Object.entries(
    pilotControlsQuery.data?.errors ?? {},
  ).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].trim() !== "",
  );

  useEffect(() => {
    const previous = previousIdentityScopeRef.current;
    if (previous && previous.stamp !== verifiedIdentityStamp) {
      void queryClient
        .cancelQueries({ queryKey: previous.key, exact: false })
        .then(() =>
          queryClient.removeQueries({ queryKey: previous.key, exact: false }),
        );
    }
    previousIdentityScopeRef.current = canAdmin
      ? { stamp: verifiedIdentityStamp, key: migrationBaseKey }
      : null;
  }, [canAdmin, migrationBaseKey, queryClient, verifiedIdentityStamp]);

  useEffect(() => {
    if (localScopeRef.current === detailScope) return;
    localScopeRef.current = detailScope;
    setJob(null);
    setReport(null);
    setAcceptance(null);
    setRebuilds([]);
    setShadow(null);
    setSourceEvents(null);
    setAudit([]);
    setDetailSidecarErrors({});
    setError(null);
    setPilotPending(null);
    setDeltaScheduledFor("");
  }, [detailScope]);

  const beginWrite = useCallback((): string | null => {
    if (!canAdmin || !identity || writeInFlightRef.current) return null;
    writeInFlightRef.current = true;
    return identityStamp;
  }, [canAdmin, identity, identityStamp]);

  const finishWrite = useCallback(() => {
    writeInFlightRef.current = false;
  }, []);

  const confirmWrite = useCallback(
    async (stamp: string, signal?: AbortSignal): Promise<void> => {
      if (!identity || identityStampRef.current !== stamp) {
        throw new Error(
          "Workspace identity or authority changed. Nothing was written; reload and retry.",
        );
      }
      await verifyFreshAdminAuthority(identity, signal);
      if (identityStampRef.current !== stamp) {
        throw new Error(
          "Workspace identity or authority changed. Nothing was written; reload and retry.",
        );
      }
    },
    [identity],
  );

  const authorityStillCurrent = useCallback(
    (stamp: string): boolean => identityStampRef.current === stamp,
    [],
  );

  async function executeAuthorizedWrite<T>(
    pendingKey: string | null,
    operation: (stamp: string) => Promise<T>,
  ): Promise<{ value: T; stamp: string } | null> {
    // The single-write lock is a ref, so no button can react to it: the pilot
    // controls only disable their own pending key and every caller silently
    // bails on a null outcome. Without this the second of two quick clicks
    // looks accepted while nothing was recorded, so say the lock out loud.
    const blockedByInFlightWrite = writeInFlightRef.current;
    const stamp = beginWrite();
    if (!stamp) {
      if (blockedByInFlightWrite) {
        toast.info("Another migration action is still running", {
          description: "Nothing was recorded. Wait for it to finish and retry.",
        });
      }
      return null;
    }
    if (pendingKey) setPilotPending(pendingKey);
    try {
      await confirmWrite(stamp);
      const value = await operation(stamp);
      return authorityStillCurrent(stamp) ? { value, stamp } : null;
    } finally {
      if (pendingKey && authorityStillCurrent(stamp)) setPilotPending(null);
      finishWrite();
    }
  }

  const confirmChildWrite = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const stamp = identityStampRef.current;
      if (!canAdmin || !identity || stamp !== identityStamp) {
        throw new Error(
          "Workspace identity or authority changed. Nothing was written; reload and retry.",
        );
      }
      await confirmWrite(stamp, signal);
    },
    [canAdmin, confirmWrite, identity, identityStamp],
  );

  const loadPilotControls = useCallback(async () => {
    if (!canAdmin || identityStampRef.current !== identityStamp) return;
    await queryClient.invalidateQueries({
      queryKey: migrationPilotKey,
      exact: true,
    });
  }, [canAdmin, identityStamp, migrationPilotKey, queryClient]);

  // Keep this identity stable across ordinary re-renders so the SSE
  // subscription effect is not reopened, but refresh server-backed detail and
  // pilot controls when the runner emits the terminal job snapshot.
  const handleProgressComplete = useCallback(
    (done: MigrationStreamDone) => {
      if (!canAdmin || identityStampRef.current !== identityStamp) return;
      const next = done.job as MigrationJob | undefined;
      if (next && next.id) setJob(next);
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: migrationDetailKey,
          exact: true,
        }),
        queryClient.invalidateQueries({
          queryKey: migrationPilotKey,
          exact: true,
        }),
      ]);
    },
    [
      canAdmin,
      identityStamp,
      migrationDetailKey,
      migrationPilotKey,
      queryClient,
    ],
  );

  useEffect(() => {
    const data = detailQuery.data;
    if (!canAdmin || !data) return;
    setError(null);
    setJob(data.job);
    setReport(data.report);
    setAudit(data.audit);
    setDetailSidecarErrors(data.errors ?? {});
  }, [canAdmin, detailQuery.data]);

  useEffect(() => {
    const data = pilotControlsQuery.data;
    if (!canAdmin || !data) return;
    // Do not keep previously loaded cutover evidence visible when that
    // sidecar fails on refresh; the warning banner below names the failure.
    if (data.errors?.acceptance) setAcceptance(null);
    else if (data.acceptance) setAcceptance(data.acceptance);
    if (data.errors?.rebuilds) setRebuilds([]);
    else if (data.rebuilds) setRebuilds(data.rebuilds);
    if (data.errors?.shadow) setShadow(null);
    else if ("shadow" in data) setShadow(data.shadow ?? null);
    if (data.errors?.sourceEvents) setSourceEvents(null);
    else if ("sourceEvents" in data) setSourceEvents(data.sourceEvents ?? null);
  }, [canAdmin, pilotControlsQuery.data]);

  useEffect(() => {
    if (!canAdmin || !detailQuery.isError) return;
    setError(
      detailQuery.error instanceof Error
        ? detailQuery.error.message
        : "Could not load this migration — this is a failed request, not a job with no progress.",
    );
  }, [canAdmin, detailQuery.isError, detailQuery.error]);

  const retryDetail = useCallback(async () => {
    if (!canAdmin || identityStampRef.current !== identityStamp) return;
    setError(null);
    const result = await detailQuery.refetch();
    if (result.error && !job) {
      setError(
        result.error instanceof Error
          ? result.error.message
          : "Could not load this migration — this is a failed request, not a job with no progress.",
      );
    }
  }, [canAdmin, detailQuery, identityStamp, job]);

  const renameMigration = async (
    label: string,
  ): Promise<MigrationJob | undefined> => {
    if (!job) return undefined;
    const intent = { id: job.id, label } as const;
    const outcome = await executeAuthorizedWrite(null, () =>
      updateMigrationJob(intent.id, { label: intent.label }),
    );
    if (!outcome) return undefined;
    setJob(outcome.value);
    return outcome.value;
  };

  const runDeltaImport = async () => {
    if (!job) return;
    if (cutoverSessionStatus.kind !== "ok") {
      toast.warning("Reconnect source first", {
        description: cutoverSessionStatus.message,
      });
      return;
    }
    // MIGR-038: optional off-peak schedule for the delta import.
    if (
      deltaScheduledFor !== "" &&
      new Date(deltaScheduledFor).getTime() <= Date.now()
    ) {
      toast.error("Pick a future time to schedule the delta import.");
      return;
    }
    const scheduledForIso = deltaScheduledFor
      ? new Date(deltaScheduledFor).toISOString()
      : undefined;
    const intent = {
      job: structuredClone(job),
      scheduledForIso,
    };
    try {
      const outcome = await executeAuthorizedWrite("delta", () =>
        deltaImport(intent.job.source, intent.job.id, intent.scheduledForIso),
      );
      if (!outcome) return;
      toast.success(
        intent.scheduledForIso
          ? "Delta import scheduled"
          : "Delta import started",
      );
      // A future-scheduled delta is NOT in flight yet — keep the current status
      // (so the progress/SSE view doesn't mount) and just surface the schedule.
      // An immediate delta flips optimistically to "importing".
      setJob(
        intent.scheduledForIso
          ? {
              ...intent.job,
              cursor: {
                ...intent.job.cursor,
                scheduled_start_at: intent.scheduledForIso,
              },
            }
          : {
              ...intent.job,
              status: "importing",
              completed_at: null,
              rollback_until: null,
              cursor: { ...intent.job.cursor, scheduled_start_at: null },
            },
      );
      setDeltaScheduledFor("");
      setAcceptance(null);
      await queryClient.invalidateQueries({
        queryKey: migrationDetailKey,
        exact: true,
      });
      await queryClient.invalidateQueries({
        queryKey: migrationPilotKey,
        exact: true,
      });
    } catch (err) {
      toast.error("Could not start delta import", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const markAutomation = async (
    item: AutomationRebuildItem,
    status: AutomationRebuildItem["status"],
  ) => {
    const intent = {
      item: structuredClone(item),
      status,
      jobId,
    };
    try {
      const outcome = await executeAuthorizedWrite(
        `automation:${intent.item.rank}:${intent.status}`,
        () =>
          updateAutomationRebuild(intent.jobId, {
            ...intent.item,
            status: intent.status,
            test_evidence:
              intent.item.test_evidence?.trim() ||
              automationQuickActionEvidence(intent.status),
          }),
      );
      if (!outcome) return;
      toast.success("Automation rebuild updated");
      await loadPilotControls();
    } catch (err) {
      toast.error("Could not update automation rebuild", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const markCutoverEvidence = async (
    key: CutoverEvidenceKey,
    label: string,
  ) => {
    if (!job) return;
    const intent = { jobId: job.id, key, label } as const;
    try {
      const outcome = await executeAuthorizedWrite(
        `cutover:${intent.key}`,
        async (stamp) => {
          let detail = `${intent.label} reviewed after final delta.`;
          let evidence: [string, ...string[]] = [
            `Operator marked ${intent.label} reviewed from the pilot acceptance card.`,
          ];
          if (intent.key === "sms_readiness") {
            // The SMS API module is ~2,500 lines and this is its only use on
            // the page; load it when the operator actually reviews SMS
            // readiness instead of shipping it in the route's initial bundle.
            const { getSmsPilotReadiness } = await import("@/lib/sms-api");
            const readiness = smsReadinessCutoverEvidence(
              await getSmsPilotReadiness(),
            );
            if (!readiness.ready) {
              return { blocked: readiness.detail, next: null };
            }
            detail = readiness.detail;
            evidence = readiness.evidence;
          }
          // The readiness read above can be slow; check authority again at the
          // actual write boundary instead of treating the earlier read as a
          // mutation credential.
          await confirmWrite(stamp);
          const next = await recordCutoverEvidence(intent.jobId, {
            key: intent.key,
            status: "pass",
            detail,
            evidence,
          });
          return { blocked: null, next };
        },
      );
      if (!outcome) return;
      if (outcome.value.blocked) {
        toast.error("SMS pilot readiness is still blocked", {
          description: outcome.value.blocked,
        });
        return;
      }
      if (outcome.value.next) {
        setAcceptance(outcome.value.next);
        await loadPilotControls();
        toast.success("Cutover review recorded");
      }
    } catch (err) {
      toast.error("Could not record cutover review", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const startShadow = async () => {
    if (!job) return;
    if (cutoverSessionStatus.kind !== "ok") {
      toast.warning("Reconnect source first", {
        description: cutoverSessionStatus.message,
      });
      return;
    }
    const intent = { jobId: job.id, source: job.source } as const;
    try {
      const outcome = await executeAuthorizedWrite("shadow-start", () =>
        startShadowMonitor(intent.source, intent.jobId, 3600),
      );
      if (!outcome) return;
      setShadow(outcome.value);
      await loadPilotControls();
      toast.success("Shadow monitor enabled");
    } catch (err) {
      toast.error("Could not enable shadow monitor", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const stopShadow = async () => {
    if (!job) return;
    const intent = { jobId: job.id } as const;
    try {
      const outcome = await executeAuthorizedWrite("shadow-stop", () =>
        stopShadowMonitor(intent.jobId),
      );
      if (!outcome) return;
      await loadPilotControls();
      toast.success("Shadow monitor disabled");
    } catch (err) {
      toast.error("Could not disable shadow monitor", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const startSourceEventReplay = async () => {
    if (!job) return;
    if (cutoverSessionStatus.kind !== "ok") {
      toast.warning("Reconnect source first", {
        description: cutoverSessionStatus.message,
      });
      return;
    }
    const intent = { jobId: job.id, source: job.source } as const;
    try {
      const outcome = await executeAuthorizedWrite("source-events-start", () =>
        startSourceEvents(intent.source, intent.jobId, 300),
      );
      if (!outcome) return;
      setSourceEvents(outcome.value);
      await loadPilotControls();
      toast.success("Source-event replay enabled");
    } catch (err) {
      toast.error("Could not enable source-event replay", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const stopSourceEventReplay = async () => {
    if (!job) return;
    const intent = { jobId: job.id } as const;
    try {
      const outcome = await executeAuthorizedWrite("source-events-stop", () =>
        stopSourceEvents(intent.jobId),
      );
      if (!outcome) return;
      await loadPilotControls();
      toast.success("Source-event replay disabled");
    } catch (err) {
      toast.error("Could not disable source-event replay", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const reviewSourceEvent = async (
    eventId: string,
    input: SourceEventReviewInput,
  ) => {
    if (!job) return;
    const intent = {
      eventId,
      input: structuredClone(input),
      jobId: job.id,
    };
    try {
      const outcome = await executeAuthorizedWrite(
        `source-event-review:${intent.eventId}`,
        () =>
          updateSourceEventReview(intent.jobId, intent.eventId, intent.input),
      );
      if (!outcome) return;
      await loadPilotControls();
      toast.success(
        intent.input.status === "reviewed"
          ? "Source event review recorded"
          : "Source event review reopened",
      );
    } catch (err) {
      toast.error("Could not update source event review", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const resumeCancelledJob = async () => {
    if (!job) return;
    const intent = structuredClone(job);
    try {
      const outcome = await executeAuthorizedWrite("resume", () =>
        resumeMigrationJob(intent.id),
      );
      if (!outcome) return;
      toast.success("Migration resumed");
      setJob({
        ...intent,
        status: outcome.value.status === "dry_run" ? "dry_run" : "importing",
        error: null,
      });
    } catch (err) {
      toast.error("Could not resume migration", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  if (meQuery.isError || (meQuery.isFetched && !identity)) {
    return (
      <PageShell className="max-w-3xl">
        <Breadcrumb
          items={[
            { label: "All migrations", href: "/app/migrations" },
            { label: "Access unavailable" },
          ]}
        />
        <Alert variant="destructive">
          <AlertTitle>Could not verify migration access</AlertTitle>
          <AlertDescription>
            {meQuery.error instanceof Error
              ? meQuery.error.message
              : "Moosewave could not verify your current workspace authority."}
          </AlertDescription>
        </Alert>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            loading={meQuery.isFetching}
            onClick={() => void meQuery.refetch()}
          >
            {meQuery.isFetching ? "Retrying…" : "Retry access check"}
          </Button>
          <Button asChild variant="outline">
            <Link href="/app/migrations">Back to migrations</Link>
          </Button>
        </div>
      </PageShell>
    );
  }

  if (meQuery.isSuccess && !canAdmin) {
    return (
      <PageShell className="max-w-3xl">
        <Breadcrumb
          items={[
            { label: "All migrations", href: "/app/migrations" },
            { label: "Admin access required" },
          ]}
        />
        <Card>
          <CardHeader>
            <CardTitle>Admin access required</CardTitle>
            <CardDescription>
              Migration records and controls are restricted to workspace owners
              and administrators outside viewer mode. No migration data was
              requested for this session.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/app/migrations">Back to migrations</Link>
            </Button>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  const detailErrorMessage = detailQuery.isError
    ? detailQuery.error instanceof Error
      ? detailQuery.error.message
      : "Could not load this migration — this is a failed request, not a job with no progress."
    : error;

  if (detailErrorMessage) {
    return (
      <PageShell className="max-w-3xl [&_[data-slot=button]]:min-h-11 [&_[data-slot=button]]:min-w-11 sm:[&_[data-slot=button]]:min-h-9 sm:[&_[data-slot=button]]:min-w-0">
        <Breadcrumb
          items={[
            { label: "All migrations", href: "/app/migrations" },
            { label: "Migration unavailable" },
          ]}
        />
        <header className="space-y-2">
          <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            Migration unavailable
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            No job data is being shown until Moosewave can verify this migration
            record.
          </p>
        </header>
        <Alert variant="destructive">
          <AlertTitle>Could not load migration</AlertTitle>
          <AlertDescription>{detailErrorMessage}</AlertDescription>
        </Alert>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            loading={detailQuery.isFetching}
            onClick={() => void retryDetail()}
          >
            {detailQuery.isFetching ? "Retrying…" : "Retry"}
          </Button>
          <Button asChild variant="outline">
            <Link href="/app/migrations">Back to migrations</Link>
          </Button>
        </div>
      </PageShell>
    );
  }

  if (!job) {
    // Structured skeleton rather than a lone spinner (MIGR-015).
    return (
      <PageShell className="max-w-4xl">
        <h1 className="sr-only">Migration details</h1>
        <span role="status" className="sr-only">
          Loading migration details
        </span>
        <div className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-8 w-56" />
              <Skeleton className="h-4 w-64" />
            </div>
            <Skeleton className="h-6 w-24 rounded-full" />
          </div>
        </div>
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-md border bg-card p-5">
            <Skeleton className="h-5 w-48" />
            <div className="grid gap-3 sm:grid-cols-3">
              {Array.from({ length: 3 }).map((_, s) => (
                <div key={s} className="space-y-2 rounded-md border p-4">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-7 w-14" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </PageShell>
    );
  }

  const cancelled = isCancelledJob(job);
  const reportIsPreview =
    job.status !== "completed" && job.status !== "rolled_back";
  const rollbackOpen =
    (job.status === "completed" || cancelled) &&
    !!job.rollback_until &&
    new Date(job.rollback_until).getTime() > Date.now();

  return (
    <PageShell
      key={detailScope}
      className="max-w-4xl [&_[data-slot=button]]:min-h-11 [&_[data-slot=button]]:min-w-11 [&_input]:min-h-11 [&_select]:min-h-11 sm:[&_[data-slot=button]]:min-h-9 sm:[&_[data-slot=button]]:min-w-0 sm:[&_input]:min-h-9 sm:[&_select]:min-h-9"
    >
      <header className="relative isolate space-y-4 overflow-hidden rounded-2xl border bg-card p-4 shadow-pw-sm sm:p-6">
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-gradient-to-br from-primary/[0.08] via-transparent to-info-subtle/25"
        />
        <Breadcrumb
          items={[
            { label: "All migrations", href: "/app/migrations" },
            { label: `${SOURCE_LABELS[job.source]} migration` },
          ]}
        />
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <MigrationTitle
              job={job}
              defaultTitle={`${SOURCE_LABELS[job.source]} migration`}
              canWrite={canAdmin}
              onSave={renameMigration}
            />
            <p className="text-sm text-muted-foreground mt-1">
              Started {new Date(job.started_at).toLocaleString()}
              {job.completed_at &&
                ` · completed ${new Date(job.completed_at).toLocaleString()}`}
            </p>
            {/* MIGR-038: a pending scheduled start (from the job cursor). */}
            {(() => {
              const at = job.cursor?.["scheduled_start_at"];
              return at && new Date(at).getTime() > Date.now() ? (
                <p className="text-sm text-muted-foreground mt-1">
                  Scheduled to start {new Date(at).toLocaleString()}
                </p>
              ) : null;
            })()}
          </div>
          <div className="space-y-1 sm:shrink-0 sm:text-right">
            <StatusBadge status={job.status} />
            {rollbackOpen && job.rollback_until && (
              <p className="text-xs text-muted-foreground">
                {daysUntil(job.rollback_until)} days remaining for rollback
              </p>
            )}
          </div>
        </div>
      </header>

      {Object.keys(detailSidecarErrors).length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>Migration evidence partially unavailable</AlertTitle>
          <AlertDescription>
            <p>
              These requests failed; empty sections below must not be treated as
              evidence that nothing happened.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {Object.entries(detailSidecarErrors).map(([key, message]) => (
                <li key={key}>
                  {key === "report" ? "Verification report" : "Audit log"}:{" "}
                  {message}
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              className="mt-3 bg-background"
              loading={detailQuery.isFetching}
              onClick={() => void retryDetail()}
            >
              {detailQuery.isFetching ? "Retrying…" : "Retry evidence"}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Suspense
        fallback={<DeferredPanelFallback label="selected audience scope" />}
      >
        <SelectedAudienceScopeCard job={job} />
      </Suspense>

      {pilotControlsQuery.isError ? (
        <Alert variant="warning">
          <AlertTitle>Pilot controls could not be loaded</AlertTitle>
          <AlertDescription>
            The pilot-controls request failed, so the checklist below is missing
            its evidence — that is a failed request, not a cutover with nothing
            recorded. Retry before treating the checklist as final.
            <Button
              type="button"
              variant="outline"
              className="mt-3 bg-background"
              loading={pilotControlsQuery.isFetching}
              onClick={() => void loadPilotControls()}
            >
              {pilotControlsQuery.isFetching
                ? "Retrying…"
                : "Retry pilot controls"}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {pilotControlErrorEntries.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>Pilot controls partially unavailable</AlertTitle>
          <AlertDescription>
            <div>
              Some cutover controls could not be loaded. Refresh after fixing
              these errors before treating the checklist as final.
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {pilotControlErrorEntries.map(([key, message]) => (
                <li key={key}>
                  {pilotControlLabel(key)}: {message}
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              className="mt-3 bg-background"
              loading={pilotControlsQuery.isFetching}
              onClick={() => void loadPilotControls()}
            >
              {pilotControlsQuery.isFetching
                ? "Retrying…"
                : "Retry missing controls"}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {(["completed", "failed", "rolled_back"] as string[]).includes(
        job.status,
      ) ? (
        <Suspense fallback={<DeferredPanelFallback label="source cleanup" />}>
          <SourceCleanupCard
            job={job}
            authorityKey={identityStamp}
            beforeWrite={confirmChildWrite}
            onRemoved={(next) => {
              setJob(next);
              void Promise.all([
                queryClient.invalidateQueries({
                  queryKey: migrationDetailKey,
                  exact: true,
                }),
                queryClient.invalidateQueries({
                  queryKey: migrationPilotKey,
                  exact: true,
                }),
              ]);
            }}
          />
        </Suspense>
      ) : null}

      {(job.source === "activecampaign" ||
        job.source === "hubspot" ||
        job.source === "beehiiv" ||
        job.source === "klaviyo" ||
        job.source === "customerio" ||
        job.source === "brevo") &&
      cutoverSessionStatus.kind !== "ok" ? (
        <Suspense
          fallback={<DeferredPanelFallback label="source reconnection" />}
        >
          <ActiveCampaignSessionReconnectCard
            source={job.source}
            jobId={job.id}
            sessionStatus={cutoverSessionStatus}
            beforeWrite={confirmChildWrite}
            authorityKey={identityStamp}
            pending={pilotPending === "source-session"}
            onReconnected={(next) => {
              setJob(next);
              void Promise.all([
                queryClient.invalidateQueries({
                  queryKey: migrationDetailKey,
                  exact: true,
                }),
                queryClient.invalidateQueries({
                  queryKey: migrationPilotKey,
                  exact: true,
                }),
              ]);
            }}
            onPendingChange={(pending) =>
              setPilotPending(pending ? "source-session" : null)
            }
          />
        </Suspense>
      ) : null}

      {(job.source === "mailchimp" || job.source === "convertkit") &&
      cutoverSessionStatus.kind !== "ok" ? (
        <Suspense
          fallback={<DeferredPanelFallback label="source reconnection" />}
        >
          <OAuthSessionReconnectCard
            source={job.source}
            jobId={job.id}
            sessionStatus={cutoverSessionStatus}
            returnTo="detail"
            beforeWrite={confirmChildWrite}
            authorityKey={identityStamp}
            markerIdentity={identity}
          />
        </Suspense>
      ) : null}

      {isInFlight(job.status) && (
        <Suspense
          fallback={<DeferredPanelFallback label="migration progress" />}
        >
          <MigrationProgressView
            jobId={job.id}
            sourceLabel={SOURCE_LABELS[job.source]}
            source={job.source}
            onComplete={handleProgressComplete}
            beforeWrite={confirmChildWrite}
            authorityKey={identityStamp}
          />
        </Suspense>
      )}

      {cancelled && (
        <Suspense
          fallback={<DeferredPanelFallback label="cancelled migration" />}
        >
          <CancelledBanner
            importedSubscribers={job.progress.subscribers_done}
            onView={() =>
              document
                .getElementById("verification-report")
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
            onResume={() => void resumeCancelledJob()}
            onRollback={() => {
              if (rollbackOpen) {
                document
                  .getElementById("rollback-section")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              } else {
                toast.warning(
                  "Rollback is not available for this migration yet.",
                );
              }
            }}
          />
        </Suspense>
      )}

      {report && (
        <div id="verification-report">
          <Suspense
            fallback={<DeferredPanelFallback label="verification report" />}
          >
            <VerificationReportCard
              report={report}
              source={job.source}
              preview={reportIsPreview}
            />
          </Suspense>
        </div>
      )}

      {/* MIGR-038: optional off-peak schedule for the delta import (only a
          completed migration can run one). runDeltaImport reads this value. */}
      {report && job.status === "completed" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Schedule delta import (optional)
            </CardTitle>
            <CardDescription>
              Leave empty to run the delta import now, or pick a future time to
              run it off-peak.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <Label htmlFor="delta-schedule-at">Start at</Label>
            <Input
              id="delta-schedule-at"
              type="datetime-local"
              min={localDateTimeMin()}
              value={deltaScheduledFor}
              onChange={(e) => setDeltaScheduledFor(e.target.value)}
              className="max-w-xs"
            />
            <p className="text-xs text-muted-foreground">
              Times are in your timezone ({localTimezoneLabel()}).
            </p>
          </CardContent>
        </Card>
      ) : null}

      {report && reportIsPreview ? (
        <Alert>
          <AlertTitle>Pilot acceptance requires a completed import</AlertTitle>
          <AlertDescription>
            This report contains preview counts. Review the dry-run findings
            above; they do not prove that contacts were imported or that cutover
            is ready. Pilot acceptance checks become available after a real
            import completes.
          </AlertDescription>
        </Alert>
      ) : null}

      {report && !reportIsPreview && !pilotControlsQuery.isError && (
        <Suspense fallback={<PilotAcceptanceSkeleton />}>
          <PilotAcceptanceCard
            job={job}
            report={report}
            acceptance={acceptance}
            rebuilds={rebuilds}
            pending={pilotPending}
            onRefresh={loadPilotControls}
            onDeltaImport={runDeltaImport}
            onMarkAutomation={markAutomation}
            onMarkCutoverEvidence={markCutoverEvidence}
            sourceSessionStatus={cutoverSessionStatus}
            shadow={shadow}
            onStartShadow={startShadow}
            onStopShadow={stopShadow}
            sourceEvents={sourceEvents}
            onStartSourceEvents={startSourceEventReplay}
            onStopSourceEvents={stopSourceEventReplay}
            onUpdateSourceEventReview={reviewSourceEvent}
          />
        </Suspense>
      )}

      {rollbackOpen && (
        <Suspense
          fallback={<DeferredPanelFallback label="rollback controls" />}
        >
          <RollbackSection
            job={job}
            report={report}
            source={job.source}
            onRolledBack={(updatedJob) => setJob(updatedJob)}
            beforeWrite={confirmChildWrite}
          />
        </Suspense>
      )}

      {job.status === "completed" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Where to next</CardTitle>
            <CardDescription>
              Jump to the data you just imported, or start another migration.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense
              fallback={<DeferredPanelFallback label="imported data links" />}
            >
              <ImportedDataLinks
                source={job.source}
                showTemplates={
                  job.source === "mailchimp" ||
                  job.source === "klaviyo" ||
                  job.source === "customerio"
                }
              />
            </Suspense>
          </CardContent>
        </Card>
      )}

      {audit.length > 0 ? (
        <Suspense
          fallback={<DeferredPanelFallback label="migration activity" />}
        >
          <AuditCard entries={audit} />
        </Suspense>
      ) : null}
    </PageShell>
  );
}

// ─── Rollback section ─────────────────────────────────────────────────────

// ─── Audit log preview ────────────────────────────────────────────────────

// ─── small helpers ────────────────────────────────────────────────────────

function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function isInFlight(status: MigrationJob["status"]): boolean {
  return (
    status === "discovering" ||
    status === "dry_run" ||
    status === "importing" ||
    status === "authenticating"
  );
}

function isCancelledJob(job: MigrationJob): boolean {
  return (
    job.status === "failed" &&
    typeof job.error === "string" &&
    job.error.toLowerCase().includes("cancel")
  );
}

function automationQuickActionEvidence(
  status: AutomationRebuildItem["status"],
): string | undefined {
  const recordedAt = new Date().toISOString();
  if (status === "test_passed") {
    return `Dashboard operator marked this ActiveCampaign automation rebuild as test-passed at ${recordedAt}.`;
  }
  if (status === "approved_not_needed") {
    return `Dashboard operator approved this ActiveCampaign automation as not needed for cutover at ${recordedAt}.`;
  }
  return undefined;
}

function pilotControlLabel(key: string): string {
  switch (key) {
    case "acceptance":
      return "Pilot acceptance";
    case "rebuilds":
      return "Automation rebuild ledger";
    case "shadow":
      return "Shadow monitor";
    case "sourceEvents":
      return "Source-event replay";
    default:
      return key;
  }
}
