// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  ListChecks,
  Mail,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import {
  useRegisterCommands,
  type PageCommand,
} from "@/components/command-registry";
import {
  OperationsFailure,
  OperationsHeader,
  OperationsLoading,
  OperationsSection,
  OperationsShell,
} from "@/components/operations/operations-surface";
import { RelativeTime } from "@/components/relative-time";
import { ServiceNotDeployedNotice } from "@/components/service-not-deployed-notice";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RollbackRehearsalReport } from "@/lib/migration-api";
import { optionalPilotEvidence, scopePilotJobs } from "@/lib/pilot-evidence";
import { blockerWarningLabel, pluralize } from "@/lib/pluralize";
import { base, qk, STALE } from "@/lib/query-keys";
import { isServiceNotDeployed } from "@/lib/service-availability";
import type {
  SendingReadiness,
  SendingReadinessItem,
} from "@/lib/sending-controls-api";
import type {
  SmsPilotReadiness,
  SmsPilotReadinessItem,
  SmsSenderPilotCertification,
} from "@/lib/sms-api";
import type {
  AutomationRebuildItem,
  MigrationJob,
  PilotAcceptanceReport,
  ShadowMonitorResponse,
  VerificationReport,
} from "@/lib/types";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { asRoute } from "@/lib/typed-routes";

const REBUILD_CAP = 10;
const JOB_CAP = 8;
type PilotStatus = "pass" | "warning" | "blocker" | "unavailable";
type PilotTab = "overview" | "automations" | "sms" | "migrations";

interface PilotState {
  jobs: MigrationJob[];
  selectedJob: MigrationJob | null;
  allJobsCount: number;
  excludedJobsCount: number;
  acceptance: PilotAcceptanceReport | null;
  rollback: RollbackRehearsalReport | null;
  shadow: ShadowMonitorResponse | null;
  rebuilds: AutomationRebuildItem[];
  email: SendingReadiness | null;
  sms: SmsPilotReadiness | null;
  senderCerts: SmsSenderPilotCertification[];
  unavailable: string[];
  loadedAt: string;
}

async function loadPilotState(): Promise<PilotState> {
  // These clients carry the migration, sending-control, and SMS operational
  // surfaces. Load them with the evidence query rather than making every
  // initial visit parse all three before the authenticated identity gate has
  // even resolved.
  const [migrationRuntime, sendingRuntime, smsRuntime] = await Promise.all([
    import("@/lib/migration-api"),
    import("@/lib/sending-controls-api"),
    import("@/lib/sms-api"),
  ]);
  // Migration inventory is the critical selector. If it fails, no evidence is
  // queried against a guessed job and the entire query becomes retryable.
  const inventory = scopePilotJobs(await migrationRuntime.listJobs());
  const selectedJob = inventory.inScope[0] ?? null;
  const unavailable: string[] = [];
  const [acceptance, rollback, shadow, rebuilds, email, sms, senderCerts] =
    await Promise.all([
      selectedJob
        ? optionalPilotEvidence(
            "Pilot acceptance",
            () => migrationRuntime.getPilotAcceptance(selectedJob.id),
            unavailable,
          )
        : Promise.resolve(null),
      selectedJob
        ? optionalPilotEvidence(
            "Rollback rehearsal",
            () => migrationRuntime.getRollbackRehearsal(selectedJob.id),
            unavailable,
          )
        : Promise.resolve(null),
      selectedJob
        ? optionalPilotEvidence(
            "Shadow monitor",
            () => migrationRuntime.getShadowMonitor(selectedJob.id),
            unavailable,
          )
        : Promise.resolve(null),
      selectedJob
        ? optionalPilotEvidence(
            "Automation rebuilds",
            () =>
              migrationRuntime
                .listAutomationRebuilds(selectedJob.id)
                .then((result) => result.items),
            unavailable,
          )
        : Promise.resolve([]),
      optionalPilotEvidence(
        "Email readiness",
        () => sendingRuntime.sendingControlsApi.readiness(),
        unavailable,
      ),
      optionalPilotEvidence(
        "SMS readiness",
        smsRuntime.getSmsPilotReadiness,
        unavailable,
      ),
      optionalPilotEvidence(
        "SMS sender certifications",
        () =>
          smsRuntime
            .listSmsSenderPilotCertifications()
            .then((result) => result.items),
        unavailable,
      ),
    ] as const);

  return {
    jobs: inventory.inScope,
    selectedJob,
    allJobsCount: inventory.total,
    excludedJobsCount: inventory.excluded,
    acceptance,
    rollback,
    shadow,
    rebuilds: rebuilds ?? [],
    email,
    sms,
    senderCerts: senderCerts ?? [],
    unavailable,
    loadedAt: new Date().toISOString(),
  };
}

