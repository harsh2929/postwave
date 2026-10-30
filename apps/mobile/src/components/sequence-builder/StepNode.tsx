/**
 * StepNode — a single tile on the mobile sequence canvas.
 *
 * Behaviour:
 *   - Tap → opens the StepEditor sheet (parent owns the modal).
 *   - Reorder → the explicit ↑ / ↓ buttons on the right, plus the identical
 *     verbs published as accessibilityActions on the tile itself.
 *   - `dragging` still dims and (outside Reduce Motion) shrinks the tile, so a
 *     future gesture layer has its lifted state ready.
 *
 * WHY THERE IS NO DRAG HANDLE. Reordering here used to be a long-press drag,
 * and it had two defects that are the same defect: a long-press advertises
 * nothing, so nobody discovered it, and a drag has no assistive-technology
 * equivalent, so VoiceOver users could not reorder AT ALL. The canvas-side
 * gesture protocol has since been deleted (see StepCanvas's header). Replacing
 * it with visible, labelled ↑/↓ buttons fixes both defects rather than papering
 * over the first with a grab-dots glyph: the control is self-evident, it is a
 * 44pt target, and it carries `accessibilityState.disabled` at the ends of the
 * list. The rotor actions below are the same three verbs by NAME — the pattern
 * SwipeableRow uses — so a screen-reader user gets them in one gesture instead
 * of swiping past three small buttons on every tile.
 *
 * Branching nodes (condition) render two nested branch lists below the
 * summary so the operator sees the topology at a glance.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { FONT } from "@/lib/fonts";
import type { FunnelStepRow } from "@/lib/sequenceFunnel";
import { useMotion } from "@/lib/motion";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

import { StepMetrics } from "./StepNodeMetrics";
import { type CanvasStep, stepSummary, stepTypeLabel } from "./types";

interface StepNodeProps {
  step: CanvasStep;
  readOnly?: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onDelete: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  dragging?: boolean;
  /**
   * Per-step funnel row, when the report has one for this node. Matching is
   * path-encoded (lib/sequenceFunnel) because branch steps re-use position
   * numbers — a positional lookup would render another step's numbers here.
   */
  metrics?: FunnelStepRow | undefined;
  /** Optional render-prop for child branches (used by condition nodes). */
  renderBranch?: (
    branch: "yes" | "no",
    steps: CanvasStep[] | undefined,
  ) => React.ReactNode;
}

/**
 * Spoken summary of a condition's two arms. The indentation and the coloured
 * rail that carry branch structure visually convey nothing to VoiceOver, so
 * the arm sizes have to be said out loud.
 */
function branchAnnouncement(step: CanvasStep): string {
  if (step.type !== "condition") return "";
  const yes = Array.isArray(step.yes_branch) ? step.yes_branch.length : 0;
  const no = Array.isArray(step.no_branch) ? step.no_branch.length : 0;
  const arm = (n: number) => `${n} ${n === 1 ? "step" : "steps"}`;
  return ` If yes: ${arm(yes)}. If no: ${arm(no)}.`;
}

function toneForType(
  type: CanvasStep["type"],
): "accent" | "info" | "warning" | "danger" | "neutral" {
  switch (type) {
    case "email":
      return "accent";
    case "delay":
      return "info";
    case "condition":
      return "warning";
    case "tag_add":
    case "tag_remove":
      return "neutral";
    case "exit":
      return "danger";
  }
}

