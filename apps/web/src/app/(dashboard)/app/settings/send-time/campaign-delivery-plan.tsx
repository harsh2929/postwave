// SPDX-License-Identifier: AGPL-3.0-only
//
// Campaign delivery plan — the per-campaign half of send-time optimization
// (desktop gaps campaigns-108 and campaigns-36).
//
// Desktop's equivalent is components/sendtime/SendTimeScheduling.tsx. There it
// is compiled out entirely: `CAMPAIGN_SCHEDULING_AVAILABLE === false` makes the
// whole panel render a "Delivery changes stay locked" readiness card, so the
// preview never fires either. This web surface goes one step further than
// desktop and runs the READ-ONLY preview, because that half queues nothing:
// the handler is documented "It never writes the schedule into
// campaign_recipient_send_at" (apps/api/internal/send_time_opt/
// schedule_preview.go). The operator gets the answer to "where would my
// audience land?" without any dispatch being created.
//
// The COMMIT half stays withheld. It writes recipient send timestamps, and
// this app holds every scheduling write closed behind
// CAMPAIGN_SCHEDULING_RELEASE_HOLD. The button below is rendered disabled with
// that exact sentence rather than an invented one, and rather than being
// hidden — an operator who came here to schedule deserves to learn why they
// cannot, not to find nothing.
"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarClock, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api";
import {
  CAMPAIGN_SCHEDULING_RELEASE_HOLD,
  listCampaigns,
  type Campaign,
} from "@/lib/campaigns-api";
import { canWriteCampaigns } from "@/lib/campaign-write-authority";
import { STALE } from "@/lib/query-keys";
import {
  previewScheduleByBestTime,
  type SchedulePreview,
  type SendTimeStrategy,
} from "@/lib/send-time-api";
import type { MeResponse } from "@/lib/auth-api";

const DEFAULT_WITHIN_DAYS = 7;
const SCHEDULABLE_STATUSES = new Set(["draft", "scheduled"]);

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function campaignLabel(campaign: Campaign): string {
  return campaign.name || campaign.subject || `Campaign ${campaign.id}`;
}

