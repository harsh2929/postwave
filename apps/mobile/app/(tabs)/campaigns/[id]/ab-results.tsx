/**
 * A/B Results reader (mobile).
 *
 * Mirrors the desktop's `/api/v1/campaigns/{id}/ab-results` reader: a metric
 * switcher (open / click / reply) at the top, the WinnerBanner, one
 * ResultsCard per variant, and a pairwise significance list showing the
 * Bonferroni-corrected frequentist test alongside the Bayesian P(B > control).
 *
 * Fixed here:
 *  - SWITCHING METRIC NO LONGER DESTROYS THE COMPARISON. The query key
 *    includes `metric`, so tapping "Click rate" made isLoading true and
 *    unmounted the banner, every card and the pairwise block behind a bare
 *    spinner — the comparison was destroyed by the act of comparing.
 *    keepPreviousData holds the numbers and dims them while they refine.
 *  - THE SCREEN NAMES ITS CAMPAIGN. Arriving from a push, a deep link, or the
 *    A/B hand-off, nothing identified which test you were reading; the variant
 *    labels are "Variant 1/2/3". Back now returns to that campaign's detail.
 *  - NO RAW ERROR TEXT, matching the app's own stated policy.
 *
 * Honest fallback: 404 / 405 / 501 from the gateway renders an EmptyState
 * with copy matching the desktop muted notice — this deployment hasn't
 * enabled the engagement reader yet.
 */
import { useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { evaluateAB, getABView } from "@/api/abSettings";
import {
  getABResults,
  type ABMetric,
  type ABResultsResponse,
} from "@/api/abTests";
import {
  ABMetricBar,
  abMetricLabel,
} from "@/components/abtest/ABMetricBar";
import { ABSettingsSheet } from "@/components/abtest/ABSettingsSheet";
import { ABResultsBody } from "@/components/abtest/ABResultsBody";
import {
  CachedSessionNotice,
  cachedSessionNotice,
} from "@/components/CachedSessionNotice";
import { EmptyState } from "@/components/EmptyState";
import { useConfirm } from "@/components/ConfirmSheet";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonCard } from "@/components/Skeleton";
import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import { useToast } from "@/components/Toast";
import { useCampaignAccess } from "@/hooks/useCampaignAccess";
import { useCampaign } from "@/hooks/useCampaigns";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { abSettingsFrom } from "@/lib/abSettings";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import { useMotion } from "@/lib/motion";
import { goBackOr } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";

/** Contain a render failure to this route instead of the whole app. */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

/**
 * Narrows an unknown 200 body to a usable ABResultsResponse: it must be an
 * object whose required collections are actually present and the right type.
 * Guards against a gateway returning `{}`, a text/HTML page (string), or a
 * partial payload — any of which would otherwise crash the render.
 */
function isValidResult(
  r: ABResultsResponse | null | undefined,
): r is ABResultsResponse {
  return (
    typeof r === "object" &&
    r !== null &&
    Array.isArray(r.variants) &&
    typeof r.frequentist === "object" &&
    r.frequentist !== null &&
    typeof r.bayesian === "object" &&
    r.bayesian !== null &&
    typeof r.bonferroni === "object" &&
    r.bonferroni !== null &&
    typeof r.bonferroni.corrected_alpha === "number"
  );
}

