/**
 * Sequence detail — the journey topology, editable when the row is a draft.
 *
 * Layout (top → bottom):
 *   - ScreenHeader (back + name + status/step-count subtitle).
 *   - Persistent runtime/authoring capability boundary.
 *   - Entry trigger / goal / stuck-threshold context.
 *   - StepCanvas (vertical tile tree, condition branches included).
 *
 * ONE COMPOSED GATE, `stepsEditable`, and it is the ONLY thing deciding whether
 * this screen can author: it drives StepCanvas's `readOnly`, the StepEditor's
 * `visible`, AND the persistence hook's enqueue. A hardcoded `readOnly` beside
 * the flag used to mean flipping the flag still could not open the editor (a
 * read-only canvas never calls `onEditStep`) — so the flag was not the gate it
 * claimed to be, and the fix was to make one expression carry every term.
 *
 * Its two terms are the client's release decision and the server's rule about
 * this row (only a `draft` accepts a PATCH — 409 otherwise). Both are argued at
 * the declaration; the point of composing them here is that a term added later
 * reaches all three consumers at once instead of two of the three.
 *
 * Deliberately ABSENT even with authoring open: the drag-and-drop gesture layer
 * and the step palette. Reorder is the explicit up/down control on each tile
 * and steps are ADDED on desktop — half a gesture protocol is worse than none,
 * so restore those together or not at all.
 *
 * Honest fallbacks:
 *   - 404 on GET → muted "feature unavailable" empty state.
 *   - Save errors surface via a toast with a Retry action; the in-memory
 *     canvas keeps the unsaved edit.
 *   - A malformed sequence body is contained by the route-level ErrorBoundary
 *     re-exported at the bottom of this file rather than blanking the app.
 */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { RefreshControl, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  CachedSessionNotice,
  cachedSessionNotice,
} from "@/components/CachedSessionNotice";
import { EmptyState } from "@/components/EmptyState";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SkeletonDetail } from "@/components/Skeleton";
import {
  SequenceDetailBoundary,
  SequenceShareAction,
} from "@/components/sequences/SequenceChrome";
import { SequenceDetailActions } from "@/components/sequences/SequenceDeleteAction";
import { SequenceLiveSections } from "@/components/sequences/SequenceParticipants";
import { WebHandoffRow } from "@/components/WebHandoffRow";
import { StepCanvas } from "@/components/sequence-builder/StepCanvas";
import { SequenceContextCard } from "@/components/sequences/SequenceContextCard";
import { StepEditor } from "@/components/sequence-builder/StepEditor";
import {
  type CanvasStep,
  countCanvasSteps,
} from "@/components/sequence-builder/types";
import {
  firstMeaningful,
  sequencesQueryRootKey,
} from "@/lib/detailSeedKeys";
import { plural } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { goBackOr } from "@/lib/nav";
import { useCachedRowSeed } from "@/hooks/useCachedRowSeed";
import { useEntityActivity } from "@/hooks/useEntityActivity";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { useSequenceCanvasSave } from "@/hooks/useSequenceCanvasSave";
import { useSequenceCanvasSeed } from "@/hooks/useSequenceCanvasSeed";
import { useRecordLastViewed } from "@/hooks/useActivityCursor";
import {
  useSequenceDetail,
  useSequenceFunnelReport,
} from "@/hooks/useSequences";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useAuthStore } from "@/store/auth";
import {
  mobileSequenceStatusPresentation,
  mobileSequenceStepsEditable,
} from "@/lib/sequenceCapabilities";
import { useTheme } from "@/lib/theme";

/** The one string the list row can honestly lend the detail header. */
const SEQUENCE_SEED_FIELDS = ["name"] as const;