export function StepNode({
  step,
  readOnly = false,
  onPress,
  onLongPress,
  onDelete,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  dragging,
  metrics,
  renderBranch,
}: StepNodeProps) {
  const { t } = useTheme();
  const { reduceMotion } = useMotion();
  const tone = toneForType(step.type);
  // Rotor actions, mirroring SwipeableRow: every verb this tile exposes as a
  // small glyph is also published by NAME so VoiceOver announces "Actions
  // available" and offers them without the user hunting three 44pt targets
  // per step. Built from what is actually WIRED and ENABLED — an action whose
  // handler is absent, or whose button is disabled because the step is already
  // first/last, is not listed, because a rotor action that silently does
  // nothing is worse than one that is missing.
  const rotorActions = readOnly
    ? []
    : [
        ...(onMoveUp && canMoveUp
          ? [{ name: "Move up", label: "Move up", run: onMoveUp }]
          : []),
        ...(onMoveDown && canMoveDown
          ? [{ name: "Move down", label: "Move down", run: onMoveDown }]
          : []),
        { name: "Delete step", label: "Delete step", run: onDelete },
      ];
  return (
    <View
      style={{
        opacity: dragging ? 0.4 : 1,
        // Reduce Motion is a request for no movement, not for no feedback:
        // the opacity change still communicates "lifted" without the scale.
        transform: dragging && !reduceMotion ? [{ scale: 0.97 }] : undefined,
      }}
    >
      <View
        style={{
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 14,
          minHeight: 64,
          position: "relative",
        }}
      >
        <Pressable
          onPress={onPress}
          onLongPress={onLongPress}
          delayLongPress={250}
          accessibilityRole="button"
          accessibilityLabel={`${stepTypeLabel(step.type)} step. ${stepSummary(step)}${branchAnnouncement(step)}`}
          // Ordering is meaning in a journey, and "position 3 of 7" is the
          // part a screen reader cannot infer from a vertical stack of tiles.
          {...(readOnly
            ? {}
            : {
                accessibilityHint:
                  "Opens this step. Reorder or remove it from the actions rotor, or with the arrow buttons on the right.",
                accessibilityActions: rotorActions.map(({ name, label }) => ({
                  name,
                  label,
                })),
                onAccessibilityAction: (event: {
                  nativeEvent: { actionName: string };
                }) => {
                  rotorActions
                    .find((a) => a.name === event.nativeEvent.actionName)
                    ?.run();
                },
              })}
          accessibilityState={{ disabled: readOnly }}
          disabled={readOnly}
          style={{
            minHeight: 64,
            padding: 14,
            paddingEnd: readOnly ? 14 : 150,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              marginBottom: 6,
            }}
          >
            <Pill label={stepTypeLabel(step.type)} tone={tone} />
            <Text
              {...typeCap("badgeSmall")}
              // The visible glyph is "#3"; VoiceOver would say "number 3",
              // which is not what the number means here.
              accessibilityLabel={`Position ${step.position + 1}`}
              style={{
                color: t.fgSubtle,
                ...typeStyle("badgeSmall"),
                fontFamily: FONT.regular,
                fontVariant: ["tabular-nums"],
                marginStart: "auto",
              }}
            >
              #{step.position + 1}
            </Text>
          </View>
          <Text
            {...typeCap("callout")}
            style={{
              color: t.fg,
              ...typeStyle("callout"),
              fontFamily: FONT.regular,
            }}
            numberOfLines={3}
          >
            {stepSummary(step)}
          </Text>
          {metrics ? <StepMetrics row={metrics} /> : null}
          {step.variants && step.variants.length > 0 ? (
            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                marginTop: 4,
                fontFamily: FONT.regular,
              }}
            >
              {step.variants.length} A/B variants · edit on desktop
            </Text>
          ) : null}
        </Pressable>
        {!readOnly ? (
          <View
            style={{
              position: "absolute",
              top: 10,
              // Logical, and paired with the title's `paddingEnd` reservation:
              // a physical `right` would park these controls over the step
              // title on an RTL layout.
              insetInlineEnd: 10,
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
            }}
          >
            {onMoveUp ? (
              <MoveButton
                label="Move step up"
                glyph="↑"
                disabled={!canMoveUp}
                onPress={onMoveUp}
              />
            ) : null}
            {onMoveDown ? (
              <MoveButton
                label="Move step down"
                glyph="↓"
                disabled={!canMoveDown}
                onPress={onMoveDown}
              />
            ) : null}
            <Pressable
              onPress={onDelete}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Delete step"
              style={{
                width: 44,
                height: 44,
                borderRadius: 6,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "transparent",
              }}
            >
              <Text
                {...typeCap("heading")}
                style={{
                  color: t.danger,
                  ...typeStyle("heading"),
                  fontFamily: FONT.regular,
                }}
              >
                ×
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      {step.type === "condition" && renderBranch ? (
        <View
          style={{
            // Logical (start/end) properties so the branch rail sits on the
            // reading-start edge under RTL instead of on the wrong side.
            marginStart: 16,
            marginTop: 6,
            paddingStart: 12,
            borderStartWidth: 2,
            borderStartColor: t.borderSubtle,
            gap: 8,
          }}
        >
          <View>
            <Text
              accessibilityRole="header"
              {...typeCap("caption")}
              style={{
                color: t.success,
                ...typeStyle("caption"),
                fontWeight: "700",
                fontFamily: FONT.bold,
                letterSpacing: 0.5,
                marginBottom: 4,
              }}
            >
              IF YES
            </Text>
            {renderBranch("yes", step.yes_branch)}
          </View>
          <View>
            <Text
              accessibilityRole="header"
              {...typeCap("caption")}
              style={{
                color: t.fgMuted,
                ...typeStyle("caption"),
                fontWeight: "700",
                fontFamily: FONT.bold,
                letterSpacing: 0.5,
                marginBottom: 4,
              }}
            >
              IF NO
            </Text>
            {renderBranch("no", step.no_branch)}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function MoveButton({
  label,
  glyph,
  disabled,
  onPress,
}: {
  label: string;
  glyph: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      hitSlop={4}
      style={{
        width: 44,
        height: 44,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: disabled ? "transparent" : t.bgSubtle,
        borderWidth: 1,
        borderColor: disabled ? t.borderSubtle : t.border,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "700",
          fontFamily: FONT.bold,
        }}
      >
        {glyph}
      </Text>
    </Pressable>
  );
}