export default function ABResults() {
  useScreenViewed("campaign-ab-results");
  const { t } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const onlineGate = useOnlineQueryGate();
  const abGateNotice = cachedSessionNotice({
    gateEnabled: onlineGate.enabled,
    hasTenant: Boolean(onlineGate.tenantId),
    surface: "abResults",
  });
  const [metric, setMetric] = useState<ABMetric>("open_rate");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { toast } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const access = useCampaignAccess({ sessionUsable: !abGateNotice });

  const q = useQuery({
    queryKey: ["ab-results", onlineGate.tenantId, id, metric],
    queryFn: () => getABResults(id ?? "", metric),
    enabled: onlineGate.enabled && Boolean(onlineGate.tenantId && id),
    placeholderData: keepPreviousData,
  });

  // The detail screen's cache is usually warm, so this names the test without
  // a second round trip in the common case.
  const camp = useCampaign(id);

  // The test's own CONFIGURATION (winner metric, evaluation window, winner
  // share) plus the ability to force a decision — all reachable on desktop and
  // on none of them here, so a phone could watch a test and never act on it.
  const view = useQuery({
    queryKey: ["ab-view", onlineGate.tenantId, id],
    queryFn: () => getABView(id ?? ""),
    enabled: onlineGate.enabled && Boolean(onlineGate.tenantId && id),
  });
  const settings = useMemo(
    () => abSettingsFrom(view.data?.settings),
    [view.data?.settings],
  );
  const evaluate = useMutation({
    mutationFn: () => evaluateAB(id ?? ""),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ab-view"] });
      void queryClient.invalidateQueries({ queryKey: ["ab-results"] });
      toast({ kind: "success", message: "Evaluation run — results refreshed." });
    },
    onError: (err: unknown) =>
      toast({
        kind: "error",
        message: campaignErrorMessage(err, "Couldn't run the evaluation."),
      }),
  });

  /**
   * Evaluating is NOT a refresh, and the one-tap button said it was.
   *
   * `POST /ab/evaluate` persists a look against a FIXED alpha-spending budget
   * (`Repo.RecordWinnerLook`, abtests/handlers.go:339) — the Go comment names
   * the exact abuse this guards: "anyone unhappy with 'no winner yet' could
   * re-POST until noise cleared the bar". The spend cannot be given back, and
   * if the pass decides, `MarkWinner` fixes which subject line the rest of the
   * audience receives. There is no undo for either half, so the tap gets a
   * confirm that names both.
   */
  const onEvaluate = async () => {
    if (evaluate.isPending) return;
    const ok = await confirm({
      title: "Run an evaluation now?",
      message:
        "This asks the server to test the variants against each other immediately, instead of waiting for the next scheduled check.",
      consequence:
        "It spends one of this test's fixed significance looks, which cannot be given back — and if a winner is decided, the remaining audience receives that variant.",
      confirmLabel: "Evaluate",
      cancelLabel: "Not yet",
    });
    if (!ok) return;
    evaluate.mutate();
  };

  // `refreshing={q.isFetching}` spun on every BACKGROUND fetch — and this
  // screen refetches whenever the metric chip changes, so switching from Open
  // rate to Click rate drove the refresh spinner as if the operator had pulled.
  // The shared hook binds it to the gesture and confirms completion with a tick.
  const refetchResults = q.refetch;
  const refetchView = view.refetch;
  const refresh = useManualRefresh([refetchResults, refetchView], {
    enabled: !abGateNotice,
  });

  // Changing the winner metric re-fetches and re-lays out every variant row,
  // the winner callout and the chart above them at once. Reduce Motion is
  // carried by `animateLayout` itself, so this cannot forget to honour it.
  const { animateLayout } = useMotion();
  const changeMetric = (next: ABMetric) => {
    animateLayout("enter");
    setMetric(next);
  };

  const rawResult = q.data?.data;
  const result = isValidResult(rawResult) ? rawResult : undefined;
  const fetchErr = q.data?.error;
  const unavailable =
    fetchErr != null &&
    (fetchErr.status === 404 ||
      fetchErr.status === 405 ||
      fetchErr.status === 501);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="A/B Results"
        subtitle={camp.data?.name ?? camp.data?.subject}
        onBack={() =>
          id
            ? goBackOr({ pathname: "/(tabs)/campaigns/[id]", params: { id } })
            : goBackOr("/(tabs)/campaigns")
        }
      />

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={!abGateNotice}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        <ABMetricBar
          metric={metric}
          onChange={changeMetric}
          {...(id ? { onOpenSettings: () => setSettingsOpen(true) } : {})}
        />

        {id && result ? (
          <View style={{ marginTop: 12, alignItems: "flex-start" }}>
            <ActionButton
              label={evaluate.isPending ? "Evaluating…" : "Evaluate now"}
              onPress={() => void onEvaluate()}
              disabled={evaluate.isPending || !access.canMutate}
            />
          </View>
        ) : null}

        {abGateNotice && result ? (
          <CachedSessionNotice
            notice={abGateNotice}
            variant="stale"
            style={{ marginTop: 12 }}
          />
        ) : null}

        <View style={{ marginTop: 16 }}>
          <ABResultsState
            hasId={Boolean(id)}
            campaignId={id ?? ""}
            loading={q.isLoading}
            unavailable={unavailable}
            gateNotice={abGateNotice}
            result={result}
            error={fetchErr ?? q.error}
            metricLabel={abMetricLabel(metric)}
            refining={q.isFetching}
          />
        </View>
      </ScrollView>

      {id ? (
        <ABSettingsSheet
          visible={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          campaignId={id}
          initial={settings}
          canMutate={access.canMutate}
          blockedReason={access.notice}
        />
      ) : null}
    </SafeAreaView>
  );
}

/**
 * The state ladder, in the one order that is correct: no id → skeleton →
 * endpoint-absent → offline → load failure → no variants → results.
 */
function ABResultsState({
  hasId,
  campaignId,
  loading,
  unavailable,
  gateNotice,
  result,
  error,
  metricLabel,
  refining,
}: {
  hasId: boolean;
  campaignId: string;
  loading: boolean;
  unavailable: boolean;
  gateNotice: ReturnType<typeof cachedSessionNotice>;
  result: ABResultsResponse | undefined;
  error: unknown;
  metricLabel: string;
  refining: boolean;
}) {
  if (!hasId) {
    // Malformed or cold deep link: the query is disabled, so "pull to retry"
    // could never succeed. Give a real way out.
    return (
      <EmptyState
        title="Campaign not found"
        description="This A/B results link is missing its campaign. Head back to the campaigns list and open the test from there."
        cta={{
          label: "Back to campaigns",
          onPress: () => goBackOr("/(tabs)/campaigns"),
        }}
      />
    );
  }
  if (loading) {
    return (
      <View style={{ gap: 10 }}>
        <SkeletonCard lines={3} />
        <SkeletonCard lines={3} />
      </View>
    );
  }
  if (unavailable) {
    return (
      <EmptyState
        title="A/B results unavailable"
        description="This deployment doesn't expose the engagement reader endpoint. Open the desktop app for the full pairwise stats — Bayesian P(B > A), Bonferroni-corrected frequentist tests, and credible intervals."
      />
    );
  }
  if (!result) {
    if (gateNotice) return <CachedSessionNotice notice={gateNotice} />;
    return (
      <EmptyState
        title="Couldn't load A/B results"
        description={campaignErrorMessage(
          error,
          "The A/B results didn't load.",
        )}
      />
    );
  }
  if (result.variants.length === 0) {
    return (
      <EmptyState
        title="No variants yet"
        description="This campaign has no A/B variants with engagement data for this metric. Send the test and check back once recipients start opening."
      />
    );
  }
  return (
    <ABResultsBody
      result={result}
      campaignId={campaignId}
      metricLabel={metricLabel}
      refining={refining}
    />
  );
}
