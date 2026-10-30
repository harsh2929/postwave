// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * "Clear limit & quiet hours" — the confirmed reset of the workspace hourly
 * ceiling and quiet-hours window. Desktop parity: pages/SendingSettings.tsx
 * openClear (830) → ConfirmModal (1037-1067) → useSendingSettingsController
 * confirmClear (632-652) → sendingSettingsApi.put(clearedSendingInput).
 *
 * The server has no DELETE for sending settings, so "clear" is the same
 * revision-checked full-replace PUT the editor uses, carrying an empty cap
 * and an empty quiet-hours window:
 *
 *   PUT /api/v1/settings/sending
 *   { max_sends_per_hour: null, quiet_hours_start: "", quiet_hours_end: "",
 *     quiet_hours_tz: "", quiet_hours_per_recipient: <unchanged>,
 *     expected_updated_at: <loaded revision> }
 *
 * `quiet_hours_per_recipient` is preserved exactly like desktop's
 * clearedSendingInput: the clear scope is the ceiling and the window only.
 *
 * An ambiguous write (transport loss, a fenced or unreadable commit receipt)
 * is NEVER retried. It is resolved through reconcileSendingSettingsMutation,
 * which only reads, and until that proves an outcome the control stays held.
 */
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import type { MeResponse } from "@/lib/auth-api";
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

/** The exact payload a clear submits for a loaded settings row. */
export function clearedSendingSettingsInput(
  settings: SendingSettings,
  revision: string,
): SendingSettingsInput {
  return {
    max_sends_per_hour: null,
    quiet_hours_start: "",
    quiet_hours_end: "",
    quiet_hours_tz: "",
    quiet_hours_per_recipient: settings.quiet_hours_per_recipient,
    expected_updated_at: revision,
  };
}

/** True when the loaded row has a ceiling or a quiet-hours window to clear. */
export function sendingLimitsConfigured(settings: SendingSettings): boolean {
  return (
    settings.max_sends_per_hour != null ||
    Boolean(settings.quiet_hours_start) ||
    Boolean(settings.quiet_hours_end) ||
    Boolean(settings.quiet_hours_tz)
  );
}

interface HeldClear {
  input: SendingSettingsInput;
  dispatchedAt: number;
  message: string;
}

