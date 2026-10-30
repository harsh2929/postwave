// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { ApiError } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import { isMailchimpSource } from "@/lib/migration-audience-selection";
import { commit, getJob, getVerification } from "@/lib/migration-api";
import {
  sourceSessionBlocksAction,
  sourceSessionStatus,
} from "@/lib/migration-source-session";
import {
  SOURCE_LABELS,
  type DiscoveryReport,
  type MigrationJob,
  type SourcePlatform,
  type VerificationReport,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  localDateTimeMin,
  localTimezoneLabel,
  resolvedSendTime,
} from "@/app/(dashboard)/app/campaigns/campaign-list-helpers";
import { DryRunPreviewCard } from "../../_dry-run-preview";
import { ActiveCampaignSessionReconnectCard } from "@/components/migration/activecampaign-session-reconnect-card";
import { OAuthSessionReconnectCard } from "@/components/migration/oauth-session-reconnect-card";
import { ReviewBreakdownCard } from "./review-breakdown-card";

type ReviewAudience = {
  id: string;
  name?: string;
  subscribers_total?: number;
};

export interface ReviewStepState {
  jobId: string;
  job: MigrationJob | null;
  report: VerificationReport | null;
  loading: boolean;
  selectedAudiences?: NonNullable<DiscoveryReport["audiences"]>;
}

interface ReportLoadedPayload {
  jobId: string;
  job: MigrationJob;
  report: VerificationReport;
}

interface ReviewStepProps {
  commitAvailable?: boolean;
  source: SourcePlatform;
  state: ReviewStepState;
  onBack: (jobId: string) => void;
  onReportLoaded: (payload: ReportLoadedPayload) => void;
  onLoadingChange: (loading: boolean) => void;
  onCommitted: (jobId: string) => void;
  onJobRefreshed: (job: MigrationJob) => void;
  identity: MeResponse;
  authorityKey: string;
  beforeWrite: (signal?: AbortSignal) => Promise<void>;
}