export default function SequenceDetail() {
  const { t } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Cross-device continuity: tell the server this is where the user is,
  // so their other devices can offer "Continue". Best-effort and silent.
  useRecordLastViewed("sequence", id);
  const onlineGate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  useScreenViewed("sequence detail");
  const sequenceGateNotice = cachedSessionNotice({
    gateEnabled: onlineGate.enabled,
    hasTenant: Boolean(onlineGate.tenantId),
    surface: "sequence",
  });

  // Cold-offline capable (hooks/useSequences): with the gate closed this
  // resolves the last saved topology projection instead of a bare reconnect
  // notice. A projection deliberately carries no `version`, so the save path
  // below fails closed on it — see the seeding effect.
  const seq = useSequenceDetail(id);
  // The sequences row the operator tapped is still cached one screen away, so
  // the title does not have to read a generic "Sequence" for the whole detail
  // round trip. Identity only — the status pill and step count below stay
  // hidden until they are measured, because a stale count is a wrong claim
  // whereas a stale NAME is just the name.
  const headerSeed = useCachedRowSeed(
    sequencesQueryRootKey(onlineGate.tenantId),
    id,
    SEQUENCE_SEED_FIELDS,
  );

  const [steps, setSteps] = useState<CanvasStep[]>([]);
  const [editing, setEditing] = useState<CanvasStep | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [name, setName] = useState<string>("");
  // Offer this sequence to Handoff and Spotlight (SHELL#31). Suppressed while
  // the app lock is armed, and revoked from the search index on sign-out.
  useEntityActivity({
    entity: "sequence",
    id,
    title: firstMeaningful(name, headerSeed.name),
  });
  const sequenceVersionRef = useRef<number | null>(null);
  const activeSequenceIdRef = useRef(id ?? "");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<CanvasStep[] | null>(null);

  // Canvas seeding and the route-change reset — the two rules that decide
  // when the canvas may be repopulated without destroying in-progress edits.
  // See hooks/useSequenceCanvasSeed for why they belong together.
  const seededForRef = useRef<string | null>(null);
  useSequenceCanvasSeed({
    id,
    detail: seq.data?.detail,
    setSteps,
    setName,
    setEditing,
    setEditorOpen,
    sequenceVersionRef,
    activeSequenceIdRef,
    saveTimerRef,
    pendingSaveRef,
    seededForRef,
  });

  /* ---------------- authoring gate --------------------------------- */

  /**
   * The build's release decision AND the server's rule about this row, composed
   * in lib/sequenceCapabilities where both terms are argued and tested.
   *
   * Computed HERE, above the persistence hook, because it gates that hook as
   * well as the canvas and the editor: a queued save is not undone by hiding
   * the button that made it.
   */
  const sequenceStatus = seq.data?.detail?.status;
  const presentedStatus = mobileSequenceStatusPresentation(sequenceStatus);
  const stepsEditable = mobileSequenceStepsEditable(sequenceStatus);

  /* ---------------- persistence ------------------------------------ */

  const onEditStep = useCallback((s: CanvasStep) => {
    setEditing(s);
    setEditorOpen(true);
  }, []);
  const onEditCommitted = useCallback(() => {
    setEditorOpen(false);
    setEditing(null);
  }, []);

  // Everything the authoring flag re-opens lives in hooks/useSequenceCanvasSave:
  // the debounced save, the unmount flush, the version chaining and the
  // step-level undo. Unreachable while MOBILE_SEQUENCE_AUTHORING_AVAILABLE is
  // false, and kept only so mutations queued by older builds replay safely.
  const { onDeleteStep, onSaveEdit, onMoveStep } = useSequenceCanvasSave({
    id,
    tenantId: onlineGate.tenantId,
    stepsEditable,
    steps,
    setSteps,
    sequenceVersionRef,
    activeSequenceIdRef,
    saveTimerRef,
    pendingSaveRef,
    onEditRequested: onEditStep,
    onEditCommitted,
  });

  /* ---------------- render ----------------------------------------- */

  // The query never rejects for HTTP errors (rawRequest resolves to an
  // AIApiResult), so the failure signal lives on `seq.data.error`. A
  // thrown query (network down before the request resolves) shows up as
  // `seq.isError`. Treat both, but split "endpoint not deployed" (404/
  // 405/501 — an honest "feature unavailable") from a real fetch failure
  // that must NOT look like an empty success.
  const detail = seq.data?.detail ?? null;
  const fetchErr = seq.data?.error ?? null;
  const unavailable =
    !!fetchErr &&
    (fetchErr.status === 404 ||
      fetchErr.status === 405 ||
      fetchErr.status === 501);
  const hasSequenceDetail = Boolean(detail);
  const hardError = !unavailable && (seq.isError || !!fetchErr || !id);

  // Header subtitle: status badge + TOTAL step count (nested condition
  // branches included — `steps.length` counted only the top level, so a
  // 1-condition / 12-branch-step journey reported "1 step").
  const stepCount = useMemo(() => countCanvasSteps(steps), [steps]);
  const statusLabel = presentedStatus.label;
  const headerSubtitle = detailSubtitle({
    hide:
      seq.isLoading ||
      hardError ||
      unavailable ||
      Boolean(sequenceGateNotice && !hasSequenceDetail),
    statusLabel,
    stepCount,
  });

  const onRefresh = useCallback(() => {
    if (sequenceGateNotice) return;
    haptics.tap();
    void seq.refetch();
  }, [seq, sequenceGateNotice]);

  // Delete preconditions. The affordance is HIDDEN, not disabled, when it
  // cannot succeed: offline (DELETE is never queued — see offlineQueueSafety),
  // read-only role, or no loaded version for If-Match. Assembled here and
  // judged in SequenceDetailActions.
  const detailFromSnapshot = seq.data?.fromSnapshot ?? false;
  const canWriteOnline = onlineGate.enabled && !sequenceGateNotice;
  // Derived aggregates (participants, stuck) have no stored projection and no
  // value when stale — their whole point is being current.
  const liveSections = canWriteOnline && !detailFromSnapshot;
  // Shared with the summary card in the footer: one heavy-read request feeds
  // both the per-node metrics and the journey totals.
  const funnelReport = useSequenceFunnelReport(id, liveSections);
  const canWriteRole = canAccessMinimumRole(
    "editor",
    onlineGate.effectiveRole,
    mode,
  );

  // One title expression, read by the header AND by the web-handoff label.
  // Hoisted rather than repeated: this component sits against its cyclomatic
  // ceiling (see scripts/source-budgets.json), and a second `??` here costs a
  // point of it for no gain.
  const sequenceTitle = firstMeaningful(name, headerSeed.name) ?? "Sequence";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title={sequenceTitle}
        subtitle={headerSubtitle}
        onBack={() => goBackOr("/(tabs)/sequences")}
        right={
          <SequenceDetailActions
            id={id}
            name={name}
            stepCount={stepCount}
            version={sequenceVersionRef.current}
            online={canWriteOnline}
            canWrite={canWriteRole}
            hasDetail={hasSequenceDetail}
            fromSnapshot={detailFromSnapshot}
            onDeleted={() => goBackOr("/(tabs)/sequences")}
            share={<SequenceShareAction id={id} name={name} />}
          />
        }
      />

      {seq.isLoading ? (
        <View style={{ padding: 16 }}>
          <SkeletonDetail sections={3} />
        </View>
      ) : sequenceGateNotice && !hasSequenceDetail ? (
        <View style={{ padding: 16 }}>
          <CachedSessionNotice notice={sequenceGateNotice} />
        </View>
      ) : unavailable ? (
        <View style={{ padding: 16 }}>
          <EmptyState
            title="Sequence not available"
            description="This deployment doesn't expose the Voice sequence detail endpoint. Open the desktop or web app to view or edit this sequence."
          />
        </View>
      ) : hardError ? (
        <View style={{ padding: 16 }}>
          <EmptyState
            title="Couldn't load this sequence"
            description={
              !id
                ? "No sequence was selected. Go back and pick a sequence from the list."
                : fetchErr?.message
                  ? `${fetchErr.message}. Check your connection and try again.`
                  : "Something went wrong loading this sequence. Check your connection and try again."
            }
            cta={
              id
                ? { label: "Try again", onPress: () => void seq.refetch() }
                : {
                    label: "Go back",
                    onPress: () => goBackOr("/(tabs)/sequences"),
                  }
            }
          />
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          {sequenceGateNotice ? (
            <CachedSessionNotice
              notice={sequenceGateNotice}
              variant="stale"
              style={{ margin: 16, marginBottom: 8 }}
            />
          ) : null}
          <SequenceDetailBoundary topMargin={sequenceGateNotice ? 0 : 12} />
          <SequenceContextCard
            trigger={detail?.trigger}
            goal={detail?.goal}
            stuckAfterDays={detail?.stuck_after_days}
          />
          <StepCanvas
            steps={steps}
            readOnly={!stepsEditable}
            onEditStep={onEditStep}
            onDeleteStep={onDeleteStep}
            onMoveStep={onMoveStep}
            refreshControl={
              <RefreshControl
                refreshing={seq.isFetching && !seq.isLoading}
                onRefresh={onRefresh}
                enabled={!sequenceGateNotice}
                tintColor={t.fgMuted}
                colors={[t.accent]}
              />
            }
            // Inside the canvas's own scroller: participants and the stuck
            // report are LIVE-only derived reads, so they are hidden rather
            // than shown empty whenever this screen is on a stored projection.
            funnel={funnelReport}
            footer={
              <>
                <SequenceLiveSections id={id} visible={liveSections} />
                {/* "Finish this on the web" (LOVE#50). Still the honest exit
                    even now that a draft's steps are editable here: steps are
                    ADDED on desktop (there is no palette on this canvas), and
                    a non-draft journey is read-only for every client, so
                    `readOnly={!stepsEditable}` leaves a real remainder in both
                    directions. NOT gated on `liveSections` like the sections
                    above it — copying a link is exactly what still works on a
                    cached read, and it is the primary action here for the same
                    reason (see WebHandoffRow: the in-app browser does not
                    carry this app's session). */}
                <WebHandoffRow
                  entity="sequence"
                  id={id}
                  label={sequenceTitle}
                />
              </>
            }
          />
        </View>
      )}

      <StepEditor
        visible={stepsEditable && editorOpen}
        step={editing}
        onCancel={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
        onSave={onSaveEdit}
      />
    </SafeAreaView>
  );
}

/**
 * Header subtitle, or nothing.
 *
 * Every state that is NOT "we have a sequence to describe" must show no
 * subtitle at all: a status badge over a failed load is a claim about tenant
 * state we have not earned.
 */
function detailSubtitle(input: {
  hide: boolean;
  statusLabel: string;
  stepCount: number;
}): string | undefined {
  if (input.hide) return undefined;
  return `${input.statusLabel} · ${plural(input.stepCount, "step")}`;
}

/** Route-level containment. Expo Router picks up the named export; the whole
 *  boundary — chrome included — lives in SequenceChrome. */
export { SequenceRouteErrorBoundary as ErrorBoundary } from "@/components/sequences/SequenceChrome";
