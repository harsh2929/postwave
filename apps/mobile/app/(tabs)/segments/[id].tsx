/**
 * Segment detail — what this audience means, and how big it is over time.
 *
 * Mobile previously had no segments surface at all, so an operator
 * reviewing a campaign on a phone could see a segment's NAME and nothing
 * about what it selects or how many people it reaches.
 *
 * The cards live in src/components/segments/SegmentDetailCards.tsx along
 * with the two honesty rules they encode (an unevaluated size is not zero;
 * a one-point history is not a trend).
 */
import { useCallback, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { RefreshControl, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { CachedSessionNotice } from "@/components/CachedSessionNotice";
import { useConfirm } from "@/components/ConfirmSheet";
import { ErrorState } from "@/components/ErrorState";
import { ScreenHeader } from "@/components/ScreenHeader";
import { useToast } from "@/components/Toast";
import { SkeletonDetail } from "@/components/Skeleton";
import { SegmentDecayCard } from "@/components/segments/SegmentDecayCard";
import {
  SegmentRuleCard,
  SegmentSizeCard,
  SegmentSummaryCard,
} from "@/components/segments/SegmentDetailCards";
import { SegmentEvidenceCards } from "@/components/segments/SegmentEvidenceCards";
import { SegmentManageCard } from "@/components/segments/SegmentManageCard";
import type { SegmentDecayEvent } from "@/api/segmentDecay";
import { useCachedRowSeed } from "@/hooks/useCachedRowSeed";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useRecordLastViewed } from "@/hooks/useActivityCursor";
import {
  useDismissSegmentDecayEvent,
  useSegmentDecayEvents,
} from "@/hooks/useSegmentDecay";
import {
  segmentsKey,
  useRecomputeSegment,
  useSegment,
  useSegmentSizeHistory,
} from "@/hooks/useSegments";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { audienceGateNotice } from "@/lib/audienceGateNotice";
import { errorPresentation } from "@/lib/errorCopy";
import { plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOr } from "@/lib/nav";
import { useTheme } from "@/lib/theme";

/** Per-route boundary (src/lib/routeErrorBoundary.consistency.test.ts). */
export { AppErrorBoundary as ErrorBoundary } from "@/components/AppErrorBoundary";

/** Module-level so the seed's memo key is stable across renders. */
const SEGMENT_SEED_FIELDS = ["name"] as const;

export default function SegmentDetail() {
  useScreenViewed("segment-detail");
  const { t } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Cross-device continuity: tell the server this is where the user is,
  // so their other devices can offer "Continue". Best-effort and silent.
  useRecordLastViewed("segment", id);
  const gate = useOnlineQueryGate();
  const gateNotice = audienceGateNotice({
    gateEnabled: gate.enabled,
    hasTenant: Boolean(gate.tenantId),
    noun: "this segment",
  });
  const segment = useSegment(id);
  const history = useSegmentSizeHistory(id);
  // The decay radar: the server has flagged segments quietly collapsing for a
  // long time and mobile called none of those routes, so a segment that lost
  // most of its members overnight was invisible on the one device the operator
  // has with them — and a dismissal recorded on web could not be recorded here.
  const decay = useSegmentDecayEvents(id);
  // The catalogue row that led here already has the name; without this the
  // header reads a generic "Segment" for the whole detail round trip even
  // though the user tapped a row labelled "Churn risk — 90 days".
  const headerSeed = useCachedRowSeed(
    segmentsKey(gate.tenantId),
    id,
    SEGMENT_SEED_FIELDS,
  );

  // POST /api/v1/segments/{id}/recompute is `write:subscribers` — editor and
  // above. Gating here rather than discovering the floor through a 403 keeps a
  // viewer's screen free of a control they can never use.
  const { toast } = useToast();
  const canRecompute = canAccessMinimumRole("editor", gate.effectiveRole);
  const recompute = useRecomputeSegment();
  const onRecompute = useCallback(() => {
    if (!id || recompute.isPending) return;
    haptics.tap();
    recompute.mutate(id, {
      onSuccess: (result) => {
        haptics.success();
        toast({
          kind: "success",
          message: `Sized: ${plural(result.count, "member")}.`,
        });
      },
      onError: (error) => {
        haptics.error();
        toast({
          kind: "error",
          message:
            errorPresentation(error).message ||
            "Couldn't size this segment. Try again.",
        });
      },
    });
  }, [id, recompute, toast]);

  // Dismissing a decay alert is `write:subscribers` — editor and above, the
  // same floor as the recompute above — and there is NO un-dismiss route, so
  // it earns a confirm rather than an undo toast.
  const confirm = useConfirm();
  const canDismissDecay = canAccessMinimumRole("editor", gate.effectiveRole);
  const dismissDecay = useDismissSegmentDecayEvent(id);
  const [dismissingDecayId, setDismissingDecayId] = useState<string | null>(
    null,
  );
  const onDismissDecay = useCallback(
    (event: SegmentDecayEvent) => {
      if (dismissingDecayId) return;
      void (async () => {
        const ok = await confirm({
          title: "Dismiss this alert?",
          message:
            "It stops appearing here and on the other surfaces that read the radar.",
          confirmLabel: "Dismiss",
          consequence: "Dismissing can't be undone from any surface.",
        });
        if (!ok) return;
        haptics.tap();
        setDismissingDecayId(event.id);
        dismissDecay.mutate(event.id, {
          onSuccess: () => {
            haptics.success();
            setDismissingDecayId(null);
          },
          onError: (error) => {
            haptics.error();
            setDismissingDecayId(null);
            toast({
              kind: "error",
              message:
                errorPresentation(error).message ||
                "Couldn't dismiss that alert. Try again.",
            });
          },
        });
      })();
    },
    [confirm, dismissDecay, dismissingDecayId, toast],
  );

  // `useSegment` is DISABLED without an id, so a malformed deep link (or a
  // cold universal link that loses the param) left isLoading and isError both
  // false with no data — indistinguishable from a 404, and the screen said
  // "That segment no longer exists" about a segment it was never told to load.
  // Guarding `missing` on the id is what keeps that sentence a real finding.
  const missing =
    Boolean(id) &&
    !segment.isLoading &&
    !segment.isError &&
    !segment.data &&
    !gateNotice;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title={segment.data?.name ?? headerSeed.name ?? "Segment"}
        onBack={() => goBackOr("/(tabs)/segments")}
      />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 12 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={
              (segment.isRefetching && !segment.isLoading) ||
              (history.isRefetching && !history.isLoading)
            }
            enabled={!gateNotice}
            onRefresh={() => {
              void segment.refetch();
              void history.refetch();
              void decay.refetch();
            }}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {gateNotice ? <CachedSessionNotice notice={gateNotice} /> : null}

        {segment.isLoading && !segment.data ? (
          <SkeletonDetail sections={3} />
        ) : null}
        {segment.isError ? (
          <ErrorState
            error={segment.error}
            onRetry={() => void segment.refetch()}
          />
        ) : null}
        {!id ? (
          <ErrorState message="That link didn't include a segment. Open one from the segments list." />
        ) : null}
        {missing ? <ErrorState message="That segment no longer exists." /> : null}

        {segment.data ? (
          <>
            <SegmentSummaryCard
              segment={segment.data}
              onRecompute={canRecompute ? onRecompute : null}
              recomputing={recompute.isPending}
            />
            <SegmentDecayCard
              events={decay.data}
              isError={decay.isError}
              error={decay.error}
              onRetry={() => void decay.refetch()}
              onDismiss={canDismissDecay ? onDismissDecay : null}
              dismissingId={dismissingDecayId}
            />
            <SegmentRuleCard queryAst={segment.data.queryAst} />
            <SegmentSizeCard
              history={history.data}
              isLoading={history.isLoading}
              isError={history.isError}
              error={history.error}
              onRetry={() => void history.refetch()}
            />
            {/* Evidence panels — desktop's snapshots / definition-history /
                usage / growth-report surfaces, collapsed so a visit costs
                nothing until one is opened. Withheld while the gate is
                closed: every panel is a live read. */}
            {!gateNotice && id ? <SegmentEvidenceCards segmentId={id} /> : null}
            {/* Delete — editor-floor, typed confirm, online-only. */}
            <SegmentManageCard
              segment={segment.data}
              blocked={Boolean(gateNotice)}
            />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
