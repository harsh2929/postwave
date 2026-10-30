// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Send-frequency preference (SUB-132) for one subscriber, shown on the
 * Preferences tab above the topic overrides.
 *
 * Reads/writes the two columns the queue-fill frequency filter enforces at
 * send time: `frequency_preference` (default / weekly / monthly / paused) and
 * `paused_until` (auto-reactivation timestamp; null = indefinite). A paused
 * subscriber — or one whose expiry is still in the future — is excluded from
 * every campaign audience server-side, so "Paused" is an operator pause of
 * sends, not a cosmetic flag.
 *
 * Backed by PATCH /api/v1/subscribers/{id} under the exact revision that was
 * loaded (If-Match); see setFrequencyPreference in subscriber-consent-api.ts.
 */
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage, isApiError } from "@/lib/api";
import { absoluteTime } from "@/lib/relative-time";
import {
  FREQUENCY_PREFERENCE_OPTIONS,
  isFrequencyPreference,
  setFrequencyPreference,
  type FrequencyPreference,
  type FrequencyPreferenceInput,
} from "@/lib/subscriber-consent-api";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import {
  isExactSubscriberVersion,
  type Subscriber,
} from "@/lib/subscribers-api";

/** ISO → the `YYYY-MM-DDTHH:mm` a datetime-local input wants, in local time. */
export function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function mutationMessage(err: unknown, fallback: string): string {
  if (isApiError(err) && [409, 412, 428].includes(err.status)) {
    return "This subscriber changed while you were reviewing it. The profile was reloaded; review the current preference and try again.";
  }
  if (err instanceof Error && err.message.trim()) {
    return apiErrorMessage(err, fallback);
  }
  return fallback;
}

