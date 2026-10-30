// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import {
  getTriggerDelayPreference,
  newAutomationOperationKey,
  putTriggerDelayPreference,
  type TriggerDelayLookup,
} from "@/lib/automation-configuration-api";
import { AUTOMATION_CONFIGURATION_BOUNDARIES } from "@/lib/automation-operational-availability";
import {
  useAutomationReadAbort,
  verifyFreshAutomationAdmin,
} from "./automation-configuration-authority";

interface Props {
  me: MeResponse;
  queryScope: readonly unknown[];
  canAdmin: boolean;
}
interface Pair {
  subscriberId: string;
  eventName: string;
}
interface SaveAttempt {
  fingerprint: string;
  idempotencyKey: string;
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_EVENT_BYTES = 256;
const MAX_REASON_BYTES = 500;
const MAX_DELAY_SECONDS = 2_592_000;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function subscriberInputError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return CANONICAL_UUID.test(trimmed)
    ? null
    : "Subscriber ID must be a canonical UUID.";
}

function eventInputError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return byteLength(trimmed) <= MAX_EVENT_BYTES
    ? null
    : "Event name must use 256 UTF-8 bytes or fewer.";
}

function delayInputError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) &&
    parsed >= 0 &&
    parsed <= MAX_DELAY_SECONDS
    ? null
    : "Manual delay must be a whole number from 0 through 2,592,000 seconds.";
}

