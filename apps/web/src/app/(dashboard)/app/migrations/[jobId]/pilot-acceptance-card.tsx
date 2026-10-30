// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import { CheckCircle2, Download, RefreshCw, RotateCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  SOURCE_LABELS,
  type AutomationRebuildItem,
  type MigrationJob,
  type PilotAcceptanceReport,
  type ShadowMonitorResponse,
  type SourcePlatform,
  type SourceEventMonitorResponse,
  type SourceEventRecord,
  type VerificationReport,
} from "@/lib/types";
import type { SourceSessionStatus } from "@/lib/migration-source-session";
import {
  isCutoverEvidenceKey,
  type CutoverEvidenceKey,
  type SourceEventReviewInput,
} from "@/lib/migration-api";

import { Stat } from "./migration-detail-primitives";
import { downloadTextFile } from "@/lib/download";

export function PilotAcceptanceCard({
  job,
  report,
  acceptance,
  rebuilds,
  pending,
  onRefresh,
  onDeltaImport,
  onMarkAutomation,
  onMarkCutoverEvidence,
  sourceSessionStatus,
  shadow,
  onStartShadow,
  onStopShadow,
  sourceEvents,
  onStartSourceEvents,
  onStopSourceEvents,
  onUpdateSourceEventReview,
}: {
  job: MigrationJob;
  report: VerificationReport;
  acceptance: PilotAcceptanceReport | null;
  rebuilds: AutomationRebuildItem[];
  pending: string | null;
  onRefresh: () => Promise<void>;
  onDeltaImport: () => Promise<void>;
  onMarkAutomation: (
    item: AutomationRebuildItem,
    status: AutomationRebuildItem["status"],
  ) => Promise<void>;
  onMarkCutoverEvidence: (
    key: CutoverEvidenceKey,
    label: string,
  ) => Promise<void>;
  sourceSessionStatus?: SourceSessionStatus;
  shadow: ShadowMonitorResponse | null;
  onStartShadow: () => Promise<void>;
  onStopShadow: () => Promise<void>;
  sourceEvents: SourceEventMonitorResponse | null;
  onStartSourceEvents: () => Promise<void>;
  onStopSourceEvents: () => Promise<void>;
  onUpdateSourceEventReview: (
    eventId: string,
    input: SourceEventReviewInput,
  ) => Promise<void>;
}) {
  const [sourceEventReviewDrafts, setSourceEventReviewDrafts] = useState<
    Record<string, { detail: string; evidence: string }>
  >({});
  const latestShadow = shadow?.history[0];
  const shadowEnabled = shadow?.monitor.enabled === true;
  const shadowLastError = shadow?.monitor.last_error
    ? redactMigrationSensitiveText(shadow.monitor.last_error)
    : "";
  const sourceEventsEnabled = sourceEvents?.monitor.enabled === true;
  const latestSourceEvent = sourceEvents?.events[0];
  const sourceEventsLastError = sourceEvents?.monitor.last_error
    ? redactMigrationSensitiveText(sourceEvents.monitor.last_error)
    : "";
  const sourceEventsLatestError =
    latestSourceEvent?.error && latestSourceEvent.action !== "manual_review"
      ? redactMigrationSensitiveText(latestSourceEvent.error)
      : "";
  const pendingSourceEventReviews =
    sourceEvents?.events?.filter(
      (event) =>
        !event.applied &&
        event.action === "manual_review" &&
        !sourceEventManualReviewComplete(event),
    ) ?? [];
  const reviewedSourceEventReviews =
    sourceEvents?.events?.filter(sourceEventManualReviewComplete) ?? [];
  const sourceEventReplaySupported = supportsSourceEventReplay(job.source);
  const checklist = buildPilotChecklist({
    job,
    report,
    acceptance,
    rebuilds,
    shadow,
    sourceEvents,
  });
  const finalDeltaReady =
    checklist.find((item) => item.key === `${job.source}_final_delta_import`)
      ?.status === "pass";
  const cutoverJobComplete = job.status === "completed";
  const finalDeltaRunning = pending === "delta" || job.status === "importing";
  const sourceSessionBlocksCutover =
    sourceSessionStatus !== undefined && sourceSessionStatus.kind !== "ok";
  const shadowStartDisabled =
    sourceSessionBlocksCutover ||
    pending === "shadow-start" ||
    !cutoverJobComplete;
  const shadowStartTitle = sourceSessionBlocksCutover
    ? sourceSessionStatus?.message
    : !cutoverJobComplete
      ? "Wait for migration job to complete"
      : undefined;
  const sourceEventsStartDisabled =
    sourceSessionBlocksCutover ||
    pending === "source-events-start" ||
    !cutoverJobComplete;
  const sourceEventsStartTitle = sourceSessionBlocksCutover
    ? sourceSessionStatus?.message
    : job.status !== "completed"
      ? "Wait for migration job to complete"
      : undefined;
  const cutoverReviewDisabled = (key: string) =>
    !cutoverJobComplete ||
    !finalDeltaReady ||
    finalDeltaRunning ||
    pending === `cutover:${key}`;
  const cutoverReviewTitle = (label: string) => {
    if (finalDeltaRunning) return "Wait for final delta import to finish";
    if (!cutoverJobComplete) return "Wait for migration job to complete";
    if (!finalDeltaReady) return "Run final delta import first";
    return `Record review for ${label}`;
  };
  const signoffReady = checklist.every((item) =>
    job.source === "activecampaign" ||
    job.source === "hubspot" ||
    job.source === "beehiiv" ||
    job.source === "klaviyo" ||
    job.source === "customerio"
      ? item.status === "pass"
      : item.status !== "blocker",
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Pilot acceptance</CardTitle>
            <CardDescription>
              {job.source === "hubspot"
                ? "HubSpot bridge acceptance gates: exact identities/properties, complete preference plus current-email eligibility coverage, authoritative final snapshot, shadow/source-event evidence, 14-row scope sign-off, rollback, and durable session/token cleanup."
                : job.source === "beehiiv"
                  ? "Beehiiv acceptance gates: final snapshot and deletion reconciliation, post-delta shadow evidence, consent and segment review, campaign archive fidelity, rebuild-only automations, rollback, and credential cleanup."
                  : job.source === "klaviyo"
                    ? "Klaviyo acceptance gates: final primary-profile and audience snapshot reconciliation, clean shadow and source-event evidence, mandatory secondary-address and per-address-consent review, flow rebuilds, channel identity, deliverability, and ecosystem-dependency review, rollback, and credential cleanup."
                    : job.source === "customerio"
                      ? "Customer.io acceptance gates: a final complete immutable-cio_id snapshot, post-delta shadow evidence, three-layer global/email-channel/topic eligibility and ESP-suppression review, separate sender-specific SMS/WhatsApp opt-out review, duplicate-email/profile identity and frozen-audience review, workflow rebuilds, channel and ecosystem dependencies, deliverability, rollback, and credential cleanup. Customer.io has no supported source-event feed."
                      : `Final ${SOURCE_LABELS[job.source]} cutover gates: delta replay, automation review, resource fidelity, and manual-review blockers.`}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={acceptanceVariant(acceptance?.status)}>
              {acceptance?.status ?? "not checked"}
            </Badge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onRefresh()}
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                downloadText(
                  `postwave-pilot-signoff-${job.id}.md`,
                  buildPilotSignoffMarkdown({
                    job,
                    report,
                    acceptance,
                    rebuilds,
                    shadow,
                    sourceEvents,
                    checklist,
                  }),
                )
              }
            >
              <Download className="h-4 w-4" />
              Sign-off packet
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void onDeltaImport()}
              disabled={
                sourceSessionBlocksCutover ||
                pending === "delta" ||
                job.status !== "completed"
              }
              title={
                sourceSessionBlocksCutover
                  ? sourceSessionStatus?.message
                  : pending === "delta" || job.status === "importing"
                    ? "Wait for final delta import to finish"
                    : job.status === "completed"
                      ? "Run final delta import"
                      : "Wait for migration job to complete"
              }
            >
              Run delta import
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {sourceSessionBlocksCutover ? (
          <div className="rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-emphasis">
            {sourceSessionStatus.message}
          </div>
        ) : null}
        {sourceRequiresCredentialCleanup(job.source) ? (
          <div className="rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-emphasis">
            {SOURCE_LABELS[job.source]} 100% readiness also requires credential
            cleanup evidence after {credentialCleanupTimingCopy(job.source)}:{" "}
            {credentialCleanupActionCopy(job.source)},{" "}
            {credentialCleanupVerificationCopy(job.source)}, and attach a
            non-secret evidence reference to the live certification record.
          </div>
        ) : null}
        <section className="rounded-md border p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">Cutover checklist</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Use this as the working handoff before the limited live pilot.
                Items marked blocker must be cleared or explicitly waived.
              </p>
            </div>
            <Badge variant={signoffReady ? "success" : "destructive"}>
              {signoffReady ? "review-ready" : "blocked"}
            </Badge>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {checklist.map((item) => (
              <div
                key={item.key}
                className="rounded-md bg-muted/40 p-3 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{item.label}</span>
                  <Badge variant={acceptanceVariant(item.status)}>
                    {item.status}
                  </Badge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {item.detail}
                </div>
                {job.source === "activecampaign" &&
                item.key === "activecampaign_deliverability_review" &&
                item.status !== "pass" ? (
                  <div className="mt-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={cutoverReviewDisabled(item.key)}
                      title={cutoverReviewTitle(item.label)}
                      onClick={() =>
                        void onMarkCutoverEvidence(
                          "activecampaign_deliverability_review",
                          item.label,
                        )
                      }
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Mark reviewed
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
        {acceptance && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Blockers" value={acceptance.blockers} />
            <Stat label="Warnings" value={acceptance.warnings} />
            <Stat label="Checks" value={acceptance.items.length} />
          </div>
        )}
        <section className="rounded-md border p-3 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium">Shadow monitor</h3>
                <Badge variant={shadowEnabled ? "success" : "secondary"}>
                  {shadowEnabled ? "enabled" : "disabled"}
                </Badge>
                {shadow?.monitor.last_error ? (
                  <Badge variant="destructive">check failed</Badge>
                ) : null}
              </div>
              <p className="text-muted-foreground">
                Periodically rediscover the source account during the pilot
                overlap and flag deltas before final cutover.
              </p>
              <div className="grid gap-2 pt-2 text-xs text-muted-foreground sm:grid-cols-3">
                <div>
                  Last check{" "}
                  <span className="font-medium text-foreground">
                    {formatOptionalDate(shadow?.monitor.last_checked_at)}
                  </span>
                </div>
                <div>
                  Next check{" "}
                  <span className="font-medium text-foreground">
                    {formatOptionalDate(shadow?.monitor.next_check_at)}
                  </span>
                </div>
                <div>
                  Last action{" "}
                  <span className="font-medium text-foreground">
                    {shadow?.monitor?.last_recommended_action ?? "none"}
                  </span>
                </div>
              </div>
              {latestShadow ? (
                <div className="pt-2 text-xs text-muted-foreground">
                  Latest result:{" "}
                  <span className="font-medium text-foreground">
                    {latestShadow.recommended_action.replaceAll("_", " ")}
                  </span>
                  {latestShadow.needs_delta_import
                    ? " · delta import required"
                    : ""}
                  {latestShadow.blockers?.length
                    ? ` · ${latestShadow.blockers.length} blocker(s)`
                    : ""}
                </div>
              ) : null}
              {shadowLastError ? (
                <div className="pt-2 text-xs text-destructive">
                  {shadowLastError}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void onStartShadow()}
                disabled={shadowStartDisabled}
                title={shadowStartTitle}
              >
                {shadowEnabled ? "Run now" : "Enable hourly"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void onStopShadow()}
                disabled={!shadowEnabled || pending === "shadow-stop"}
              >
                Disable
              </Button>
            </div>
          </div>
        </section>
        {sourceEventReplaySupported ? (
          <section className="rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">Source-event replay</h3>
                  <Badge
                    variant={sourceEventsEnabled ? "success" : "secondary"}
                  >
                    {sourceEventsEnabled ? "enabled" : "disabled"}
                  </Badge>
                  {sourceEventsLastError ? (
                    <Badge variant="destructive">sync failed</Badge>
                  ) : null}
                </div>
                <p className="text-muted-foreground">
                  Replay changed {SOURCE_LABELS[job.source]}{" "}
                  {job.source === "klaviyo"
                    ? "profiles and email-marketing state"
                    : "contacts"}{" "}
                  during the pilot overlap so the import stays current and
                  auditable.
                </p>
                <div className="grid gap-2 pt-2 text-xs text-muted-foreground sm:grid-cols-4">
                  <div>
                    Last sync{" "}
                    <span className="font-medium text-foreground">
                      {formatOptionalDate(sourceEvents?.monitor.last_synced_at)}
                    </span>
                  </div>
                  <div>
                    Next sync{" "}
                    <span className="font-medium text-foreground">
                      {formatOptionalDate(sourceEvents?.monitor.next_sync_at)}
                    </span>
                  </div>
                  <div>
                    Events seen{" "}
                    <span className="font-medium text-foreground">
                      {sourceEvents?.monitor?.events_seen ?? 0}
                    </span>
                  </div>
                  <div>
                    Applied{" "}
                    <span className="font-medium text-foreground">
                      {sourceEvents?.monitor?.events_applied ?? 0}
                    </span>
                  </div>
                </div>
                <div className="pt-1 text-xs text-muted-foreground">
                  Continuous coverage: enabled since{" "}
                  <span className="font-medium text-foreground">
                    {formatOptionalDate(sourceEvents?.monitor.enabled_since)}
                  </span>{" "}
                  · successful polls{" "}
                  <span className="font-medium text-foreground">
                    {sourceEvents?.monitor?.successful_sync_count ?? 0}
                  </span>{" "}
                  · max clean-sync gap{" "}
                  <span className="font-medium text-foreground">
                    {formatDurationSeconds(
                      sourceEvents?.monitor.max_success_gap_seconds,
                    )}
                  </span>
                </div>
                {latestSourceEvent ? (
                  <div className="pt-2 text-xs text-muted-foreground">
                    Latest event:{" "}
                    <span className="font-medium text-foreground">
                      {latestSourceEvent.action}{" "}
                      {latestSourceEvent.resource_type}
                    </span>
                    {latestSourceEvent.applied
                      ? " · applied"
                      : sourceEventManualReviewComplete(latestSourceEvent)
                        ? " · reviewed"
                        : " · review required"}
                    {latestSourceEvent.occurred_at
                      ? ` · ${formatOptionalDate(latestSourceEvent.occurred_at)}`
                      : ""}
                  </div>
                ) : null}
                {pendingSourceEventReviews.length > 0 ? (
                  <div className="mt-3 space-y-3 rounded-md border border-warning/40 bg-warning-subtle p-3">
                    <div>
                      <div className="font-medium text-foreground">
                        Manual source-event reconciliation
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        These events were intentionally not auto-applied. Review
                        the phone-only or non-email contact in the source
                        archive, reconcile consent and destination handling,
                        then attach a non-secret evidence reference. Automatic
                        replay failures cannot be waived here.
                      </p>
                    </div>
                    {pendingSourceEventReviews.slice(0, 20).map((event) => {
                      const draft = sourceEventReviewDrafts[event.id] ?? {
                        detail: "",
                        evidence: "",
                      };
                      const reviewPending =
                        pending === `source-event-review:${event.id}`;
                      return (
                        <div
                          key={event.id}
                          className="space-y-2 rounded-md border bg-background p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium text-foreground">
                              {event.resource_type} {event.action}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {formatOptionalDate(event.occurred_at)}
                            </span>
                          </div>
                          <label
                            className="block space-y-1 text-xs font-medium text-foreground"
                            htmlFor={`source-event-review-detail-${event.id}`}
                          >
                            <span>Reconciliation detail</span>
                            <Textarea
                              id={`source-event-review-detail-${event.id}`}
                              value={draft.detail}
                              placeholder="Describe how consent and destination handling were reconciled."
                              onChange={(change) =>
                                setSourceEventReviewDrafts((current) => ({
                                  ...current,
                                  [event.id]: {
                                    ...(current[event.id] ?? {
                                      detail: "",
                                      evidence: "",
                                    }),
                                    detail: change.target.value,
                                  },
                                }))
                              }
                            />
                          </label>
                          <label
                            className="block space-y-1 text-xs font-medium text-foreground"
                            htmlFor={`source-event-review-evidence-${event.id}`}
                          >
                            <span>Evidence reference</span>
                            <Input
                              id={`source-event-review-evidence-${event.id}`}
                              value={draft.evidence}
                              placeholder="Ticket, reviewed export row, or artifact reference"
                              onChange={(change) =>
                                setSourceEventReviewDrafts((current) => ({
                                  ...current,
                                  [event.id]: {
                                    ...(current[event.id] ?? {
                                      detail: "",
                                      evidence: "",
                                    }),
                                    evidence: change.target.value,
                                  },
                                }))
                              }
                            />
                          </label>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={
                              reviewPending ||
                              !cutoverJobComplete ||
                              !draft.detail.trim() ||
                              !draft.evidence.trim()
                            }
                            onClick={() =>
                              void onUpdateSourceEventReview(event.id, {
                                status: "reviewed",
                                detail: draft.detail.trim(),
                                evidence: [draft.evidence.trim()],
                              })
                            }
                          >
                            <CheckCircle2 className="h-4 w-4" />
                            Record reviewed event
                          </Button>
                        </div>
                      );
                    })}
                    {pendingSourceEventReviews.length > 20 ? (
                      <p className="text-xs text-muted-foreground">
                        Showing 20 of {pendingSourceEventReviews.length} pending
                        reviews. Record this batch, then refresh to continue.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {reviewedSourceEventReviews.length > 0 ? (
                  <div className="mt-3 space-y-3 rounded-md border bg-muted/30 p-3">
                    <div>
                      <div className="font-medium text-foreground">
                        Reviewed source-event reconciliations
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Inspect the sanitized handling record and evidence
                        below. Reopen a row if the reconciliation is no longer
                        valid; it will block pilot acceptance again until
                        reviewed with fresh evidence.
                      </p>
                    </div>
                    {reviewedSourceEventReviews.slice(0, 20).map((event) => {
                      const reviewPending =
                        pending === `source-event-review:${event.id}`;
                      return (
                        <div
                          key={event.id}
                          className="space-y-2 rounded-md border bg-background p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium text-foreground">
                              {event.resource_type} {event.action}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              Reviewed {formatOptionalDate(event.reviewed_at)}
                            </span>
                          </div>
                          <p className="text-sm text-foreground">
                            {redactMigrationSensitiveText(
                              event.review_detail ?? "",
                            )}
                          </p>
                          <ul
                            aria-label={`Evidence for source-event review ${event.id}`}
                            className="list-disc space-y-1 pl-5 text-xs text-muted-foreground"
                          >
                            {(event.review_evidence ?? []).map(
                              (evidence, index) => (
                                <li key={`${event.id}-evidence-${index}`}>
                                  {redactMigrationSensitiveText(evidence)}
                                </li>
                              ),
                            )}
                          </ul>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={reviewPending || !cutoverJobComplete}
                            onClick={() =>
                              void onUpdateSourceEventReview(event.id, {
                                status: "pending",
                              })
                            }
                          >
                            <RotateCcw className="h-4 w-4" />
                            Reopen review
                          </Button>
                        </div>
                      );
                    })}
                    {reviewedSourceEventReviews.length > 20 ? (
                      <p className="text-xs text-muted-foreground">
                        Showing 20 of {reviewedSourceEventReviews.length}{" "}
                        reviewed reconciliations.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {sourceEventsLastError ? (
                  <div className="pt-2 text-xs text-destructive">
                    {sourceEventsLastError}
                  </div>
                ) : null}
                {sourceEventsLatestError ? (
                  <div className="pt-2 text-xs text-destructive">
                    {sourceEventsLatestError}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void onStartSourceEvents()}
                  disabled={sourceEventsStartDisabled}
                  title={sourceEventsStartTitle}
                >
                  {sourceEventsEnabled ? "Run sync" : "Enable replay"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void onStopSourceEvents()}
                  disabled={
                    !sourceEventsEnabled || pending === "source-events-stop"
                  }
                >
                  Disable replay
                </Button>
              </div>
            </div>
          </section>
        ) : null}
        <section className="space-y-2">
          <h3 className="text-sm font-medium">
            {job.source === "klaviyo"
              ? "Klaviyo flow rebuilds"
              : job.source === "customerio"
                ? "Customer.io workflow rebuilds"
                : "Top automation rebuilds"}
          </h3>
          <div className="space-y-2">
            {rebuilds.length === 0 ? (
              <div className="rounded-md border p-3 text-sm text-muted-foreground">
                {job.source === "klaviyo"
                  ? "No Klaviyo flows are tracked for rebuild in this report."
                  : job.source === "customerio"
                    ? "No Customer.io campaign or API-broadcast workflows are tracked for rebuild in this report."
                    : "No unsupported automations are tracked for this report."}
              </div>
            ) : (
              rebuilds.map((item) => (
                <div key={item.rank} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">
                        #{item.rank} {item.name}
                      </div>
                      {item.notes ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          {item.notes}
                        </div>
                      ) : null}
                    </div>
                    <Badge variant={rebuildStatusVariant(item.status)}>
                      {item.status.replaceAll("_", " ")}
                    </Badge>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={
                        pending === `automation:${item.rank}:test_passed`
                      }
                      onClick={() => void onMarkAutomation(item, "test_passed")}
                    >
                      Mark test-passed
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={
                        pending ===
                        `automation:${item.rank}:approved_not_needed`
                      }
                      onClick={() =>
                        void onMarkAutomation(item, "approved_not_needed")
                      }
                    >
                      Not needed
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending === `automation:${item.rank}:blocked`}
                      onClick={() => void onMarkAutomation(item, "blocked")}
                    >
                      Blocked
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
        {acceptance ? (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Acceptance checks</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {acceptance.items.map((item) => (
                <div key={item.key} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">{item.label}</div>
                    <Badge variant={acceptanceVariant(item.status)}>
                      {item.status}
                    </Badge>
                  </div>
                  {item.detail ? (
                    <div className="mt-1 text-muted-foreground">
                      {item.detail}
                    </div>
                  ) : null}
                  {typeof item.expected === "number" ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {item.actual ?? 0}/{item.expected} complete
                    </div>
                  ) : null}
                  {item.evidence && item.evidence.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {item.evidence.slice(0, 4).map((evidence, index) => (
                        <li
                          key={`${item.key}-evidence-${index}`}
                          className="break-words"
                        >
                          {evidence}
                        </li>
                      ))}
                      {item.evidence.length > 4 ? (
                        <li>
                          {item.evidence.length - 4} more evidence item(s)
                        </li>
                      ) : null}
                    </ul>
                  ) : null}
                  {canRecordSourceCutoverEvidence(job, item) ? (
                    <div className="mt-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={cutoverReviewDisabled(item.key)}
                        title={cutoverReviewTitle(item.label)}
                        onClick={() =>
                          void onMarkCutoverEvidence(item.key, item.label)
                        }
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        {item.key === "sms_readiness"
                          ? "Verify & record"
                          : "Mark reviewed"}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : (
          <div className="rounded-md border p-3 text-sm text-muted-foreground">
            Run refresh after verification is available to calculate pilot
            acceptance.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface PilotChecklistItem {
  key: string;
  label: string;
  status: PilotAcceptanceItemStatus;
  detail: string;
}

const ACTIVE_CAMPAIGN_REVIEW_EVIDENCE_KEYS: ReadonlySet<CutoverEvidenceKey> =
  new Set([
    "activecampaign_automation_rebuild_review",
    "activecampaign_segments_review",
    "activecampaign_templates_review",
    "activecampaign_forms_review",
    "activecampaign_custom_objects_review",
    "activecampaign_ecommerce_review",
    "activecampaign_crm_archive_review",
    "activecampaign_audience_schema_review",
    "activecampaign_campaign_archive_fidelity_review",
  ]);

const ACTIVE_CAMPAIGN_BLOCKER_SIGNOFF_KEYS: ReadonlySet<CutoverEvidenceKey> =
  new Set([
    "activecampaign_consent_exclusion_review",
    "activecampaign_segments_review",
    "activecampaign_templates_review",
    "activecampaign_forms_review",
    "activecampaign_custom_objects_review",
    "activecampaign_ecommerce_review",
    "activecampaign_crm_archive_review",
    "activecampaign_audience_schema_review",
    "activecampaign_campaign_archive_fidelity_review",
    "source_discovery_warnings",
    "source_archive_warnings",
    "sms_readiness",
  ]);

const BEEHIIV_CUTOVER_EVIDENCE_KEYS: ReadonlySet<CutoverEvidenceKey> = new Set([
  "beehiiv_consent_reconciliation",
  "beehiiv_segment_rules_review",
  "beehiiv_campaign_archive_fidelity",
  "beehiiv_automation_retirement_review",
  "beehiiv_website_capture_rebuild_review",
  "beehiiv_boosts_recommendations_rebuild_review",
  "beehiiv_ad_network_review",
  "source_discovery_warnings",
  "source_archive_warnings",
]);

const KLAVIYO_CUTOVER_EVIDENCE_KEYS: ReadonlySet<CutoverEvidenceKey> = new Set([
  "klaviyo_consent_suppression_review",
  "klaviyo_audience_snapshot_review",
  "klaviyo_flow_rebuild_review",
  "klaviyo_channel_identity_review",
  "klaviyo_deliverability_review",
  "klaviyo_ecosystem_dependencies_review",
  "source_discovery_warnings",
  "source_archive_warnings",
]);

const CUSTOMERIO_CUTOVER_EVIDENCE_KEYS: ReadonlySet<CutoverEvidenceKey> =
  new Set([
    "customerio_consent_subscription_review",
    "customerio_identity_audience_review",
    "customerio_automation_rebuild_review",
    "customerio_channel_dependency_review",
    "customerio_deliverability_review",
    "customerio_ecosystem_dependencies_review",
    "source_discovery_warnings",
    "source_archive_warnings",
  ]);

const HUBSPOT_CUTOVER_EVIDENCE_KEYS: ReadonlySet<CutoverEvidenceKey> = new Set([
  "hubspot_crm_bridge_scope_review",
]);

function canRecordSourceCutoverEvidence(
  job: MigrationJob,
  item: PilotAcceptanceReport["items"][number],
): item is PilotAcceptanceReport["items"][number] & {
  key: CutoverEvidenceKey;
} {
  if (!isCutoverEvidenceKey(item.key) || item.status === "pass") return false;
  if (job.source === "beehiiv") {
    return BEEHIIV_CUTOVER_EVIDENCE_KEYS.has(item.key);
  }
  if (job.source === "klaviyo") {
    return KLAVIYO_CUTOVER_EVIDENCE_KEYS.has(item.key);
  }
  if (job.source === "customerio") {
    return CUSTOMERIO_CUTOVER_EVIDENCE_KEYS.has(item.key);
  }
  if (job.source === "hubspot") {
    return HUBSPOT_CUTOVER_EVIDENCE_KEYS.has(item.key);
  }
  return (
    job.source === "activecampaign" &&
    ((item.status === "warning" &&
      ACTIVE_CAMPAIGN_REVIEW_EVIDENCE_KEYS.has(item.key)) ||
      (item.status === "blocker" &&
        ACTIVE_CAMPAIGN_BLOCKER_SIGNOFF_KEYS.has(item.key)))
  );
}

function supportsSourceEventReplay(source: MigrationJob["source"]): boolean {
  return (
    source === "activecampaign" || source === "hubspot" || source === "klaviyo"
  );
}

export function buildPilotChecklist({
  job,
  report,
  acceptance,
  rebuilds,
  shadow,
  sourceEvents,
}: {
  job: MigrationJob;
  report: VerificationReport;
  acceptance: PilotAcceptanceReport | null;
  rebuilds: AutomationRebuildItem[];
  shadow: ShadowMonitorResponse | null;
  sourceEvents?: SourceEventMonitorResponse | null;
}): PilotChecklistItem[] {
  const hasVerification =
    report.subscribers_imported > 0 ||
    report.archive_imported > 0 ||
    report.segments_translated > 0;
  const topAutomationsReady =
    rebuilds.length === 0 ||
    rebuilds.every((item) =>
      ["test_passed", "approved_not_needed"].includes(item.status),
    );
  const shadowAction = shadow?.monitor.last_recommended_action;
  const shadowReady =
    shadowAction === "ready_for_cutover_review" ||
    (shadow?.monitor.enabled === true && !shadow?.monitor.last_error);
  const sourceDeltas =
    shadow?.history[0]?.needs_delta_import === true ||
    shadowAction === "run_delta_import_before_cutover";
  const rollbackItem = acceptance?.items?.find((item) =>
    item.key.includes("rollback"),
  );
  const discoveryWarningItem = acceptance?.items?.find(
    (item) => item.key === "source_discovery_warnings",
  );
  const sourceArchiveWarningItem = acceptance?.items?.find(
    (item) => item.key === "source_archive_warnings",
  );
  const hubSpotScopeReviewItem =
    job.source === "hubspot"
      ? acceptance?.items?.find(
          (item) => item.key === "hubspot_crm_bridge_scope_review",
        )
      : undefined;
  const sourceEventReplaySupported = supportsSourceEventReplay(job.source);
  const activeCampaignShadowCheckItem =
    job.source === "activecampaign"
      ? acceptance?.items?.find(
          (item) => item.key === "activecampaign_shadow_check",
        )
      : undefined;
  const beehiivShadowCheckItem =
    job.source === "beehiiv"
      ? acceptance?.items?.find((item) => item.key === "beehiiv_shadow_check")
      : undefined;
  const klaviyoShadowCheckItem =
    job.source === "klaviyo"
      ? acceptance?.items?.find((item) => item.key === "klaviyo_shadow_check")
      : undefined;
  const customerIOShadowCheckItem =
    job.source === "customerio"
      ? acceptance?.items?.find((item) => item.key === "customerio_shadow_check")
      : undefined;
  const sourceFinalDeltaKey =
    job.source === "activecampaign" ||
    job.source === "hubspot" ||
    job.source === "beehiiv" ||
    job.source === "klaviyo" ||
    job.source === "customerio"
      ? `${job.source}_final_delta_import`
      : "";
  const sourceFinalDeltaItem =
    sourceFinalDeltaKey !== ""
      ? acceptance?.items?.find((item) => item.key === sourceFinalDeltaKey)
      : undefined;
  const activeCampaignSourceEventItem =
    job.source === "activecampaign"
      ? acceptance?.items?.find(
          (item) => item.key === "activecampaign_source_event_replay",
        )
      : undefined;
  const hubSpotShadowCheckItem =
    job.source === "hubspot"
      ? acceptance?.items?.find((item) => item.key === "hubspot_shadow_check")
      : undefined;
  const hubSpotSourceEventItem =
    job.source === "hubspot"
      ? acceptance?.items?.find(
          (item) => item.key === "hubspot_source_event_replay",
        )
      : undefined;
  const klaviyoSourceEventItem =
    job.source === "klaviyo"
      ? acceptance?.items?.find(
          (item) => item.key === "klaviyo_source_event_replay",
        )
      : undefined;
  const sourceShadowCheckItem =
    activeCampaignShadowCheckItem ??
    hubSpotShadowCheckItem ??
    beehiivShadowCheckItem ??
    klaviyoShadowCheckItem ??
    customerIOShadowCheckItem;
  const sourceEventAcceptanceItem =
    activeCampaignSourceEventItem ??
    hubSpotSourceEventItem ??
    klaviyoSourceEventItem;
  const activeCampaignAutomationItem =
    job.source === "activecampaign"
      ? acceptance?.items?.find(
          (item) => item.key === "activecampaign_automation_rebuild_review",
        )
      : undefined;
  const beehiivAutomationItem =
    job.source === "beehiiv"
      ? acceptance?.items?.find((item) => item.key === "top_automations")
      : undefined;
  const klaviyoAutomationItem =
    job.source === "klaviyo"
      ? (acceptance?.items?.find(
          (item) => item.key === "klaviyo_flow_rebuild_review",
        ) ?? acceptance?.items?.find((item) => item.key === "top_automations"))
      : undefined;
  const customerIOAutomationItem =
    job.source === "customerio"
      ? (acceptance?.items?.find(
          (item) => item.key === "customerio_automation_rebuild_review",
        ) ?? acceptance?.items?.find((item) => item.key === "top_automations"))
      : undefined;
  const sourceAutomationItem =
    activeCampaignAutomationItem ??
    beehiivAutomationItem ??
    klaviyoAutomationItem ??
    customerIOAutomationItem;
  const activeCampaignDeliverabilityItem =
    job.source === "activecampaign"
      ? acceptance?.items?.find(
          (item) => item.key === "activecampaign_deliverability_review",
        )
      : undefined;
  const activeCampaignConsentExclusionItem =
    job.source === "activecampaign"
      ? acceptance?.items?.find(
          (item) => item.key === "activecampaign_consent_exclusion_review",
        )
      : undefined;
  const activeCampaignManualReviewItems =
    job.source === "activecampaign"
      ? (acceptance?.items?.filter((item) =>
          [
            "activecampaign_segments_review",
            "activecampaign_templates_review",
            "activecampaign_forms_review",
            "activecampaign_custom_objects_review",
            "activecampaign_ecommerce_review",
            "activecampaign_crm_archive_review",
          ].includes(item.key),
        ) ?? [])
      : [];
  const activeCampaignManualReviewBlockers =
    activeCampaignManualReviewItems.filter((item) => item.status === "blocker");
  const activeCampaignManualReviewWarnings =
    activeCampaignManualReviewItems.filter((item) => item.status === "warning");
  const klaviyoReviewItems =
    job.source === "klaviyo"
      ? (acceptance?.items?.filter((item) =>
          [
            "klaviyo_consent_suppression_review",
            "klaviyo_audience_snapshot_review",
            "klaviyo_flow_rebuild_review",
            "klaviyo_channel_identity_review",
            "klaviyo_deliverability_review",
            "klaviyo_ecosystem_dependencies_review",
          ].includes(item.key),
        ) ?? [])
      : [];
  const klaviyoReviewBlockers = klaviyoReviewItems.filter(
    (item) => item.status === "blocker",
  );
  const klaviyoReviewWarnings = klaviyoReviewItems.filter(
    (item) => item.status === "warning",
  );
  const customerIOReviewItems =
    job.source === "customerio"
      ? (acceptance?.items?.filter((item) =>
          [
            "customerio_consent_subscription_review",
            "customerio_identity_audience_review",
            "customerio_automation_rebuild_review",
            "customerio_channel_dependency_review",
            "customerio_deliverability_review",
            "customerio_ecosystem_dependencies_review",
          ].includes(item.key),
        ) ?? [])
      : [];
  const customerIOReviewBlockers = customerIOReviewItems.filter(
    (item) => item.status === "blocker",
  );
  const customerIOReviewWarnings = customerIOReviewItems.filter(
    (item) => item.status === "warning",
  );
  const smsItem = acceptance?.items?.find((item) => item.key.includes("sms"));
  const unsupportedBlockers =
    report.resource_completeness?.filter(
      (row) => row.source_total > 0 && row.supported === false,
    ) ?? [];
  const discoveryWarnings = report.discovery_warnings ?? [];
  const sourceArchiveWarnings = report.source_archive_warnings ?? [];
  const sourceEventReplayFailures =
    sourceEvents?.events?.filter(
      (event) =>
        !sourceEventManualReviewComplete(event) &&
        (!event.applied || Boolean(event.error)),
    ) ?? [];
  const sourceEventReplaySynced =
    Boolean(sourceEvents?.monitor.last_synced_at) &&
    !sourceEvents?.monitor.last_error &&
    sourceEventReplayFailures.length === 0;

  const items: PilotChecklistItem[] = [
    {
      key: "source_connected",
      label: `${SOURCE_LABELS[job.source]} source connected`,
      status:
        job.status === "completed"
          ? "pass"
          : job.status === "failed"
            ? "blocker"
            : "blocker",
      detail: `Job ${job.id} is ${job.status.replaceAll("_", " ")}.`,
    },
    {
      key: "verification",
      label: "Dry-run or import verification exists",
      status: hasVerification ? "pass" : "blocker",
      detail: hasVerification
        ? `${report.subscribers_imported.toLocaleString()} subscribers and ${report.archive_imported.toLocaleString()} archive items are represented.`
        : "Run dry-run/import before pilot review.",
    },
    {
      key: "source_discovery_warnings",
      label: "Source discovery warnings resolved",
      status:
        discoveryWarningItem?.status ??
        (discoveryWarnings.length === 0
          ? "pass"
          : job.source === "activecampaign" ||
              job.source === "hubspot" ||
              job.source === "klaviyo" ||
              job.source === "customerio"
            ? "blocker"
            : "warning"),
      detail:
        discoveryWarningItem?.detail ??
        (discoveryWarnings.length === 0
          ? "Discovery completed without adapter-reported source inventory warnings."
          : `${discoveryWarnings.length} source inventory warning(s) need review before cutover.`),
    },
    {
      key: "shadow_monitor",
      label: "Shadow monitor clean",
      status:
        sourceShadowCheckItem?.status ??
        (sourceDeltas ? "blocker" : shadowReady ? "pass" : "warning"),
      detail:
        sourceShadowCheckItem?.detail ??
        (sourceDeltas
          ? "Source-side changes require final delta import after freeze."
          : shadowReady
            ? "Shadow mode has no current delta-import blocker."
            : "Enable shadow mode during the 7-14 day overlap window."),
    },
    ...(job.source === "activecampaign" ||
    job.source === "hubspot" ||
    job.source === "beehiiv" ||
    job.source === "klaviyo" ||
    job.source === "customerio"
      ? [
          {
            key: `${job.source}_final_delta_import`,
            label: `${SOURCE_LABELS[job.source]} final delta import`,
            status: sourceFinalDeltaItem?.status ?? "blocker",
            detail:
              sourceFinalDeltaItem?.detail ??
              (job.source === "hubspot"
                ? "Freeze HubSpot contact, primary-email, list/rule, and communication-preference edits, then run the authoritative full snapshot so current-email eligibility and every polling gap are reconciled before acceptance refresh."
                : job.source === "beehiiv"
                  ? "Run final delta import after freezing Beehiiv publication edits, reconcile source deletions, then refresh acceptance."
                  : job.source === "klaviyo"
                    ? "Run final delta import after freezing Klaviyo profile, list, segment, campaign, template, and flow edits; reconcile suppressions and membership changes; then refresh acceptance."
                    : job.source === "customerio"
                      ? "Freeze Customer.io profile, preference, segment, topic, newsletter, template, workflow, and channel changes; run a complete email-addressable immutable-cio_id snapshot that reconciles deletions, email moves, duplicate-email ownership, suppressions, and memberships; then refresh acceptance."
                      : "Run final delta import after freezing ActiveCampaign edits, then refresh acceptance."),
          } satisfies PilotChecklistItem,
        ]
      : []),
    ...(sourceEventReplaySupported
      ? [
          {
            key: `${job.source}_source_event_replay`,
            label: `${SOURCE_LABELS[job.source]} source-event replay clean`,
            status:
              sourceEventAcceptanceItem?.status ??
              (sourceEventReplaySynced ? "pass" : "blocker"),
            detail:
              sourceEventAcceptanceItem?.detail ??
              (sourceEventReplaySynced
                ? sourceEvents?.monitor.enabled === true
                  ? "Source-event replay has synced cleanly for the pilot overlap."
                  : "Source-event replay synced cleanly and the monitor was disabled after evidence capture."
                : "Enable source-event replay during the pilot overlap and confirm the latest sync is clean."),
          } satisfies PilotChecklistItem,
        ]
      : []),
    {
      key:
        job.source === "klaviyo"
          ? "klaviyo_flow_rebuild_review"
          : job.source === "customerio"
            ? "customerio_automation_rebuild_review"
            : "automations",
      label:
        job.source === "beehiiv"
          ? "Beehiiv automations rebuilt or waived"
          : job.source === "klaviyo"
            ? "Klaviyo flows rebuilt or waived"
            : job.source === "customerio"
              ? "Customer.io workflows rebuilt or retired"
              : "Top automations rebuilt or waived",
      status:
        sourceAutomationItem?.status ??
        (topAutomationsReady ? "pass" : "blocker"),
      detail:
        job.source === "beehiiv"
          ? `${
              sourceAutomationItem?.detail ??
              (rebuilds.length === 0
                ? "No Beehiiv automations were discovered."
                : `${rebuilds.filter((item) => ["test_passed", "approved_not_needed"].includes(item.status)).length}/${rebuilds.length} Beehiiv automations are rebuilt or waived.`)
            } Beehiiv automation migration is rebuild-only; runtime automations activated: 0.`
          : job.source === "klaviyo"
            ? `${
                sourceAutomationItem?.detail ??
                (rebuilds.length === 0
                  ? "No Klaviyo flows were discovered."
                  : `${rebuilds.filter((item) => ["test_passed", "approved_not_needed"].includes(item.status)).length}/${rebuilds.length} Klaviyo flows are rebuilt or waived.`)
              } Klaviyo flow migration is rebuild-only; runtime automations activated: 0.`
            : job.source === "customerio"
              ? `${
                  sourceAutomationItem?.detail ??
                  (rebuilds.length === 0
                    ? "No Customer.io campaign or API-broadcast workflows were discovered."
                    : `${rebuilds.filter((item) => ["test_passed", "approved_not_needed"].includes(item.status)).length}/${rebuilds.length} Customer.io workflows are rebuilt or retired.`)
                } Customer.io campaign and API-broadcast workflows are rebuild-only; runtime automations activated: 0.`
              : (sourceAutomationItem?.detail ??
                (rebuilds.length === 0
                  ? "No unsupported automations are tracked for this migration."
                  : `${rebuilds.filter((item) => ["test_passed", "approved_not_needed"].includes(item.status)).length}/${rebuilds.length} top automations are ready.`)),
    },
    {
      key: "manual_review",
      label: "Manual-review resources handled",
      status:
        job.source === "hubspot"
          ? (hubSpotScopeReviewItem?.status ?? "blocker")
          : activeCampaignManualReviewBlockers.length > 0 ||
              klaviyoReviewBlockers.length > 0 ||
              customerIOReviewBlockers.length > 0
            ? "blocker"
            : unsupportedBlockers.length > 0 ||
                activeCampaignManualReviewWarnings.length > 0 ||
                klaviyoReviewWarnings.length > 0 ||
                customerIOReviewWarnings.length > 0
              ? "warning"
              : "pass",
      detail:
        job.source === "hubspot"
          ? (hubSpotScopeReviewItem?.detail ??
            "Record the post-final-snapshot HubSpot CRM-bridge scope review for excluded identities, property schema, dynamic rules, and every unsupported product surface.")
          : activeCampaignManualReviewBlockers.length > 0
            ? `${activeCampaignManualReviewBlockers.length} ActiveCampaign rebuild/review surface(s) need fixes or explicit sign-off before cutover.`
            : klaviyoReviewBlockers.length > 0
              ? `${klaviyoReviewBlockers.length} Klaviyo cutover review surface(s) need fixes or explicit sign-off before cutover.`
              : customerIOReviewBlockers.length > 0
                ? `${customerIOReviewBlockers.length} Customer.io cutover review surface(s) need fixes or explicit sign-off before cutover.`
                : activeCampaignManualReviewWarnings.length > 0
                  ? `${activeCampaignManualReviewWarnings.length} ActiveCampaign rebuild/review surface(s) need owner sign-off before cutover.`
                  : klaviyoReviewWarnings.length > 0
                    ? `${klaviyoReviewWarnings.length} Klaviyo cutover review surface(s) need owner sign-off before cutover.`
                    : customerIOReviewWarnings.length > 0
                      ? `${customerIOReviewWarnings.length} Customer.io cutover review surface(s) need owner sign-off before cutover.`
                      : unsupportedBlockers.length === 0
                        ? "No unsupported detected resources remain in the completeness table."
                        : `${unsupportedBlockers.length} unsupported resource surface(s) need owner sign-off or explicit waiver.`,
    },
    {
      key: "source_archive_warnings",
      label: "Source archive warnings cleared",
      status:
        sourceArchiveWarningItem?.status ??
        (sourceArchiveWarnings.length === 0 ? "pass" : "blocker"),
      detail:
        sourceArchiveWarningItem?.detail ??
        (sourceArchiveWarnings.length === 0
          ? "No source archive endpoint warnings are present."
          : `${sourceArchiveWarnings.length} source archive endpoint warning(s) need permission fixes, rerun, or explicit cutover sign-off.`),
    },
    ...(job.source === "activecampaign"
      ? [
          {
            key: "activecampaign_consent_exclusion_review",
            label:
              "ActiveCampaign consent, exclusion, and contact-identity review",
            status: activeCampaignConsentExclusionItem?.status ?? "blocker",
            detail:
              activeCampaignConsentExclusionItem?.detail ??
              "Reconcile email/SMS consent by channel, the ActiveCampaign exclusion list, and the final source-ID-to-email mapping. Keep unresolved contacts unconfirmed, disable destination identities for removed contacts or stale pre-change emails, require one current identity per source ID, and remove targeting tags covered by exclusions.",
          } satisfies PilotChecklistItem,
          {
            key: "activecampaign_deliverability_review",
            label: "ActiveCampaign deliverability review",
            status: activeCampaignDeliverabilityItem?.status ?? "warning",
            detail:
              activeCampaignDeliverabilityItem?.detail ??
              "Verify sending domains, tracking links, suppression policies, forms, webhooks, and sender readiness before moving ActiveCampaign traffic to Moosewave.",
          } satisfies PilotChecklistItem,
        ]
      : []),
    ...(job.source === "klaviyo"
      ? [
          {
            key: "klaviyo_consent_suppression_review",
            label: "Klaviyo profile identity, consent, and suppression review",
            status:
              acceptance?.items?.find(
                (item) => item.key === "klaviyo_consent_suppression_review",
              )?.status ?? "blocker",
            detail:
              acceptance?.items?.find(
                (item) => item.key === "klaviyo_consent_suppression_review",
              )?.detail ??
              "Reconcile global and list-specific suppressions, email consent state, source timestamps, and the final source-profile-to-destination identity mapping after final delta. Klaviyo's stable Get Profiles response does not expose secondary email identifiers or their independent per-address consent/suppression state, so reconcile the mandatory source-archive review record against a provider export or retained Klaviyo access before approving parity.",
          } satisfies PilotChecklistItem,
          {
            key: "klaviyo_audience_snapshot_review",
            label: "Klaviyo list and segment snapshot review",
            status:
              acceptance?.items?.find(
                (item) => item.key === "klaviyo_audience_snapshot_review",
              )?.status ?? "blocker",
            detail:
              acceptance?.items?.find(
                (item) => item.key === "klaviyo_audience_snapshot_review",
              )?.detail ??
              "Spot-check the exact enumerated send-targetable list and segment projection after validated list-level suppressions are excluded. This is not raw Klaviyo membership, and the adapter does not expose a separate raw count. Rebuild any source predicates needed for ongoing targeting.",
          } satisfies PilotChecklistItem,
          {
            key: "klaviyo_channel_identity_review",
            label: "Klaviyo channel identity and sender review",
            status:
              acceptance?.items?.find(
                (item) => item.key === "klaviyo_channel_identity_review",
              )?.status ?? "blocker",
            detail:
              acceptance?.items?.find(
                (item) => item.key === "klaviyo_channel_identity_review",
              )?.detail ??
              "Review SMS, push, and other channel consent evidence separately; the import does not recreate provider credentials, sender registration, app push credentials, or non-email-only identities.",
          } satisfies PilotChecklistItem,
          {
            key: "klaviyo_deliverability_review",
            label: "Klaviyo deliverability review",
            status:
              acceptance?.items?.find(
                (item) => item.key === "klaviyo_deliverability_review",
              )?.status ?? "blocker",
            detail:
              acceptance?.items?.find(
                (item) => item.key === "klaviyo_deliverability_review",
              )?.detail ??
              "Verify sending domains, branded tracking, DNS ownership, suppression policy, sender readiness, and warmup before moving Klaviyo traffic to Moosewave.",
          } satisfies PilotChecklistItem,
          {
            key: "klaviyo_ecosystem_dependencies_review",
            label: "Klaviyo ecosystem dependency review",
            status:
              acceptance?.items?.find(
                (item) => item.key === "klaviyo_ecosystem_dependencies_review",
              )?.status ?? "blocker",
            detail:
              acceptance?.items?.find(
                (item) => item.key === "klaviyo_ecosystem_dependencies_review",
              )?.detail ??
              "Review non-sent campaigns (including nullable draft message definitions and IDs-only campaign tags), nullable flow definitions, structured templates, forms, reporting retention, commerce, reviews, service/CDP dependencies, installed apps, and the retained-source/provider-export path needed to reconcile secondary email identities and per-address consent. The eight static product-area rows are unconditional checklists, not detected inventory; rebuild, export, retain source access, or retire each applicable dependency before cutover.",
          } satisfies PilotChecklistItem,
        ]
      : []),
    ...(job.source === "customerio"
      ? [
          {
            key: "customerio_consent_subscription_review",
            label: "Customer.io consent and subscription review",
            status:
              acceptance?.items?.find(
                (item) => item.key === "customerio_consent_subscription_review",
              )?.status ?? "blocker",
            detail:
              acceptance?.items?.find(
                (item) => item.key === "customerio_consent_subscription_review",
              )?.detail ??
              "Prove email is enabled only when global state is subscribed, the resolved email-channel state is subscribed explicitly or by configured default, and the applicable topic is subscribed explicitly or by configured default. Reconcile all four ESP suppression types and any GDPR-suppressed identifiers available only through retained Customer.io support/export evidence. Do not infer consent from profile presence or topic membership; sender-specific SMS/WhatsApp /v1/optouts are separate non-email evidence, not the email-channel preference.",
          } satisfies PilotChecklistItem,
          {
            key: "customerio_identity_audience_review",
            label: "Customer.io profile identity and audience review",
            status:
              acceptance?.items?.find(
                (item) => item.key === "customerio_identity_audience_review",
              )?.status ?? "blocker",
            detail:
              acceptance?.items?.find(
                (item) => item.key === "customerio_identity_audience_review",
              )?.detail ??
              "Compare the final immutable-cio_id snapshot and frozen segment/topic memberships with the destination. Resolve profiles without email, multiple profiles sharing one email, publisher-ID changes, email moves, hard deletions, and source-owned field/tag removal without silently merging unrelated cio_id identities.",
          } satisfies PilotChecklistItem,
          {
            key: "customerio_channel_dependency_review",
            label: "Customer.io channel identity and dependency review",
            status:
              acceptance?.items?.find(
                (item) => item.key === "customerio_channel_dependency_review",
              )?.status ?? "blocker",
            detail:
              acceptance?.items?.find(
                (item) => item.key === "customerio_channel_dependency_review",
              )?.detail ??
              "Review SMS, WhatsApp, push, in-app, Slack, webhook, device and phone identities, sender registrations, routing, quiet hours, and sender-specific opt-outs. The email migration preserves evidence but does not recreate channel runtime or consent continuity.",
          } satisfies PilotChecklistItem,
          {
            key: "customerio_deliverability_review",
            label: "Customer.io deliverability review",
            status:
              acceptance?.items?.find(
                (item) => item.key === "customerio_deliverability_review",
              )?.status ?? "blocker",
            detail:
              acceptance?.items?.find(
                (item) => item.key === "customerio_deliverability_review",
              )?.detail ??
              "Verify sending domains, DNS, branded tracking, sender identities, bounce/complaint policy, suppressions, warmup, and proof sends before moving Customer.io email traffic to Moosewave.",
          } satisfies PilotChecklistItem,
          {
            key: "customerio_ecosystem_dependencies_review",
            label: "Customer.io ecosystem dependency review",
            status:
              acceptance?.items?.find(
                (item) =>
                  item.key === "customerio_ecosystem_dependencies_review",
              )?.status ?? "blocker",
            detail:
              acceptance?.items?.find(
                (item) =>
                  item.key === "customerio_ecosystem_dependencies_review",
              )?.detail ??
              "Review object-type metadata, Data Pipelines and warehouse feeds, reporting retention, forms and capture surfaces, installed apps, webhooks, transactional triggers, Design Studio items without importable HTML, and every static migration-gap checklist. Rebuild, export, retain source access, or retire each applicable dependency.",
          } satisfies PilotChecklistItem,
        ]
      : []),
    ...(job.source === "hubspot"
      ? []
      : [
          {
            key: "sms",
            label: "SMS pilot readiness",
            status: smsItem?.status ?? "warning",
            detail:
              smsItem?.detail ??
              "If SMS is in pilot scope, run the SMS pilot-readiness and exact-sender certification checks.",
          } satisfies PilotChecklistItem,
        ]),
    {
      key: "rollback",
      label: "Rollback rehearsal",
      status: rollbackItem?.status ?? "warning",
      detail:
        rollbackItem?.detail ??
        "Run rollback rehearsal after final delta import and before cutover.",
    },
    {
      key: "acceptance",
      label: "Pilot acceptance report",
      status: acceptance?.status ?? "warning",
      detail: acceptance
        ? `${acceptance.blockers} blocker(s), ${acceptance.warnings} warning(s).`
        : "Refresh acceptance after verification is available.",
    },
  ];

  if (job.source === "mailchimp") {
    items.splice(
      4,
      0,
      {
        key: "mailchimp_audience_merges",
        label: "Mailchimp audience overlap reviewed",
        status:
          (report.duplicate_subscribers_merged ?? 0) > 0 ? "warning" : "pass",
        detail:
          (report.duplicate_subscribers_merged ?? 0) > 0
            ? `${report.duplicate_subscribers_merged?.toLocaleString()} overlapping subscriber(s) were merged; review preserved source IDs and conflicting fields.`
            : "No overlapping Mailchimp audience subscribers were detected.",
      },
      {
        key: "mailchimp_segment_checks",
        label: "Mailchimp tag/static segments spot-checked",
        status:
          report.segments_with_warnings.length > 0 ? "blocker" : "warning",
        detail:
          report.segments_with_warnings.length > 0
            ? `${report.segments_with_warnings.length} segment warning(s) must be resolved before cutover.`
            : "Spot-check high-value tag, interest, audience, and static-segment membership before activating sends.",
      },
      {
        key: "mailchimp_template_checks",
        label: "Mailchimp templates rendered",
        status:
          (report.template_warnings?.length ?? 0) > 0 ? "blocker" : "warning",
        detail:
          (report.template_warnings?.length ?? 0) > 0
            ? `${report.template_warnings?.length} template fidelity warning(s) need render fixes.`
            : "Render imported templates and send proofs before live traffic.",
      },
      {
        key: "mailchimp_paused_surfaces",
        label: "Paused surfaces reviewed",
        status: "warning",
        detail:
          "Imported Mailchimp Classic Automations are runtime-capable but stay paused until reviewed. The API cannot inventory Customer Journeys: attach a manual Mailchimp rebuild/waiver checklist and do not treat the generic warning as a zero count. Forms, landing pages, and commerce surfaces stay draft/paused until reviewed.",
      },
      {
        key: "mailchimp_deliverability",
        label: "Domains and deliverability verified",
        status: "warning",
        detail:
          "Verify sending domains, branded links, DNS, warmup, and suppression policy before cutover.",
      },
    );
  }

  return items;
}

export function buildPilotSignoffMarkdown({
  job,
  report,
  acceptance,
  rebuilds,
  shadow,
  sourceEvents,
  checklist,
}: {
  job: MigrationJob;
  report: VerificationReport;
  acceptance: PilotAcceptanceReport | null;
  rebuilds: AutomationRebuildItem[];
  shadow: ShadowMonitorResponse | null;
  sourceEvents?: SourceEventMonitorResponse | null;
  checklist: PilotChecklistItem[];
}): string {
  const latestSourceEvent = sourceEvents?.events[0];
  const reviewedSourceEvents =
    sourceEvents?.events?.filter(sourceEventManualReviewComplete) ?? [];
  const pendingSourceEventReviews =
    sourceEvents?.events?.filter(
      (event) =>
        !event.applied &&
        event.action === "manual_review" &&
        !sourceEventManualReviewComplete(event),
    ) ?? [];
  const automationSummary =
    job.source === "activecampaign"
      ? [
          `- Automation rebuilds detected: ${automationRebuildCount(report)}`,
          `- Runtime automations activated: ${report.automations_translated}`,
        ]
      : job.source === "beehiiv"
        ? [
            `- Automation rebuilds detected: ${automationRebuildCount(report)}`,
            `- Automation migration mode: rebuild-only`,
            `- Runtime automations activated: 0`,
          ]
        : job.source === "klaviyo"
          ? [
              `- Flow rebuilds detected: ${automationRebuildCount(report)}`,
              `- Flow migration mode: rebuild-only`,
              `- Runtime automations activated: 0`,
            ]
          : job.source === "customerio"
            ? [
                `- Campaign/API-broadcast workflow rebuilds detected: ${automationRebuildCount(report)}`,
                `- Workflow migration mode: rebuild-only`,
                `- Runtime automations activated: 0`,
              ]
            : [`- Automations translated: ${report.automations_translated}`];
  const lines = [
    `# Moosewave First-Customer Pilot Sign-off`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    `Migration job: ${job.id}`,
    `Source: ${SOURCE_LABELS[job.source]}`,
    `Status: ${job.status}`,
    ``,
    `## Cutover Checklist`,
    ``,
    `| Item | Status | Detail |`,
    `| --- | --- | --- |`,
    ...checklist.map(
      (item) =>
        `| ${escapeMarkdownTable(item.label)} | ${item.status} | ${escapeMarkdownTable(item.detail)} |`,
    ),
    ``,
    `## Verification Summary`,
    ``,
    `- Subscribers imported: ${report.subscribers_imported}`,
    `- Suppressions: ${report.suppression_list_size}`,
    `- Segments translated: ${report.segments_translated}`,
    ...automationSummary,
    `- Campaign archive imported: ${report.archive_imported}`,
    `- Source archive imported: ${report.source_archive_imported ?? 0}`,
    `- Source archive warnings: ${report.source_archive_warnings?.length ?? 0}`,
    `- Estimated data-loss risk: ${report.data_loss_estimate_pct}%`,
    ``,
    `## Shadow Monitor`,
    ``,
    `- Enabled: ${shadow?.monitor.enabled === true ? "yes" : "no"}`,
    `- Last action: ${shadow?.monitor?.last_recommended_action ?? "none"}`,
    `- Last checked: ${shadow?.monitor?.last_checked_at ?? "never"}`,
    `- Last error: ${redactMigrationSensitiveText(
      shadow?.monitor?.last_error ?? "none",
    )}`,
    ...(supportsSourceEventReplay(job.source)
      ? [
          ``,
          `## Source-Event Replay`,
          ``,
          `- Enabled: ${sourceEvents?.monitor.enabled === true ? "yes" : "no"}`,
          `- Enabled since: ${sourceEvents?.monitor?.enabled_since ?? "unknown"}`,
          `- First successful sync: ${sourceEvents?.monitor?.first_successful_sync_at ?? "unknown"}`,
          `- Successful sync count: ${sourceEvents?.monitor?.successful_sync_count ?? 0}`,
          `- Maximum successful-sync gap: ${sourceEvents?.monitor?.max_success_gap_seconds ?? 0} seconds`,
          `- Last synced: ${sourceEvents?.monitor?.last_synced_at ?? "never"}`,
          `- Next sync: ${sourceEvents?.monitor?.next_sync_at ?? "none"}`,
          `- Events seen: ${sourceEvents?.monitor?.events_seen ?? 0}`,
          `- Events applied: ${sourceEvents?.monitor?.events_applied ?? 0}`,
          `- Last error: ${redactMigrationSensitiveText(
            sourceEvents?.monitor?.last_error ?? "none",
          )}`,
          `- Latest event: ${
            latestSourceEvent
              ? `${latestSourceEvent.action} ${latestSourceEvent.resource_type}; applied=${latestSourceEvent.applied ? "yes" : "no"}; occurred=${latestSourceEvent.occurred_at ?? "unknown"}`
              : "none"
          }`,
          `- Latest event review status: ${
            latestSourceEvent?.action === "manual_review"
              ? (latestSourceEvent.review_status ?? "pending")
              : "n/a"
          }`,
          `- Latest event error: ${redactMigrationSensitiveText(
            latestSourceEvent?.error ?? "none",
          )}`,
          `- Manual-review events reviewed: ${reviewedSourceEvents.length}`,
          `- Manual-review events pending in this packet: ${pendingSourceEventReviews.length}`,
          ...(reviewedSourceEvents.length > 0
            ? [
                ``,
                `### Reviewed Source Events`,
                ``,
                `| Result ID | Resource | Reviewed at | Reconciliation | Evidence |`,
                `| --- | --- | --- | --- | --- |`,
                ...reviewedSourceEvents.map(
                  (event) =>
                    `| ${escapeMarkdownTable(event.id)} | ${escapeMarkdownTable(event.resource_type)} | ${escapeMarkdownTable(event.reviewed_at ?? "unknown")} | ${escapeMarkdownTable(redactMigrationSensitiveText(event.review_detail ?? ""))} | ${escapeMarkdownTable(redactMigrationSensitiveText(event.review_evidence?.join("; ") ?? ""))} |`,
                ),
              ]
            : []),
        ]
      : []),
    ...credentialCleanupSignoffLines(job.source),
    ...activeCampaignConsentExclusionSignoffLines(job.source),
    ...beehiivManualReviewSignoffLines(job.source),
    ...customerIOManualReviewSignoffLines(job.source),
    ``,
    `## ${job.source === "klaviyo" ? "Flow Rebuilds" : job.source === "customerio" ? "Workflow Rebuilds" : "Automation Rebuilds"}`,
    ``,
    rebuilds.length === 0
      ? job.source === "klaviyo"
        ? `No Klaviyo flow rebuilds are tracked.`
        : job.source === "customerio"
          ? `No Customer.io campaign or API-broadcast workflow rebuilds are tracked.`
          : `No top automation rebuilds are tracked.`
      : `| Rank | Name | Status | Notes |\n| ---: | --- | --- | --- |\n${rebuilds
          .map(
            (item) =>
              `| ${item.rank} | ${escapeMarkdownTable(item.name)} | ${item.status} | ${escapeMarkdownTable(item.notes ?? "")} |`,
          )
          .join("\n")}`,
    ``,
    `## Acceptance`,
    ``,
    acceptance
      ? `Status: ${acceptance.status}; blockers: ${acceptance.blockers}; warnings: ${acceptance.warnings}.`
      : `Acceptance report has not been generated yet.`,
    ...(acceptance && acceptance.items?.length > 0
      ? [
          ``,
          `| Check | Status | Detail | Evidence |`,
          `| --- | --- | --- | --- |`,
          ...acceptance.items.map(
            (item) =>
              `| ${escapeMarkdownTable(item.label)} | ${item.status} | ${escapeMarkdownTable(item.detail ?? "")} | ${escapeMarkdownTable((item.evidence ?? []).join("; "))} |`,
          ),
        ]
      : []),
  ];
  return lines.join("\n");
}

function escapeMarkdownTable(value: string): string {
  return redactMigrationSensitiveText(value)
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

function automationRebuildCount(report: VerificationReport): number {
  return (
    report.resource_completeness?.find((row) => row.resource === "automations")
      ?.source_total ?? report.automations_unsupported.length
  );
}

export function redactMigrationSensitiveText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-activecampaign-api-url]")
    .replace(
      /(^|[\s"'(<={:\[])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?(?:\/[^\s"'<>]*)?)/giu,
      "$1[redacted-activecampaign-api-url]",
    )
    .replace(
      /\b(authorization|api[-_ ]?key|api[-_ ]?token|access[-_ ]?token|refresh[-_ ]?token|api[-_ ]?secret|password)\s*[:=]\s*["']?(?:(?:bearer|basic)\s+)?[^"',\s}]+/giu,
      "$1=[redacted]",
    )
    .replace(
      /\bactivecampaign:contact:[^\s"',;)}\]]+/giu,
      "[redacted-activecampaign-source-event-id]",
    )
    .replace(
      /\bhubspot:contact:[^\s"',;)}\]]+/giu,
      "[redacted-hubspot-source-event-id]",
    )
    .replace(
      /\bklaviyo:profile:[^\s"',;)}\]]+/giu,
      "[redacted-klaviyo-source-event-id]",
    )
    .replace(
      /\bcustomerio:(?:profile|campaign|broadcast|newsletter|transactional|design_email|subscription_topic|subscription_channel|esp_suppression|channel_optout|object_type|checklist|non_email_profile):[^\s"',;)}\]]+/giu,
      "[redacted-customerio-source-id]",
    )
    .replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[redacted]@")
    .replace(
      /\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b/giu,
      "[redacted-email]",
    );
}

function sourceRequiresCredentialCleanup(source: SourcePlatform): boolean {
  return (
    source === "activecampaign" ||
    source === "hubspot" ||
    source === "beehiiv" ||
    source === "klaviyo" ||
    source === "customerio"
  );
}

function credentialCleanupActionCopy(source: SourcePlatform): string {
  if (source === "hubspot") {
    return "revoke or rotate the dedicated HubSpot Service Key or private app token";
  }
  if (source === "beehiiv") {
    return "rotate or revoke the dedicated Beehiiv API key";
  }
  if (source === "klaviyo") {
    return "rotate or revoke the dedicated Klaviyo private API key";
  }
  if (source === "customerio") {
    return "rotate or revoke the dedicated Customer.io App API key";
  }
  return "reset or revoke the dedicated migration user's API token";
}

function credentialCleanupTimingCopy(source: SourcePlatform): string {
  return source === "beehiiv" || source === "customerio"
    ? "rollback certification"
    : "cutover rehearsal";
}

function credentialCleanupVerificationCopy(source: SourcePlatform): string {
  if (source === "beehiiv") {
    return "verify the retired key cannot access the bound workspace or publication";
  }
  if (source === "klaviyo") {
    return "verify the retired key cannot access the Klaviyo account bound to this job";
  }
  if (source === "customerio") {
    return "verify the retired key cannot access the Customer.io region/workspace bound to this job";
  }
  return "verify follow-up source access fails safely or shows reconnect guidance";
}

function credentialCleanupSignoffLines(source: SourcePlatform): string[] {
  if (!sourceRequiresCredentialCleanup(source)) return [];
  const label = SOURCE_LABELS[source];
  const prefix = source.toUpperCase().replaceAll("-", "_");
  const tokenDescription =
    source === "hubspot"
      ? "the dedicated HubSpot Service Key or private app token"
      : source === "beehiiv"
        ? "the dedicated Beehiiv API key"
        : source === "klaviyo"
          ? "the dedicated Klaviyo private API key"
          : source === "customerio"
            ? "the dedicated Customer.io App API key"
            : "the dedicated ActiveCampaign migration user's API token";
  const packetWarning =
    source === "hubspot"
      ? "Do not paste HubSpot portal IDs, contact IDs, emails, tokens, passwords, or credentials into this packet."
      : source === "beehiiv"
        ? "Do not paste Beehiiv publication IDs, emails, API keys, tokens, passwords, or credentials into this packet."
        : source === "klaviyo"
          ? "Do not paste Klaviyo account IDs, profile IDs, emails, private API keys, tokens, passwords, or credentials into this packet."
          : source === "customerio"
            ? "Do not paste Customer.io workspace IDs, cio_id values, emails, App API keys, tokens, passwords, or credentials into this packet."
            : "Do not paste ActiveCampaign API URLs, emails, tokens, passwords, or credentials into this packet.";
  const cleanupRequirement =
    source === "beehiiv"
      ? `revoke or rotate ${tokenDescription} after rollback certification`
      : source === "klaviyo"
        ? `revoke or rotate ${tokenDescription} after rollback certification or production cutover cleanup`
        : source === "customerio"
          ? `revoke or rotate ${tokenDescription} after rollback certification or production cutover cleanup`
          : `revoke, rotate, reset, or intentionally retain ${tokenDescription} after cutover rehearsal or production cutover cleanup`;
  const accessVerification =
    source === "beehiiv"
      ? "Verify the retired key cannot access the bound Beehiiv workspace or publication."
      : source === "klaviyo"
        ? "Verify the retired key cannot access the Klaviyo account bound to this migration job."
        : source === "customerio"
          ? "Verify the retired key cannot access the US/EU Customer.io workspace bound to this migration job."
          : "Verify follow-up source access fails safely or shows reconnect guidance when the credential was revoked or rotated.";
  return [
    ``,
    `## ${label} Credential Cleanup`,
    ``,
    `- Required before a 100% ready claim: ${cleanupRequirement}.`,
    `- Preserve a non-secret evidence reference in the confidential cutover record, such as a ticket ID, artifact filename, screenshot bundle name, or runbook record ID.`,
    `- ${accessVerification}`,
    `- ${packetWarning}`,
    `- Live harness gate: ${prefix}_LIVE_CREDENTIAL_CLEANUP_REVIEW=1 and ${prefix}_LIVE_CREDENTIAL_CLEANUP_EVIDENCE_REF=<non-secret reference>.`,
  ];
}

function activeCampaignConsentExclusionSignoffLines(
  source: SourcePlatform,
): string[] {
  if (source !== "activecampaign") return [];
  return [
    ``,
    `## ActiveCampaign Consent, Exclusion, and Contact-Identity Reconciliation`,
    ``,
    `- Treat list status and subscription dates as source provenance, not as channel-specific marketing consent proof.`,
    `- Reconcile the ActiveCampaign exclusion list, separate email/SMS consent evidence, and the final source-ID-to-email mapping before activating any imported audience; unresolved contacts stay unconfirmed, destination identities for removed contacts or stale pre-change emails are disabled, exactly one current identity remains per source ID, and list-targeting tags covered by exclusions are removed.`,
    `- Review phone-only and email-less contacts from source archive evidence; do not fabricate email subscribers for them.`,
    `- Live harness gate: ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_REVIEW=1 and ACTIVECAMPAIGN_LIVE_CONSENT_EXCLUSION_EVIDENCE_REF=<non-secret reference>.`,
  ];
}

function beehiivManualReviewSignoffLines(source: SourcePlatform): string[] {
  if (source !== "beehiiv") return [];
  return [
    ``,
    `## Beehiiv Manual Review`,
    ``,
    `- Review consent and suppression provenance, campaign archive fidelity, every dynamic segment rule, every automation rebuild, website/theme/capture surfaces, Boosts and recommendations, and Ad Network exports and ownership against the final post-delta Beehiiv snapshot.`,
    `- Beehiiv automation migration is rebuild-only; require test evidence or an explicit not-needed approval for every tracked automation. Runtime automations activated by migration: 0.`,
    `- Preserve a non-secret ticket or artifact reference for the review; do not paste publication IDs, subscriber data, emails, API keys, tokens, passwords, or credentials into this packet.`,
    `- Live harness gates: BEEHIIV_LIVE_MANUAL_REVIEW_SIGNOFF=1 and BEEHIIV_LIVE_MANUAL_REVIEW_EVIDENCE_REF=<non-secret reference>.`,
  ];
}

function customerIOManualReviewSignoffLines(source: SourcePlatform): string[] {
  if (source !== "customerio") return [];
  return [
    ``,
    `## Customer.io Manual Review`,
    ``,
    `- Prove email is enabled only when global state is subscribed, the resolved email-channel state is subscribed explicitly or by configured default, and the applicable topic is subscribed explicitly or by configured default. Reconcile all ESP suppression types and any GDPR-suppressed identifiers retained outside the App API. Profile presence is not consent proof.`,
    `- Keep sender-specific SMS/WhatsApp /v1/optouts separate from subscription-center channel-type preferences; an opt-out for one non-email sender is not the email-channel preference and must not determine email status.`,
    `- Compare the final complete immutable-cio_id snapshot and frozen segment/topic memberships with the destination, including profiles without email, multiple profiles sharing one email, email moves, hard deletions, and source-owned field/tag removals.`,
    `- Rebuild, test, retire, or explicitly waive every campaign automation, API-triggered broadcast, transactional definition, and non-email channel dependency. Runtime workflows activated by migration: 0.`,
    `- Review sending domains and warmup, object-type metadata, Data Pipelines/warehouse and reporting retention, capture surfaces, installed apps, webhooks, template rebuild evidence, and every migration-gap checklist.`,
    `- Preserve non-secret evidence references for all six Customer.io gates; do not paste workspace IDs, cio_id values, emails, App API keys, tokens, passwords, or credentials into this packet.`,
    `- Customer.io has no supported incremental profile-change feed. Freeze source changes and rely on the final full snapshot plus a fresh post-delta shadow check, never a source-event monitor.`,
  ];
}

function downloadText(filename: string, body: string): void {
  // Delegates rather than repeating the anchor dance: the local copy revoked
  // the object URL in a `finally` immediately after .click(), racing the
  // download it had just started, and never attached the anchor.
  downloadTextFile(filename, body, "text/markdown;charset=utf-8");
}

function acceptanceVariant(
  status:
    | PilotAcceptanceReport["status"]
    | PilotAcceptanceItemStatus
    | undefined,
): "success" | "warning" | "destructive" | "secondary" {
  if (status === "pass") return "success";
  if (status === "warning") return "warning";
  if (status === "blocker") return "destructive";
  return "secondary";
}

type PilotAcceptanceItemStatus = "pass" | "warning" | "blocker";

function sourceEventManualReviewComplete(event: SourceEventRecord): boolean {
  return (
    !event.applied &&
    event.action === "manual_review" &&
    event.review_status === "reviewed" &&
    Boolean(event.reviewed_at) &&
    Boolean(event.review_detail?.trim()) &&
    Boolean(event.review_evidence?.some((item) => item.trim()))
  );
}

function formatOptionalDate(value?: string | null): string {
  if (!value) return "never";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "unknown";
  return new Date(timestamp).toLocaleString();
}

function formatDurationSeconds(value?: number): string {
  if (value === undefined || value < 0 || !Number.isFinite(value))
    return "unknown";
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  if (value < 86400) return `${Math.round(value / 3600)}h`;
  return `${Math.round(value / 86400)}d`;
}

function rebuildStatusVariant(
  status: AutomationRebuildItem["status"],
): "success" | "warning" | "destructive" | "secondary" {
  if (status === "test_passed" || status === "approved_not_needed")
    return "success";
  if (status === "blocked") return "destructive";
  if (status === "rebuilding") return "warning";
  return "secondary";
}
