// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ClearSendingLimitsButton } from "@/components/settings/ClearSendingLimitsButton";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import {
  reconcileSendingSettingsMutation,
  sendingSettingsApi,
  sendingSettingsMatchInput,
  sendingSettingsMonotonicNow,
  sendingSettingsRevision,
  SendingSettingsMutationOutcomeError,
  type SendingSettings,
  type SendingSettingsInput,
  type SendingSettingsReconciliation,
} from "@/lib/sending-settings-api";
import { isKnownTimeZone, listTimeZones } from "@/lib/timezones";
import type { SendingReadiness } from "@/lib/sending-controls-api";
import type { MeResponse } from "@/lib/auth-api";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";

interface LimitsForm {
  cap: string; // empty = no workspace-specific hourly ceiling
  quietEnabled: boolean;
  start: string;
  end: string;
  tz: string;
  perRecipient: boolean;
}

function formFromSources(
  settings: SendingSettings | null,
  readiness: SendingReadiness | null,
): LimitsForm {
  const s = settings ?? readiness?.settings;
  const quietEnabled = Boolean(
    s?.quiet_hours_start && s?.quiet_hours_end && s?.quiet_hours_tz,
  );
  return {
    cap: s?.max_sends_per_hour != null ? String(s.max_sends_per_hour) : "",
    quietEnabled,
    start: s?.quiet_hours_start ?? "",
    end: s?.quiet_hours_end ?? "",
    tz: s?.quiet_hours_tz ?? "UTC",
    perRecipient: settings?.quiet_hours_per_recipient ?? true,
  };
}