export function ReviewStep({
  commitAvailable = true,
  source,
  state,
  onBack,
  onReportLoaded,
  onLoadingChange,
  onCommitted,
  onJobRefreshed,
  identity,
  authorityKey,
  beforeWrite,
}: ReviewStepProps) {
  const [retry, setRetry] = useState(0);
  const [pollError, setPollError] = useState<string | null>(null);
  // MIGR-038: optional off-peak schedule. Empty = commit immediately.
  const [scheduledFor, setScheduledFor] = useState("");
  const commitBusyRef = useRef(false);
  const commitControllerRef = useRef<AbortController | null>(null);
  const scheduleInPast =
    scheduledFor !== "" && new Date(scheduledFor).getTime() <= Date.now();
  const { jobId } = state;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const job = await getJob(jobId, controller.signal);
        controller.signal.throwIfAborted();
        onJobRefreshed(job);
        if (job.status === "failed") {
          setPollError(
            job.error ||
              "The dry-run failed before a verification report was produced.",
          );
          return;
        }
        try {
          const report = await getVerification(jobId, controller.signal);
          controller.signal.throwIfAborted();
          setPollError(null);
          onReportLoaded({ jobId, job, report });
        } catch (err) {
          if (controller.signal.aborted) return;
          const stillProcessing =
            err instanceof ApiError &&
            (err.status === 404 || err.status === 409);
          if (stillProcessing) {
            timer = setTimeout(
              () => setRetry((n) => n + 1),
              Math.min(5_000, 1_000 + retry * 100),
            );
            return;
          }
          setPollError(reviewPollErrorMessage(err));
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setPollError(reviewPollErrorMessage(err));
        }
      }
    })();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [authorityKey, identity, jobId, onJobRefreshed, onReportLoaded, retry]);

  useEffect(
    () => () => {
      commitControllerRef.current?.abort();
      commitControllerRef.current = null;
      commitBusyRef.current = false;
    },
    [authorityKey],
  );

  const report = state.report;
  const sessionStatus = sourceSessionStatus(
    source,
    state.job?.source_session_expires_at ?? null,
    "the real import",
  );
  const selectedAudienceIDs = isMailchimpSource(source)
    ? (state.job?.selected_audience_ids ?? [])
    : [];
  const selectedAudienceDetails = selectedAudienceDetailsForReview(
    selectedAudienceIDs,
    state.selectedAudiences ?? [],
  );

  const handleBack = () => onBack(jobId);

  const sessionBlocked = sourceSessionBlocksAction(sessionStatus);
  const audienceScopeBlocked =
    isMailchimpSource(source) && selectedAudienceIDs.length === 0;

  const handleCommit = async () => {
    if (commitBusyRef.current) return;
    if (!commitAvailable) {
      toast.error("Import setup is pending for this workspace");
      return;
    }
    if (sessionBlocked) {
      toast.error("Reconnect source before commit", {
        description: sessionStatus.message,
      });
      return;
    }
    if (audienceScopeBlocked) {
      toast.error("Select a Mailchimp audience before commit", {
        description:
          "This job has no saved audience scope. Return to discovery and select at least one audience.",
      });
      return;
    }
    // Re-check against fresh time at click (the render-time scheduleInPast can
    // go stale while the step is open).
    if (scheduledFor !== "" && new Date(scheduledFor).getTime() <= Date.now()) {
      toast.error("Pick a future time to schedule the import.");
      return;
    }
    const intent = {
      source,
      jobId,
      selectedAudienceIDs: [...selectedAudienceIDs],
      scheduledFor,
    };
    const scheduledForIso = intent.scheduledFor
      ? new Date(intent.scheduledFor).toISOString()
      : undefined;
    commitBusyRef.current = true;
    const controller = new AbortController();
    commitControllerRef.current = controller;
    onLoadingChange(true);
    try {
      await beforeWrite(controller.signal);
      controller.signal.throwIfAborted();
      const { job_id } = await commit(
        intent.source,
        intent.jobId,
        isMailchimpSource(intent.source)
          ? intent.selectedAudienceIDs
          : undefined,
        scheduledForIso,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      toast.success(
        scheduledForIso ? "Migration scheduled" : "Migration committed",
        {
          description: scheduledForIso
            ? `Import will start ${resolvedSendTime(scheduledFor)}.`
            : "Importing now — this is the part where you can grab a coffee.",
        },
      );
      onCommitted(job_id);
    } catch (err) {
      if (controller.signal.aborted) return;
      toast.error("Could not commit", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
      onLoadingChange(false);
    } finally {
      if (commitControllerRef.current === controller) {
        commitControllerRef.current = null;
        commitBusyRef.current = false;
      }
    }
  };

  if (!report) {
    if (pollError) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>Couldn&apos;t load the dry-run</CardTitle>
            <CardDescription>{pollError}</CardDescription>
          </CardHeader>
          <CardFooter className="justify-between">
            <Button variant="ghost" onClick={handleBack}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button
              onClick={() => {
                setPollError(null);
                setRetry((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </CardFooter>
        </Card>
      );
    }
    return (
      <Card>
        <CardHeader>
          <CardTitle>Running dry-run…</CardTitle>
          <CardDescription>
            Translating segments, mapping custom fields, surfacing edge cases.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {selectedAudienceDetails.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Mailchimp audience scope</CardTitle>
            <CardDescription>
              This dry-run is scoped to {selectedAudienceDetails.length}{" "}
              selected audience{selectedAudienceDetails.length === 1 ? "" : "s"}
              .
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2">
              {selectedAudienceDetails.map((audience) => (
                <div
                  key={audience.id}
                  className="rounded-md border p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {audience.name || audience.id}
                    </span>
                    <Badge variant="secondary">{audience.id}</Badge>
                  </div>
                  {typeof audience.subscribers_total === "number" &&
                    Number.isFinite(audience.subscribers_total) && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {audience.subscribers_total.toLocaleString()} subscriber
                        {audience.subscribers_total === 1 ? "" : "s"}
                      </p>
                    )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      {isMailchimpSource(source) && selectedAudienceDetails.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>Review account-global Mailchimp surfaces</AlertTitle>
          <AlertDescription>
            Audience selection scopes members and merge data, groups/interests,
            segments, signup-form and audience-schema evidence, list-triggered
            Classic Automations, campaigns, and reports. Templates, landing
            pages, ecommerce evidence, and other source-archive evidence may
            still include account-global records outside those audiences.
          </AlertDescription>
        </Alert>
      ) : null}
      {audienceScopeBlocked ? (
        <Alert variant="destructive">
          <AlertTitle>Mailchimp audience scope is missing</AlertTitle>
          <AlertDescription>
            Return to discovery and explicitly select at least one audience.
            Commit is disabled for this job.
          </AlertDescription>
        </Alert>
      ) : null}
      {/* MIGR-038: optional off-peak schedule for the import. */}
      <Card>
        <CardHeader>
          <CardTitle>Schedule (optional)</CardTitle>
          <CardDescription>
            Leave empty to import now, or pick a future time to run the import
            off-peak. You can cancel a scheduled import before it starts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Label htmlFor="migration-schedule-at">Start at</Label>
          <Input
            id="migration-schedule-at"
            type="datetime-local"
            min={localDateTimeMin()}
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
            className="max-w-xs"
          />
          <p className="text-xs text-muted-foreground">
            Times are in your timezone ({localTimezoneLabel()}).
            {scheduledFor && !scheduleInPast
              ? ` Import will start ${resolvedSendTime(scheduledFor)}.`
              : ""}
          </p>
          {scheduleInPast ? (
            <p className="text-xs text-destructive">
              Pick a time in the future.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <DryRunPreviewCard
        jobId={jobId}
        sourceLabel={SOURCE_LABELS[source]}
        preview={report}
        onConfirm={() => void handleCommit()}
        onCancel={handleBack}
        // In-flight disables both buttons; a validation block (bad schedule /
        // session / audience) blocks only Commit so Cancel stays available.
        busy={state.loading}
        commitDisabled={
          !commitAvailable ||
          sessionBlocked ||
          audienceScopeBlocked ||
          scheduleInPast
        }
      />
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
          onReconnected={onJobRefreshed}
          beforeWrite={beforeWrite}
          authorityKey={authorityKey}
        />
      ) : (source === "mailchimp" || source === "convertkit") &&
        sessionStatus.kind !== "ok" ? (
        <OAuthSessionReconnectCard
          source={source}
          jobId={jobId}
          sessionStatus={sessionStatus}
          beforeWrite={beforeWrite}
          authorityKey={authorityKey}
          markerIdentity={identity}
        />
      ) : sessionStatus.kind !== "ok" ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {sessionStatus.kind === "near"
                ? `${SOURCE_LABELS[source]} session expires soon`
                : `Reconnect ${SOURCE_LABELS[source]}`}
            </CardTitle>
            <CardDescription>{sessionStatus.message}</CardDescription>
          </CardHeader>
          {sessionBlocked ? (
            <CardFooter>
              <Button variant="ghost" onClick={handleBack}>
                <ArrowLeft className="h-4 w-4" /> Back to connection
              </Button>
            </CardFooter>
          ) : null}
        </Card>
      ) : null}
      <ReviewBreakdownCard
        busy={
          !commitAvailable ||
          state.loading ||
          sessionBlocked ||
          audienceScopeBlocked ||
          scheduleInPast
        }
        source={source}
        report={report}
        onBack={handleBack}
        onCommit={handleCommit}
      />
    </div>
  );
}

function selectedAudienceDetailsForReview(
  selectedAudienceIDs: string[],
  selectedAudiences: NonNullable<DiscoveryReport["audiences"]>,
): ReviewAudience[] {
  if (selectedAudienceIDs.length === 0) return [];
  const byID = new Map(
    selectedAudiences.map((audience) => [audience.id, audience]),
  );
  return selectedAudienceIDs.map((id) => byID.get(id) ?? { id });
}

function reviewPollErrorMessage(err: unknown): string {
  return err instanceof Error
    ? err.message
    : "Could not load the dry-run report.";
}
