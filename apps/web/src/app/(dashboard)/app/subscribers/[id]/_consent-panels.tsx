// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Consent-tab panels that sit beside the per-channel ConsentPanel:
 *
 *   - TrackingConsentPanel    open-pixel / click-rewrite opt-outs with the
 *                             effective send-time decision (GPC-aware)
 *   - JurisdictionReconfirmPanel  SUB-055 one-time re-confirmation evidence
 *                             after a stricter-regime jurisdiction drift
 *   - GppSectionsPanel        SUB-120 IAB Global Privacy Platform strings,
 *                             read-only with their audit trail
 *
 * Each panel owns its own query and is enabled only while its tab is active.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage, isApiError } from "@/lib/api";
import { base, STALE } from "@/lib/query-keys";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import {
  getGppSections,
  getTrackingConsent,
  gppSourceLabel,
  jurisdictionCapturedTextError,
  jurisdictionPolicyVersionError,
  readJurisdictionDrift,
  reconfirmJurisdiction,
  regimeForJurisdiction,
  regulationsForJurisdiction,
  updateTrackingConsent,
  type TrackingConsentState,
} from "@/lib/subscriber-consent-api";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import type { Subscriber } from "@/lib/subscribers-api";

function PanelError({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div
        role="alert"
        className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
      >
        {message}
      </div>
      {onRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      ) : null}
    </div>
  );
}

function panelMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

const isStaleError = (err: unknown): boolean =>
  isApiError(err) && [409, 412, 428].includes(err.status);

/* ============================ Tracking consent ============================ */

type TrackingDimension = "open" | "click";

function effectiveHelp(
  channel: "Open" | "Click",
  explicitOptOut: boolean,
  effectiveOptOut: boolean,
  gpc: boolean,
): string {
  if (gpc && explicitOptOut) {
    return `${channel} tracking is suppressed by both explicit subscriber evidence and Global Privacy Control. GPC must be cleared at its source before effective tracking can resume.`;
  }
  if (gpc && effectiveOptOut) {
    return `${channel} tracking is suppressed by Global Privacy Control. This switch can record an additional explicit opt-out but cannot override GPC.`;
  }
  if (explicitOptOut || effectiveOptOut) {
    return `${channel} tracking is suppressed for this subscriber.`;
  }
  return `${channel} tracking is currently active for this subscriber.`;
}

