// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, BarChart3, Save, Wand2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createVariants,
  evaluateAB,
  getAB,
  setABSettings,
} from "@/lib/abtests-api";
import { getABWeightHistory } from "@/lib/ab-results-api";
import { getCampaign } from "@/lib/campaigns-api";
import {
  assertFreshCampaignWriteAuthority,
  canWriteCampaigns,
} from "@/lib/campaign-write-authority";
import type {
  ABView,
  Variant,
  VariantResult,
  WinnerMetric,
} from "@/lib/abtests-types";
import type { Route } from "next";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AbVariantsEditor,
  defaultAbVariants,
} from "@/components/campaigns/ab-variants-editor";
import { effectiveAuthRole, whoami, whoamiFresh } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import { useTableUrlState } from "@/lib/use-table-url-state";
import { enumParam } from "@/lib/table-url-state";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";

const AB_TABS = ["variants", "settings", "results"] as const;
const tabSchema = { tab: enumParam(AB_TABS, "variants") } as const;

export const CAMPAIGN_AB_ROLLOUT_RELEASE_HOLD =
  "Winner rollout and adaptive traffic redistribution are unavailable until durable campaign scheduling is release-qualified. The web app keeps the initial test at a fixed, full-audience variant split; evaluation may record a winner but never queues another send.";

export const CAMPAIGN_AB_READ_ONLY_MESSAGE =
  "Campaign A/B configuration is read-only for this session. Owner, admin, or editor access outside viewer mode is required to change variants, save evaluation settings, send tests, or record a winner.";

