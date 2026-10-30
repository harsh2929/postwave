// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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
import { ArrowLeft, ArrowRight, BookOpen, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  FreshAdminAuthorityError,
  verifyFreshAdminAuthority,
} from "@/lib/admin-mutation-authority";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import {
  initialSelectedAudienceIds,
  isMailchimpSource,
  selectedAudienceSet,
  selectedMailchimpAudienceIds,
} from "@/lib/migration-audience-selection";
import { migrationDocsHref } from "@/lib/migration-docs";
import { migrationAvailabilityDescription } from "@/lib/migration-capability-copy";
import {
  discover,
  dryRun,
  clearMigrationUploadLedgers,
  getJob,
  listCapabilities,
} from "@/lib/migration-api";
import { hubSpotDiscoveryIdentitySummary } from "@/lib/migration-discovery-summary";
import {
  sourceSessionBlocksAction,
  sourceSessionStatus,
} from "@/lib/migration-source-session";
import { base, qk, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import {
  MIGRATION_SOURCE_PLATFORMS,
  SOURCE_LABELS,
  type DiscoveryReport,
  type MigrationJob,
  type SourcePlatform,
  type VerificationReport,
} from "@/lib/types";
import { Stepper, type Step } from "@/components/migration/stepper";
import { PageShell } from "@/components/dashboard/page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

const ActiveCampaignSessionReconnectCard = lazy(() =>
  import("@/components/migration/activecampaign-session-reconnect-card").then(
    (module) => ({
      default: module.ActiveCampaignSessionReconnectCard,
    }),
  ),
);
const ConnectStep = lazy(() =>
  import("./connect-step").then((module) => ({
    default: module.ConnectStep,
  })),
);
const ImportedDataLinks = lazy(() =>
  import("../../_cross-links").then((module) => ({
    default: module.ImportedDataLinks,
  })),
);
const ImportStep = lazy(() =>
  import("./import-step").then((module) => ({
    default: module.ImportStep,
  })),
);
const ResourceCompleteness = lazy(() =>
  import("@/components/migration/resource-completeness").then((module) => ({
    default: module.ResourceCompleteness,
  })),
);
const ReviewOnlyAlert = lazy(() =>
  import("./review-only-alert").then((module) => ({
    default: module.ReviewOnlyAlert,
  })),
);
const ReviewStep = lazy(() =>
  import("./review-step").then((module) => ({
    default: module.ReviewStep,
  })),
);

const STEPS: Step[] = [
  { key: "connect", label: "Connect" },
  { key: "discover", label: "Discover" },
  { key: "review", label: "Dry-run review" },
  { key: "import", label: "Importing" },
  { key: "done", label: "Done" },
];

function StepLoading({ label }: { label: string }) {
  return (
    <Card role="status" aria-busy="true">
      <CardContent className="py-8 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <Loader2
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          Loading {label}…
        </span>
      </CardContent>
    </Card>
  );
}

function isSourcePlatform(s: string): s is SourcePlatform {
  return (MIGRATION_SOURCE_PLATFORMS as readonly string[]).includes(s);
}

type WizardState =
  | { step: 0 }
  | {
      step: 1;
      jobId: string;
      discovery: DiscoveryReport | null;
      loading: boolean;
      selectedAudienceIds: string[];
    }
  | {
      step: 2;
      jobId: string;
      job: MigrationJob | null;
      report: VerificationReport | null;
      loading: boolean;
      selectedAudiences?: NonNullable<DiscoveryReport["audiences"]>;
    }
  | { step: 3; jobId: string; job: MigrationJob | null }
  | { step: 4; job: MigrationJob };

export default function NewMigrationWizardPage({
  params,
}: {
  params: Promise<{ source: string }>;
}) {
  const { source: rawSource } = use(params);
  const router = useRouter();

  if (!isSourcePlatform(rawSource)) {
    return (
      <PageShell className="max-w-3xl [&_[data-slot=button]]:min-h-11 [&_[data-slot=button]]:min-w-11 sm:[&_[data-slot=button]]:min-h-9 sm:[&_[data-slot=button]]:min-w-0">
        <header className="space-y-2">
          <Breadcrumb
            items={[
              { label: "All migrations", href: "/app/migrations" },
              { label: "Unsupported source" },
            ]}
          />
          <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            Unsupported migration source
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            Choose a source from the capability-driven catalogue to begin a
            supported transfer.
          </p>
        </header>
        <Alert variant="destructive">
          <AlertTitle>Unknown source</AlertTitle>
          <AlertDescription>
            <code className="[overflow-wrap:anywhere]">{rawSource}</code>{" "}
            isn&apos;t a supported migration source.
          </AlertDescription>
        </Alert>
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link href="/app/migrations">
            <ArrowLeft aria-hidden="true" /> Back to migration sources
          </Link>
        </Button>
      </PageShell>
    );
  }

  return <MigrationWizard source={rawSource} router={router} />;
}

function migrationAuthorityFingerprint(identity: MeResponse): string {
  return [
    identity.tenant_id,
    identity.user_id,
    effectiveAuthRole(identity),
    identity.viewer_mode === true ? "viewer" : "member",
  ].join("\u0000");
}

function migrationQueryScope(identity: MeResponse) {
  return [
    ...base("migrations", identity.tenant_id, effectiveAuthRole(identity)),
    identity.user_id,
    identity.viewer_mode === true ? "viewer" : "member",
  ] as const;
}

function clearMigrationBrowserState(): void {
  clearMigrationUploadLedgers();
  try {
    sessionStorage.removeItem("postwave:oauth-pending");
  } catch {
    // Storage can be unavailable; mounted credential state is still unmounted.
  }
}

function MigrationWizard({
  source,
  router,
}: {
  source: SourcePlatform;
  router: ReturnType<typeof useRouter>;
}) {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const identity = meQuery.data ?? null;
  const effectiveRole = identity ? effectiveAuthRole(identity) : null;
  const canAdmin = Boolean(
    meQuery.isSuccess &&
    identity &&
    identity.viewer_mode !== true &&
    roleCanWrite(effectiveRole),
  );
  const authorityKey = identity
    ? migrationAuthorityFingerprint(identity)
    : null;
  const currentScope = useMemo(
    () => (identity && canAdmin ? migrationQueryScope(identity) : null),
    [canAdmin, identity],
  );
  const previousScopeRef = useRef<{
    fingerprint: string;
    queryKey: readonly unknown[];
  } | null>(null);

  useEffect(() => {
    if (meQuery.isPending) return;
    const previous = previousScopeRef.current;
    const current =
      currentScope && authorityKey
        ? { fingerprint: authorityKey, queryKey: currentScope }
        : null;
    if (
      previous &&
      (!current || previous.fingerprint !== current.fingerprint)
    ) {
      void queryClient.cancelQueries({
        queryKey: previous.queryKey,
        exact: false,
      });
      queryClient.removeQueries({
        queryKey: previous.queryKey,
        exact: false,
      });
      clearMigrationBrowserState();
    }
    if (!current) {
      void queryClient.cancelQueries({
        queryKey: ["migrations"],
        exact: false,
      });
      queryClient.removeQueries({
        queryKey: ["migrations"],
        exact: false,
      });
      clearMigrationBrowserState();
    }
    previousScopeRef.current = current;
  }, [authorityKey, currentScope, meQuery.isPending, queryClient]);

  if (meQuery.isPending) {
    return <MigrationAccessState kind="loading" source={source} />;
  }
  if (meQuery.isError || !identity) {
    return (
      <MigrationAccessState
        kind="error"
        source={source}
        error={
          meQuery.error instanceof Error
            ? meQuery.error.message
            : "Moosewave could not verify your current workspace identity."
        }
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      />
    );
  }
  if (!canAdmin || !authorityKey || !currentScope) {
    return (
      <MigrationAccessState
        kind="read-only"
        source={source}
        role={effectiveRole}
        viewerMode={identity.viewer_mode === true}
      />
    );
  }

  return (
    <AuthorizedWizard
      key={authorityKey}
      source={source}
      router={router}
      searchParams={searchParams}
      identity={identity}
      authorityKey={authorityKey}
      migrationBaseKey={currentScope}
    />
  );
}

function MigrationAccessState({
  kind,
  source,
  error,
  retrying = false,
  onRetry,
  role,
  viewerMode = false,
}: {
  kind: "loading" | "error" | "read-only";
  source: SourcePlatform;
  error?: string;
  retrying?: boolean;
  onRetry?: () => void;
  role?: ReturnType<typeof effectiveAuthRole> | null;
  viewerMode?: boolean;
}) {
  const title =
    kind === "loading"
      ? "Checking migration access…"
      : kind === "error"
        ? "Couldn’t verify migration access"
        : "Owner or admin access required";
  const description =
    kind === "loading"
      ? "Moosewave is confirming your current workspace and effective role before loading migration data."
      : kind === "error"
        ? error || "Moosewave could not verify your current workspace identity."
        : viewerMode
          ? "Viewer mode is active. Exit viewer mode before connecting a source or opening protected migration data."
          : `Your effective ${role ?? "unknown"} role cannot access workspace migrations. Ask an owner or admin to run this transfer.`;
  return (
    <PageShell className="max-w-3xl">
      <Breadcrumb
        items={[
          { label: "All migrations", href: "/app/migrations" },
          { label: `${SOURCE_LABELS[source]} migration` },
        ]}
      />
      <Card role={kind === "loading" ? "status" : "alert"}>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardFooter className="gap-2">
          {kind === "error" && onRetry ? (
            <Button type="button" onClick={onRetry} loading={retrying}>
              {retrying ? "Retrying…" : "Retry access check"}
            </Button>
          ) : null}
          <Button asChild variant={kind === "error" ? "ghost" : "outline"}>
            <Link href="/app/migrations">Back to migrations</Link>
          </Button>
        </CardFooter>
      </Card>
    </PageShell>
  );
}

function AuthorizedWizard({
  source,
  router,
  searchParams,
  identity,
  authorityKey,
  migrationBaseKey,
}: {
  source: SourcePlatform;
  router: ReturnType<typeof useRouter>;
  searchParams: ReturnType<typeof useSearchParams>;
  identity: MeResponse;
  authorityKey: string;
  migrationBaseKey: ReturnType<typeof migrationQueryScope>;
}) {
  const queryClient = useQueryClient();
  const initialJobId = searchParams.get("job_id") ?? "";
  const initialStep = searchParams.get("step");
  const [state, setState] = useState<WizardState>(
    initialStep === "review" && initialJobId
      ? {
          step: 2,
          jobId: initialJobId,
          job: null,
          report: null,
          loading: true,
        }
      : initialStep === "discover" && initialJobId
        ? {
            step: 1,
            jobId: initialJobId,
            discovery: null,
            loading: false,
            selectedAudienceIds: [],
          }
        : { step: 0 },
  );
  const [freshAuthorityError, setFreshAuthorityError] = useState<string | null>(
    null,
  );
  const [retryingAuthority, setRetryingAuthority] = useState(false);
  const authorityRetryRef = useRef<AbortController | null>(null);
  const capabilitiesQuery = useQuery({
    queryKey: [...migrationBaseKey, "capabilities"] as const,
    queryFn: ({ signal }) => listCapabilities(signal),
    enabled: freshAuthorityError === null,
    staleTime: STALE.reference,
    retry: false,
  });
  const capability = useMemo(
    () => capabilitiesQuery.data?.find((cap) => cap.source === source) ?? null,
    [capabilitiesQuery.data, source],
  );
  const failClosedForAuthority = useCallback(
    (error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : "Moosewave could not verify your current workspace authority.";
      // Hide and discard the old principal's data before React paints another
      // interactive wizard frame. A typed mismatch also updates the shared auth
      // cache so the parent immediately renders the truthful viewer/editor or
      // replacement-principal gate.
      void queryClient.cancelQueries({
        queryKey: migrationBaseKey,
        exact: false,
      });
      queryClient.removeQueries({ queryKey: migrationBaseKey, exact: false });
      clearMigrationBrowserState();
      setFreshAuthorityError(message);
      if (error instanceof FreshAdminAuthorityError) {
        queryClient.setQueryData(qk.authMe(), error.freshIdentity);
      }
    },
    [migrationBaseKey, queryClient],
  );
  const confirmAdminAuthority = useCallback(
    async (signal?: AbortSignal) => {
      try {
        await verifyFreshAdminAuthority(identity, signal);
      } catch (error) {
        if (!signal?.aborted) failClosedForAuthority(error);
        throw error;
      }
    },
    [failClosedForAuthority, identity],
  );
  const retryAdminAuthority = useCallback(async () => {
    if (authorityRetryRef.current) return;
    const controller = new AbortController();
    authorityRetryRef.current = controller;
    setRetryingAuthority(true);
    try {
      await confirmAdminAuthority(controller.signal);
      controller.signal.throwIfAborted();
      setFreshAuthorityError(null);
    } catch {
      // confirmAdminAuthority already preserved the actionable failure.
    } finally {
      if (authorityRetryRef.current === controller) {
        authorityRetryRef.current = null;
        if (!controller.signal.aborted) setRetryingAuthority(false);
      }
    }
  }, [confirmAdminAuthority]);
  const capabilityRequestFailed = capabilitiesQuery.isError;
  const capabilityError =
    capabilitiesQuery.error instanceof Error
      ? capabilitiesQuery.error.message
      : capabilitiesQuery.isError
        ? "Could not load migration sources — this is a failed request, not a source that is unavailable."
        : capabilitiesQuery.isSuccess && !capability
          ? `${SOURCE_LABELS[source]} is not available.`
          : null;
  const handleReviewBack = useCallback((jobId: string) => {
    setState({
      step: 1,
      jobId,
      discovery: null,
      loading: false,
      selectedAudienceIds: [],
    });
  }, []);
  const handleReviewReportLoaded = useCallback(
    ({
      jobId,
      job,
      report,
    }: {
      jobId: string;
      job: MigrationJob;
      report: VerificationReport;
    }) => {
      setState((current) =>
        current.step === 2 && current.jobId === jobId
          ? {
              step: 2,
              jobId,
              job,
              report,
              loading: false,
              selectedAudiences: current.selectedAudiences,
            }
          : current,
      );
    },
    [],
  );
  const handleReviewLoadingChange = useCallback((loading: boolean) => {
    setState((current) =>
      current.step === 2 ? { ...current, loading } : current,
    );
  }, []);
  const handleReviewCommitted = useCallback((jobId: string) => {
    setState({ step: 3, jobId, job: null });
  }, []);
  const handleReviewJobRefreshed = useCallback((job: MigrationJob) => {
    setState((current) =>
      current.step === 2 && current.jobId === job.id
        ? { ...current, job, loading: false }
        : current,
    );
  }, []);

  // Move focus to the step heading and announce the step whenever it changes,
  // so keyboard/screen-reader users aren't stranded on the just-clicked (now
  // unmounted) button with no notice the content changed (MIGR-012).
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    stepHeadingRef.current?.focus();
  }, [state.step]);

  useEffect(
    () => () => {
      authorityRetryRef.current?.abort();
      authorityRetryRef.current = null;
    },
    [],
  );

  if (freshAuthorityError) {
    return (
      <MigrationAccessState
        kind="error"
        source={source}
        error={`${freshAuthorityError} Protected migration data and local connection state were cleared.`}
        retrying={retryingAuthority}
        onRetry={() => void retryAdminAuthority()}
      />
    );
  }

  return (
    <PageShell className="max-w-4xl space-y-8 [&_[data-slot=button]]:min-h-11 [&_[data-slot=button]]:min-w-11 [&_input]:min-h-11 [&_select]:min-h-11 sm:[&_[data-slot=button]]:min-h-9 sm:[&_[data-slot=button]]:min-w-0 sm:[&_input]:min-h-9 sm:[&_select]:min-h-9">
      <header className="relative isolate space-y-5 overflow-hidden rounded-2xl border bg-card p-4 shadow-pw-sm sm:p-6">
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-gradient-to-br from-primary/[0.08] via-transparent to-info-subtle/25"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Breadcrumb
            items={[
              { label: "All migrations", href: "/app/migrations" },
              { label: `${SOURCE_LABELS[source]} migration` },
            ]}
          />
          <Link
            href={migrationDocsHref(source)}
            className="inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:min-h-9"
          >
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" /> Migration
            guide
          </Link>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            Guided transfer
          </p>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight sm:text-3xl">
            Migrate from {SOURCE_LABELS[source]}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            We&apos;ll connect, inspect, dry-run, and only commit when you say
            so.
          </p>
        </div>
        <Stepper steps={STEPS} current={state.step} />
        {/* Focus target + live announcement for step transitions (MIGR-012). */}
        <h2 ref={stepHeadingRef} tabIndex={-1} className="sr-only">
          Step {state.step + 1} of {STEPS.length}: {STEPS[state.step]?.label}
        </h2>
        <div aria-live="polite" className="sr-only">
          {`Step ${state.step + 1} of ${STEPS.length}: ${STEPS[state.step]?.label}`}
        </div>
      </header>

      {capabilityError && (
        <Alert variant="destructive">
          <AlertTitle>Migration source unavailable</AlertTitle>
          <AlertDescription>
            <p>{capabilityError}</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              {capabilityRequestFailed ? (
                <Button
                  type="button"
                  variant="outline"
                  loading={capabilitiesQuery.isFetching}
                  onClick={() => void capabilitiesQuery.refetch()}
                >
                  {capabilitiesQuery.isFetching ? "Retrying…" : "Retry"}
                </Button>
              ) : null}
              <Button asChild variant="ghost">
                <Link href="/app/migrations">Choose another source</Link>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {!capability && !capabilityError && (
        <Card role="status" aria-busy="true">
          <CardContent className="py-8 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              Loading migration source…
            </span>
          </CardContent>
        </Card>
      )}

      <Suspense
        fallback={
          <StepLoading label={STEPS[state.step]?.label ?? "migration step"} />
        }
      >
        {capability && migrationAvailabilityDescription(capability) && (
          <Alert>
            <AlertTitle>Migration availability</AlertTitle>
            <AlertDescription>
              {migrationAvailabilityDescription(capability)}
            </AlertDescription>
          </Alert>
        )}
        {state.step === 0 &&
          capability &&
          capability.intake_available !== false && (
            <ConnectStep
              source={source}
              authMethod={capability.auth_method}
              identity={identity}
              authorityKey={authorityKey}
              beforeWrite={confirmAdminAuthority}
              desktopReturn={searchParams.get("desktop_return") === "1"}
              onConnected={(jobId) =>
                setState({
                  step: 1,
                  jobId,
                  discovery: null,
                  loading: false,
                  selectedAudienceIds: [],
                })
              }
            />
          )}

        {state.step === 1 && (
          <DiscoverStep
            source={source}
            state={state}
            setState={setState}
            onBack={() => setState({ step: 0 })}
            beforeWrite={confirmAdminAuthority}
            authorityKey={authorityKey}
          />
        )}

        {state.step === 2 && (
          <ReviewStep
            source={source}
            commitAvailable={capability?.commit_available !== false}
            state={state}
            onBack={handleReviewBack}
            onReportLoaded={handleReviewReportLoaded}
            onLoadingChange={handleReviewLoadingChange}
            onCommitted={handleReviewCommitted}
            onJobRefreshed={handleReviewJobRefreshed}
            identity={identity}
            authorityKey={authorityKey}
            beforeWrite={confirmAdminAuthority}
          />
        )}

        {state.step === 3 && (
          <ImportStep
            source={source}
            state={state}
            onComplete={(job) => setState({ step: 4, job })}
            beforeWrite={confirmAdminAuthority}
            authorityKey={authorityKey}
          />
        )}

        {state.step === 4 && (
          <DoneStep source={source} job={state.job} router={router} />
        )}
      </Suspense>
    </PageShell>
  );
}

// ─── Step 2: Discover ──────────────────────────────────────────────────────

function DiscoverStep({
  source,
  state,
  setState,
  onBack,
  beforeWrite,
  authorityKey,
}: {
  source: SourcePlatform;
  state: Extract<WizardState, { step: 1 }>;
  setState: (s: WizardState) => void;
  onBack: () => void;
  beforeWrite: (signal?: AbortSignal) => Promise<void>;
  authorityKey: string;
}) {
  const { discovery, jobId } = state;
  const [sourceSessionExpiresAt, setSourceSessionExpiresAt] = useState<
    string | null
  >(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [audienceQuery, setAudienceQuery] = useState("");
  const dryRunBusyRef = useRef(false);
  const dryRunControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (discovery !== null) return;
    const controller = new AbortController();
    const selectedAudienceIdsOriginal = state.selectedAudienceIds;
    const selectedAudienceIdsAtStart = [...state.selectedAudienceIds];
    setDiscoveryError(null);
    setState({
      step: 1,
      jobId,
      discovery: null,
      loading: true,
      selectedAudienceIds: selectedAudienceIdsOriginal,
    });
    void (async () => {
      try {
        await beforeWrite(controller.signal);
        controller.signal.throwIfAborted();
        const [discoveryResult, jobResult] = await Promise.allSettled([
          discover(source, jobId, undefined, controller.signal),
          getJob(jobId, controller.signal),
        ]);
        controller.signal.throwIfAborted();
        if (jobResult.status === "fulfilled") {
          setSourceSessionExpiresAt(
            jobResult.value.source_session_expires_at ?? null,
          );
        }
        if (discoveryResult.status === "rejected") {
          const message =
            discoveryResult.reason instanceof Error
              ? discoveryResult.reason.message
              : "Unknown error";
          setDiscoveryError(message);
          toast.error("Discovery failed", { description: message });
          setState({
            step: 1,
            jobId,
            discovery: null,
            loading: false,
            selectedAudienceIds: selectedAudienceIdsOriginal,
          });
          return;
        }
        const d = discoveryResult.value;
        const selectedAudienceIds = initialSelectedAudienceIds(
          source,
          d,
          selectedAudienceIdsAtStart,
        );
        setState({
          step: 1,
          jobId,
          discovery: d,
          loading: false,
          selectedAudienceIds,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const message =
          error instanceof Error ? error.message : "Unknown error";
        setDiscoveryError(message);
        toast.error("Discovery failed", { description: message });
        setState({
          step: 1,
          jobId,
          discovery: null,
          loading: false,
          selectedAudienceIds: selectedAudienceIdsOriginal,
        });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [
    discovery,
    beforeWrite,
    jobId,
    retry,
    setState,
    source,
    state.selectedAudienceIds,
  ]);

  useEffect(
    () => () => {
      dryRunControllerRef.current?.abort();
      dryRunControllerRef.current = null;
      dryRunBusyRef.current = false;
    },
    [authorityKey],
  );

  const handleDryRun = async () => {
    if (dryRunBusyRef.current) return;
    const intent = {
      source,
      jobId: state.jobId,
      discovery: state.discovery,
      selectedAudienceIds: [...state.selectedAudienceIds],
    };
    dryRunBusyRef.current = true;
    const controller = new AbortController();
    dryRunControllerRef.current = controller;
    setState({ ...state, loading: true });
    try {
      const selectedAudienceIds = selectedMailchimpAudienceIds(
        intent.discovery,
        intent.selectedAudienceIds,
      );
      if (isMailchimpSource(intent.source)) {
        await beforeWrite(controller.signal);
        controller.signal.throwIfAborted();
        await discover(
          intent.source,
          intent.jobId,
          selectedAudienceIds,
          controller.signal,
        );
        controller.signal.throwIfAborted();
      }
      await beforeWrite(controller.signal);
      controller.signal.throwIfAborted();
      const { job_id } = await dryRun(
        intent.source,
        intent.jobId,
        selectedAudienceIds,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      toast.success("Dry-run started");
      setState({
        step: 2,
        jobId: job_id,
        job: null,
        report: null,
        loading: true,
        selectedAudiences: selectedAudienceDetails(
          intent.discovery,
          selectedAudienceIds,
        ),
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      toast.error("Could not start dry-run", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
      setState({ ...state, loading: false });
    } finally {
      if (dryRunControllerRef.current === controller) {
        dryRunControllerRef.current = null;
        dryRunBusyRef.current = false;
      }
    }
  };

  if (state.discovery === null) {
    const sessionStatus = sourceSessionStatus(
      source,
      sourceSessionExpiresAt,
      "dry-run or import",
    );
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>
              {discoveryError
                ? "Couldn't inspect your account"
                : "Inspecting your account…"}
            </CardTitle>
            <CardDescription>
              {discoveryError ??
                "Counting subscribers, segments, automations. This usually takes 10-30 seconds."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {state.loading ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : null}
          </CardContent>
          {discoveryError ? (
            <CardFooter className="justify-between">
              <Button variant="ghost" onClick={onBack}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button onClick={() => setRetry((n) => n + 1)}>Try again</Button>
            </CardFooter>
          ) : null}
        </Card>
        {(source === "activecampaign" ||
          source === "hubspot" ||
          source === "beehiiv" ||
          source === "klaviyo" ||
          source === "customerio" ||
          source === "brevo") &&
        sessionStatus.kind !== "ok" ? (
          <ActiveCampaignSessionReconnectCard
            source={source}
            jobId={jobId}
            sessionStatus={sessionStatus}
            onReconnected={(job) => {
              setSourceSessionExpiresAt(job.source_session_expires_at ?? null);
              setRetry((n) => n + 1);
            }}
            beforeWrite={beforeWrite}
            authorityKey={authorityKey}
          />
        ) : sessionStatus.kind !== "ok" ? (
          <Alert
            variant={
              sessionStatus.kind === "expired" ? "destructive" : "warning"
            }
          >
            <AlertTitle>
              {sessionStatus.kind === "near"
                ? `${SOURCE_LABELS[source]} session expires soon`
                : `Reconnect ${SOURCE_LABELS[source]}`}
            </AlertTitle>
            <AlertDescription>{sessionStatus.message}</AlertDescription>
          </Alert>
        ) : null}
      </div>
    );
  }

  const d = state.discovery;
  const sessionStatus = sourceSessionStatus(
    source,
    sourceSessionExpiresAt,
    "dry-run or import",
  );
  const mailchimpAudiences = isMailchimpSource(source)
    ? (d.audiences ?? [])
    : [];
  const selectedSet = selectedAudienceSet(d, state.selectedAudienceIds);
  const selectedSubscribers = mailchimpAudiences.reduce(
    (sum, audience) =>
      sum + (selectedSet.has(audience.id) ? audience.subscribers_total : 0),
    0,
  );
  const sessionBlocked = sourceSessionBlocksAction(sessionStatus);
  const canRunDryRun =
    !state.loading &&
    !sessionBlocked &&
    (!isMailchimpSource(source) ||
      (mailchimpAudiences.length > 0 && selectedSet.size > 0));
  const setAudienceSelected = (id: string, checked: boolean) => {
    const next = new Set(selectedSet);
    if (checked) next.add(id);
    else next.delete(id);
    setState({
      ...state,
      selectedAudienceIds: Array.from(next).sort(),
    });
  };
  const cells: Array<[string, number]> = [
    [
      source === "klaviyo"
        ? "Primary-email profiles"
        : source === "customerio"
          ? "Email-addressable cio_id profiles"
          : "Subscribers",
      d.subscribers_count,
    ],
    [
      source === "customerio"
        ? "Frozen segment/topic membership inventory"
        : source === "klaviyo"
          ? "Suppression-filtered audience snapshot inventory"
          : source === "beehiiv"
            ? "Segment/list snapshot inventory"
            : source === "hubspot"
              ? "Frozen list/subscription targeting boundaries"
              : "Segments",
      d.segments_count,
    ],
    [automationInventoryLabel(source), d.automations_count],
    [
      source === "beehiiv"
        ? "Eligible sent posts"
        : source === "klaviyo"
          ? "Sent email campaign archive"
          : source === "customerio"
            ? "Sent email newsletter archive"
            : "Archived posts",
      d.archive_count,
    ],
    [
      source === "beehiiv"
        ? "Premium memberships (metadata)"
        : source === "customerio"
          ? "Paid subscriptions (not imported)"
          : "Paid subscribers",
      d.paid_subs_count,
    ],
  ];
  if (source === "klaviyo") {
    cells.push(
      [
        "Non-email-only profiles (not imported)",
        d.profiles_without_email_count ?? 0,
      ],
      ["Sent SMS source-archive evidence", d.sms_campaigns_count ?? 0],
      ["Sent push source-archive evidence", d.push_campaigns_count ?? 0],
      ["Source archive/rebuild records", d.source_archive_count ?? 0],
    );
  }
  if (source === "hubspot") {
    cells.push(...hubSpotDiscoveryIdentitySummary(d));
  }
  if (source === "customerio") {
    cells.push(
      [
        "Profiles without email (review only)",
        d.profiles_without_email_count ?? 0,
      ],
      [
        "Subscription channel definitions/defaults",
        d.subscription_channels_count ?? 0,
      ],
      ["Sent SMS/non-email newsletter evidence", d.sms_campaigns_count ?? 0],
      ["Workflow/channel/ecosystem evidence", d.source_archive_count ?? 0],
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>What we found</CardTitle>
          <CardDescription>
            A snapshot of your {SOURCE_LABELS[source]} account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            {cells.map(([label, n]) => (
              <div key={label} className="rounded-md border p-4">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-2xl font-semibold mt-1">
                  {n.toLocaleString()}
                </p>
              </div>
            ))}
          </div>
          {d.custom_fields.length > 0 && (
            <div className="mt-4">
              <p className="text-xs text-muted-foreground mb-2">
                Custom fields
              </p>
              <div className="flex flex-wrap gap-1.5">
                {d.custom_fields.map((f) => (
                  <Badge key={f} variant="secondary">
                    {f}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {mailchimpAudiences.length > 0 && (
            <div className="mt-6 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">Mailchimp audiences</p>
                  <p className="text-xs text-muted-foreground">
                    {selectedSet.size} of {mailchimpAudiences.length} selected ·{" "}
                    {selectedSubscribers.toLocaleString()} subscriber rows
                    before duplicate-email merge.
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setState({
                        ...state,
                        selectedAudienceIds: mailchimpAudiences
                          .map((a) => a.id)
                          .sort(),
                      })
                    }
                  >
                    Select all
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={selectedSet.size === 0}
                    onClick={() =>
                      setState({ ...state, selectedAudienceIds: [] })
                    }
                  >
                    Clear
                  </Button>
                </div>
              </div>
              {mailchimpAudiences.length > 6 && (
                <Input
                  type="search"
                  aria-label="Search audiences"
                  placeholder="Search audiences…"
                  value={audienceQuery}
                  onChange={(e) => setAudienceQuery(e.target.value)}
                  className="mt-3"
                />
              )}
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {mailchimpAudiences
                  .filter((audience) => {
                    const q = audienceQuery.trim().toLowerCase();
                    if (q === "") return true;
                    return (
                      (audience.name ?? "").toLowerCase().includes(q) ||
                      audience.id.toLowerCase().includes(q)
                    );
                  })
                  .map((audience) => (
                    <label
                      key={audience.id}
                      className="flex items-start gap-2 rounded-md border bg-background p-2 text-sm"
                    >
                      <Checkbox
                        className="mt-1"
                        checked={selectedSet.has(audience.id)}
                        onChange={(event) =>
                          setAudienceSelected(
                            audience.id,
                            event.currentTarget.checked,
                          )
                        }
                      />
                      <span>
                        <span className="block font-medium">
                          {audience.name || audience.id}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {audience.subscribers_total.toLocaleString()}{" "}
                          subscribers · {audience.id}
                        </span>
                      </span>
                    </label>
                  ))}
              </div>
              {audienceQuery.trim() !== "" &&
                mailchimpAudiences.every((audience) => {
                  const q = audienceQuery.trim().toLowerCase();
                  return !(
                    (audience.name ?? "").toLowerCase().includes(q) ||
                    audience.id.toLowerCase().includes(q)
                  );
                }) && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    No audiences match “{audienceQuery.trim()}”.
                  </p>
                )}
            </div>
          )}
          <div className="mt-6">
            <ResourceCompleteness
              rows={d.resource_metadata}
              title="Source parity preview"
              preview
            />
          </div>
        </CardContent>
        <CardFooter className="justify-between">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <Button onClick={handleDryRun} disabled={!canRunDryRun}>
            {state.loading && <Loader2 className="h-4 w-4 animate-spin" />}
            Run dry-run <ArrowRight className="h-4 w-4" />
          </Button>
        </CardFooter>
      </Card>

      {source === "beehiiv" ? (
        <Alert variant="warning">
          <AlertTitle>Review-only Beehiiv inventory</AlertTitle>
          <AlertDescription>
            Dynamic segment predicates and automations are preserved for
            rebuild, not activated. Premium membership counts are metadata;
            Stripe billing objects and continuity are not imported.
          </AlertDescription>
        </Alert>
      ) : null}

      {source === "klaviyo" ? (
        <ReviewOnlyAlert
          title="Review-only Klaviyo surfaces"
          docsHref={migrationDocsHref(source)}
          lede="This import is bounded — several Klaviyo surfaces are preserved as evidence to review or rebuild, not activated."
          bullets={[
            "Only the primary email identity and its exposed consent state import; secondary addresses and their per-address consent/suppression need a mandatory source-archive/manual review before cutover.",
            "Lists and segments import as the exact suppression-filtered, send-targetable snapshot; dynamic segment predicates and Klaviyo flows stay rebuild-review work.",
            "Only sent email campaigns become archive rows — sent SMS and push remain non-executable source-archive evidence and never become email campaigns.",
            "Reporting metrics, non-email-only profiles, channel identity/sender setup, commerce, deliverability, and partner integrations are not activated by this import.",
          ]}
          details={
            <>
              Klaviyo&apos;s stable Get Profiles response exposes the primary
              email identity, but not secondary addresses or their independent
              per-address consent/suppression state. Automatic profile-identity
              and consent parity is unavailable: reconcile the mandatory
              source-archive review record against a provider export or retained
              Klaviyo access before cutover. Unnamed lists and segments receive
              deterministic <code>Klaviyo list &lt;id&gt;</code> and{" "}
              <code>Klaviyo segment &lt;id&gt;</code> labels. Audience counts
              and tags are the exact enumerated send-targetable projection after
              validated list-level suppressions are excluded; a separate raw
              Klaviyo membership count is not exposed. Incremental replay fails
              closed when a stable profile ID changes email while its previous
              source-owned address remains active; run the full final snapshot
              to materialize the new address and disable the old one before
              replay resumes. Profile reads request predictive analytics and
              follow its stricter 10 requests/second and 150 requests/minute
              tier. Only sent email campaigns materialize as email archive rows.
              Sent SMS and push records remain non-executable source-archive
              evidence and never become email campaigns. Draft campaign-message
              and flow definitions may be null and remain explicitly incomplete
              rebuild evidence; campaign tag relationships retain provider IDs
              only, not resolved names. Eight static product-area rows are
              emitted unconditionally as checklists: <code>source_total=1</code>{" "}
              means one checklist record, not detected source inventory. The
              suppression-filtered audience projection imports as executable
              targeting, while dynamic segment predicates and Klaviyo flows
              remain rebuild-review work. Reporting metrics, non-email-only
              profiles, channel identity and sender setup, commerce/service
              configuration, deliverability, and partner integrations are not
              activated by this import.
            </>
          }
        />
      ) : null}

      {source === "customerio" ? (
        <ReviewOnlyAlert
          title="Review-only Customer.io surfaces"
          docsHref={migrationDocsHref(source)}
          lede="This job is bound to one App API region/workspace by immutable cio_id — several surfaces are review/rebuild evidence, not runtime resources."
          bullets={[
            "Profiles without email, multiple profiles sharing one email, email moves/deletions, and GDPR-suppressed identifiers require explicit reconciliation.",
            "Email is enabled only when global status, the resolved email-channel state, and the applicable topic all resolve subscribed; ESP suppressions still block.",
            "Campaign automations and API-triggered broadcasts are rebuild-only — no runtime workflow is activated.",
            "There is no incremental change feed: cutover needs a source freeze, a final full snapshot, a fresh shadow check, rollback rehearsal, all six review gates, and credential cleanup.",
          ]}
          details={
            <>
              Moosewave binds this job to one App API region and workspace and
              uses immutable <code>cio_id</code> profile identities. Profiles
              without email, multiple profiles sharing one email, email moves
              and deletions, global status, subscription-center
              email-channel/topic preferences and defaults, ESP suppressions,
              frozen segment/topic memberships, and GDPR-suppressed identifiers
              require explicit reconciliation. Sent email One-time sends become
              campaign archive rows only with at least one explicit{" "}
              <code>language=&quot;&quot;</code> default and provably composable
              source HTML. The lowest stable content ID represents a
              multi-default/A-B set with an explicit warning, every variant
              remains evidence, and translations are never silently selected. A
              missing or empty layout uses the exact non-empty source body with
              a fidelity warning; a non-empty layout must contain exactly one
              documented <code>{"{{content}}"}</code> slot. Reusable Design
              Studio emails with non-empty HTML become editable templates using
              exact source HTML. Neither newsletter nor Design Studio HTML is
              provider-rendered output; Liquid, CSS/assets,
              components/styles/transformers, and per-recipient rendering
              require destination validation. Campaign automations,
              API-triggered broadcasts, transactional/non-email definitions,
              sender-specific SMS/WhatsApp <code>/v1/optouts</code>, object-type
              metadata, and ecosystem gaps remain rebuild/review evidence; those
              opt-outs are separate from subscription-center channel preferences
              and never decide email eligibility. Broadcast trigger evidence
              retains only trigger IDs plus created/processed timestamps;
              original trigger payloads, audiences, and per-user data require
              manual reconciliation. Email is enabled only when global state,
              resolved email-channel state, and the applicable topic all resolve
              subscribed. No runtime workflow is activated. Customer.io has no
              supported incremental profile-change feed, so freeze source
              changes and require a final full snapshot, fresh shadow check,
              rollback rehearsal, all six review gates, and credential cleanup
              before cutover.
            </>
          }
        />
      ) : null}

      {d.warnings.length > 0 && (
        <Alert variant="warning">
          <AlertTitle>Heads up</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5 space-y-1">
              {d.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {(source === "activecampaign" ||
        source === "hubspot" ||
        source === "beehiiv" ||
        source === "klaviyo" ||
        source === "customerio" ||
        source === "brevo") &&
      sessionStatus.kind !== "ok" ? (
        <ActiveCampaignSessionReconnectCard
          source={source}
          jobId={jobId}
          sessionStatus={sessionStatus}
          onReconnected={(job) =>
            setSourceSessionExpiresAt(job.source_session_expires_at ?? null)
          }
          beforeWrite={beforeWrite}
          authorityKey={authorityKey}
        />
      ) : sessionStatus.kind !== "ok" ? (
        <Alert
          variant={sessionStatus.kind === "expired" ? "destructive" : "warning"}
        >
          <AlertTitle>
            {sessionStatus.kind === "near"
              ? `${SOURCE_LABELS[source]} session expires soon`
              : `Reconnect ${SOURCE_LABELS[source]}`}
          </AlertTitle>
          <AlertDescription>{sessionStatus.message}</AlertDescription>
        </Alert>
      ) : null}
      {isMailchimpSource(source) && mailchimpAudiences.length === 0 ? (
        <Alert variant="destructive">
          <AlertTitle>No Mailchimp audiences discovered</AlertTitle>
          <AlertDescription>
            Dry-run and commit require at least one explicit audience. Reconnect
            with a Mailchimp user who can read the intended audience.
          </AlertDescription>
        </Alert>
      ) : mailchimpAudiences.length > 0 && selectedSet.size === 0 ? (
        <Alert variant="warning">
          <AlertTitle>Select at least one audience</AlertTitle>
          <AlertDescription>
            Dry-run needs at least one Mailchimp audience, or choose Select all
            to migrate the full account.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function selectedAudienceDetails(
  discovery: DiscoveryReport | null,
  selectedAudienceIds: string[] | undefined,
): NonNullable<DiscoveryReport["audiences"]> | undefined {
  if (!selectedAudienceIds || selectedAudienceIds.length === 0)
    return undefined;
  const audiences = discovery?.audiences ?? [];
  const byID = new Map(audiences.map((audience) => [audience.id, audience]));
  return selectedAudienceIds
    .map((id) => byID.get(id))
    .filter(isDiscoveryAudience);
}

function isDiscoveryAudience(
  audience: DiscoveryReport["audiences"] extends Array<infer T> | undefined
    ? T | undefined
    : never,
): audience is NonNullable<DiscoveryReport["audiences"]>[number] {
  return !!audience;
}

function automationInventoryLabel(source: SourcePlatform): string {
  if (source === "beehiiv") return "Automation rebuild inventory";
  if (source === "klaviyo") return "Flow rebuild inventory";
  if (source === "customerio") return "Workflow rebuild inventory";
  return source === "activecampaign" ? "Automation rebuilds" : "Automations";
}

function automationResultLabel(source: SourcePlatform): string {
  if (source === "beehiiv") return "Automation rebuild records";
  if (source === "klaviyo") return "Flow rebuild records";
  if (source === "customerio") return "Workflow rebuild records";
  return source === "activecampaign" ? "Automation rebuilds" : "Automations";
}

function automationResultValue(
  source: SourcePlatform,
  report: VerificationReport,
): number {
  if (
    source !== "activecampaign" &&
    source !== "beehiiv" &&
    source !== "klaviyo" &&
    source !== "customerio"
  ) {
    return report.automations_translated;
  }
  return (
    report.resource_completeness?.find((row) => row.resource === "automations")
      ?.source_total ?? report.automations_unsupported.length
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold mt-1">{value.toLocaleString()}</p>
    </div>
  );
}

// ─── Step 5: Done ─────────────────────────────────────────────────────────

function DoneStep({
  source,
  job,
  router,
}: {
  source: SourcePlatform;
  job: MigrationJob;
  router: ReturnType<typeof useRouter>;
}) {
  const report = job.verification_report;
  if (job.status !== "completed") {
    const rolledBack = job.status === "rolled_back";
    return (
      <Card>
        <CardHeader>
          <Badge
            variant={rolledBack ? "secondary" : "destructive"}
            className="mb-2 w-fit"
          >
            {rolledBack ? "Migration rolled back" : "Migration failed"}
          </Badge>
          <CardTitle>
            {rolledBack
              ? "Your imported changes were reversed"
              : `We couldn't finish the ${SOURCE_LABELS[source]} migration`}
          </CardTitle>
          <CardDescription>
            {job.error ||
              (rolledBack
                ? "Review the migration record for rollback details."
                : "Review the migration record, fix the reported issue, and retry when ready.")}
          </CardDescription>
        </CardHeader>
        <CardFooter className="justify-between gap-2">
          <Button
            variant="outline"
            onClick={() => router.push(`/app/migrations/new/${source}`)}
          >
            Start another migration
          </Button>
          <Button onClick={() => router.push(`/app/migrations/${job.id}`)}>
            View migration <ArrowRight className="h-4 w-4" />
          </Button>
        </CardFooter>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <Badge variant="success" className="w-fit mb-2">
          {source === "beehiiv" ||
          source === "klaviyo" ||
          source === "customerio"
            ? "Initial import complete"
            : "Migration complete"}
        </Badge>
        <CardTitle>
          {source === "beehiiv" ||
          source === "klaviyo" ||
          source === "customerio"
            ? `${SOURCE_LABELS[source]} import is ready for cutover review`
            : "You're on Moosewave"}
        </CardTitle>
        <CardDescription>
          {report
            ? `${source === "beehiiv" || source === "klaviyo" || source === "customerio" ? "The initial" : "We"} imported your ${SOURCE_LABELS[source]} data with ${(100 - report.data_loss_estimate_pct).toFixed(1)}% fidelity.`
            : `We imported your ${SOURCE_LABELS[source]} data. Verification details are still being prepared.`}{" "}
          {source === "beehiiv"
            ? "Final delta, shadow check, rebuild evidence, consent/suppression review, campaign fidelity review, billing handoff, and rollback rehearsal still gate cutover."
            : source === "klaviyo"
              ? "Final delta, including any stable-profile email-move reconciliation, source-event reconciliation, a clean shadow check, secondary-address and per-address-consent reconciliation, audience-snapshot review, flow rebuild evidence, channel-identity, deliverability, and ecosystem-dependency review, rollback rehearsal, and credential cleanup still gate cutover."
              : source === "customerio"
                ? "A source freeze, final complete immutable-cio_id snapshot, post-delta shadow check, consent/subscription and identity/audience reconciliation, workflow rebuild evidence, channel, deliverability, ecosystem reviews, rollback rehearsal, and credential cleanup still gate cutover. Customer.io source-event polling is not supported."
                : "Rollback is available for 7 days."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {report && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat
              label={
                source === "klaviyo"
                  ? "Primary-email profiles"
                  : source === "customerio"
                    ? "Email-addressable cio_id profiles"
                    : "Subscribers"
              }
              value={report.subscribers_imported}
            />
            <Stat
              label={
                source === "customerio"
                  ? "Frozen segment/topic memberships"
                  : source === "klaviyo"
                    ? "Suppression-filtered audience snapshots"
                    : source === "beehiiv"
                      ? "Frozen segment/list snapshots"
                      : source === "hubspot"
                        ? "Frozen list/subscription targeting boundaries"
                        : "Segments"
              }
              value={report.segments_translated}
            />
            <Stat
              label={automationResultLabel(source)}
              value={automationResultValue(source, report)}
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Rollback window ends{" "}
          {job.rollback_until
            ? new Date(job.rollback_until).toLocaleDateString()
            : "in 7 days"}
          .
        </p>
        {/* Cross-links to the data just imported (MIGR-022) + a path to begin
            another migration (MIGR-025). */}
        <div className="rounded-md border bg-muted/20 p-3">
          <p className="mb-2 text-sm font-medium">Where to next</p>
          <ImportedDataLinks
            source={source}
            showTemplates={
              source === "mailchimp" ||
              source === "klaviyo" ||
              source === "customerio"
            }
          />
        </div>
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={() => router.push(`/app/migrations/${job.id}`)}>
          View migration <ArrowRight className="h-4 w-4" />
        </Button>
      </CardFooter>
    </Card>
  );
}