export function TrackingConsentPanel({
  id,
  tenantId,
  role,
  authority,
  enabled,
}: {
  id: string;
  tenantId: string;
  role: string | null;
  authority: SubscriberAuthority | null;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = [...base("subscriber-tracking-consent", tenantId, role), id];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getTrackingConsent(id, signal),
    enabled,
    staleTime: STALE.detail,
    retry: false,
  });
  const reasonId = useId();
  const switchIds = useId();
  const [saving, setSaving] = useState<TrackingDimension | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setSaving(null);
    setMutationError(null);
  }, [id, authority?.tenantId, authority?.userId, authority?.role]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (mutationError) errorRef.current?.focus();
  }, [mutationError]);

  if (!enabled) return null;

  const toggle = async (
    dimension: TrackingDimension,
    nextOptOut: boolean,
  ): Promise<void> => {
    const state = query.data;
    if (!authority || saving !== null || !state) return;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setSaving(dimension);
    setMutationError(null);
    let committed = false;
    try {
      await reauthorizeSubscriberMutation(authority, controller.signal);
      const next = await updateTrackingConsent(
        id,
        dimension === "open"
          ? { open_opt_out: nextOptOut }
          : { click_opt_out: nextOptOut },
        state.version,
        { signal: controller.signal },
      );
      committed = true;
      await reauthorizeSubscriberMutation(authority, controller.signal);
      if (generation !== generationRef.current) return;
      queryClient.setQueryData<TrackingConsentState>(queryKey, next);
      toast.success(
        `${dimension === "open" ? "Open" : "Click"} tracking ${nextOptOut ? "opt-out" : "grant"} recorded.`,
      );
    } catch (err) {
      if (generation !== generationRef.current) return;
      if (committed) {
        void query.refetch();
        toast.info(
          "Tracking preference saved, but workspace access changed afterward. The preferences were reloaded.",
        );
        return;
      }
      const message = isStaleError(err)
        ? "Tracking preferences changed elsewhere. The latest verified state was reloaded; review it and try again."
        : panelMessage(
            isApiError(err) ? new Error(apiErrorMessage(err)) : err,
            "Tracking preference could not be confirmed. The previous verified preferences were kept.",
          );
      if (isStaleError(err)) void query.refetch();
      setMutationError(message);
      toast.error(message);
    } finally {
      if (generation === generationRef.current) {
        abortRef.current = null;
        setSaving(null);
      }
    }
  };

  if (query.isPending) {
    return (
      <div
        className="space-y-2"
        role="status"
        aria-label="Loading tracking preferences"
      >
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (query.isError && !query.data) {
    return (
      <PanelError
        message={panelMessage(
          query.error,
          "Tracking preferences could not be verified. No default is being inferred.",
        )}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (!query.data) return null;

  const { prefs } = query.data;
  const openOptedOut = Boolean(prefs.open_opt_out_at);
  const clickOptedOut = Boolean(prefs.click_opt_out_at);
  const blockedReason =
    authority === null
      ? "Viewer access can inspect tracking preferences but cannot change them."
      : null;

  const rows: Array<{
    dimension: TrackingDimension;
    label: string;
    optedOut: boolean;
    effectiveOptOut: boolean;
    channel: "Open" | "Click";
  }> = [
    {
      dimension: "open",
      label: "Open tracking opt-out",
      optedOut: openOptedOut,
      effectiveOptOut: prefs.effective_open_opt_out,
      channel: "Open",
    },
    {
      dimension: "click",
      label: "Click tracking opt-out",
      optedOut: clickOptedOut,
      effectiveOptOut: prefs.effective_click_opt_out,
      channel: "Click",
    },
  ];

  return (
    <section className="space-y-3" aria-label="Tracking preferences">
      <p className="text-xs text-muted-foreground">
        Per-subscriber eligibility for the open pixel and click rewriting.
        Send-time injection respects these decisions on every commercial send.
      </p>
      {query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          The latest tracking read failed. The decisions below are the last
          verified state and may now be stale.
        </p>
      ) : null}
      {mutationError ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
        >
          {mutationError}
        </div>
      ) : null}
      <ul className="divide-y rounded-md border bg-card">
        {rows.map((row) => {
          const switchId = `${switchIds}-${row.dimension}`;
          const helpId = `${switchId}-help`;
          const gpcLocked = prefs.gpc && row.optedOut;
          const disabled =
            blockedReason !== null || saving !== null || gpcLocked;
          return (
            <li
              key={row.dimension}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <div className="min-w-0 space-y-1">
                <Label htmlFor={switchId} className="text-sm font-medium">
                  {row.label}
                </Label>
                <p id={helpId} className="text-xs text-muted-foreground">
                  {effectiveHelp(
                    row.channel,
                    row.optedOut,
                    row.effectiveOptOut,
                    prefs.gpc,
                  )}
                </p>
              </div>
              <Button
                id={switchId}
                type="button"
                role="switch"
                variant="outline"
                size="sm"
                aria-checked={row.optedOut}
                aria-describedby={
                  [helpId, blockedReason ? reasonId : null]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                disabled={disabled}
                onClick={() => void toggle(row.dimension, !row.optedOut)}
              >
                {saving === row.dimension
                  ? "Saving…"
                  : row.optedOut
                    ? "Opted out"
                    : "Granted"}
              </Button>
            </li>
          );
        })}
      </ul>
      <div
        aria-label="Effective tracking decision"
        className="flex flex-wrap items-center gap-2 text-xs"
      >
        <span className="text-muted-foreground">
          Effective send-time decision
        </span>
        <Badge variant={prefs.effective_open_opt_out ? "warning" : "success"}>
          Opens {prefs.effective_open_opt_out ? "suppressed" : "active"}
        </Badge>
        <Badge variant={prefs.effective_click_opt_out ? "warning" : "success"}>
          Clicks {prefs.effective_click_opt_out ? "suppressed" : "active"}
        </Badge>
        {prefs.gpc ? (
          <Badge variant="success">GPC opt-out honored</Badge>
        ) : null}
      </div>
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          Policy <code>{prefs.policy_version || "v1"}</code>
        </span>
        <span aria-hidden>·</span>
        <span>
          Source <code>{prefs.source || "default"}</code>
        </span>
        <span aria-hidden>·</span>
        <span title={absoluteTime(prefs.updated_at)}>
          Updated {timeAgo(prefs.updated_at)}
        </span>
      </p>
      {blockedReason ? (
        <p
          id={reasonId}
          role="status"
          className="text-xs text-muted-foreground"
        >
          {blockedReason}
        </p>
      ) : null}
    </section>
  );
}

/* ========================= Jurisdiction re-confirm ======================== */

type JurisdictionDecision = "accepted" | "declined";

export function JurisdictionReconfirmPanel({
  record,
  authority,
  onRecordRefetch,
}: {
  record: Subscriber | undefined;
  authority: SubscriberAuthority | null;
  onRecordRefetch: () => void | Promise<void>;
}) {
  const fieldPrefix = useId();
  const [decision, setDecision] = useState<JurisdictionDecision | null>(null);
  const [policyVersion, setPolicyVersion] = useState("");
  const [capturedText, setCapturedText] = useState("");
  const [evidenceConfirmed, setEvidenceConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const drift = readJurisdictionDrift(record);
  const subscriberId = record?.id ?? null;

  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setDecision(null);
    setPolicyVersion("");
    setCapturedText("");
    setEvidenceConfirmed(false);
    setBusy(false);
  }, [subscriberId, authority?.tenantId, authority?.userId, authority?.role]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  if (!record || !subscriberId || !drift.required) {
    return (
      <p className="text-xs text-muted-foreground">
        No jurisdiction re-confirmation is pending for this subscriber.
      </p>
    );
  }

  const regime = regimeForJurisdiction(
    drift.detectedJurisdiction,
    drift.region,
  );
  const regulations = regulationsForJurisdiction(
    drift.detectedJurisdiction,
    drift.region,
  );
  const policyError = jurisdictionPolicyVersionError(policyVersion);
  const capturedError = jurisdictionCapturedTextError(capturedText);
  const capturedRunes = Array.from(capturedText).length;
  const capturedBytes = new TextEncoder().encode(capturedText).length;
  const stateError =
    regime === "unknown"
      ? "The detected jurisdiction does not map to a supported strict consent regime. Reload the profile or contact support."
      : !drift.changedAt
        ? "The one-time jurisdiction-change timestamp is missing. Reload the profile before recording evidence."
        : !drift.version
          ? "The exact subscriber revision is missing or invalid. Reload the profile before recording evidence."
          : null;
  const canMutate = authority !== null;
  const canSubmit =
    canMutate &&
    decision !== null &&
    !policyError &&
    !capturedError &&
    !stateError &&
    evidenceConfirmed &&
    !busy;

  const recordDecision = async (): Promise<void> => {
    if (
      !authority ||
      !canSubmit ||
      decision === null ||
      regime === "unknown" ||
      !drift.changedAt ||
      !drift.version
    ) {
      return;
    }
    const generation = ++generationRef.current;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setBusy(true);
    let committed = false;
    try {
      await reauthorizeSubscriberMutation(authority, controller.signal);
      await reconfirmJurisdiction(
        subscriberId,
        {
          decision,
          regime,
          privacy_policy_version: policyVersion.trim(),
          captured_text: capturedText,
          expected_jurisdiction_changed_at: drift.changedAt,
          expected_subscriber_version: drift.version,
        },
        { signal: controller.signal },
      );
      committed = true;
      await reauthorizeSubscriberMutation(authority, controller.signal);
      if (generation !== generationRef.current) return;
      toast.success(
        decision === "accepted"
          ? "Subject acceptance recorded with consent evidence."
          : "Subject decline recorded and email consent removed.",
      );
      setDecision(null);
      setPolicyVersion("");
      setCapturedText("");
      setEvidenceConfirmed(false);
      await onRecordRefetch();
    } catch (err) {
      if (generation !== generationRef.current) return;
      if (committed) {
        void onRecordRefetch();
        toast.info(
          "The decision was recorded, but workspace access changed afterward. Reloading the profile.",
        );
        return;
      }
      if (isStaleError(err)) void onRecordRefetch();
      // Surface the server's own sentence inside the confirm dialog.
      throw new Error(
        isApiError(err)
          ? apiErrorMessage(err)
          : panelMessage(
              err,
              "The consent decision could not be recorded. No evidence was written.",
            ),
      );
    } finally {
      if (generation === generationRef.current) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  };

  const email = record.email;
  const consequence =
    decision === "accepted"
      ? `This appends immutable consent and audit evidence for ${email} under ${regulations} and can restore send eligibility. The evidence cannot be edited or withdrawn afterwards.`
      : `This appends immutable consent and audit evidence and removes email consent for ${email} under ${regulations}. It cannot be undone; sending again will need fresh consent evidence.`;

  return (
    <section
      className="space-y-3 rounded-md border border-warning/40 bg-warning/5 p-3"
      aria-label="Jurisdiction re-confirmation"
    >
      <p className="text-sm">
        {drift.detectedJurisdiction
          ? `Jurisdiction changed to ${drift.detectedJurisdiction}. `
          : "Jurisdiction changed. "}
        Re-confirmation required for {regulations}.
      </p>
      {stateError ? (
        <div role="alert" className="text-sm text-destructive-emphasis">
          <span className="font-medium">
            Evidence cannot be recorded safely.{" "}
          </span>
          {stateError}
        </div>
      ) : decision === null ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!canMutate || busy}
            onClick={() => setDecision("accepted")}
          >
            Record subject acceptance
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canMutate || busy}
            onClick={() => setDecision("declined")}
          >
            Record subject decline
          </Button>
        </div>
      ) : (
        <form
          className="grid gap-3 border-t pt-3"
          onSubmit={(event) => event.preventDefault()}
        >
          <p className="text-sm">
            <span className="font-medium">
              {decision === "accepted"
                ? "Record acceptance evidence. "
                : "Record decline evidence. "}
            </span>
            This records the subject&apos;s decision; it does not let an
            operator consent on their behalf. Paste the exact disclosure they
            reviewed.
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor={`${fieldPrefix}-policy`}>
              Privacy-policy version
            </Label>
            <Input
              id={`${fieldPrefix}-policy`}
              value={policyVersion}
              autoComplete="off"
              disabled={busy}
              placeholder="e.g. privacy-2026-07-01"
              aria-invalid={policyVersion !== "" && policyError !== null}
              onChange={(event) => setPolicyVersion(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {policyVersion !== "" && policyError
                ? policyError
                : "Use the immutable version or release identifier for the disclosure shown."}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${fieldPrefix}-captured`}>
              Exact consent disclosure shown to the subject
            </Label>
            <Textarea
              id={`${fieldPrefix}-captured`}
              rows={6}
              value={capturedText}
              spellCheck={false}
              disabled={busy}
              placeholder="Paste the precise consent copy, including material purpose and channel terms."
              aria-invalid={capturedText !== "" && capturedError !== null}
              onChange={(event) => setCapturedText(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {capturedText !== "" && capturedError
                ? capturedError
                : `${capturedRunes.toLocaleString()} / 8,192 characters · ${capturedBytes.toLocaleString()} / 16,384 UTF-8 bytes`}
            </p>
          </div>
          <label className="flex min-h-11 items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-primary"
              checked={evidenceConfirmed}
              disabled={busy}
              onChange={(event) => setEvidenceConfirmed(event.target.checked)}
            />
            <span>
              I verified that this exact copy was shown to the subject and the
              selected decision reflects their explicit response.
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <ConfirmDialog
              title={
                decision === "accepted"
                  ? "Record subject acceptance?"
                  : "Record subject decline?"
              }
              description={consequence}
              confirmLabel={
                decision === "accepted"
                  ? "Record accepted decision"
                  : "Record declined decision"
              }
              confirmVariant={
                decision === "accepted" ? "default" : "destructive"
              }
              onConfirm={recordDecision}
              trigger={
                <Button
                  type="button"
                  size="sm"
                  variant={decision === "accepted" ? "default" : "destructive"}
                  disabled={!canSubmit}
                >
                  {busy
                    ? "Recording evidence…"
                    : decision === "accepted"
                      ? "Record accepted decision"
                      : "Record declined decision"}
                </Button>
              }
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDecision(null);
                setEvidenceConfirmed(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      <p className="text-xs text-muted-foreground">
        {canMutate
          ? "Acceptance can restore send eligibility; decline removes email consent. Both decisions create immutable consent and audit evidence."
          : "A write-enabled role is required to record a fresh consent decision."}
      </p>
    </section>
  );
}

/* ================================== GPP =================================== */

export function GppSectionsPanel({
  id,
  tenantId,
  role,
  enabled,
}: {
  id: string;
  tenantId: string;
  role: string | null;
  enabled: boolean;
}) {
  const query = useQuery({
    queryKey: [...base("subscriber-gpp", tenantId, role), id],
    queryFn: ({ signal }) => getGppSections(id, signal),
    enabled,
    staleTime: STALE.detail,
    retry: false,
  });

  if (!enabled) return null;
  if (query.isPending) {
    return (
      <div
        className="space-y-2"
        role="status"
        aria-label="Loading GPP sections"
      >
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (query.isError && !query.data) {
    return (
      <PanelError
        message={panelMessage(
          query.error,
          "GPP sections could not be loaded. No empty state is being inferred.",
        )}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (!query.data) return null;

  const jurisdictions = Object.keys(query.data.sections).sort();
  const audit = query.data.audit;

  return (
    <section
      className="space-y-3"
      aria-label="Global Privacy Platform sections"
    >
      <p className="text-xs text-muted-foreground">
        IAB Global Privacy Platform consent strings recorded per jurisdiction
        (for example US national or California). Strings are stored verbatim;
        edits arrive from the CMP webhook or an admin override, not from here.
      </p>
      {jurisdictions.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No GPP consent sections recorded for this profile.
        </p>
      ) : (
        <div
          role="region"
          aria-label="GPP consent sections"
          tabIndex={0}
          className="overflow-x-auto rounded-md border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  Jurisdiction
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Encoded section
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {jurisdictions.map((jurisdiction) => {
                const value = query.data.sections[jurisdiction] ?? "";
                return (
                  <tr key={jurisdiction}>
                    <th
                      scope="row"
                      className="whitespace-nowrap px-3 py-2 text-left font-medium"
                    >
                      {jurisdiction}
                    </th>
                    <td className="px-3 py-2">
                      <code
                        className="block max-w-md truncate font-mono text-xs"
                        title={value}
                      >
                        {value || "—"}
                      </code>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {audit.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Audit trail ({audit.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {audit.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{entry.jurisdiction}</Badge>
                <span className="text-muted-foreground">
                  {gppSourceLabel(entry.source)}
                </span>
                <span
                  className="tabular-nums text-muted-foreground"
                  title={entry.created_at}
                >
                  · {absoluteTime(entry.created_at)}
                </span>
                {entry.section_value === "" ? (
                  <span className="italic text-muted-foreground">
                    (cleared)
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
