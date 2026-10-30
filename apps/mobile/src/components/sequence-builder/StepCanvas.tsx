/**
 * StepCanvas — the scrollable vertical tree of CanvasStep tiles.
 *
 * Condition nodes render their IF YES / IF NO subtrees inline (see
 * `BranchSteps`) so a branching journey reads as the topology it actually is
 * rather than as a flat list.
 *
 * NO DRAG LAYER. This file used to carry the canvas half of a long-press
 * drag-and-drop protocol — an imperative `beginDrag/updateDrag/endDrag` handle,
 * measured row rects, a drop-target resolver, a drop indicator, and
 * `applyDropToSteps`/`freshStepOfType` helpers. Its driver (the page-level
 * PanResponder in app/(tabs)/sequences/[id].tsx) was deleted, leaving every one
 * of those with zero callers: the sole remaining consumer satisfied the
 * required `onLongPressStep` prop with a no-op. Half a gesture protocol is
 * worse than none — it makes the shipped surface unreadable. Restore the whole
 * thing with the authoring flag, not one side at a time.
 *
 * TWO RENDER PATHS, chosen by `readOnly`. The caller composes that bit from the
 * build's authoring flag AND the sequence's own status — a non-draft journey is
 * read-only for every client, because the server answers a PATCH on one with
 * 409 (app/(tabs)/sequences/[id].tsx, `stepsEditable`).
 *
 *   readOnly → a virtualised FlatList. The comment that used to sit here
 *   justified a plain ScrollView because "the drop-zone calculations need
 *   synchronous access to each child's rect". That justification died with the
 *   drag layer: nothing measures rows any more, so an unbounded map over a
 *   100-step sequence (desktop's ceiling, and therefore within contract) was
 *   mounting every tile on a phone for nothing.
 *
 *   authoring → the ScrollView, kept intact so the rect-measuring path a
 *   restored drag layer would need is still here.
 *
 * Branch subtrees are NOT virtualised in either path: they are nested inside
 * their condition's row and are bounded by CANVAS_RENDER_DEPTH_LIMIT.
 */
import type { ReactNode } from "react";
import {
  FlatList,
  ScrollView,
  Text,
  View,
  type ListRenderItem,
  type RefreshControlProps,
} from "react-native";

import { FONT } from "@/lib/fonts";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import {
  branchFunnelStepId,
  getFunnelMetric,
  topLevelFunnelStepId,
  type SequenceFunnelWire,
} from "@/lib/sequenceFunnel";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

import { StepNode } from "./StepNode";
import { type CanvasStep, countCanvasSteps } from "./types";

/**
 * Nesting ceiling for the rendered branch tree.
 *
 * `wireToCanvas` decodes arbitrarily nested yes/no subtrees; drawing all of
 * them on a phone would produce unreadable 6-level indentation, and a hostile
 * payload could nest far deeper. Past this depth we stop recursing and say so
 * rather than silently truncating (an invisible subtree is exactly the failure
 * this whole feature exists to fix).
 */
export const CANVAS_RENDER_DEPTH_LIMIT = 3;

interface StepCanvasProps {
  steps: CanvasStep[];
  /** Runtime-off containment: render topology without mutation controls. */
  readOnly?: boolean;
  onEditStep: (step: CanvasStep) => void;
  onDeleteStep: (id: string) => void;
  onMoveStep?: (id: string, direction: "up" | "down") => void;
  /**
   * Pull-to-refresh for the owning screen. Pull-to-refresh is the universal
   * iOS gesture for "is this still true?"; the sibling list has it, so its
   * absence on the detail screen reads as a bug to anyone who tries it.
   */
  refreshControl?: React.ReactElement<RefreshControlProps> | undefined;
  /**
   * Rendered below the last step, INSIDE the canvas's scroller. The detail
   * screen hangs its participants and stuck-report sections here rather than
   * stacking a second scrollable beside this one — nested scrollables on a
   * phone make both feel broken.
   */
  footer?: ReactNode;
  /**
   * Per-step funnel report. Matching is path-encoded (lib/sequenceFunnel):
   * branch steps re-use position numbers, so a positional lookup would render
   * a different step's numbers on every branch node.
   */
  funnel?: SequenceFunnelWire | null | undefined;
}

export function StepCanvas({
  steps,
  readOnly = false,
  onEditStep,
  onDeleteStep,
  onMoveStep,
  refreshControl,
  footer,
  funnel,
}: StepCanvasProps) {
  const renderStep = (s: CanvasStep, idx: number) => {
    const funnelId = topLevelFunnelStepId(s.position);
    const metrics = getFunnelMetric(funnel, funnelId, s.position);
    return (
      <StepNode
        step={s}
        readOnly={readOnly}
        {...(metrics ? { metrics } : {})}
        onPress={() => {
          if (!readOnly) onEditStep(s);
        }}
        onLongPress={noop}
        onDelete={() => {
          if (!readOnly) onDeleteStep(s.id);
        }}
        {...(!readOnly && onMoveStep
          ? {
              onMoveUp: () => onMoveStep(s.id, "up"),
              onMoveDown: () => onMoveStep(s.id, "down"),
            }
          : {})}
        canMoveUp={idx > 0}
        canMoveDown={idx < steps.length - 1}
        renderBranch={(branch, branchSteps) => (
          <BranchSteps
            steps={branchSteps}
            depth={1}
            parentFunnelId={funnelId}
            branch={branch}
            funnel={funnel}
          />
        )}
      />
    );
  };

  if (readOnly) {
    const renderItem: ListRenderItem<CanvasStep> = ({ item, index }) => (
      <View>{renderStep(item, index)}</View>
    );
    return (
      <FlatList
        {...MOBILE_LIST_PERF_PROPS}
        style={{ flex: 1 }}
        data={steps}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        ItemSeparatorComponent={SeparatorGap}
        ListEmptyComponent={<EmptyCanvas readOnly />}
        {...(footer ? { ListFooterComponent: <>{footer}</> } : {})}
        {...(refreshControl ? { refreshControl } : {})}
        renderItem={renderItem}
      />
    );
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 10 }}
      keyboardShouldPersistTaps="handled"
      {...(refreshControl ? { refreshControl } : {})}
    >
      {steps.length === 0 ? <EmptyCanvas readOnly={readOnly} /> : null}

      {steps.map((s, idx) => (
        <View key={s.id}>{renderStep(s, idx)}</View>
      ))}
      {footer}
    </ScrollView>
  );
}