/** `datetime-local` is local-wall-clock; the server contract is RFC3339. */
function localInputToRfc3339(value: string): string | null {
  if (!value.trim()) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function PreviewHistogram({ preview }: { preview: SchedulePreview }) {
  const peak = preview.distribution.reduce(
    (max, bucket) => (bucket.count > max ? bucket.count : max),
    0,
  );
  return (
    <div className="space-y-2">
      <div
        role="img"
        aria-label="Recipients per hour of day, UTC"
        aria-describedby="send-time-distribution-table"
        tabIndex={0}
        className="flex items-end gap-0.5 overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {preview.distribution.map((bucket) => (
          <div
            key={bucket.hour}
            title={`${bucket.hour}:00 UTC — ${formatCount(bucket.count)} recipients`}
            className="flex min-w-3 flex-1 flex-col items-center gap-1"
          >
            <div
              className="w-full rounded-sm bg-primary"
              style={{
                height: `${peak > 0 ? Math.max(2, (bucket.count / peak) * 56) : 2}px`,
                opacity: bucket.count > 0 ? 1 : 0.15,
              }}
            />
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {bucket.hour % 6 === 0 ? bucket.hour : ""}
            </span>
          </div>
        ))}
      </div>
      {/* The histogram is decorative to a screen reader; the table is the
          accessible copy of the same numbers rather than a summary of them. */}
      <table id="send-time-distribution-table" className="sr-only">
        <caption>Recipients per hour of day in UTC</caption>
        <thead>
          <tr>
            <th scope="col">Hour (UTC)</th>
            <th scope="col">Recipients</th>
          </tr>
        </thead>
        <tbody>
          {preview.distribution.map((bucket) => (
            <tr key={bucket.hour}>
              <th scope="row">{bucket.hour}:00</th>
              <td>{bucket.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CampaignDeliveryPlan({
  identity,
  baseKey,
}: {
  identity: MeResponse;
  baseKey: readonly unknown[];
}) {
  const canWrite = canWriteCampaigns(identity);
  const [campaignId, setCampaignId] = useState("");
  const [strategy, setStrategy] = useState<SendTimeStrategy>("per_recipient");
  const [referenceAt, setReferenceAt] = useState("");
  const [withinDays, setWithinDays] = useState(DEFAULT_WITHIN_DAYS);
  const [formError, setFormError] = useState<string | null>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);

  const campaigns = useQuery({
    queryKey: [...baseKey, "schedulable-campaigns"],
    queryFn: ({ signal }) => listCampaigns({ limit: 100 }, { signal }),
    enabled: canWrite,
    staleTime: STALE.list,
  });

  const eligible = useMemo(
    () =>
      (Array.isArray(campaigns.data) ? campaigns.data : []).filter((campaign) =>
        SCHEDULABLE_STATUSES.has(campaign.status),
      ),
    [campaigns.data],
  );

  const preview = useMutation({
    mutationFn: (input: {
      campaignId: string;
      strategy: SendTimeStrategy;
      withinDays: number;
      referenceAt: string;
    }) =>
      previewScheduleByBestTime(input.campaignId, {
        strategy: input.strategy,
        withinDays: input.withinDays,
        referenceAt: input.referenceAt,
      }),
    onSettled: () => outcomeRef.current?.focus(),
  });

  // A preview describes the form state that produced it. Once any input moves,
  // the numbers on screen are about a different question — so the result is
  // dropped rather than left sitting under a changed form.
  function resetPreview(): void {
    setFormError(null);
    if (preview.data || preview.error) preview.reset();
  }

  function runPreview(): void {
    setFormError(null);
    if (!campaignId) {
      setFormError("Choose a campaign to preview.");
      return;
    }
    const reference = localInputToRfc3339(referenceAt);
    if (reference === null) {
      setFormError("The reference time is not a valid date and time.");
      return;
    }
    preview.mutate({
      campaignId,
      strategy,
      withinDays,
      referenceAt: reference,
    });
  }

  const result = preview.data ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Campaign delivery plan</CardTitle>
        <CardDescription>
          Dry-run the schedule a best-send-time run would produce for one
          campaign. The preview reads your audience and writes nothing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!canWrite ? (
          <p className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
            Your role can read send-time analysis but cannot preview or change a
            campaign&apos;s delivery plan. Owner, admin, or editor access
            outside viewer mode is required.
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="send-time-campaign">Eligible campaign</Label>
                <Select
                  id="send-time-campaign"
                  value={campaignId}
                  disabled={campaigns.isPending || campaigns.isError}
                  onChange={(event) => {
                    setCampaignId(event.target.value);
                    resetPreview();
                  }}
                >
                  <option value="">
                    {campaigns.isPending
                      ? "Loading campaigns…"
                      : eligible.length === 0
                        ? "No draft or scheduled campaigns"
                        : "Choose a campaign…"}
                  </option>
                  {eligible.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaignLabel(campaign)}
                    </option>
                  ))}
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="send-time-within-days">
                  Search window (days)
                </Label>
                <Input
                  id="send-time-within-days"
                  type="number"
                  min={7}
                  max={30}
                  value={withinDays}
                  onChange={(event) => {
                    setWithinDays(Number(event.target.value));
                    resetPreview();
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Between 7 and 30 days. Each recipient is placed at their best
                  hour inside this window.
                </p>
              </div>

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">
                  Optimization strategy
                </legend>
                {(
                  [
                    [
                      "per_recipient",
                      "Per recipient",
                      "Each recipient's own window, with a cold-start fallback.",
                    ],
                    [
                      "modal_hour",
                      "One audience window",
                      "The most common window, used for every recipient.",
                    ],
                  ] as const
                ).map(([value, title, hint]) => (
                  <label
                    key={value}
                    htmlFor={`send-time-strategy-${value}`}
                    className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3"
                  >
                    <input
                      id={`send-time-strategy-${value}`}
                      type="radio"
                      name="send_time_strategy"
                      className="mt-1"
                      checked={strategy === value}
                      onChange={() => {
                        setStrategy(value);
                        resetPreview();
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {hint}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <div className="space-y-2">
                <Label htmlFor="send-time-reference">
                  Start searching after
                </Label>
                <Input
                  id="send-time-reference"
                  type="datetime-local"
                  value={referenceAt}
                  onChange={(event) => {
                    setReferenceAt(event.target.value);
                    resetPreview();
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Blank starts from the server&apos;s current time.
                </p>
              </div>
            </div>

            {campaigns.isError ? (
              <div
                role="alert"
                className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
              >
                <p>
                  Campaigns could not be loaded, so no campaign is being
                  presented as ineligible.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  loading={campaigns.isFetching}
                  onClick={() => void campaigns.refetch()}
                >
                  Retry campaigns
                </Button>
              </div>
            ) : null}

            {formError ? (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            ) : null}

            <Button
              type="button"
              loading={preview.isPending}
              onClick={runPreview}
            >
              <CalendarClock aria-hidden />
              Preview schedule
            </Button>

            <div
              ref={outcomeRef}
              tabIndex={-1}
              className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {preview.isPending ? (
                <Skeleton className="h-32 w-full" />
              ) : preview.isError ? (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
                >
                  {apiErrorMessage(
                    preview.error,
                    "The delivery preview could not be computed. Nothing was scheduled.",
                  )}
                </div>
              ) : result ? (
                <div className="space-y-3 rounded-md border p-4">
                  <p className="text-sm">
                    <span className="font-medium">
                      {formatCount(result.scheduled)}
                    </span>{" "}
                    recipients would be placed across{" "}
                    {formatCount(result.withinDays)} days, starting after{" "}
                    <time dateTime={result.referenceAt}>
                      {new Date(result.referenceAt).toLocaleString()}
                    </time>
                    . Cold recipients fall back to {result.tenantMean}:00 UTC.
                  </p>
                  <PreviewHistogram preview={result} />
                  <ul className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                    <li>
                      Busiest minute: {formatCount(result.maxPerMinute)}{" "}
                      recipients
                    </li>
                    <li>
                      Busiest day: {formatCount(result.maxPerDay)} recipients
                      {result.peakDayUtc ? ` on ${result.peakDayUtc}` : ""}
                    </li>
                  </ul>
                  {result.truncated ? (
                    <p
                      role="alert"
                      className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm"
                    >
                      This audience exceeds the safe scheduling load of{" "}
                      {formatCount(result.hardCap)} recipients, so the preview
                      covers only part of it.
                    </p>
                  ) : null}
                  {result.warmupCapBreach ? (
                    <p
                      role="alert"
                      className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm"
                    >
                      The busiest day exceeds today&apos;s warmup cap of{" "}
                      {formatCount(result.tierCapToday)}. Split the campaign or
                      widen the search window.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        )}

        <div
          className="rounded-md border border-warning/30 bg-warning/5 p-4 text-sm leading-relaxed"
          role="note"
        >
          <p className="flex items-center gap-2 font-medium">
            <Lock aria-hidden className="size-4" />
            Activation stays held
          </p>
          <p className="mt-1 text-muted-foreground">
            {CAMPAIGN_SCHEDULING_RELEASE_HOLD}
          </p>
          <p className="mt-2 text-muted-foreground">
            The same hold covers the per-campaign personalized send window
            (per-recipient optimization with a start and end time). Neither a
            durable best-time schedule nor a personalized window can be stored
            from this app while it applies.
          </p>
          <Button
            type="button"
            className="mt-3"
            disabled
            aria-describedby="send-time-activation-hold"
          >
            Confirm durable schedule
          </Button>
          <span id="send-time-activation-hold" className="sr-only">
            {CAMPAIGN_SCHEDULING_RELEASE_HOLD}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