export function ClearSendingLimitsButton({
  settings,
  canWrite,
  identity,
  disabled = false,
  dirty = false,
  beginSharedMutation,
  endSharedMutation,
  onCleared,
}: {
  /** The exact canonical row the editor loaded; null while unavailable. */
  settings: SendingSettings | null;
  canWrite: boolean;
  identity: MeResponse;
  /** The host card's own lock (loading, reconciling, pending remote row). */
  disabled?: boolean;
  /** Whether the host editor holds unsaved changes the clear would replace. */
  dirty?: boolean;
  beginSharedMutation?: () => boolean;
  endSharedMutation?: () => void;
  /**
   * Called with the verified cleared row, or with no argument when the server
   * now holds a different revision and the host should reload.
   */
  onCleared: (saved?: SendingSettings) => void;
}) {
  const reasonId = useId();
  const [held, setHeld] = useState<HeldClear | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const mountedRef = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const revision = settings ? sendingSettingsRevision(settings) : null;
  const configured = settings ? sendingLimitsConfigured(settings) : false;
  const blockedReason = !canWrite
    ? "Only an owner or admin can clear sending limits."
    : !settings || revision === null
      ? "The exact sending-settings revision is unavailable. Refresh before clearing."
      : !configured
        ? "No hourly cap or quiet-hours window is saved, so there is nothing to clear."
        : held
          ? "Reconcile the previous clear before trying again."
          : null;

  /**
   * Applies a read-only reconciliation. Returns the server's sentence when the
   * clear provably did NOT apply (safe to try again deliberately); every other
   * unresolved outcome holds the control instead.
   */
  function applyReconciliation(
    result: SendingSettingsReconciliation,
    submission: Omit<HeldClear, "message">,
  ): string | null {
    if (result.kind === "applied") {
      setHeld(null);
      toast.success("Hourly cap and quiet hours cleared and verified.");
      onCleared(result.settings);
      return null;
    }
    if (result.kind === "not-applied") {
      setHeld(null);
      return result.message;
    }
    setHeld({ ...submission, message: result.message });
    if (result.kind === "conflict") onCleared();
    return null;
  }

  /**
   * Read-only resolution of an ambiguous clear. A failure to reconcile is
   * itself unresolved, so it holds the control rather than surfacing as a
   * plain error the operator could answer with a second PUT.
   */
  async function reconcile(
    submission: Omit<HeldClear, "message">,
    signal: AbortSignal,
  ): Promise<string | null> {
    try {
      const result = await reconcileSendingSettingsMutation(
        submission.input,
        settings?.tenant_id ?? "",
        signal,
        submission.dispatchedAt,
      );
      if (!mountedRef.current || signal.aborted) return null;
      return applyReconciliation(result, submission);
    } catch {
      if (mountedRef.current && !signal.aborted) {
        setHeld({
          ...submission,
          message:
            "Canonical verification failed. The clear stays held so it cannot be replayed before its outcome is known.",
        });
      }
      return null;
    }
  }

  async function confirmClear(): Promise<void> {
    if (blockedReason || !settings || revision === null) {
      throw new Error(blockedReason ?? "Sending limits cannot be cleared.");
    }
    if (beginSharedMutation && !beginSharedMutation()) {
      throw new Error(
        "Another sending-settings change is still in progress. Nothing was written.",
      );
    }
    const input = clearedSendingSettingsInput(settings, revision);
    const submission = { input, dispatchedAt: Number.NaN };
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      await verifyFreshAdminAuthority(identity, controller.signal);
      submission.dispatchedAt = sendingSettingsMonotonicNow();
      let saved: SendingSettings;
      try {
        saved = await sendingSettingsApi.put(input, {
          signal: controller.signal,
        });
      } catch (error) {
        if (!mountedRef.current || controller.signal.aborted) return;
        if (
          error instanceof SendingSettingsMutationOutcomeError &&
          error.requiresReconciliation
        ) {
          const notApplied = await reconcile(submission, controller.signal);
          if (notApplied) throw new Error(notApplied);
          return;
        }
        throw error;
      }
      if (!mountedRef.current || controller.signal.aborted) return;
      if (
        saved.tenant_id !== settings.tenant_id ||
        !sendingSettingsMatchInput(saved, input) ||
        sendingSettingsRevision(saved) === null
      ) {
        const notApplied = await reconcile(submission, controller.signal);
        if (notApplied) throw new Error(notApplied);
        return;
      }
      setHeld(null);
      toast.success("Hourly cap and quiet hours cleared.");
      onCleared(saved);
    } finally {
      endSharedMutation?.();
    }
  }

  async function refreshReconciliation(): Promise<void> {
    if (!held || reconciling) return;
    if (beginSharedMutation && !beginSharedMutation()) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setReconciling(true);
    try {
      const notApplied = await reconcile(held, controller.signal);
      if (notApplied) toast.info(notApplied);
    } finally {
      endSharedMutation?.();
      if (mountedRef.current) setReconciling(false);
    }
  }

  const triggerDisabled = disabled || blockedReason !== null;

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Clear scope</p>
          <p className="text-xs text-muted-foreground">
            Clears only the hourly ceiling and quiet hours. Frequency caps,
            identity, IP assignments, and send-time settings are preserved.
          </p>
        </div>
        <ConfirmDialog
          title="Clear hourly limit and quiet hours?"
          description={
            <>
              This submits a revision-checked settings update. The workspace
              will no longer have an hourly ceiling or be held by a quiet-hours
              window; provider, quota, and safety controls still apply.
              Frequency caps, sending identity, IP assignments, and send-time
              settings are not changed.
              {dirty ? (
                <strong className="mt-2 block">
                  Your unsaved draft will also be replaced if this clear
                  succeeds.
                </strong>
              ) : null}
            </>
          }
          confirmLabel="Clear limit & quiet hours"
          confirmVariant="destructive"
          onConfirm={confirmClear}
          trigger={
            <Button
              type="button"
              variant="outline"
              className="shrink-0 border-destructive/40 text-destructive-emphasis"
              disabled={triggerDisabled}
              aria-describedby={blockedReason ? reasonId : undefined}
            >
              Clear limit &amp; quiet hours
            </Button>
          }
        />
      </div>
      {held ? (
        <div
          role="alert"
          className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm"
        >
          <p id={reasonId}>{held.message}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            loading={reconciling}
            onClick={() => void refreshReconciliation()}
          >
            {reconciling ? "Reconciling…" : "Refresh to reconcile"}
          </Button>
        </div>
      ) : blockedReason ? (
        <p id={reasonId} className="text-xs text-muted-foreground">
          {blockedReason}
        </p>
      ) : null}
    </div>
  );
}