export function CampaignABClient() {
  const queryClient = useQueryClient();
  const params = useParams<{ id: string }>();
  const campaignID = params.id;

  // Bind the active tab to ?tab= so Settings/Results are deep-linkable and Back
  // returns to the prior tab (CAMP-026).
  const { state: tabState, setState: setTabState } =
    useTableUrlState(tabSchema);

  const [view, setView] = useState<ABView | null>(null);
  const observedABView = useRef<ABView | null>(null);
  const [busy, setBusy] = useState(false);
  const [variantsDirty, setVariantsDirty] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [variants, setVariants] = useState<Variant[]>(defaultAbVariants());
  const [winnerMetric, setWinnerMetric] = useState<WinnerMetric>("open_rate");
  const [evaluationWindow, setEvaluationWindow] = useState(24);
  const [actionError, setActionError] = useState<string | null>(null);

  // Prompt before losing unsaved variant/settings edits on navigation (CAMP-027).
  useUnsavedChangesGuard(variantsDirty || settingsDirty);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const canWrite = canWriteCampaigns(meQuery.data);
  const campaignKey = useMemo(
    () => qk.campaign(tenantId, role, campaignID),
    [campaignID, role, tenantId],
  );
  const abKey = useMemo(() => [...campaignKey, "ab"] as const, [campaignKey]);
  const abQuery = useQuery({
    queryKey: abKey,
    queryFn: () => getAB(campaignID),
    enabled: meQuery.isFetched,
    staleTime: STALE.detail,
  });
  const campaignQuery = useQuery({
    queryKey: campaignKey,
    queryFn: () => getCampaign(campaignID),
    enabled: meQuery.isFetched,
    staleTime: STALE.detail,
  });
  const weightHistoryQuery = useQuery({
    queryKey: [...campaignKey, "ab-weight-history"],
    queryFn: () => getABWeightHistory(campaignID),
    enabled: meQuery.isFetched,
    staleTime: STALE.detail,
  });
  // A failed campaign lookup must not read as a campaign with no name.
  const campaignName = campaignQuery.isError
    ? "Campaign (name failed to load)"
    : campaignQuery.data?.name;

  useEffect(() => {
    observedABView.current = null;
    setView(null);
    setVariantsDirty(false);
    setSettingsDirty(false);
    setActionError(null);
  }, [campaignID]);

  const applyABView = useMemo(
    () =>
      (
        next: ABView,
        opts: { syncSettings?: boolean; syncVariants?: boolean } = {},
      ): void => {
        const { syncSettings = true, syncVariants = true } = opts;
        const safeNext: ABView = {
          ...next,
          variants: Array.isArray(next.variants) ? next.variants : [],
          results: Array.isArray(next.results) ? next.results : [],
        };
        setView(safeNext);
        if (syncVariants) {
          // Seed the default two arms when the campaign has none yet, so the
          // displayed A/B always matches what a Save persists (CAMP-028).
          setVariants(
            safeNext.variants.length > 0
              ? safeNext.variants
              : defaultAbVariants(),
          );
        }
        if (syncSettings) {
          const s = next.settings;
          if (s.winner_metric) setWinnerMetric(s.winner_metric);
          if (s.evaluation_window_hours)
            setEvaluationWindow(s.evaluation_window_hours);
        }
      },
    [],
  );

  useEffect(() => {
    // Clearing a dirty flag after a save is not a new server snapshot. Query
    // observers may still expose the pre-save value until their notification
    // arrives; reapplying it here makes successful edits disappear on screen.
    if (!abQuery.data || observedABView.current === abQuery.data) return;
    observedABView.current = abQuery.data;
    applyABView(abQuery.data, {
      syncSettings: !settingsDirty,
      syncVariants: !variantsDirty,
    });
  }, [abQuery.data, settingsDirty, variantsDirty, applyABView]);

  const loading = meQuery.isLoading || (abQuery.isPending && !view);
  const loadError =
    abQuery.error instanceof Error
      ? abQuery.error.message
      : meQuery.error instanceof Error
        ? meQuery.error.message
        : abQuery.isError
          ? "Could not load the A/B setup — this is a failed request, not a campaign without variants."
          : null;

  const error = actionError ?? (!view ? loadError : null);

  function updateVariants(next: Variant[]): void {
    setVariantsDirty(true);
    setVariants(next);
  }

  // Latest editor state, readable after an await. Only the Save buttons are
  // disabled while a request is open — every input stays live — so the
  // operator can and does keep editing mid-save.
  const variantsRef = useRef(variants);
  useEffect(() => {
    variantsRef.current = variants;
  }, [variants]);
  const settingsKey = JSON.stringify([winnerMetric, evaluationWindow]);
  const settingsKeyRef = useRef(settingsKey);
  useEffect(() => {
    settingsKeyRef.current = settingsKey;
  }, [settingsKey]);

  const onSaveVariants = async () => {
    if (!canWrite) {
      setActionError(CAMPAIGN_AB_READ_ONLY_MESSAGE);
      return;
    }
    setBusy(true);
    setActionError(null);
    const sent = variants;
    try {
      const fresh = await whoamiFresh();
      assertFreshCampaignWriteAuthority(meQuery.data, fresh);
      const created = await createVariants(campaignID, variants);
      setView((current) =>
        current ? { ...current, variants: created } : current,
      );
      queryClient.setQueryData<ABView>(abKey, (current) =>
        current ? { ...current, variants: created } : current,
      );
      // Adopt the server's copy, and call the editor clean, only if the
      // operator did not edit while the request was open. Doing it
      // unconditionally reverted their newer variant edits and cleared the
      // dirty flag, so nothing signalled that the edits were gone.
      if (variantsRef.current === sent) {
        setVariants(created);
        setVariantsDirty(false);
      }
      void queryClient.invalidateQueries({
        queryKey: campaignKey,
        exact: false,
      });
      toast.success("Variants saved.");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const onSaveSettings = async () => {
    if (!canWrite) {
      setActionError(CAMPAIGN_AB_READ_ONLY_MESSAGE);
      return;
    }
    setBusy(true);
    setActionError(null);
    const sent = settingsKey;
    try {
      const fresh = await whoamiFresh();
      assertFreshCampaignWriteAuthority(meQuery.data, fresh);
      const next = await setABSettings(campaignID, {
        winner_metric: winnerMetric,
        evaluation_window_hours: evaluationWindow,
        winner_recipients_pct: 0,
        sample_pct: 100,
        bandit_strategy: "fixed",
        explore_floor: 0.1,
        recompute_interval_minutes: 30,
      });
      setView((v) => (v ? { ...v, settings: next } : v));
      queryClient.setQueryData<ABView>(abKey, (current) =>
        current ? { ...current, settings: next } : current,
      );
      // Only call the panel clean if these are still the settings on screen.
      if (settingsKeyRef.current === sent) setSettingsDirty(false);
      void queryClient.invalidateQueries({
        queryKey: campaignKey,
        exact: false,
      });
      toast.success("Settings saved.");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const onEvaluate = async () => {
    if (!canWrite) {
      setActionError(CAMPAIGN_AB_READ_ONLY_MESSAGE);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const fresh = await whoamiFresh();
      assertFreshCampaignWriteAuthority(meQuery.data, fresh);
      const next = await evaluateAB(campaignID);
      applyABView(next);
      queryClient.setQueryData<ABView>(abKey, next);
      setVariantsDirty(false);
      setSettingsDirty(false);
      void queryClient.invalidateQueries({
        queryKey: campaignKey,
        exact: false,
      });
      toast.success("Winner evaluated.");
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Evaluate failed");
    } finally {
      setBusy(false);
    }
  };

  const dirty = variantsDirty || settingsDirty;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6 lg:p-8">
      <Breadcrumb
        items={[
          { label: "Campaigns", href: asRoute("/app/campaigns") },
          ...(campaignName
            ? [
                {
                  label: campaignName,
                  href: asRoute(`/app/campaigns/${campaignID}`) as Route,
                },
              ]
            : []),
          { label: "A/B test" },
        ]}
      />
      <div className="flex items-center gap-3">
        <Button
          asChild
          variant="ghost"
          size="icon"
          aria-label="Back to campaign"
          title="Back to campaign"
        >
          <Link href={`/app/campaigns/${campaignID}`}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="font-display text-xl font-semibold tracking-tight">
            A/B test
          </h1>
          {campaignName ? (
            <p className="break-words text-sm text-muted-foreground">
              {campaignName}
            </p>
          ) : null}
        </div>
      </div>

      {error && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          <span>{error}</span>
          {!view && loadError ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void meQuery.refetch();
                void abQuery.refetch();
              }}
            >
              Retry
            </Button>
          ) : null}
        </div>
      )}

      {meQuery.isSuccess && !canWrite ? (
        <p
          role="note"
          className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground"
        >
          {CAMPAIGN_AB_READ_ONLY_MESSAGE}
        </p>
      ) : null}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-64 rounded-md" />
          <Skeleton className="h-48 w-full rounded-md" />
        </div>
      ) : (
        <Tabs
          value={tabState.tab}
          onValueChange={(value) =>
            setTabState({ tab: value as (typeof AB_TABS)[number] })
          }
        >
          <TabsList aria-label="Campaign experiment section">
            <TabsTrigger value="variants">Variants</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="results">Results</TabsTrigger>
          </TabsList>

          <TabsContent value="variants" className="space-y-4">
            <fieldset disabled={!canWrite || busy} className="space-y-4">
              <legend className="sr-only">Campaign A/B variants</legend>
              <AbVariantsEditor initial={variants} onChange={updateVariants} />
              <div className="flex justify-end">
                <Button
                  onClick={() => void onSaveVariants()}
                  disabled={!canWrite || busy}
                  title={!canWrite ? CAMPAIGN_AB_READ_ONLY_MESSAGE : undefined}
                >
                  <Save className="h-4 w-4" />{" "}
                  {busy ? "Saving…" : "Save variants"}
                </Button>
              </div>
            </fieldset>
          </TabsContent>

          <TabsContent value="settings" className="space-y-4">
            <Card>
              <CardContent className="p-4">
                <fieldset disabled={!canWrite || busy} className="space-y-4">
                  <legend className="sr-only">
                    Campaign A/B evaluation settings
                  </legend>
                  <div className="space-y-1.5">
                    <Label htmlFor="metric">Winner metric</Label>
                    <Select
                      id="metric"
                      value={winnerMetric}
                      onChange={(e) => {
                        setSettingsDirty(true);
                        setWinnerMetric(e.target.value as WinnerMetric);
                      }}
                    >
                      <option value="open_rate">Open rate</option>
                      <option value="click_rate">Click rate</option>
                      <option value="reply_rate">Reply rate</option>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      The metric used to record a winning variant when the
                      decision policy is satisfied.
                    </p>
                  </div>

                  <SliderField
                    id="window"
                    label="Evaluation window"
                    value={evaluationWindow}
                    suffix={`${evaluationWindow} hours`}
                    min={1}
                    max={168}
                    step={1}
                    help="How long after variant delivery the evaluator waits before recording a winner. This never queues another send."
                    onChange={(v) => {
                      setSettingsDirty(true);
                      setEvaluationWindow(v);
                    }}
                  />

                  <div
                    role="note"
                    className="rounded-md border border-warning/30 bg-warning-subtle p-3 text-sm text-warning-emphasis"
                  >
                    <div className="font-medium">
                      Fixed, full-audience experiment only
                    </div>
                    <p className="mt-1 leading-6">
                      {CAMPAIGN_AB_ROLLOUT_RELEASE_HOLD}
                    </p>
                  </div>

                  <div className="flex justify-end">
                    <Button
                      onClick={() => void onSaveSettings()}
                      disabled={!canWrite || busy}
                      title={
                        !canWrite ? CAMPAIGN_AB_READ_ONLY_MESSAGE : undefined
                      }
                    >
                      <Save className="h-4 w-4" />{" "}
                      {busy ? "Saving…" : "Save settings"}
                    </Button>
                  </div>
                </fieldset>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="results" className="space-y-4">
            <div className="flex flex-wrap justify-end gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href={`/app/campaigns/${campaignID}/ab-results`}>
                  <BarChart3 className="h-4 w-4" /> Full statistical report
                </Link>
              </Button>
              <ConfirmDialog
                title="Evaluate the result?"
                description={`This evaluates ${winnerMetric.replace("_", " ")} and records a winner only when the decision policy is satisfied. It does not send messages or create a rollout campaign.${
                  dirty
                    ? " You have unsaved variant/settings edits that will be replaced by the server's result."
                    : ""
                }`}
                confirmLabel="Record evaluation"
                confirmVariant="default"
                onConfirm={onEvaluate}
                trigger={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canWrite || busy}
                    title={
                      !canWrite ? CAMPAIGN_AB_READ_ONLY_MESSAGE : undefined
                    }
                  >
                    <Wand2 className="h-4 w-4" /> Evaluate result
                  </Button>
                }
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Evaluation records statistical evidence only. It does not send the
              winning content or create a follow-up campaign.
            </p>
            {/* Preserve historical rollout references without treating the
                record as proof that delivery completed. New rollout creation
                is held in this deployment. */}
            {view?.settings?.winner_rollout_campaign_id ? (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
                <div className="font-medium">Historical rollout record</div>
                <p className="mt-1 text-muted-foreground">
                  The server retained a child campaign reference from an earlier
                  rollout attempt. This reference alone does not prove that any
                  message was delivered.
                </p>
                <Button asChild variant="outline" size="sm" className="mt-3">
                  <Link
                    href={`/app/campaigns/${view.settings.winner_rollout_campaign_id}`}
                  >
                    View rollout campaign
                  </Link>
                </Button>
              </div>
            ) : null}
            <ResultsGrid view={view} />
            {/* WeightHistory renders nothing for an empty series, so a failed
                fetch would read as "no allocation weights were recorded". */}
            {weightHistoryQuery.isError ? (
              <p className="text-sm text-destructive">
                Could not load the allocation-weight history.
              </p>
            ) : (
              <WeightHistory
                series={
                  Array.isArray(weightHistoryQuery.data?.series)
                    ? weightHistoryQuery.data?.series
                    : []
                }
              />
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function SliderField({
  id,
  label,
  value,
  suffix,
  min,
  max,
  step,
  help,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  suffix: string;
  min: number;
  max: number;
  step: number;
  help: string;
  onChange: (value: number) => void;
}) {
  // `Slider` renders its own input and accepts no `id`, so the previous
  // `<Label htmlFor={id}>` pointed at an element that never existed: clicking
  // the label did nothing and the control had no accessible name at all.
  // Slider names itself from `aria-label` when no `label` prop is passed, and
  // passing `label` here would duplicate the heading this component already
  // draws alongside the suffix.
  return (
    <div id={id} className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="text-xs text-muted-foreground tabular-nums">
          {suffix}
        </span>
      </div>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={onChange}
        aria-label={label}
      />
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );
}

function ResultsGrid({ view }: { view: ABView | null }) {
  const byID = useMemo(() => {
    const m = new Map<string, Variant>();
    if (view) for (const v of view.variants ?? []) if (v.id) m.set(v.id, v);
    return m;
  }, [view]);

  if (!view) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if ((view.results ?? []).length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No results yet — variants need to be sent first.
      </p>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {(view.results ?? []).map((r) => (
        <ResultCard
          key={r.variant_id}
          result={r}
          variant={byID.get(r.variant_id)}
          isWinner={view.winner_variant_id === r.variant_id}
        />
      ))}
    </div>
  );
}

function ResultCard({
  result,
  variant,
  isWinner,
}: {
  result: VariantResult;
  variant?: Variant;
  isWinner: boolean;
}) {
  const n = result.recipients_count;
  const openRate = n > 0 ? (result.opens / n) * 100 : 0;
  const clickRate = n > 0 ? (result.clicks / n) * 100 : 0;
  const ci = wilsonCI(result.opens, n);

  return (
    <Card className={isWinner ? "ring-2 ring-success" : undefined}>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-full bg-foreground text-background text-xs font-semibold">
            {variant?.variant_label ?? "?"}
          </span>
          <span className="font-medium text-sm">
            {variant?.subject || "(no subject)"}
          </span>
          {isWinner && (
            <span className="ml-auto text-xs font-semibold text-success">
              Winner
            </span>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <Stat label="Recipients" value={n.toLocaleString()} />
          <Stat label="Delivered" value={result.delivered.toLocaleString()} />
          <Stat
            label="Open rate"
            value={n > 0 ? `${openRate.toFixed(1)}%` : "—"}
          />
          <Stat
            label="Click rate"
            value={n > 0 ? `${clickRate.toFixed(1)}%` : "—"}
          />
          <Stat label="Unsubs" value={String(result.unsubscribes)} />
          <Stat label="Complaints" value={String(result.complaints)} />
        </dl>
        <p className="text-xs text-muted-foreground">
          {n > 0 ? (
            <>
              Open rate 95% CI: {(ci.lo * 100).toFixed(1)}% –{" "}
              {(ci.hi * 100).toFixed(1)}%
            </>
          ) : (
            "Not enough recipients to estimate an open rate or confidence interval."
          )}
        </p>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </>
  );
}

// Compact multi-series history of server-recorded allocation weights.
function WeightHistory({
  series,
}: {
  series: {
    variant_id: string;
    label: string;
    points: { at: string; weight: number }[];
  }[];
}) {
  // Parse each timestamp once and drop points whose `at` is unparseable.
  // Date.parse returns NaN, and Math.min/Math.max return NaN if ANY argument is
  // NaN — so a single bad timestamp made minAt/maxAt NaN, which made x NaN for
  // every point in every series and blanked the whole chart. (`span`'s `|| 1`
  // hid that rather than containing it, since NaN is falsy.) Now one bad row
  // costs only itself.
  const withPoints = series
    .map((s) => ({
      ...s,
      points: s.points
        .map((p) => ({ at: Date.parse(p.at), weight: p.weight }))
        .filter((p) => Number.isFinite(p.at)),
    }))
    .filter((s) => s.points.length > 1);
  if (withPoints.length === 0) return null;

  const width = 480;
  const height = 120;
  const pad = 8;
  const allAts = withPoints.flatMap((s) => s.points.map((p) => p.at));
  const minAt = Math.min(...allAts);
  const maxAt = Math.max(...allAts);
  const span = maxAt - minAt || 1;
  const colors = [
    "var(--pw-chart-1, #6366f1)",
    "var(--pw-chart-2, #10b981)",
    "#f59e0b",
    "#ef4444",
  ];

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Recorded allocation weights</h3>
          <p className="text-xs text-muted-foreground">
            Stored bandit weights at each recompute. This history does not prove
            that recipient traffic shifted after queue materialization.
          </p>
        </div>
        <div
          tabIndex={0}
          role="group"
          aria-label="Recorded variant allocation weight over time"
          className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-32 w-full min-w-[320px]"
            role="img"
            aria-label="Recorded variant allocation weight over time"
          >
            {withPoints.map((s, i) => {
              const d = s.points
                .map((p, idx) => {
                  const x = pad + ((p.at - minAt) / span) * (width - pad * 2);
                  const y =
                    pad +
                    (1 - Math.min(100, Math.max(0, p.weight)) / 100) *
                      (height - pad * 2);
                  return `${idx === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
                })
                .join(" ");
              return (
                <path
                  key={s.variant_id}
                  d={d}
                  fill="none"
                  stroke={colors[i % colors.length]}
                  strokeWidth={2}
                />
              );
            })}
          </svg>
        </div>
        <div className="flex flex-wrap gap-3 text-xs">
          {withPoints.map((s, i) => (
            <span
              key={s.variant_id}
              className="inline-flex items-center gap-1.5"
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: colors[i % colors.length] }}
              />
              Variant {s.label}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Wilson score interval for a binomial proportion at z=1.96 (95%).
function wilsonCI(x: number, n: number): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 0 };
  const z = 1.96;
  const p = x / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    lo: Math.max(0, (center - margin) / denom),
    hi: Math.min(1, (center + margin) / denom),
  };
}
