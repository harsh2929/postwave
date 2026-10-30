// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { STALE } from "@/lib/query-keys";
import {
  getSegmentSendTimeBest,
  getSegmentSendTimePattern,
  getSubscriberSendTimeBest,
  getSubscriberSendTimePattern,
  isSendTimeIdentity,
  listSendTimeSegments,
  type WeeklySendTimePattern,
} from "@/lib/send-time-api";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type IntelligenceProps = {
  baseKey: readonly unknown[];
  enabled: boolean;
};

function isMissingSignal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function hourOfWeekLabel(hourOfWeek: number): string {
  const day = Math.floor(hourOfWeek / 24);
  const hour = hourOfWeek % 24;
  return (
    (DAY_LABELS[day] ?? "Unknown") +
    " " +
    String(hour).padStart(2, "0") +
    ":00 UTC"
  );
}

function patternWindow(day: number, hour: number): string {
  return (
    (DAY_LABELS[day] ?? "Unknown") +
    " " +
    String(hour).padStart(2, "0") +
    ":00 UTC"
  );
}

function TimingMetric({
  label,
  value,
  help,
}: {
  label: string;
  value: string;
  help?: string;
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold tabular-nums">{value}</dd>
      {help ? (
        <p className="mt-1 text-xs text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}

function WeeklyHeatmap({
  pattern,
  title,
}: {
  pattern: WeeklySendTimePattern;
  title: string;
}) {
  const summaryId = useId();
  const max = useMemo(
    () => Math.max(0, ...pattern.grid.flat()),
    [pattern.grid],
  );

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">{title}</h4>
      <div
        role="img"
        tabIndex={0}
        aria-label={title + " by UTC hour"}
        aria-describedby={summaryId}
        className="overflow-x-auto rounded-md border p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="inline-grid min-w-[620px] grid-cols-[auto_repeat(24,minmax(18px,1fr))] gap-1 text-[10px] text-muted-foreground">
          <div />
          {Array.from({ length: 24 }, (_, hour) => (
            <div key={hour} className="text-center tabular-nums">
              {hour % 3 === 0 ? hour : ""}
            </div>
          ))}
          {pattern.grid.map((row, day) => (
            <div key={DAY_LABELS[day]} className="contents">
              <div className="pr-1 text-right leading-5">{DAY_LABELS[day]}</div>
              {row.map((weight, hour) => {
                const primary =
                  day === pattern.bestDay && hour === pattern.bestHour;
                const secondary =
                  pattern.hasSecondary &&
                  day === pattern.secondaryDay &&
                  hour === pattern.secondaryHour;
                return (
                  <div
                    key={hour}
                    title={
                      patternWindow(day, hour) +
                      " — " +
                      (weight * 100).toFixed(2) +
                      "% of measured signal" +
                      (primary
                        ? " — strongest window"
                        : secondary
                          ? " — secondary window"
                          : "")
                    }
                    className={[
                      "h-5 rounded-[3px] bg-primary",
                      primary
                        ? "ring-2 ring-primary ring-offset-1"
                        : secondary
                          ? "ring-2 ring-amber-500 ring-offset-1"
                          : "",
                    ].join(" ")}
                    style={{
                      opacity: 0.06 + (max > 0 ? weight / max : 0) * 0.94,
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p id={summaryId} className="text-xs text-muted-foreground">
        Strongest measured window:{" "}
        {patternWindow(pattern.bestDay, pattern.bestHour)}.
        {pattern.hasSecondary &&
        pattern.secondaryDay !== null &&
        pattern.secondaryHour !== null
          ? " Secondary window: " +
            patternWindow(pattern.secondaryDay, pattern.secondaryHour) +
            "."
          : ""}{" "}
        Based on {pattern.sampleSize.toLocaleString()} qualifying signal
        {pattern.sampleSize === 1 ? "" : "s"}. Recommendations describe past
        behavior and do not guarantee future engagement.
      </p>
    </div>
  );
}

export function SendTimeAudienceIntelligence({
  baseKey,
  enabled,
}: IntelligenceProps) {
  const [segmentId, setSegmentId] = useState("");
  const segments = useQuery({
    queryKey: [...baseKey, "segment-catalog"],
    queryFn: ({ signal }) => listSendTimeSegments(signal),
    enabled,
    staleTime: STALE.list,
  });
  const pattern = useQuery({
    queryKey: [...baseKey, "segment-pattern", segmentId],
    queryFn: ({ signal }) => getSegmentSendTimePattern(segmentId, signal),
    enabled: enabled && isSendTimeIdentity(segmentId),
    staleTime: STALE.reference,
  });
  const best = useQuery({
    queryKey: [...baseKey, "segment-best", segmentId],
    queryFn: ({ signal }) => getSegmentSendTimeBest(segmentId, signal),
    enabled: enabled && isSendTimeIdentity(segmentId),
    staleTime: STALE.reference,
  });
  const selected = segments.data?.find((segment) => segment.id === segmentId);
  const loadingSignal =
    segmentId !== "" && (pattern.isLoading || best.isLoading);
  const insufficient =
    isMissingSignal(pattern.error) || isMissingSignal(best.error);
  const failed =
    (!isMissingSignal(pattern.error) && pattern.error) ||
    (!isMissingSignal(best.error) && best.error);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Saved-segment attention map</CardTitle>
        <CardDescription>
          Inspect the measured 7×24 UTC pattern and recommendation for one
          explicit saved segment. This analysis never schedules a campaign.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-2">
            <Label htmlFor="send-time-segment">Audience scope</Label>
            {segments.isLoading ? (
              <Skeleton className="h-11 w-full sm:h-9" />
            ) : segments.isError ? (
              <div
                role="alert"
                className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
              >
                <p>The saved-segment catalog could not be verified.</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void segments.refetch()}
                  loading={segments.isFetching}
                >
                  Retry segments
                </Button>
              </div>
            ) : (
              <Select
                id="send-time-segment"
                value={segmentId}
                onChange={(event) => setSegmentId(event.target.value)}
                disabled={(segments.data?.length ?? 0) === 0}
              >
                <option value="">
                  {(segments.data?.length ?? 0) === 0
                    ? "No saved segments"
                    : "Choose a saved segment…"}
                </option>
                {segments.data?.map((segment) => (
                  <option key={segment.id} value={segment.id}>
                    {segment.name}
                    {segment.lastCount === null
                      ? ""
                      : " · " + segment.lastCount.toLocaleString() + " members"}
                  </option>
                ))}
              </Select>
            )}
          </div>
          <Button asChild variant="outline">
            <Link href="/app/subscribers/segments">Manage segments</Link>
          </Button>
        </div>

        {!segmentId ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            Choose a segment to load measured behavior. No workspace-wide or
            placeholder audience is substituted.
          </p>
        ) : loadingSignal ? (
          <Skeleton className="h-56 w-full" />
        ) : insufficient ? (
          <div
            role="status"
            className="space-y-3 rounded-md border p-4 text-sm"
          >
            <p>
              This segment does not yet have enough qualifying engagement for a
              recommendation.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void pattern.refetch();
                void best.refetch();
              }}
              loading={pattern.isFetching || best.isFetching}
            >
              Check again
            </Button>
          </div>
        ) : failed ? (
          <div
            role="alert"
            className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-emphasis"
          >
            <p>
              The selected segment&apos;s recommendation could not be verified.
              No failed response is shown as missing history.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void pattern.refetch();
                void best.refetch();
              }}
              loading={pattern.isFetching || best.isFetching}
            >
              Retry analysis
            </Button>
          </div>
        ) : pattern.data && best.data ? (
          <div className="space-y-4" aria-live="polite">
            <dl className="grid gap-3 sm:grid-cols-3">
              <TimingMetric
                label="Recommended hour"
                value={
                  String(best.data.bestHourUtc).padStart(2, "0") + ":00 UTC"
                }
                help={selected?.name ?? "Selected segment"}
              />
              <TimingMetric
                label="Model coverage"
                value={(best.data.confidence * 100).toFixed(0) + "%"}
                help="Eligible members with signal"
              />
              <TimingMetric
                label="Measured members"
                value={pattern.data.sampleSize.toLocaleString()}
                help="Pattern sample"
              />
            </dl>
            <WeeklyHeatmap
              pattern={pattern.data}
              title="Weekly segment engagement density"
            />
            <Dialog>
              <DialogTrigger asChild>
                <Button type="button" variant="outline">
                  Review recommendation details
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {selected?.name ?? "Segment"} recommendation
                  </DialogTitle>
                  <DialogDescription>
                    Cached model output for review only. Times are UTC.
                  </DialogDescription>
                </DialogHeader>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <TimingMetric
                    label="Recommended hour"
                    value={
                      String(best.data.bestHourUtc).padStart(2, "0") + ":00 UTC"
                    }
                  />
                  <TimingMetric
                    label="Coverage confidence"
                    value={(best.data.confidence * 100).toFixed(1) + "%"}
                  />
                  <TimingMetric
                    label="Recommendation sample"
                    value={best.data.sampleSize.toLocaleString()}
                  />
                  <TimingMetric
                    label="Pattern sample"
                    value={pattern.data.sampleSize.toLocaleString()}
                  />
                </dl>
                <p className="text-xs text-muted-foreground">
                  Pattern computed{" "}
                  {new Date(pattern.data.computedAt).toLocaleString()}.
                  Recommendation computed{" "}
                  {new Date(best.data.computedAt).toLocaleString()}.
                </p>
              </DialogContent>
            </Dialog>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function SendTimeSubscriberInspector({
  baseKey,
  enabled,
}: IntelligenceProps) {
  const [input, setInput] = useState("");
  const [submittedId, setSubmittedId] = useState("");
  const [inputError, setInputError] = useState("");
  const best = useQuery({
    queryKey: [...baseKey, "subscriber-best", submittedId],
    queryFn: ({ signal }) => getSubscriberSendTimeBest(submittedId, signal),
    enabled: enabled && isSendTimeIdentity(submittedId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const pattern = useQuery({
    queryKey: [...baseKey, "subscriber-pattern", submittedId],
    queryFn: ({ signal }) => getSubscriberSendTimePattern(submittedId, signal),
    enabled: enabled && isSendTimeIdentity(submittedId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  function inspect() {
    const normalized = input.trim().toLowerCase();
    if (!isSendTimeIdentity(normalized)) {
      setInputError(
        "Enter a valid subscriber UUID. Email addresses are not accepted.",
      );
      return;
    }
    setInputError("");
    if (normalized === submittedId) {
      void best.refetch();
      void pattern.refetch();
      return;
    }
    setSubmittedId(normalized);
  }

  const loading = submittedId !== "" && (best.isLoading || pattern.isLoading);
  const cold = isMissingSignal(best.error);
  const bestFailure = best.error && !cold;
  const patternMissing = isMissingSignal(pattern.error);
  const patternFailure = pattern.error && !patternMissing;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subscriber recommendation inspector</CardTitle>
        <CardDescription>
          Inspect one cached recommendation by UUID. The API may return an email
          for desktop compatibility; the web parser drops it before query state
          is created.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            inspect();
          }}
        >
          <Label htmlFor="send-time-subscriber-id">Subscriber UUID</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="send-time-subscriber-id"
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                if (inputError) setInputError("");
              }}
              placeholder="00000000-0000-0000-0000-000000000000"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={inputError ? true : undefined}
              aria-describedby="send-time-subscriber-help"
              disabled={!enabled || loading}
            />
            <Button type="submit" disabled={!enabled || loading}>
              {loading ? "Inspecting…" : "Inspect"}
            </Button>
          </div>
          <p
            id="send-time-subscriber-help"
            role={inputError ? "alert" : undefined}
            className={
              inputError
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {inputError || "Use the internal UUID, not an email address."}
          </p>
        </form>

        {!submittedId ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No subscriber has been inspected. Results stay blank until an
            explicit UUID is submitted.
          </p>
        ) : loading ? (
          <Skeleton className="h-36 w-full" />
        ) : cold ? (
          <div role="status" className="rounded-md border p-4 text-sm">
            No cached individual recommendation exists yet. The model is still
            learning from qualifying engagement for subscriber …
            {submittedId.slice(-8)}.
          </div>
        ) : bestFailure ? (
          <div
            role="alert"
            className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-emphasis"
          >
            <p>
              The subscriber recommendation could not be verified. This is not
              presented as a cold-start result.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void best.refetch()}
              loading={best.isFetching}
            >
              Retry recommendation
            </Button>
          </div>
        ) : best.data ? (
          <div className="space-y-4" aria-live="polite">
            <dl className="grid gap-3 sm:grid-cols-3">
              <TimingMetric
                label="Best weekly window"
                value={hourOfWeekLabel(best.data.bestHourOfWeekUtc)}
              />
              <TimingMetric
                label="Recommendation sample"
                value={best.data.sampleSize.toLocaleString()}
              />
              <TimingMetric
                label="Checked identity"
                value={"…" + submittedId.slice(-8)}
                help="UUID suffix only"
              />
            </dl>
            {pattern.isLoading ? (
              <Skeleton className="h-52 w-full" />
            ) : patternFailure ? (
              <div
                role="alert"
                className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
              >
                <p>
                  The recommendation loaded, but its detailed weekly pattern
                  could not be verified.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void pattern.refetch()}
                  loading={pattern.isFetching}
                >
                  Retry pattern
                </Button>
              </div>
            ) : patternMissing ? (
              <p className="rounded-md border p-3 text-sm text-muted-foreground">
                The recommendation is available, but there is not enough
                detailed signal for a weekly heatmap.
              </p>
            ) : pattern.data ? (
              <WeeklyHeatmap
                pattern={pattern.data}
                title="Subscriber weekly engagement pattern"
              />
            ) : null}
            <p className="text-xs text-muted-foreground">
              Recommendation computed{" "}
              {new Date(best.data.computedAt).toLocaleString()}.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