export default function PilotCommandCenterPage() {
  const [tab, setTab] = useState<PilotTab>("overview");
  const notDeployedId = useId();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anonymous";
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const pilotQuery = useQuery({
    queryKey: base("pilot-readiness", tenantId, role),
    queryFn: loadPilotState,
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });
  const refreshRef = useRef(() => void pilotQuery.refetch());
  refreshRef.current = () => void pilotQuery.refetch();
  const commands = useMemo<PageCommand[]>(
    () => [
      {
        id: "refresh-pilot",
        label: "Refresh pilot",
        keywords: "reload jobs readiness status",
        run: () => refreshRef.current(),
      },
    ],
    [],
  );
  useRegisterCommands(commands);

  if (meQuery.isPending) {
    return <PilotBoundary mode="loading" />;
  }
  if (meQuery.isError) {
    return (
      <PilotBoundary
        mode="auth-error"
        onRetry={() => void meQuery.refetch()}
        retrying={meQuery.isFetching}
      />
    );
  }

  const state = pilotQuery.data;
  const summary = state ? buildSummary(state) : null;
  // The migration inventory answered 503 service_not_deployed: this
  // environment runs no migrations, so there is no pilot to assess and no
  // refresh that could produce one.
  const notDeployed = isServiceNotDeployed(pilotQuery.error);

  return (
    <OperationsShell className="max-w-7xl">
      <OperationsHeader
        icon={ClipboardCheck}
        eyebrow="First-customer command center"
        title="Pilot readiness"
        description="Read-only evidence for ActiveCampaign and HubSpot migration pilots, email safety, SMS certification, consent coverage, and rollback preparedness. This surface does not send traffic or deploy changes."
        actions={
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => void pilotQuery.refetch()}
              loading={pilotQuery.isFetching}
              disabled={notDeployed}
              aria-describedby={notDeployed ? notDeployedId : undefined}
            >
              <RefreshCw aria-hidden />
              Refresh
            </Button>
            {state ? (
              <span className="text-xs text-muted-foreground">
                Updated <RelativeTime iso={state.loadedAt} />
              </span>
            ) : null}
          </div>
        }
      />

      {pilotQuery.isError && state && !notDeployed ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Refresh failed</AlertTitle>
          <AlertDescription>
            The last successful snapshot remains below. Its timestamp has not
            changed; retry when the migration inventory is available.
          </AlertDescription>
        </Alert>
      ) : null}

      {state?.excludedJobsCount ? (
        <Alert>
          <AlertTitle>
            {pluralize(state.excludedJobsCount, "migration")} excluded from
            pilot evidence
          </AlertTitle>
          <AlertDescription>
            Only ActiveCampaign and HubSpot jobs are in scope. Other source jobs
            remain available on the migrations page and are never used as
            fallback evidence here.
          </AlertDescription>
        </Alert>
      ) : null}

      {state && state.unavailable?.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>Some evidence is unavailable</AlertTitle>
          <AlertDescription>
            Missing values are not failed checks or empty results.
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {state.unavailable.map((message) => (
                <li key={message} className="break-words">
                  {message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {pilotQuery.isPending ? (
        <PilotSkeleton />
      ) : notDeployed ? (
        <ServiceNotDeployedNotice
          id={notDeployedId}
          title="Pilot readiness isn't set up in this environment"
        >
          <p>
            Pilot readiness is built from migration jobs, and this environment
            doesn&apos;t run migrations, so there is nothing to assess or
            refresh here.
          </p>
          <p className="mt-2">
            Email and SMS readiness can still be checked in{" "}
            <Link
              href={asRoute("/app/settings/sender")}
              className="font-medium underline underline-offset-2"
            >
              Sender settings
            </Link>{" "}
            and{" "}
            <Link
              href={asRoute("/app/sms")}
              className="font-medium underline underline-offset-2"
            >
              SMS
            </Link>
            .
          </p>
        </ServiceNotDeployedNotice>
      ) : pilotQuery.isError && !state ? (
        <OperationsFailure
          title="Pilot migration inventory could not be loaded"
          description="No pilot job was guessed and no missing evidence is presented as a blocker or empty result. Try again when the migration service is available."
          error={pilotQuery.error}
          onRetry={() => void pilotQuery.refetch()}
          retrying={pilotQuery.isFetching}
        />
      ) : state && summary ? (
        <Tabs value={tab} onValueChange={(value) => setTab(value as PilotTab)}>
          <TabsList
            aria-label="Pilot readiness views"
            className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4"
          >
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="automations">Automation rebuilds</TabsTrigger>
            <TabsTrigger value="sms">SMS senders</TabsTrigger>
            <TabsTrigger value="migrations">Migration jobs</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-5 space-y-6">
            <Overview state={state} summary={summary} />
          </TabsContent>
          <TabsContent value="automations" className="mt-5">
            <AutomationRebuilds
              state={state}
              onRetry={() => void pilotQuery.refetch()}
            />
          </TabsContent>
          <TabsContent value="sms" className="mt-5">
            <SmsSenders
              state={state}
              onRetry={() => void pilotQuery.refetch()}
            />
          </TabsContent>
          <TabsContent value="migrations" className="mt-5">
            <MigrationJobs state={state} />
          </TabsContent>
        </Tabs>
      ) : null}
    </OperationsShell>
  );
}

function PilotBoundary({
  mode,
  onRetry,
  retrying = false,
}: {
  mode: "loading" | "auth-error";
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <OperationsShell className="max-w-7xl">
      <OperationsHeader
        icon={ClipboardCheck}
        eyebrow="First-customer command center"
        title="Pilot readiness"
        description="Read-only migration, email, SMS, and rollback evidence."
      />
      {mode === "loading" ? (
        <PilotSkeleton label="Verifying pilot access" />
      ) : (
        <OperationsFailure
          title="Pilot access could not be verified"
          description="No pilot evidence was requested. Check the connection and try again."
          onRetry={onRetry}
          retrying={retrying}
        />
      )}
    </OperationsShell>
  );
}

function PilotSkeleton({
  label = "Loading pilot evidence",
}: {
  label?: string;
}) {
  return <OperationsLoading label={label} rows={8} />;
}

interface PilotSummary {
  overall: PilotStatus;
  overallDetail: string;
  migration: PilotStatus;
  migrationDetail: string;
  email: PilotStatus;
  emailDetail: string;
  sms: PilotStatus;
  smsDetail: string;
}

function Overview({
  state,
  summary,
}: {
  state: PilotState;
  summary: PilotSummary;
}) {
  const jobHref = state.selectedJob
    ? `/app/migrations/${state.selectedJob.id}`
    : undefined;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatusTile
          label="Overall pilot"
          status={summary.overall}
          detail={summary.overallDetail}
        />
        <StatusTile
          label="Migration"
          status={summary.migration}
          detail={summary.migrationDetail}
          href={jobHref}
        />
        <StatusTile
          label="Email"
          status={summary.email}
          detail={summary.emailDetail}
          href="/app/settings/sender"
          items={emailFailingItems(state.email).map((item) => ({
            key: item.key,
            label: item.label,
            status: item.severity,
          }))}
        />
        <StatusTile
          label="SMS"
          status={summary.sms}
          detail={summary.smsDetail}
          href="/app/sms"
          items={smsFailingItems(state.sms).map((item) => ({
            key: item.key,
            label: item.label,
            status: item.status,
          }))}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <OperationsSection
          id="pilot-cutover-evidence"
          title="Cutover evidence"
          description="Known blockers outrank unavailable evidence; unavailable requests never masquerade as failed checks."
        >
          <div className="space-y-3">
            <EvidenceRow
              icon={ShieldCheck}
              label="Pilot acceptance"
              status={evidenceStatus(
                state,
                "Pilot acceptance",
                state.acceptance?.status,
              )}
              detail={
                state.acceptance
                  ? `${blockerWarningLabel(state.acceptance.blockers, state.acceptance.warnings)}.`
                  : evidenceDetail(state, "Pilot acceptance")
              }
              href={jobHref}
            />
            <EvidenceRow
              icon={RefreshCw}
              label="Shadow monitor"
              status={evidenceStatus(
                state,
                "Shadow monitor",
                state.shadow ? shadowStatus(state.shadow) : undefined,
              )}
              detail={
                state.shadow
                  ? shadowDetail(state.shadow)
                  : evidenceDetail(state, "Shadow monitor")
              }
              href={jobHref}
            />
            <EvidenceRow
              icon={CheckCircle2}
              label="Rollback rehearsal"
              status={evidenceStatus(
                state,
                "Rollback rehearsal",
                state.rollback ? rollbackStatus(state.rollback) : undefined,
              )}
              detail={
                state.rollback
                  ? rollbackDetail(state.rollback)
                  : evidenceDetail(state, "Rollback rehearsal")
              }
              href={jobHref}
            />
            <EvidenceRow
              icon={Mail}
              label="Email sending readiness"
              status={summary.email}
              detail={summary.emailDetail}
              href="/app/settings/sender"
            />
            <EvidenceRow
              icon={MessageSquareText}
              label="SMS pilot readiness"
              status={summary.sms}
              detail={summary.smsDetail}
              href="/app/sms"
            />
          </div>
        </OperationsSection>

        <OperationsSection
          id="pilot-consent"
          title="Consent reconciliation"
          description="Unknown imported consent remains review-required and should stay out of live audiences until evidence or customer sign-off exists."
        >
          {state.selectedJob ? (
            <>
              <ConsentMeter report={state.selectedJob.verification_report} />
              <Button variant="outline" className="mt-5" asChild>
                <Link href={asRoute(`/app/migrations/${state.selectedJob.id}`)}>
                  Open migration report
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            </>
          ) : (
            <NoInScopeJob state={state} />
          )}
        </OperationsSection>
      </div>

      {state.acceptance?.items?.length ? (
        <OperationsSection
          id="pilot-cutover-signoff"
          title="Cutover evidence sign-off"
          description="Read-only status. Record or update evidence on the selected migration."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {state.acceptance.items.map((item) => (
              <div
                key={item.key}
                className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="break-words font-medium">{item.label}</p>
                  {item.detail ? (
                    <p className="mt-1 break-words text-xs text-muted-foreground">
                      {item.detail}
                    </p>
                  ) : null}
                </div>
                <Badge
                  variant={variantFor(item.status)}
                  className="w-fit shrink-0"
                >
                  {item.status}
                </Badge>
              </div>
            ))}
          </div>
        </OperationsSection>
      ) : null}
    </>
  );
}

function AutomationRebuilds({
  state,
  onRetry,
}: {
  state: PilotState;
  onRetry: () => void;
}) {
  const unavailable = hasUnavailable(state, "Automation rebuilds");
  return (
    <OperationsSection
      id="pilot-automation-rebuilds"
      title="Automation rebuild status"
      description="Read-only evidence for the newest in-scope migration. Update rebuild status on migration detail."
    >
      {!state.selectedJob ? (
        <NoInScopeJob state={state} />
      ) : unavailable ? (
        <OperationsFailure
          title="Automation rebuild evidence is unavailable"
          description="This is a failed request, not an empty rebuild list. The selected migration was not changed."
          onRetry={onRetry}
        />
      ) : state.rebuilds.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No rebuilds tracked for this pilot job"
          description="The selected in-scope migration returned an empty automation-rebuild list."
          action={
            <Button variant="outline" asChild>
              <Link href={asRoute(`/app/migrations/${state.selectedJob.id}`)}>
                Open selected migration
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {state.rebuilds.slice(0, REBUILD_CAP).map((item) => (
            <div
              key={`${item.rank}:${item.source_id ?? item.name}`}
              className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0">
                <p className="break-words font-medium">
                  #{item.rank} {item.name || "Untitled automation"}
                </p>
                {item.notes ? (
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {item.notes}
                  </p>
                ) : null}
              </div>
              <Badge
                variant={variantFor(item.status)}
                className="w-fit shrink-0"
              >
                {item.status.replaceAll("_", " ")}
              </Badge>
            </div>
          ))}
          <ShowingNote
            shown={Math.min(REBUILD_CAP, state.rebuilds.length)}
            total={state.rebuilds.length}
            noun="rebuild"
          />
        </div>
      )}
    </OperationsSection>
  );
}

function SmsSenders({
  state,
  onRetry,
}: {
  state: PilotState;
  onRetry: () => void;
}) {
  return (
    <OperationsSection
      id="pilot-sms-senders"
      title="SMS sender certification"
      description="Per-sender certification evidence, separate from tenant-level SMS readiness."
    >
      {hasUnavailable(state, "SMS sender certifications") ? (
        <OperationsFailure
          title="Sender certifications are unavailable"
          description="This is a failed request, not evidence that no senders exist."
          onRetry={onRetry}
        />
      ) : state.senderCerts.length === 0 ? (
        <EmptyState
          icon={MessageSquareText}
          title="No SMS sender certifications"
          description="The certification endpoint returned no senders. Add and verify a sender to generate per-sender evidence."
          action={
            <Button variant="outline" asChild>
              <Link href={asRoute("/app/sms")}>Set up SMS sender</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {state.senderCerts.map((certification) => (
            <SenderCertification
              key={certification.sender.id}
              certification={certification}
            />
          ))}
        </div>
      )}
    </OperationsSection>
  );
}

function SenderCertification({
  certification,
}: {
  certification: SmsSenderPilotCertification;
}) {
  const label =
    certification.sender.phone_number ||
    certification.sender.messaging_service_sid ||
    certification.sender.id;
  return (
    <div className="min-w-0 rounded-lg border p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="break-all font-medium">{label}</p>
          <p className="mt-1 break-words text-xs text-muted-foreground">
            {certification.sender.provider} · {certification.sender.sender_type}
          </p>
        </div>
        <Badge
          variant={certification.can_pilot ? "success" : "destructive"}
          className="w-fit shrink-0"
        >
          {certification.can_pilot ? "certified" : "blocked"}
        </Badge>
      </div>
      {certification.items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No per-check evidence was returned for this sender.
        </p>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {certification.items.map((item) => (
            <div
              key={item.key}
              className="flex min-w-0 items-start justify-between gap-2 rounded-md bg-muted/40 p-2 text-xs"
            >
              <span className="break-words font-medium">{item.label}</span>
              <Badge variant={variantFor(item.status)} className="shrink-0">
                {item.status}
              </Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MigrationJobs({ state }: { state: PilotState }) {
  return (
    <OperationsSection
      id="pilot-migration-jobs"
      title="Migration jobs in scope"
      description="Only ActiveCampaign and HubSpot jobs contribute to this command center."
    >
      {state.jobs.length === 0 ? (
        <NoInScopeJob state={state} />
      ) : (
        <div className="space-y-2">
          {state.jobs.slice(0, JOB_CAP).map((job) => (
            <Link
              key={job.id}
              href={asRoute(`/app/migrations/${job.id}`)}
              className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="font-medium">{job.source}</p>
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                  {job.id}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={variantFor(job.status)}>
                  {job.status.replaceAll("_", " ")}
                </Badge>
                <ArrowRight aria-hidden />
              </div>
            </Link>
          ))}
          <ShowingNote
            shown={Math.min(JOB_CAP, state.jobs.length)}
            total={state.jobs.length}
            noun="in-scope job"
          />
          <Button variant="outline" asChild>
            <Link href={asRoute("/app/migrations")}>View all migrations</Link>
          </Button>
        </div>
      )}
    </OperationsSection>
  );
}

function NoInScopeJob({ state }: { state: PilotState }) {
  const noneAtAll = state.allJobsCount === 0;
  return (
    <EmptyState
      icon={ClipboardCheck}
      title={
        noneAtAll ? "No migrations exist yet" : "No in-scope pilot migrations"
      }
      description={
        noneAtAll
          ? "There are no migration jobs to evaluate. Start an ActiveCampaign or HubSpot migration to generate pilot evidence."
          : `${pluralize(state.excludedJobsCount, "migration")} ${state.excludedJobsCount === 1 ? "exists" : "exist"}, but ${state.excludedJobsCount === 1 ? "its source is" : "their sources are"} outside this ActiveCampaign and HubSpot pilot. They were not used as fallback evidence.`
      }
      action={
        <Button variant="outline" asChild>
          <Link
            href={asRoute(
              noneAtAll ? "/app/migrations/new" : "/app/migrations",
            )}
          >
            {noneAtAll ? "Start a migration" : "View excluded migrations"}
          </Link>
        </Button>
      }
    />
  );
}

function StatusTile({
  label,
  status,
  detail,
  href,
  items = [],
}: {
  label: string;
  status: PilotStatus;
  detail: string;
  href?: string;
  items?: Array<{ key: string; label: string; status: string }>;
}) {
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const disclosureId = useId();
  return (
    <section
      aria-labelledby={labelId}
      className="min-w-0 rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <p id={labelId} className="text-sm font-medium">
          {label}
        </p>
        <Badge variant={variantFor(status)} className="shrink-0">
          {status}
        </Badge>
      </div>
      <p className="mt-2 break-words text-xs leading-5 text-muted-foreground">
        {detail}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {href ? (
          <Link
            href={asRoute(href)}
            className="text-xs font-medium text-primary"
          >
            Open evidence
          </Link>
        ) : null}
        {items.length > 0 ? (
          <button
            type="button"
            className="inline-flex min-h-11 min-w-11 items-center gap-1 rounded-sm text-xs font-medium text-primary focus-visible:ring-2 sm:min-h-8 sm:min-w-0"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            aria-controls={disclosureId}
          >
            {open ? "Hide" : "Show"} {pluralize(items.length, "failing check")}
            <ChevronDown
              className={`size-3 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
              aria-hidden
            />
          </button>
        ) : null}
      </div>
      {items.length > 0 ? (
        <ul id={disclosureId} hidden={!open} className="mt-2 space-y-1">
          {items.map((item) => (
            <li
              key={item.key}
              className="flex min-w-0 items-start justify-between gap-2 rounded bg-muted/40 px-2 py-1 text-xs"
            >
              <span className="break-words">{item.label}</span>
              <Badge variant={variantFor(item.status)} className="shrink-0">
                {item.status}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function EvidenceRow({
  icon: Icon,
  label,
  status,
  detail,
  href,
}: {
  icon: LucideIcon;
  label: string;
  status: PilotStatus;
  detail: string;
  href?: string;
}) {
  const body = (
    <div className="flex min-w-0 items-start gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/40">
      <Icon
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <p className="break-words font-medium">{label}</p>
          <Badge variant={variantFor(status)} className="w-fit shrink-0">
            {status}
          </Badge>
        </div>
        <p className="mt-1 break-words text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
  return href ? <Link href={asRoute(href)}>{body}</Link> : body;
}

function ConsentMeter({ report }: { report?: VerificationReport | null }) {
  const known = report?.consent_known ?? 0;
  const unknown = report?.consent_unknown ?? 0;
  const total = known + unknown;
  const percentage = total > 0 ? Math.round((known / total) * 100) : 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">Consent coverage</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {total > 0
              ? `${known.toLocaleString()} known, ${unknown.toLocaleString()} review-required`
              : "The selected job has no consent coverage metrics."}
          </p>
        </div>
        <Badge
          variant={unknown === 0 && total > 0 ? "success" : "warning"}
          className="w-fit"
        >
          {total > 0 ? `${percentage}% known` : "no metrics"}
        </Badge>
      </div>
      <Progress
        value={percentage}
        aria-label={
          total > 0
            ? `Consent coverage: ${percentage}% known`
            : "Consent coverage: no metrics"
        }
      />
      {unknown > 0 ? (
        <div className="flex gap-2 rounded-lg bg-warning-subtle p-3 text-xs text-warning-emphasis">
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          Unknown consent exists. Keep those contacts out of live audiences
          until source proof or customer sign-off exists.
        </div>
      ) : null}
    </div>
  );
}

function buildSummary(state: PilotState): PilotSummary {
  const migrationParts: PilotStatus[] = state.selectedJob
    ? [
        evidenceStatus(state, "Pilot acceptance", state.acceptance?.status),
        evidenceStatus(
          state,
          "Rollback rehearsal",
          state.rollback ? rollbackStatus(state.rollback) : undefined,
        ),
        evidenceStatus(
          state,
          "Shadow monitor",
          state.shadow ? shadowStatus(state.shadow) : undefined,
        ),
      ]
    : ["warning"];
  const migration = combineStatuses(migrationParts);
  const email: PilotStatus = hasUnavailable(state, "Email readiness")
    ? "unavailable"
    : state.email?.ready
      ? "pass"
      : "blocker";
  const sms: PilotStatus = hasUnavailable(state, "SMS readiness")
    ? "unavailable"
    : state.sms?.can_pilot
      ? "pass"
      : "blocker";
  const overall = combineStatuses([migration, email, sms]);
  return {
    overall,
    overallDetail:
      overall === "pass"
        ? "Every available local control-plane gate is passing."
        : overall === "blocker"
          ? "One or more known hard gates are blocked."
          : overall === "unavailable"
            ? "Evidence is unavailable; readiness cannot be concluded."
            : "Human review or an in-scope migration is still required.",
    migration,
    migrationDetail: state.selectedJob
      ? `${state.selectedJob.source} · ${state.selectedJob.status.replaceAll("_", " ")}`
      : state.allJobsCount === 0
        ? "No migrations exist yet."
        : `No in-scope job; ${pluralize(state.excludedJobsCount, "migration")} excluded.`,
    email,
    emailDetail:
      email === "unavailable"
        ? "Email readiness evidence is unavailable."
        : emailDetail(state.email),
    sms,
    smsDetail:
      sms === "unavailable"
        ? "SMS readiness evidence is unavailable."
        : smsDetail(state.sms),
  };
}

function combineStatuses(statuses: PilotStatus[]): PilotStatus {
  if (statuses.includes("blocker")) return "blocker";
  if (statuses.includes("unavailable")) return "unavailable";
  if (statuses.includes("warning")) return "warning";
  return "pass";
}

function hasUnavailable(state: PilotState, label: string): boolean {
  return state.unavailable.some((message) => message.startsWith(`${label}:`));
}

function evidenceStatus(
  state: PilotState,
  label: string,
  known: string | undefined,
): PilotStatus {
  if (!state.selectedJob) return "warning";
  if (hasUnavailable(state, label)) return "unavailable";
  if (known === "pass" || known === "warning" || known === "blocker") {
    return known;
  }
  return "unavailable";
}

function evidenceDetail(state: PilotState, label: string): string {
  if (!state.selectedJob) {
    return state.allJobsCount === 0
      ? "No migrations exist, so no job-scoped evidence is available."
      : "No ActiveCampaign or HubSpot migration is available; excluded jobs were not used as fallback evidence.";
  }
  return hasUnavailable(state, label)
    ? `${label} could not be loaded.`
    : `${label} returned no supported evidence.`;
}

function shadowStatus(shadow: ShadowMonitorResponse): PilotStatus {
  if (shadow.monitor.last_error) return "blocker";
  if (shadow.history[0]?.needs_delta_import) return "blocker";
  return shadow.monitor.enabled ? "pass" : "warning";
}

function shadowDetail(shadow: ShadowMonitorResponse): string {
  if (shadow.monitor.last_error) return shadow.monitor.last_error;
  if (shadow.history[0]?.needs_delta_import) {
    return "Source-side delta detected; run a final delta import after freeze.";
  }
  return shadow.monitor.enabled
    ? `Enabled; last action ${shadow.monitor.last_recommended_action ?? "none"}.`
    : "Enable during the overlap window.";
}

function rollbackStatus(report: RollbackRehearsalReport): PilotStatus {
  if (report.status) return report.status;
  return report.rollbackable ? "pass" : "blocker";
}

function rollbackDetail(report: RollbackRehearsalReport): string {
  return (
    report.detail ||
    report.message ||
    `${pluralize(report.items?.length ?? 0, "rollback check")}.`
  );
}

function emailFailingItems(
  readiness: SendingReadiness | null,
): SendingReadinessItem[] {
  return readiness?.items?.filter((item) => !item.complete) ?? [];
}

function emailDetail(readiness: SendingReadiness | null): string {
  if (!readiness) return "Email readiness returned no supported evidence.";
  const blockers = readiness.items.filter(
    (item) => item.severity === "blocker" && !item.complete,
  ).length;
  const warnings = readiness.items.filter(
    (item) => item.severity === "warning" && !item.complete,
  ).length;
  return readiness.ready
    ? `${pluralize(warnings, "warning")}.`
    : `${blockerWarningLabel(blockers, warnings)}.`;
}

function smsFailingItems(
  readiness: SmsPilotReadiness | null,
): SmsPilotReadinessItem[] {
  return readiness?.items?.filter((item) => item.status !== "pass") ?? [];
}

function smsDetail(readiness: SmsPilotReadiness | null): string {
  if (!readiness) return "SMS readiness returned no supported evidence.";
  const blockers = readiness.items.filter(
    (item) => item.status === "blocker",
  ).length;
  const warnings = readiness.items.filter(
    (item) => item.status === "warning",
  ).length;
  return readiness.can_pilot
    ? `${pluralize(warnings, "warning")}.`
    : `${blockerWarningLabel(blockers, warnings)}.`;
}

function ShowingNote({
  shown,
  total,
  noun,
}: {
  shown: number;
  total: number;
  noun: string;
}) {
  return (
    <p className="text-xs text-muted-foreground">
      Showing {shown} of {pluralize(total, noun)}.
    </p>
  );
}

function variantFor(
  status: string,
): "default" | "secondary" | "destructive" | "outline" | "success" | "warning" {
  switch (status) {
    case "pass":
    case "completed":
    case "test_passed":
    case "approved_not_needed":
      return "success";
    case "blocker":
    case "failed":
    case "blocked":
      return "destructive";
    case "warning":
    case "rebuilding":
      return "warning";
    case "unavailable":
      return "outline";
    default:
      return "secondary";
  }
}