/** The 10pt rhythm the ScrollView path gets from `gap`. */
function SeparatorGap() {
  return <View style={{ height: 10 }} />;
}

const noop = (): void => {};

/**
 * The empty state.
 *
 * This copy used to read "Tap a tile in the palette below to add your first
 * step. Long-press a tile to drag it to a specific position." — pointing at a
 * StepPalette that has since been deleted and a drag gesture that no longer
 * exists. Telling an operator to use controls that are not on screen is the
 * same manufactured claim as telling them a profile does not exist when we
 * never asked the server.
 *
 * BOTH branches still send the operator to desktop TO ADD A STEP, and that is
 * not stale copy left over from the read-only era: authoring opened, the step
 * PALETTE did not come back with it, so there is genuinely no way to create a
 * step here. What the editable branch must not do is imply otherwise — it says
 * what this canvas can do with steps that already exist instead.
 */
function EmptyCanvas({ readOnly }: { readOnly: boolean }) {
  const { t } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={
        readOnly
          ? "No steps. This sequence has no steps yet. Steps are added in the desktop or web app."
          : "No steps yet. Steps are added in the desktop or web app; you can edit and reorder them here once they exist."
      }
      style={{
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderStyle: "dashed",
        borderRadius: 14,
        padding: 24,
        alignItems: "center",
        gap: 6,
      }}
    >
      <Text
        {...typeCap("callout")}
        style={{
          color: t.fg,
          ...typeStyle("callout"),
          fontWeight: "600",
          fontFamily: FONT.semibold,
        }}
      >
        No steps yet
      </Text>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          textAlign: "center",
          fontFamily: FONT.regular,
        }}
      >
        {readOnly
          ? "This sequence has no steps. Build the journey in the desktop or web app — this screen then shows you its shape from anywhere."
          : "This draft has no steps yet. Add them in the desktop or web app; once they exist you can edit and reorder them here."}
      </Text>
    </View>
  );
}

/**
 * The steps inside one arm of a condition, rendered recursively.
 *
 * Before this existed the canvas drew a condition node and then simply stopped:
 * both subtrees vanished, so a branching journey rendered as a flat list and
 * the operator saw a topology that was not the topology. Branch nodes are
 * always read-only here — mobile authoring is off, and an arm's contents are
 * edited on the surface that owns the branch.
 */
function BranchSteps({
  steps,
  depth,
  parentFunnelId,
  branch,
  funnel,
}: {
  steps: CanvasStep[] | undefined;
  depth: number;
  /** Path id of the condition this arm hangs off. */
  parentFunnelId: string;
  branch: "yes" | "no";
  funnel?: SequenceFunnelWire | null | undefined;
}) {
  const { t } = useTheme();
  if (!Array.isArray(steps) || steps.length === 0) {
    return (
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
        }}
      >
        No steps — this branch ends the journey.
      </Text>
    );
  }
  const canNest = depth < CANVAS_RENDER_DEPTH_LIMIT;
  return (
    <View style={{ gap: 8 }}>
      {steps.map((s) => {
        const hidden = canNest
          ? 0
          : countCanvasSteps(s.yes_branch) + countCanvasSteps(s.no_branch);
        const funnelId = branchFunnelStepId(parentFunnelId, branch, s.position);
        // `null` legacy position, deliberately: legacy funnel rows carry no
        // branch identity, so a positional fallback here would show a
        // top-level step's numbers on a branch node.
        const metrics = getFunnelMetric(funnel, funnelId, null);
        return (
          <View key={s.id}>
            <StepNode
              step={s}
              readOnly
              onPress={noop}
              onLongPress={noop}
              onDelete={noop}
              {...(metrics ? { metrics } : {})}
              {...(canNest
                ? {
                    renderBranch: (
                      nestedBranch: "yes" | "no",
                      nested: CanvasStep[] | undefined,
                    ) => (
                      <BranchSteps
                        steps={nested}
                        depth={depth + 1}
                        parentFunnelId={funnelId}
                        branch={nestedBranch}
                        funnel={funnel}
                      />
                    ),
                  }
                : {})}
            />
            {hidden > 0 ? (
              <Text
                {...typeCap("caption")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("caption"),
                  marginTop: 4,
                  fontFamily: FONT.regular,
                }}
              >
                {hidden} more nested {hidden === 1 ? "step" : "steps"} below
                this depth — open on desktop to see them.
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
