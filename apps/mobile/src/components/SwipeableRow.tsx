/**
 * SwipeableRow — declarative swipe actions for list rows.
 *
 * `react-native-gesture-handler` and `react-native-reanimated` were both
 * already dependencies and `GestureHandlerRootView` was already mounted in
 * `app/_layout.tsx`, but no list screen in the app used a swipe gesture. Every
 * row action lived behind a tap into the detail screen, or an `Alert` with a
 * menu of choices. On a phone that is backwards: the single most common
 * actions on a row (archive, suppress, approve, delete) should be reachable
 * from the row itself.
 *
 * Two design decisions worth stating:
 *
 * 1. ACTIONS ARE DATA, NOT RENDER PROPS. The underlying library wants
 *    `renderLeftActions={(progress, translation, methods) => ...}`. Exposing
 *    that to every call site guarantees the app's twelve list screens will
 *    each style their action buttons slightly differently. Here a caller
 *    passes `right={[{label: "Suppress", kind: "danger", onPress}]}` and the
 *    geometry, colors, haptics, and auto-close are decided once.
 *
 * 2. THE GESTURE IS NEVER THE ONLY PATH. A swipe is invisible: it has no
 *    affordance, and VoiceOver users cannot perform it at all. So every action
 *    is ALSO published as an `accessibilityAction` on the row, which surfaces
 *    it in the VoiceOver rotor ("Actions available"). This is the difference
 *    between adding a gesture and adding a feature — without it, swipe actions
 *    make the app *less* accessible than it was, because functionality moves
 *    from a visible button into an unreachable gesture.
 *
 * Destructive actions should still be reversible: pair `kind: "danger"` with a
 * `toast({action: {label: "Undo"}})` rather than a confirm dialog. See Toast.
 */
import { useCallback, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";

import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export type SwipeActionKind = "neutral" | "primary" | "danger" | "success";

export interface SwipeAction {
  /** Shown on the action button AND used as the VoiceOver action name. */
  label: string;
  kind?: SwipeActionKind;
  onPress: () => void;
}

export interface SwipeableRowProps {
  children: React.ReactNode;
  /** Actions revealed by swiping right (drag from the left edge). */
  left?: readonly SwipeAction[];
  /** Actions revealed by swiping left (drag from the right edge). */
  right?: readonly SwipeAction[];
  /** Row-level a11y label; the action list is appended automatically. */
  accessibilityLabel?: string;
  enabled?: boolean;
}

/** Width of one action button. 84 fits "Suppress"/"Approve" without truncating. */
const ACTION_WIDTH = 84;

export function SwipeableRow({
  children,
  left,
  right,
  accessibilityLabel,
  enabled = true,
}: SwipeableRowProps) {
  const { t } = useTheme();
  const ref = useRef<SwipeableMethods | null>(null);

  const colorFor = useCallback(
    (kind: SwipeActionKind = "neutral") =>
      kind === "danger"
        ? t.danger
        : kind === "success"
          ? t.success
          : kind === "primary"
            ? t.accent
            : t.surfaceElevated,
    [t],
  );

  const run = useCallback((action: SwipeAction) => {
    // A destructive commit gets a heavier thud than a routine one, so the
    // hand knows which happened without reading the screen.
    if (action.kind === "danger") haptics.warning();
    else haptics.tap();
    // Close first so the row is back in place before any navigation or list
    // mutation the handler triggers — otherwise a removed row animates out
    // while still held open and the transform fights the layout.
    ref.current?.close();
    action.onPress();
  }, []);

  // Returns the panel's ELEMENT, not a component — `renderLeftActions` is a
  // render prop, so wrapping this in a component factory would both trip
  // react/display-name and remount the buttons on every drag frame.
  const renderPanel = useCallback(
    (actions: readonly SwipeAction[]) => (
      <View style={{ flexDirection: "row" }}>
        {actions.map((action) => {
          const bg = colorFor(action.kind);
          const fg =
            action.kind && action.kind !== "neutral" ? t.accentFg : t.fg;
          return (
            <Pressable
              key={action.label}
              onPress={() => run(action)}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              style={{
                width: ACTION_WIDTH,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: bg,
                paddingHorizontal: 8,
              }}
            >
              <Text
                numberOfLines={2}
                // `control`: the panel is a fixed 84pt wide, so this label
                // shares pinned geometry with its siblings and cannot reflow.
                {...typeCap("control")}
                style={{
                  color: fg,
                  fontFamily: FONT.semibold,
                  ...typeStyle("control"),
                  textAlign: "center",
                }}
              >
                {action.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    ),
    [colorFor, run, t],
  );

  const allActions = [...(left ?? []), ...(right ?? [])];

  // No actions configured → don't pay for a gesture handler at all.
  if (!enabled || allActions.length === 0) {
    return <>{children}</>;
  }

  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={2}
      // Open only after a deliberate pull past half the panel, so a horizontal
      // wobble during a vertical list scroll never latches a destructive action.
      leftThreshold={ACTION_WIDTH * 0.6}
      rightThreshold={ACTION_WIDTH * 0.6}
      overshootFriction={8}
      {...(left?.length ? { renderLeftActions: () => renderPanel(left) } : {})}
      {...(right?.length ? { renderRightActions: () => renderPanel(right) } : {})}
      onSwipeableWillOpen={() => haptics.tap()}
    >
      <View
        // The row itself carries the actions for assistive tech. VoiceOver
        // announces "Actions available" and exposes each by name in the rotor.
        accessibilityActions={allActions.map((a) => ({
          name: a.label,
          label: a.label,
        }))}
        onAccessibilityAction={(event) => {
          const match = allActions.find(
            (a) => a.label === event.nativeEvent.actionName,
          );
          if (match) run(match);
        }}
        {...(accessibilityLabel ? { accessibilityLabel } : {})}
      >
        {children}
      </View>
    </ReanimatedSwipeable>
  );
}
