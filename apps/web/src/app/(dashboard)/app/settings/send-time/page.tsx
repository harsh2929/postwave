// SPDX-License-Identifier: AGPL-3.0-only
//
// Workspace send-time-optimization governance toggle. Web previously showed
// STO read-only in reports; this is the parity control desktop has (gap A24).
"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/relative-time";
import { ApiError } from "@/lib/api";
import { listAuditLog } from "@/lib/audit-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";
import {
  getBestTimeAnalysis,
  sendTimeOptimizationApi,
  type StoAnalysisBucket,
} from "@/lib/send-time-api";
import { sendingSettingsApi } from "@/lib/sending-settings-api";
import { useAdminGate } from "@/lib/use-admin-gate";
import { AdminGateNotice } from "@/components/admin-gate-notice";
import Link from "next/link";

// The audience/subscriber intelligence panels and the campaign delivery plan
// sit below the policy toggle and its heatmap; they load after first paint so
// the route's eager chunk stays inside the bundle budget.
const SendTimeAudienceIntelligence = dynamic(
  () =>
    import("./send-time-intelligence-panels").then(
      (m) => m.SendTimeAudienceIntelligence,
    ),
  { loading: () => <Skeleton className="h-56 w-full" /> },
);
const SendTimeSubscriberInspector = dynamic(
  () =>
    import("./send-time-intelligence-panels").then(
      (m) => m.SendTimeSubscriberInspector,
    ),
  { loading: () => <Skeleton className="h-56 w-full" /> },
);
const CampaignDeliveryPlan = dynamic(
  () => import("./campaign-delivery-plan").then((m) => m.CampaignDeliveryPlan),
  { loading: () => <Skeleton className="h-56 w-full" /> },
);

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// SETA-041: STO behavior preview — a 7×24 engagement-by-hour heatmap (cell
// intensity ∝ the engine's per-bucket score) plus the best-window summary, so
// operators can see what STO will do instead of just an on/off switch.
function StoPreviewCard({
  baseKey,
  enabled,
}: {
  baseKey: readonly unknown[];
  enabled: boolean;
}) {
  const analysis = useQuery({
    queryKey: [...baseKey, "workspace-analysis"],
    queryFn: ({ signal }) => getBestTimeAnalysis(90, signal),
    enabled,
    staleTime: STALE.reference,
  });
  const outcomeRef = useRef<HTMLDivElement>(null);
  const focusAfterRetryRef = useRef(false);
  const heatmapSummaryId = useId();

  useEffect(() => {
    if (focusAfterRetryRef.current && !analysis.isFetching) {
      focusAfterRetryRef.current = false;
      outcomeRef.current?.focus();
    }
  }, [analysis.isFetching]);

  const byCell = useMemo(() => {
    const map = new Map<number, StoAnalysisBucket>();
    let max = 0;
    for (const b of Array.isArray(analysis.data?.heatmap)
      ? analysis.data.heatmap
      : []) {
      map.set(b.day_of_week * 24 + b.hour_utc, b);
      if (b.score > max) max = b.score;
    }
    return { map, max };
  }, [analysis.data]);

  const nonEmptyBuckets = useMemo(
    () =>
      (Array.isArray(analysis.data?.heatmap) ? analysis.data.heatmap : [])
        .filter((bucket) => bucket.sent > 0)
        .sort(
          (left, right) =>
            left.day_of_week - right.day_of_week ||
            left.hour_utc - right.hour_utc,
        ),
    [analysis.data],
  );
  const bestBuckets = useMemo(() => {
    const supplied = Array.isArray(analysis.data?.top_buckets)
      ? analysis.data.top_buckets.filter((bucket) => bucket.sent > 0)
      : [];
    return (
      supplied.length > 0
        ? supplied
        : [...nonEmptyBuckets].sort(
            (left, right) =>
              right.score - left.score || right.open_rate - left.open_rate,
          )
    ).slice(0, 3);
  }, [analysis.data, nonEmptyBuckets]);
  const hasData = nonEmptyBuckets.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>When your audience engages</CardTitle>
        <CardDescription>
          Opens/clicks by hour (UTC) over the last{" "}
          {analysis.data?.lookback_days ?? 90} days. Send-time optimization aims
          each recipient at their own best window; darker cells are stronger.
        </CardDescription>
      </CardHeader>
      <CardContent
        ref={outcomeRef}
        tabIndex={-1}
        className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {analysis.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : analysis.isError ? (
          <div
            role="alert"
            className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
          >
            <p>
              Engagement analysis could not be loaded. No missing data is being
              presented as an empty history.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                focusAfterRetryRef.current = true;
                void analysis.refetch();
              }}
              loading={analysis.isFetching}
            >
              Retry analysis
            </Button>
          </div>
        ) : !hasData ? (
          <p className="text-sm text-muted-foreground">
            Not enough send history yet. Once campaigns accumulate opens, the
            best-time heatmap appears here.
          </p>
        ) : (
          <div className="space-y-4">
            <div
              tabIndex={0}
              role="img"
              aria-label="Engagement heatmap by hour of week"
              aria-describedby={heatmapSummaryId}
              className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="inline-grid grid-cols-[auto_repeat(24,minmax(0,1fr))] gap-0.5 text-[10px] text-muted-foreground">
                <div />
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="text-center tabular-nums">
                    {h % 6 === 0 ? h : ""}
                  </div>
                ))}
                {DAY_LABELS.map((label, day) => (
                  <div key={label} className="contents">
                    <div className="pr-1 text-right leading-4">{label}</div>
                    {Array.from({ length: 24 }, (_, hour) => {
                      const cell = byCell.map.get(day * 24 + hour);
                      const intensity = cell
                        ? cell.score / (byCell.max || 1)
                        : 0;
                      return (
                        <div
                          key={hour}
                          title={
                            cell
                              ? `${label} ${hour}:00 UTC — ${(cell.open_rate * 100).toFixed(0)}% open (${cell.sent} sent)`
                              : `${label} ${hour}:00 UTC — no data`
                          }
                          className="h-4 rounded-[2px] border border-border/40 bg-primary"
                          style={{ opacity: 0.06 + intensity * 0.94 }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            <div id={heatmapSummaryId} className="sr-only">
              <p>
                Engagement was recorded in {nonEmptyBuckets.length} hourly
                window{nonEmptyBuckets.length === 1 ? "" : "s"}. The strongest
                recorded window is{" "}
                {DAY_LABELS[bestBuckets[0]?.day_of_week] ?? "an unknown day"}{" "}
                {bestBuckets[0]?.hour_utc ?? "an unknown"}
                :00 UTC at {((bestBuckets[0]?.open_rate ?? 0) * 100).toFixed(0)}
                % opens.
              </p>
              <table>
                <caption>Hourly engagement data in UTC</caption>
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Hour</th>
                    <th scope="col">Sent</th>
                    <th scope="col">Open rate</th>
                    <th scope="col">Click rate</th>
                  </tr>
                </thead>
                <tbody>
                  {nonEmptyBuckets.map((bucket) => (
                    <tr key={`${bucket.day_of_week}:${bucket.hour_utc}`}>
                      <th scope="row">
                        {DAY_LABELS[bucket.day_of_week] ?? "Unknown"}
                      </th>
                      <td>{bucket.hour_utc}:00</td>
                      <td>{bucket.sent}</td>
                      <td>{(bucket.open_rate * 100).toFixed(0)}%</td>
                      <td>{(bucket.click_rate * 100).toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {bestBuckets.length > 0 ? (
              <div className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  Best windows:
                </span>{" "}
                {bestBuckets
                  .map(
                    (b) =>
                      `${DAY_LABELS[b.day_of_week] ?? "?"} ${b.hour_utc}:00 UTC (${(b.open_rate * 100).toFixed(0)}% open)`,
                  )
                  .join(" · ")}
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// SETA-041 (gap 2): surface the quiet-hours window STO respects, with a link
// to edit it in Sender settings (SETC-012 owns the editor). Read-only here so
// the STO admin sees the guardrail without duplicating the editor.
function QuietHoursNote({
  baseKey,
  enabled,
}: {
  baseKey: readonly unknown[];
  enabled: boolean;
}) {
  const settings = useQuery({
    queryKey: [...baseKey, "quiet-hours"],
    queryFn: () => sendingSettingsApi.get(),
    enabled,
    staleTime: STALE.reference,
  });
  const outcomeRef = useRef<HTMLDivElement>(null);
  const focusAfterRetryRef = useRef(false);
  useEffect(() => {
    if (focusAfterRetryRef.current && !settings.isFetching) {
      focusAfterRetryRef.current = false;
      outcomeRef.current?.focus();
    }
  }, [settings.isFetching]);
  const s = settings.data;
  const hasWindow = !!(s?.quiet_hours_start && s?.quiet_hours_end);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quiet hours</CardTitle>
        <CardDescription>
          Sends are held during this window (per recipient timezone when
          enabled). Send-time optimization never schedules inside it.
        </CardDescription>
      </CardHeader>
      <CardContent
        ref={outcomeRef}
        tabIndex={-1}
        className="text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {settings.isLoading ? (
          <Skeleton className="h-6 w-48" />
        ) : settings.isError ? (
          // A failed load leaves hasWindow false, which would otherwise print
          // "No quiet-hours window set." — indistinguishable from a workspace
          // that genuinely has none, on a guardrail operators rely on.
          <div
            role="alert"
            className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive-emphasis"
          >
            <p>
              Could not load your quiet-hours window. The guardrail state is
              unknown, not unset.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                focusAfterRetryRef.current = true;
                void settings.refetch();
              }}
              loading={settings.isFetching}
            >
              Retry quiet hours
            </Button>
          </div>
        ) : hasWindow ? (
          <p>
            <span className="font-medium">
              {s?.quiet_hours_start}–{s?.quiet_hours_end}
            </span>{" "}
            <span className="text-muted-foreground">
              {s?.quiet_hours_tz ? `(${s.quiet_hours_tz})` : ""}
              {s?.quiet_hours_per_recipient ? " · per-recipient timezone" : ""}
            </span>{" "}
            <Link
              href="/app/settings/sender"
              className="inline-flex min-h-11 items-center text-primary underline-offset-2 hover:underline sm:min-h-0"
            >
              Edit
            </Link>
            {typeof s?.fallback_hour_utc === "number" ? (
              <span className="mt-1 block text-muted-foreground">
                Cold-start fallback: {s.fallback_hour_utc}:00 UTC for recipients
                with no history.
              </span>
            ) : null}
          </p>
        ) : (
          <p className="text-muted-foreground">
            No quiet-hours window set.{" "}
            <Link
              href="/app/settings/sender"
              className="inline-flex min-h-11 items-center text-primary underline-offset-2 hover:underline sm:min-h-0"
            >
              Set one in Sender settings
            </Link>
            .
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function SendTimeSettingsPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const mountedRef = useRef(false);
  const loadInFlightRef = useRef(false);
  const savingRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusToggleAfterRetryRef = useRef(false);
  // Server gates the write to workspace admins/owners; mirror that in the UI
  // so a non-admin sees the current value read-only instead of a switch that
  // would 403.
  const adminGate = useAdminGate();
  const { canWrite, loading: roleLoading } = adminGate;

  // Attribution for this workspace-wide governance toggle (SETA-052): the most
  // recent audit event for the STO setting change.
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const attributionKey = useMemo(
    () => qk.settings(tenantId, role, "send-time-attribution"),
    [role, tenantId],
  );
  const sendTimeBase = useMemo(
    () => qk.settings(tenantId, role, "send-time-intelligence"),
    [role, tenantId],
  );
  const attributionQuery = useQuery({
    queryKey: attributionKey,
    queryFn: () => listAuditLog({ action: "send_time_optimization", limit: 1 }),
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });
  const lastChange = attributionQuery.data?.rows[0] ?? null;

  const loadSetting = useCallback(async () => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await sendTimeOptimizationApi.get();
      if (typeof response.enabled !== "boolean") {
        throw new Error("The setting response did not include a valid state.");
      }
      if (mountedRef.current) setEnabled(response.enabled);
    } catch (cause) {
      if (mountedRef.current) {
        setEnabled(null);
        setLoadError(
          cause instanceof Error
            ? cause.message
            : "The setting could not be loaded.",
        );
      }
    } finally {
      loadInFlightRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadSetting();
    return () => {
      mountedRef.current = false;
    };
  }, [loadSetting]);

  useEffect(() => {
    if (loadError || saveError) errorRef.current?.focus();
  }, [loadError, saveError]);

  useEffect(() => {
    if (!loading && enabled !== null && focusToggleAfterRetryRef.current) {
      focusToggleAfterRetryRef.current = false;
      toggleRef.current?.focus();
    }
  }, [enabled, loading]);

  async function onToggle(next: boolean) {
    if (savingRef.current || enabled === null) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    // Optimistic flip; revert on failure.
    const prev = enabled;
    setEnabled(next);
    try {
      const res = await sendTimeOptimizationApi.set(next);
      if (typeof res.enabled !== "boolean") {
        throw new Error("The saved setting response was invalid.");
      }
      setEnabled(res.enabled);
      void attributionQuery.refetch();
      toast.success(
        res.enabled
          ? "Send-time optimization enabled"
          : "Send-time optimization disabled",
      );
    } catch (e) {
      setEnabled(prev ?? null);
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
        setSaveError("Only workspace admins can change this setting.");
      } else {
        setSaveError(
          e instanceof Error ? e.message : "The setting could not be saved.",
        );
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const isOn = enabled === true;

  return (
    <div className="max-w-5xl space-y-6">
      <header>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          Send-time optimization
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Let Moosewave choose each recipient&apos;s best send time based on
          their past engagement, instead of sending everyone at once.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Workspace default</CardTitle>
          <CardDescription>
            Applies as the default for new campaigns across this workspace.
            Every operator and device sees the same setting.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-14 w-full" />
          ) : enabled === null ? (
            <div
              ref={errorRef}
              role="alert"
              tabIndex={-1}
              className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <p>
                {loadError ??
                  "The current workspace setting could not be verified."}{" "}
                It will not be overwritten with a guessed value.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  focusToggleAfterRetryRef.current = true;
                  void loadSetting();
                }}
              >
                Retry setting
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-md border px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  Optimize send times automatically
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {isOn ? "Currently enabled" : "Currently disabled"}
                </div>
              </div>
              <button
                ref={toggleRef}
                type="button"
                role="switch"
                aria-checked={isOn}
                aria-label="Toggle send-time optimization"
                disabled={saving || forbidden || roleLoading || !canWrite}
                onClick={() => void onToggle(!isOn)}
                className={[
                  "relative inline-flex size-11 shrink-0 items-center justify-center rounded-md",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                ].join(" ")}
              >
                <span
                  className={[
                    "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                    isOn ? "bg-primary" : "bg-muted-foreground/30",
                  ].join(" ")}
                  aria-hidden
                >
                  <span
                    className={[
                      "inline-block h-5 w-5 transform rounded-full bg-background shadow transition-transform",
                      isOn ? "translate-x-5" : "translate-x-0.5",
                    ].join(" ")}
                  />
                </span>
              </button>
            </div>
          )}
          {lastChange ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Last changed by{" "}
              <span className="font-medium text-foreground">
                {lastChange.actorLabel || lastChange.actorType}
              </span>{" "}
              <RelativeTime iso={lastChange.at} />.
            </p>
          ) : attributionQuery.isError ? (
            // Rendering nothing on failure reads as "never changed"; say the
            // attribution lookup failed instead.
            <p className="mt-3 text-xs text-destructive" role="alert">
              Could not load who last changed this setting.
            </p>
          ) : null}
          {!loading ? (
            <AdminGateNotice
              gate={adminGate}
              className="mt-3"
              readOnlyMessage="You have read-only access. Only workspace admins can change this setting."
            />
          ) : null}
          {saveError && (
            <div
              ref={errorRef}
              className="mt-3 text-sm text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring"
              role="alert"
              tabIndex={-1}
            >
              {saveError}
            </div>
          )}
        </CardContent>
      </Card>

      {meQuery.isPending ? (
        <Skeleton className="h-56 w-full" />
      ) : meQuery.isError ? (
        <Card>
          <CardContent className="pt-6">
            <div
              role="alert"
              className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive-emphasis"
            >
              <p>
                Your workspace identity could not be verified, so tenant-scoped
                send-time analysis has not been requested.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void meQuery.refetch()}
                loading={meQuery.isFetching}
              >
                Retry workspace identity
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <StoPreviewCard baseKey={sendTimeBase} enabled />
          <SendTimeAudienceIntelligence baseKey={sendTimeBase} enabled />
          <SendTimeSubscriberInspector baseKey={sendTimeBase} enabled />
          {meQuery.data ? (
            <CampaignDeliveryPlan
              identity={meQuery.data}
              baseKey={sendTimeBase}
            />
          ) : null}
          <QuietHoursNote baseKey={sendTimeBase} enabled />
        </>
      )}

      <p className="text-xs text-muted-foreground">
        New campaigns created while this is enabled receive a 24-hour
        personalized send window. Existing campaigns keep their current timing
        configuration.
      </p>

      {forbidden && (
        <Button variant="outline" size="sm" onClick={() => location.reload()}>
          Reload
        </Button>
      )}
    </div>
  );
}