function reasonInputError(value: string): string | null {
  return byteLength(value.trim()) <= MAX_REASON_BYTES
    ? null
    : "Operator reason must use 500 UTF-8 bytes or fewer.";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function TriggerDelayPanel({ me, queryScope, canAdmin }: Props) {
  const qc = useQueryClient();
  const [subscriberId, setSubscriberId] = useState("");
  const [eventName, setEventName] = useState("");
  const [pair, setPair] = useState<Pair | null>(null);
  const [delay, setDelay] = useState("");
  const [reason, setReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const eventRef = useRef<HTMLInputElement>(null);
  const saveAttempt = useRef<SaveAttempt | null>(null);
  const nextRead = useAutomationReadAbort();
  const key = [
    ...queryScope,
    "manual-trigger-delay",
    pair?.subscriberId ?? "none",
    pair?.eventName ?? "none",
  ] as const;
  const lookup = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      getTriggerDelayPreference({
        subscriberId: pair!.subscriberId,
        eventName: pair!.eventName,
        signal,
      }),
    enabled: Boolean(pair),
    retry: false,
  });
  const subscriberError = subscriberInputError(subscriberId);
  const eventError = eventInputError(eventName);
  const delayError = delayInputError(delay);
  const reasonError = reasonInputError(reason);
  const lookupInputsValid = Boolean(
    subscriberId.trim() && eventName.trim() && !subscriberError && !eventError,
  );

  useEffect(() => {
    if (!pair || lookup.isPending || lookup.isError) return;
    if (lookup.data?.kind === "manual") {
      setDelay(String(lookup.data.optimalDelaySeconds));
      setReason(lookup.data.reason);
    } else {
      setDelay("");
      setReason("");
    }
  }, [lookup.data, lookup.isError, lookup.isPending, pair]);

  function submitLookup() {
    if (!lookupInputsValid) return;
    const next = {
      subscriberId: subscriberId.trim().toLowerCase(),
      eventName: eventName.trim().toLowerCase(),
    };
    if (
      pair?.subscriberId === next.subscriberId &&
      pair.eventName === next.eventName
    ) {
      void lookup.refetch();
      return;
    }
    setPair(next);
  }

  async function saveOverride() {
    if (!pair) throw new Error("Look up a subscriber-event pair first.");
    if (
      pair.subscriberId !== subscriberId.trim().toLowerCase() ||
      pair.eventName !== eventName.trim().toLowerCase()
    ) {
      throw new Error("Run a fresh lookup for the current inputs first.");
    }
    if (delay.trim() === "" || delayError || reasonError) {
      throw new Error(
        delayError ??
          reasonError ??
          "Enter a valid whole-number manual delay before saving.",
      );
    }
    const seconds = Number(delay);
    const controller = nextRead();
    await verifyFreshAutomationAdmin(me, controller.signal);
    const current = await getTriggerDelayPreference({
      subscriberId: pair.subscriberId,
      eventName: pair.eventName,
      signal: controller.signal,
    });
    const normalizedReason = reason.trim();
    if (
      current?.kind === "manual" &&
      current.optimalDelaySeconds === seconds &&
      current.reason === normalizedReason
    ) {
      // The prior request can commit while its response is lost. Treat an
      // exact fresh readback as confirmation instead of replaying a write over
      // newer state.
      qc.setQueryData(key, current);
      saveAttempt.current = null;
      setConfirmOpen(false);
      toast.success("Manual timing override saved");
      return;
    }
    if (JSON.stringify(current) !== JSON.stringify(lookup.data ?? null))
      throw new Error(
        "This timing preference changed on the server. Nothing was written; run the lookup again.",
      );
    controller.signal.throwIfAborted();
    const fingerprint = JSON.stringify([
      pair.subscriberId,
      pair.eventName,
      seconds,
      normalizedReason,
      lookup.data ?? null,
    ]);
    if (saveAttempt.current?.fingerprint !== fingerprint) {
      saveAttempt.current = {
        fingerprint,
        idempotencyKey: newAutomationOperationKey("manual-trigger-delay"),
      };
    }
    const receipt = await putTriggerDelayPreference({
      subscriberId: pair.subscriberId,
      eventName: pair.eventName,
      optimalDelaySeconds: seconds,
      reason: normalizedReason,
      idempotencyKey: saveAttempt.current.idempotencyKey,
      signal: controller.signal,
    });
    qc.setQueryData(key, receipt);
    saveAttempt.current = null;
    setConfirmOpen(false);
    toast.success("Manual timing override saved");
  }

  const pairMatchesInputs = Boolean(
    pair &&
    pair.subscriberId === subscriberId.trim().toLowerCase() &&
    pair.eventName === eventName.trim().toLowerCase(),
  );
  const resolved = pair && !lookup.isPending && !lookup.isError;
  const baseline: TriggerDelayLookup | undefined = lookup.data;
  const baselineDelay =
    baseline?.kind === "manual" ? String(baseline.optimalDelaySeconds) : "";
  const baselineReason = baseline?.kind === "manual" ? baseline.reason : "";
  const overrideDirty = Boolean(
    canAdmin &&
    resolved &&
    (delay !== baselineDelay || reason !== baselineReason),
  );
  useUnsavedChangesGuard(overrideDirty);

  return (
    <section aria-labelledby="trigger-delay-heading" className="space-y-4">
      <div>
        <h2 id="trigger-delay-heading" className="text-lg font-semibold">
          Manual trigger-delay override
        </h2>
        <p className="text-sm text-muted-foreground">
          Inspect and store one explicit subscriber-event delay. This is not
          learned send-time optimization.
        </p>
      </div>
      <div
        role="note"
        className="grid gap-2 rounded-lg border bg-muted/30 p-4 text-sm md:grid-cols-2"
      >
        <div>
          <strong className="block">Available</strong>
          {AUTOMATION_CONFIGURATION_BOUNDARIES.timingOverrides.available}
        </div>
        <div>
          <strong className="block text-destructive">Release-held</strong>
          {AUTOMATION_CONFIGURATION_BOUNDARIES.timingOverrides.unavailable}
        </div>
        <p className="md:col-span-2 text-muted-foreground">
          The endpoint exposes no ETag or version. Before saving, web rechecks
          administrator authority and compares a fresh pair lookup with the
          record you reviewed.
        </p>
      </div>
      <form
        className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[minmax(14rem,1fr)_minmax(12rem,1fr)_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          submitLookup();
        }}
      >
        <div className="space-y-1">
          <Label htmlFor="trigger-delay-subscriber">Subscriber UUID</Label>
          <Input
            id="trigger-delay-subscriber"
            maxLength={36}
            spellCheck={false}
            autoComplete="off"
            required
            value={subscriberId}
            aria-invalid={subscriberError ? true : undefined}
            aria-describedby={
              subscriberError ? "trigger-delay-subscriber-error" : undefined
            }
            onChange={(event) => setSubscriberId(event.target.value)}
          />
          {subscriberError ? (
            <p
              id="trigger-delay-subscriber-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {subscriberError}
            </p>
          ) : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor="trigger-delay-event">Event name</Label>
          <Input
            ref={eventRef}
            id="trigger-delay-event"
            maxLength={256}
            spellCheck={false}
            autoComplete="off"
            required
            placeholder="order.created"
            value={eventName}
            aria-invalid={eventError ? true : undefined}
            aria-describedby={
              eventError ? "trigger-delay-event-error" : undefined
            }
            onChange={(event) => setEventName(event.target.value)}
          />
          {eventError ? (
            <p
              id="trigger-delay-event-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {eventError}
            </p>
          ) : null}
        </div>
        <Button
          type="submit"
          disabled={!lookupInputsValid || lookup.isFetching}
        >
          <Search aria-hidden className="size-4" />{" "}
          {lookup.isFetching ? "Looking up…" : "Look up"}
        </Button>
      </form>

      {!pair ? (
        <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
          Enter a subscriber UUID and event name to request a fresh server
          lookup.
        </p>
      ) : lookup.isError ? (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-destructive p-4"
        >
          <p>
            {apiErrorMessage(
              lookup.error,
              "The timing preference could not be loaded",
            )}
          </p>
          <Button variant="outline" onClick={() => void lookup.refetch()}>
            <RefreshCw aria-hidden className="size-4" /> Retry
          </Button>
        </div>
      ) : lookup.isPending ? (
        <p role="status" className="py-8 text-sm text-muted-foreground">
          Loading timing preference…
        </p>
      ) : !pairMatchesInputs ? (
        <div
          role="note"
          className="rounded-lg border border-warning/50 bg-warning/10 p-4 text-sm"
        >
          The lookup inputs changed. Run the lookup again before reviewing or
          saving.
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border p-4">
          {baseline === null ? (
            <p role="status" className="text-sm">
              No preference is stored for this verified pair.
            </p>
          ) : baseline?.kind === "learned-held" ? (
            <div
              role="note"
              className="flex gap-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm"
            >
              <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <p>
                A model-produced preference exists, updated{" "}
                {formatDate(baseline.updatedAt)}, but learned timing and
                confidence are release-held and are not displayed. Saving below
                deliberately replaces it with an explicit manual override.
              </p>
            </div>
          ) : baseline?.kind === "manual" ? (
            <div role="status" className="text-sm">
              Manual override last updated {formatDate(baseline.updatedAt)}.
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="trigger-delay-seconds">
                Delay seconds (0–2,592,000)
              </Label>
              <Input
                id="trigger-delay-seconds"
                type="number"
                min={0}
                max={2592000}
                step={1}
                required
                disabled={!canAdmin}
                value={delay}
                aria-invalid={delayError ? true : undefined}
                aria-describedby={
                  delayError ? "trigger-delay-seconds-error" : undefined
                }
                onChange={(event) => setDelay(event.target.value)}
              />
              {delayError ? (
                <p
                  id="trigger-delay-seconds-error"
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {delayError}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Zero preserves the manual record but resolves to no positive
                delay.
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="trigger-delay-reason">Operator reason</Label>
              <Textarea
                id="trigger-delay-reason"
                maxLength={500}
                disabled={!canAdmin}
                value={reason}
                aria-invalid={reasonError ? true : undefined}
                aria-describedby={
                  reasonError ? "trigger-delay-reason-error" : undefined
                }
                onChange={(event) => setReason(event.target.value)}
              />
              {reasonError ? (
                <p
                  id="trigger-delay-reason-error"
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {reasonError}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Pair:{" "}
              <Link
                className="underline-offset-4 hover:underline"
                href={`/app/subscribers/${pair.subscriberId}`}
              >
                {pair.subscriberId}
              </Link>{" "}
              · {pair.eventName}
            </p>
            <Button
              disabled={
                !canAdmin ||
                !resolved ||
                delay.trim() === "" ||
                Boolean(delayError) ||
                Boolean(reasonError)
              }
              onClick={() => setConfirmOpen(true)}
            >
              Save manual override
            </Button>
          </div>
          {!canAdmin ? (
            <p role="note" className="text-sm text-muted-foreground">
              You can inspect manual override presence, but an administrator
              must save changes.
            </p>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Save manual timing override?"
        description="This stores explicit configuration for the selected subscriber-event pair. It does not prove that a runtime consumed it. Type the exact event name to continue."
        confirmationToken={pair?.eventName}
        confirmLabel="Save override"
        confirmVariant="default"
        onConfirm={saveOverride}
      />
    </section>
  );
}