function mutationRevision(settings: SendingSettings | null): string | null {
  return settings ? sendingSettingsRevision(settings) : null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

interface ReconciliationHold {
  input: SendingSettingsInput;
  sent: LimitsForm;
  mutationDispatchedAt: number;
  currentSettings?: SendingSettings;
}

export function SendingLimitsCard({
  readiness,
  settings,
  canWrite,
  disabled = false,
  loading = false,
  onSaved,
  readOnly = false,
  identity,
  authorityKey,
  beginSharedMutation,
  endSharedMutation,
}: {
  readiness: SendingReadiness | null;
  settings?: SendingSettings | null;
  canWrite: boolean;
  disabled?: boolean;
  loading?: boolean;
  onSaved: (saved?: SendingSettings) => void;
  readOnly?: boolean;
  identity: MeResponse;
  authorityKey: string;
  beginSharedMutation: () => boolean;
  endSharedMutation: () => void;
}) {
  const exactSettings = settings ?? null;
  const [form, setForm] = useState<LimitsForm>(() =>
    formFromSources(exactSettings, readiness),
  );
  const [baseline, setBaseline] = useState<LimitsForm>(() =>
    formFromSources(exactSettings, readiness),
  );
  const [baselineRevision, setBaselineRevision] = useState<string | null>(() =>
    mutationRevision(exactSettings),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reconciliationHold, setReconciliationHold] =
    useState<ReconciliationHold | null>(null);
  const [pendingRemoteSettings, setPendingRemoteSettings] =
    useState<SendingSettings | null>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const authorityKeyRef = useRef(authorityKey);
  const previousAuthorityKeyRef = useRef(authorityKey);
  const controllerRef = useRef<AbortController | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const timeZones = useMemo(() => listTimeZones(), []);

  // Seed from the readiness snapshot until the user starts editing.
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  useUnsavedChangesGuard(dirty);
  // Latest form, readable after an await. Every edit spreads into a fresh
  // object, so reference identity says whether the operator typed while the
  // PUT was open. The fields stay enabled during a save, so they can.
  const formRef = useRef(form);
  const baselineRef = useRef(baseline);
  const baselineRevisionRef = useRef(baselineRevision);
  const reconciliationHoldRef = useRef(reconciliationHold);
  formRef.current = form;
  baselineRef.current = baseline;
  baselineRevisionRef.current = baselineRevision;
  reconciliationHoldRef.current = reconciliationHold;
  useEffect(() => {
    if (previousAuthorityKeyRef.current === authorityKey) return;
    previousAuthorityKeyRef.current = authorityKey;
    authorityKeyRef.current = authorityKey;
    controllerRef.current?.abort();
    controllerRef.current = null;
    savingRef.current = false;
    setSaving(false);
    setSaveError(null);
    setReconciliationHold(null);
    setPendingRemoteSettings(null);
    const next = formFromSources(exactSettings, readiness);
    setForm(next);
    setBaseline(next);
    setBaselineRevision(mutationRevision(exactSettings));
  }, [authorityKey, exactSettings, readiness]);
  useEffect(() => {
    if (saveError) errorRef.current?.focus();
  }, [saveError]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);
  useEffect(() => {
    const next = formFromSources(exactSettings, readiness);
    const currentForm = formRef.current;
    const currentDirty =
      JSON.stringify(currentForm) !== JSON.stringify(baselineRef.current);
    if (reconciliationHoldRef.current) return;
    if (currentDirty) {
      // A background refresh must not pair the R1 draft with an R2 revision.
      // If the operator's draft already equals R2, adopting it is lossless;
      // otherwise hold the editor until they explicitly load the new row.
      if (JSON.stringify(currentForm) === JSON.stringify(next)) {
        setBaseline(next);
        setBaselineRevision(mutationRevision(exactSettings));
        setPendingRemoteSettings(null);
      } else if (
        exactSettings &&
        mutationRevision(exactSettings) !== baselineRevisionRef.current
      ) {
        setPendingRemoteSettings(exactSettings);
      }
      return;
    }
    setForm(next);
    setBaseline(next);
    setBaselineRevision(mutationRevision(exactSettings));
    setReconciliationHold(null);
    setPendingRemoteSettings(null);
  }, [exactSettings, readiness]);

  const patch = (next: Partial<LimitsForm>) => {
    if (reconciliationHold || pendingRemoteSettings) return;
    setSaveError(null);
    setForm((cur) => ({ ...cur, ...next }));
  };

  const capInvalid =
    form.cap.trim() !== "" &&
    (!Number.isSafeInteger(Number(form.cap)) ||
      Number(form.cap) < 1 ||
      Number(form.cap) > 1_000_000);
  const quietTimesEqual = form.start !== "" && form.start === form.end;
  const quietInvalid =
    form.quietEnabled &&
    (!HHMM.test(form.start) ||
      !HHMM.test(form.end) ||
      quietTimesEqual ||
      !isKnownTimeZone(form.tz));
  const revisionUnavailable = canWrite && baselineRevision === null;
  const tenantUnavailable = canWrite && !exactSettings?.tenant_id;
  const controlsDisabled =
    disabled ||
    loading ||
    readOnly ||
    !canWrite ||
    revisionUnavailable ||
    tenantUnavailable ||
    reconciliationHold !== null ||
    pendingRemoteSettings !== null;

  function inputFromForm(
    value: LimitsForm,
    revision: string,
  ): SendingSettingsInput {
    return {
      max_sends_per_hour: value.cap.trim() === "" ? null : Number(value.cap),
      quiet_hours_start: value.quietEnabled ? value.start : "",
      quiet_hours_end: value.quietEnabled ? value.end : "",
      quiet_hours_tz: value.quietEnabled ? value.tz : "",
      quiet_hours_per_recipient: value.perRecipient,
      expected_updated_at: revision,
    };
  }

  function adoptSaved(
    saved: SendingSettings,
    submission: ReconciliationHold,
    message: string,
  ): void {
    const next = formFromSources(saved, null);
    // The fields remain editable during the request. Preserve anything typed
    // after submission while still advancing the baseline to the canonical row.
    if (formRef.current === submission.sent) setForm(next);
    setBaseline(next);
    setBaselineRevision(mutationRevision(saved));
    setReconciliationHold(null);
    setPendingRemoteSettings(null);
    setSaveError(null);
    toast.success(message);
    onSaved(saved);
  }

  // A verified clear replaces any draft (the confirm says so), so the editor
  // adopts the cleared row directly rather than parking it as a newer remote
  // revision. A clear that lost a revision race passes no row: reload.
  function adoptCleared(saved?: SendingSettings): void {
    if (saved) {
      const next = formFromSources(saved, null);
      setForm(next);
      setBaseline(next);
      setBaselineRevision(mutationRevision(saved));
      setReconciliationHold(null);
      setPendingRemoteSettings(null);
      setSaveError(null);
    }
    onSaved(saved);
  }

  function applyReconciliation(
    result: SendingSettingsReconciliation,
    submission: ReconciliationHold,
  ): void {
    if (result.kind === "applied") {
      adoptSaved(
        result.settings,
        submission,
        "Sending limits saved and verified.",
      );
      return;
    }
    if (result.kind === "not-applied") {
      setReconciliationHold(null);
      setSaveError(result.message);
      return;
    }
    setReconciliationHold({
      ...submission,
      ...(result.kind === "conflict"
        ? { currentSettings: result.settings }
        : {}),
    });
    setSaveError(result.message);
    if (result.kind === "conflict") onSaved();
  }

  async function reconcile(submission: ReconciliationHold): Promise<void> {
    const openedAuthority = authorityKeyRef.current;
    const controller = controllerRef.current ?? new AbortController();
    controllerRef.current = controller;
    try {
      const result = await reconcileSendingSettingsMutation(
        submission.input,
        exactSettings?.tenant_id ?? "",
        controller.signal,
        submission.mutationDispatchedAt,
      );
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        authorityKeyRef.current === openedAuthority
      )
        applyReconciliation(result, submission);
    } catch {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthority
      )
        return;
      setReconciliationHold(submission);
      setSaveError(
        "Canonical verification failed unexpectedly. Editing remains held so the request cannot be replayed before its outcome is known.",
      );
    }
  }

  async function refreshReconciliation(): Promise<void> {
    const submission = reconciliationHold;
    if (!submission || savingRef.current || !beginSharedMutation()) return;
    savingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    setSaving(true);
    try {
      await reconcile(submission);
    } finally {
      savingRef.current = false;
      endSharedMutation();
      if (mountedRef.current) setSaving(false);
    }
  }

  function adoptCurrentServerVersion(): void {
    const current = reconciliationHold?.currentSettings;
    if (!current) return;
    const next = formFromSources(current, null);
    setForm(next);
    setBaseline(next);
    setBaselineRevision(mutationRevision(current));
    setReconciliationHold(null);
    setSaveError(null);
    toast.info("Current server settings loaded.");
  }

  function adoptPendingRemote(): void {
    if (!pendingRemoteSettings) return;
    const next = formFromSources(pendingRemoteSettings, null);
    setForm(next);
    setBaseline(next);
    setBaselineRevision(mutationRevision(pendingRemoteSettings));
    setPendingRemoteSettings(null);
    setSaveError(null);
    toast.info("Current server settings loaded.");
  }

  async function save() {
    if (savingRef.current || controlsDisabled) return;
    if (baselineRevision === null) {
      setSaveError(
        "The exact sending-settings revision is unavailable. Refresh before saving.",
      );
      return;
    }
    if (capInvalid) {
      toast.error(
        "Hourly cap must be a whole number from 1 to 1,000,000, or blank.",
      );
      return;
    }
    if (quietInvalid) {
      toast.error(
        "Quiet hours need a valid start, end (HH:MM, different), and timezone.",
      );
      return;
    }
    if (!beginSharedMutation()) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    const sent = form;
    const input = inputFromForm(sent, baselineRevision);
    const submission: ReconciliationHold = {
      input,
      sent,
      mutationDispatchedAt: Number.NaN,
    };
    const openedAuthority = authorityKey;
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      submission.mutationDispatchedAt = sendingSettingsMonotonicNow();
      const saved = await sendingSettingsApi.put(input, {
        signal: controller.signal,
      });
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthority
      ) {
        return;
      }
      if (
        saved.tenant_id !== exactSettings?.tenant_id ||
        !sendingSettingsMatchInput(saved, input) ||
        mutationRevision(saved) === null
      ) {
        await reconcile(submission);
        return;
      }
      adoptSaved(saved, submission, "Sending limits saved.");
    } catch (err) {
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        authorityKeyRef.current !== openedAuthority
      ) {
        return;
      }
      if (
        err instanceof SendingSettingsMutationOutcomeError &&
        err.requiresReconciliation
      ) {
        await reconcile(submission);
        return;
      }
      const message =
        err instanceof Error ? err.message : "Could not save sending limits.";
      setSaveError(message);
      toast.error(message);
    } finally {
      savingRef.current = false;
      endSharedMutation();
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <Card
      id="sending-limits"
      tabIndex={-1}
      className="scroll-mt-24 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-busy={loading || saving || undefined}
    >
      <CardHeader>
        <CardTitle>Sending limits</CardTitle>
        <CardDescription>
          Cap how fast this workspace sends and hold delivery during quiet
          hours. These feed the production-readiness checklist above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div
            role="status"
            className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
          >
            Loading the saved sending limits…
          </div>
        ) : disabled ? (
          <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
            Sending limits are unavailable. Unknown values stay hidden so they
            cannot be overwritten; retry above.
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="cap">Hourly send cap</Label>
              <Input
                id="cap"
                type="number"
                min={1}
                max={1_000_000}
                value={form.cap}
                disabled={controlsDisabled}
                aria-invalid={capInvalid}
                aria-describedby={capInvalid ? "cap-error" : "cap-help"}
                placeholder="No workspace ceiling"
                onChange={(e) => patch({ cap: e.target.value })}
              />
              {capInvalid ? (
                <p
                  id="cap-error"
                  className="text-xs text-destructive"
                  role="alert"
                >
                  Enter a whole number from 1 to 1,000,000, or leave this blank.
                </p>
              ) : (
                <p id="cap-help" className="text-xs text-muted-foreground">
                  Maximum emails per hour for this workspace. Leave blank for no
                  workspace-specific ceiling; provider, quota, and safety
                  controls still apply.
                </p>
              )}
            </div>

            <label className="flex min-h-11 items-start gap-3 rounded-md py-2 text-sm sm:min-h-0 sm:py-0">
              <Checkbox
                className="mt-1"
                checked={form.quietEnabled}
                disabled={controlsDisabled}
                onChange={(e) => patch({ quietEnabled: e.target.checked })}
              />
              <span>
                <span className="font-medium">Enable quiet hours</span>
                <span className="block text-xs text-muted-foreground">
                  Hold delivery within a daily window.
                </span>
              </span>
            </label>

            {form.quietEnabled ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="qh-start">Start (HH:MM)</Label>
                  <Input
                    id="qh-start"
                    placeholder="22:00"
                    value={form.start}
                    disabled={controlsDisabled}
                    aria-invalid={
                      form.quietEnabled &&
                      (!HHMM.test(form.start) || quietTimesEqual)
                    }
                    aria-describedby="quiet-hours-help"
                    onChange={(e) => patch({ start: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="qh-end">End (HH:MM)</Label>
                  <Input
                    id="qh-end"
                    placeholder="07:00"
                    value={form.end}
                    disabled={controlsDisabled}
                    aria-invalid={
                      form.quietEnabled &&
                      (!HHMM.test(form.end) || quietTimesEqual)
                    }
                    aria-describedby="quiet-hours-help"
                    onChange={(e) => patch({ end: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="qh-tz">Timezone</Label>
                  <Input
                    id="qh-tz"
                    list="qh-tz-options"
                    value={form.tz}
                    disabled={controlsDisabled}
                    aria-invalid={
                      form.quietEnabled && !isKnownTimeZone(form.tz)
                    }
                    aria-describedby="quiet-hours-help"
                    onChange={(e) => patch({ tz: e.target.value })}
                  />
                  <datalist id="qh-tz-options">
                    {timeZones.map((tz) => (
                      <option key={tz} value={tz} />
                    ))}
                  </datalist>
                </div>
              </div>
            ) : null}
            {form.quietEnabled ? (
              <>
                <p
                  id="quiet-hours-help"
                  className={
                    quietInvalid
                      ? "text-xs text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                  role={quietInvalid ? "alert" : undefined}
                >
                  {quietInvalid
                    ? "Use different start and end times in HH:MM format and a valid IANA timezone."
                    : "Delivery pauses inside this daily window in the selected timezone."}
                </p>
                <label className="flex min-h-11 items-start gap-3 rounded-md py-2 text-sm sm:min-h-0 sm:py-0">
                  <Checkbox
                    className="mt-1"
                    checked={form.perRecipient}
                    disabled={controlsDisabled}
                    onChange={(event) =>
                      patch({ perRecipient: event.target.checked })
                    }
                  />
                  <span>
                    <span className="font-medium">
                      Use each recipient&apos;s timezone
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Turn this off to apply the workspace timezone above to
                      everyone.
                    </span>
                  </span>
                </label>
              </>
            ) : null}

            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="font-medium">Send-time optimization</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Timing policy is managed separately, so saving these limits will
                not overwrite it.{" "}
                <Link
                  href="/app/settings/send-time"
                  className="font-medium text-foreground underline underline-offset-4 hover:text-primary"
                >
                  Open send-time settings
                </Link>
                .
              </p>
            </div>

            {saveError ? (
              <div
                ref={errorRef}
                role="alert"
                tabIndex={-1}
                className="break-words rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
              >
                <p>{saveError} Your unsaved values are still here.</p>
                {reconciliationHold ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {reconciliationHold.currentSettings ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={adoptCurrentServerVersion}
                        disabled={saving}
                      >
                        Load current server version
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void refreshReconciliation()}
                        loading={saving}
                      >
                        {saving ? "Reconciling…" : "Refresh to reconcile"}
                      </Button>
                    )}
                  </div>
                ) : (
                  <p className="mt-1">Correct the issue, then retry.</p>
                )}
              </div>
            ) : null}

            {pendingRemoteSettings && !reconciliationHold ? (
              <div
                role="alert"
                className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning-foreground"
              >
                <p className="font-medium">
                  Newer sending limits are available.
                </p>
                <p className="mt-1">
                  Your draft is still here, but saving is paused so an older
                  revision cannot overwrite the current policy.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  onClick={adoptPendingRemote}
                  disabled={saving}
                >
                  Discard draft and load current settings
                </Button>
              </div>
            ) : null}

            {revisionUnavailable && !saveError ? (
              <div
                role="alert"
                className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning-foreground"
              >
                The exact sending-settings revision is unavailable. Refresh this
                page before editing so an older view cannot overwrite a newer
                policy.
              </div>
            ) : null}

            {canWrite ? (
              <ClearSendingLimitsButton
                settings={exactSettings}
                canWrite={canWrite}
                identity={identity}
                disabled={controlsDisabled || saving}
                dirty={dirty}
                beginSharedMutation={beginSharedMutation}
                endSharedMutation={endSharedMutation}
                onCleared={adoptCleared}
              />
            ) : null}

            {canWrite ? (
              <div className="flex justify-end">
                <Button
                  type="button"
                  onClick={() => void save()}
                  loading={saving}
                  disabled={
                    !dirty ||
                    controlsDisabled ||
                    saving ||
                    capInvalid ||
                    quietInvalid
                  }
                >
                  {saving ? "Saving…" : "Save sending limits"}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Sending limits are read-only for your role.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