export function FrequencyPreferencePanel({
  record,
  authority,
  onRecordRefetch,
}: {
  record: Subscriber | undefined;
  authority: SubscriberAuthority | null;
  onRecordRefetch: () => void | Promise<void>;
}) {
  const reasonId = useId();
  const pauseUntilId = useId();
  const groupId = useId();
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pausedDraft, setPausedDraft] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const errorRef = useRef<HTMLDivElement>(null);

  const subscriberId = record?.id ?? null;
  const version = record?.version;
  const current: FrequencyPreference = isFrequencyPreference(
    record?.frequency_preference,
  )
    ? record.frequency_preference
    : "default";
  const pausedUntil = record?.paused_until ?? null;

  // Re-seed the expiry draft whenever the loaded row changes (subscriber
  // switch or a refetch that moved the expiry).
  useEffect(() => {
    setPausedDraft(toDatetimeLocal(pausedUntil));
  }, [subscriberId, pausedUntil]);

  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setSaving(null);
    setError(null);
  }, [subscriberId, authority?.tenantId, authority?.userId, authority?.role]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  if (!record || !subscriberId) {
    return (
      <p className="text-sm text-muted-foreground">
        The subscriber record must load before send frequency can be changed.
      </p>
    );
  }

  const versionReady = isExactSubscriberVersion(version, subscriberId);
  const blockedReason =
    authority === null
      ? "Viewer access can inspect send frequency but cannot change it."
      : !versionReady
        ? "Reload this subscriber to obtain the latest revision before changing send frequency."
        : null;
  const disabled = blockedReason !== null || saving !== null;

  const save = async (
    busyKey: string,
    input: FrequencyPreferenceInput,
    success: string,
  ): Promise<void> => {
    if (!authority || !versionReady || saving !== null) return;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setSaving(busyKey);
    setError(null);
    let committed = false;
    try {
      await reauthorizeSubscriberMutation(authority, controller.signal);
      await setFrequencyPreference(subscriberId, input, version, {
        signal: controller.signal,
      });
      committed = true;
      await reauthorizeSubscriberMutation(authority, controller.signal);
      if (generation !== generationRef.current) return;
      await onRecordRefetch();
      toast.success(success);
    } catch (err) {
      if (generation !== generationRef.current) return;
      if (committed) {
        void onRecordRefetch();
        toast.info(
          "The preference saved, but workspace access changed afterward. Reloading the profile.",
        );
        return;
      }
      const message = mutationMessage(
        err,
        "Send frequency could not be confirmed. The enforced preference is unchanged.",
      );
      if (isApiError(err) && [409, 412, 428].includes(err.status)) {
        void onRecordRefetch();
      }
      setError(message);
      toast.error(message);
    } finally {
      if (generation === generationRef.current) {
        abortRef.current = null;
        setSaving(null);
      }
    }
  };

  const pausedInFuture =
    pausedUntil !== null && new Date(pausedUntil).getTime() > Date.now();

  return (
    <section className="space-y-4" aria-labelledby={`${groupId}-heading`}>
      <div>
        <h3 id={`${groupId}-heading`} className="text-sm font-medium">
          Send frequency
        </h3>
        <p className="text-xs text-muted-foreground">
          The subscriber&apos;s own send-cadence preference. &ldquo;Paused&rdquo;
          (or a future pause expiry) excludes them from every campaign at
          queue-fill until reactivated.
        </p>
      </div>

      {error ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
        >
          {error}
        </div>
      ) : null}

      <fieldset
        className="space-y-2"
        disabled={disabled}
        aria-describedby={blockedReason ? reasonId : undefined}
      >
        <legend className="sr-only">Send frequency preference</legend>
        {FREQUENCY_PREFERENCE_OPTIONS.map((option) => {
          const checked = current === option.value;
          const inputId = `${groupId}-${option.value}`;
          return (
            <label
              key={option.value}
              htmlFor={inputId}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 sm:min-h-9"
            >
              <input
                id={inputId}
                type="radio"
                name={`${groupId}-frequency`}
                value={option.value}
                className="h-4 w-4 accent-primary"
                checked={checked}
                // Disabled on the control itself, not only via the
                // fieldset: a fieldset's disabled state never reflects
                // onto `input.disabled`, so each radio must carry the
                // withhold (and its reason) for assistive tech and tests.
                disabled={disabled}
                aria-describedby={blockedReason ? reasonId : undefined}
                onChange={() => {
                  if (checked) return;
                  void save(
                    `pref:${option.value}`,
                    { frequency_preference: option.value },
                    option.value === "paused"
                      ? "Sends paused for this subscriber."
                      : `Cadence set to ${option.label.toLowerCase()}.`,
                  );
                }}
              />
              <span className="font-medium">{option.label}</span>
              <span className="text-xs text-muted-foreground">
                {option.hint}
              </span>
              {saving === `pref:${option.value}` ? (
                <span
                  role="status"
                  className="ml-auto text-xs text-muted-foreground"
                >
                  Saving…
                </span>
              ) : null}
            </label>
          );
        })}
      </fieldset>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Pause expiry</span>
          {pausedInFuture && pausedUntil ? (
            <Badge
              variant="warning"
              title="Excluded from sends until this passes."
            >
              Until {absoluteTime(pausedUntil)}
            </Badge>
          ) : current === "paused" ? (
            <Badge
              variant="outline"
              title="Paused with no expiry — stays paused until reactivated."
            >
              Indefinite
            </Badge>
          ) : (
            <span>None</span>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="grid gap-1.5">
            <Label htmlFor={pauseUntilId}>Pause until</Label>
            <Input
              id={pauseUntilId}
              type="datetime-local"
              value={pausedDraft}
              disabled={disabled}
              aria-describedby={blockedReason ? reasonId : undefined}
              onChange={(event) => setPausedDraft(event.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || !pausedDraft}
            aria-describedby={blockedReason ? reasonId : undefined}
            onClick={() => {
              if (!pausedDraft) return;
              const at = new Date(pausedDraft);
              if (Number.isNaN(at.getTime())) {
                setError("Enter a valid pause expiry date and time.");
                return;
              }
              void save(
                "paused_until",
                {
                  frequency_preference: "paused",
                  paused_until: at.toISOString(),
                },
                "Pause expiry updated.",
              );
            }}
          >
            {saving === "paused_until" ? "Saving…" : "Set expiry"}
          </Button>
          {pausedUntil ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              aria-describedby={blockedReason ? reasonId : undefined}
              onClick={() =>
                void save(
                  "clear_paused",
                  { clear_paused_until: true },
                  "Pause expiry cleared.",
                )
              }
            >
              {saving === "clear_paused" ? "Clearing…" : "Clear expiry"}
            </Button>
          ) : null}
        </div>
      </div>

      {blockedReason ? (
        <p id={reasonId} role="status" className="text-xs text-muted-foreground">
          {blockedReason}
        </p>
      ) : null}
    </section>
  );
}
