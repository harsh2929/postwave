/**
 * OnboardingChecklist — the dashboard getting-started card.
 *
 * Fetches GET /api/v1/onboarding-progress (via useOnboardingProgressQuery)
 * and renders the canonical CHECKLIST_GOALS against real per-goal
 * completion. Goals are tiered: the PATH_TO_SEND_GOALS spine is heroed at
 * the top; the hardening goals collapse behind a "Show N more" toggle so
 * the card stays light. An animated reanimated progress ring tracks the
 * completed fraction; when every goal is done the card flips to a brief
 * confetti celebration.
 *
 * Persistence: dismissal is stored under
 *   postwave_onboarding_checklist_dismissed
 * Once dismissed (or once all_done) the host stops mounting it.
 *
 * Reduced-motion: ring fill + confetti drop to instant / hidden. The
 * preference comes from reanimated's `useReducedMotion()`, the one source.
 *
 * NativeWind v4: STATIC Pressable styles only (function-style `style`
 * silently drops layout).
 */
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withTiming,
  useReducedMotion,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";

import { motion } from "@postwave/design-tokens";
import {
  CHECKLIST_GOALS,
  PATH_TO_SEND_GOALS,
  isGoalComplete,
  type ChecklistGoal,
} from "@postwave/onboarding-schema";

import { Card } from "@/components/Card";
import { FONT } from "@/lib/fonts";
import { dismissChecklist } from "@/lib/onboardingDecisions";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

import { ChecklistConfetti } from "./ChecklistConfetti";
import { ONBOARDING_EVENTS, trackOnboarding } from "./analytics";
import { routeForOnboardingKey } from "./onboardingRoutes";
import { useOnboardingProgressQuery } from "./useOnboardingProgress";

// Re-exported from the shared decision module so the existing importers keep
// one spelling of the key. The decision itself now lives server-side; this is
// only the offline cache.
export { CHECKLIST_DISMISSED_KEY } from "@/lib/onboardingDecisions";

const RING_SIZE = 56;
const RING_STROKE = 6;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const MIN_TAP_TARGET = 44;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

interface OnboardingChecklistProps {
  /** Called once the user dismisses or fully completes the checklist. */
  onDismissed?: () => void;
}

export function OnboardingChecklist({ onDismissed }: OnboardingChecklistProps) {
  const { t } = useTheme();
  const query = useOnboardingProgressQuery();
  const progress = query.data;

  // One source for the preference: reanimated's hook, synchronous and
  // OS-change-aware. The async AccessibilityInfo read + listener this replaced
  // was copied into four components; the guard in lib/reduceMotionCoverage now
  // forbids that shape.
  const reducedMotion = useReducedMotion();
  const [showHardening, setShowHardening] = useState(false);

  // checklist_viewed — once per mount, after progress lands.
  const viewedRef = useRef(false);
  useEffect(() => {
    if (!progress || viewedRef.current) return;
    viewedRef.current = true;
    trackOnboarding(ONBOARDING_EVENTS.checklistViewed, {
      completed: progress.completed,
      total: progress.total,
    });
  }, [progress]);

  // Emit only real transitions observed after the initial snapshot. Firing
  // every already-complete goal on mount would attribute historical setup to
  // the current session.
  const previousCompletedKeysRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!progress) return;
    const current = new Set(
      // The null check guards the PARENT, not its array field. `omitempty` drops an empty slice and the field is then undefined, so the iteration below throws on a payload the server considers valid.
      (Array.isArray(progress.steps) ? progress.steps : [])
        .filter((step) => step.completed)
        .map((step) => step.key),
    );
    const previous = previousCompletedKeysRef.current;
    if (previous) {
      for (const key of current) {
        if (!previous.has(key)) {
          trackOnboarding(ONBOARDING_EVENTS.checklistGoalCompleted, { key });
        }
      }
    }
    previousCompletedKeysRef.current = current;
  }, [progress]);

  // checklist_completed — fire exactly once when the tenant crosses to all-done.
  const completedFiredRef = useRef(false);
  useEffect(() => {
    if (!progress?.all_done || completedFiredRef.current) return;
    completedFiredRef.current = true;
    trackOnboarding(ONBOARDING_EVENTS.checklistCompleted, {
      total: progress.total,
    });
    trackOnboarding(ONBOARDING_EVENTS.milestoneCelebrated, {
      milestone: "onboarding_complete",
    });
  }, [progress]);

  // Animated ring: fraction 0→1 of completed goals.
  const fraction = useMemo(() => {
    if (!progress || progress.total === 0) return 0;
    return Math.max(0, Math.min(1, progress.completed / progress.total));
  }, [progress]);

  const dash = useSharedValue(0);
  useEffect(() => {
    const target = RING_CIRCUMFERENCE * (1 - fraction);
    if (reducedMotion) {
      dash.value = target;
      return;
    }
    dash.value = withTiming(target, {
      duration: motion.durations.ringFillMs,
      easing: Easing.bezier(...motion.easing.decelerate.bezier),
    });
  }, [fraction, reducedMotion, dash]);

  const ringProps = useAnimatedProps(() => ({
    strokeDashoffset: dash.value,
  }));

  async function dismiss(): Promise<void> {
    // Records the decision for this PERSON, not this device: writing only the
    // local key meant the same checklist reappeared on desktop and web, and the
    // product asked the same question again on every surface.
    await dismissChecklist();
    onDismissed?.();
  }

  // Loading / error / no-data: render nothing (the host's empty-state copy
  // already covers a cold workspace; we don't want a skeleton flash).
  if (query.isLoading || query.isError || !progress) return null;

  const allDone = progress.all_done;
  const pathGoals = PATH_TO_SEND_GOALS;
  const hardeningGoals = CHECKLIST_GOALS.filter((g) => g.tier === "hardening");
  const hardeningRemaining = hardeningGoals.filter(
    (g) => !isGoalComplete(progress, g.key),
  ).length;

  return (
    <Card
      style={{ marginTop: 14, overflow: "hidden" }}
      accessibilityLabel={
        allDone
          ? "Getting started: complete"
          : `Getting started: ${progress.completed} of ${progress.total} done`
      }
    >
      {allDone ? (
        <AllDoneHeader reducedMotion={reducedMotion} />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
          <ProgressRing
            fraction={fraction}
            percent={progress.percent}
            ringProps={ringProps}
          />
          <View style={{ flex: 1 }}>
            <Text
              accessibilityRole="header"
              {...typeCap("heading")}
              style={{
                color: t.fg,
                ...typeStyle("heading"),
                fontWeight: "700",
                fontFamily: FONT.bold,
                letterSpacing: -0.2,
              }}
            >
              Get to your first send
            </Text>
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgMuted,
                ...typeStyle("label"),
                marginTop: 2,
                fontFamily: FONT.regular,
              }}
            >
              {progress.completed} of {progress.total} done · pick up where you
              left off.
            </Text>
          </View>
          <Pressable
            onPress={() => void dismiss()}
            accessibilityRole="button"
            accessibilityLabel="Dismiss getting-started checklist"
            hitSlop={8}
            style={{
              minWidth: MIN_TAP_TARGET,
              minHeight: MIN_TAP_TARGET,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* Decorative glyph standing in for a close icon inside a fixed
                44pt target — meaning lives on the button's a11y label. */}
            <Text
              allowFontScaling={false}
              style={{
                color: t.fgSubtle,
                fontSize: 18,
                fontFamily: FONT.regular,
              }}
            >
              ×
            </Text>
          </Pressable>
        </View>
      )}

      {/* Hero tier: the path-to-first-send spine. */}
      <View style={{ marginTop: allDone ? 4 : 14, gap: 8 }}>
        {pathGoals.map((goal) => (
          <GoalRow
            key={goal.key}
            goal={goal}
            done={isGoalComplete(progress, goal.key)}
            hero
          />
        ))}
      </View>

      {/* Hardening tier: recessed behind a toggle. */}
      {hardeningGoals.length > 0 ? (
        <>
          <Pressable
            onPress={() => setShowHardening((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={
              showHardening
                ? "Hide hardening steps"
                : `Show ${hardeningRemaining} more hardening steps`
            }
            hitSlop={8}
            style={{
              minHeight: MIN_TAP_TARGET,
              justifyContent: "center",
              marginTop: 8,
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                ...typeStyle("control"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              {showHardening
                ? "Hide hardening steps"
                : `Make it durable · ${hardeningRemaining} more`}
            </Text>
          </Pressable>
          {showHardening ? (
            <View style={{ gap: 8, marginTop: 4 }}>
              {hardeningGoals.map((goal) => (
                <GoalRow
                  key={goal.key}
                  goal={goal}
                  done={isGoalComplete(progress, goal.key)}
                  hero={false}
                />
              ))}
            </View>
          ) : null}
        </>
      ) : null}

      {allDone ? (
        <Pressable
          onPress={() => void dismiss()}
          accessibilityRole="button"
          accessibilityLabel="Dismiss getting-started checklist"
          hitSlop={8}
          style={{
            minHeight: MIN_TAP_TARGET,
            alignItems: "center",
            justifyContent: "center",
            marginTop: 10,
            borderRadius: 10,
            backgroundColor: t.surfaceElevated,
            paddingVertical: 10,
          }}
        >
          <Text
            {...typeCap("control")}
            style={{
              color: t.fg,
              ...typeStyle("control"),
              fontWeight: "600",
              fontFamily: FONT.semibold,
            }}
          >
            Dismiss
          </Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

/** A single checklist goal row: status dot, label/desc, optional Go CTA. */
function GoalRow({
  goal,
  done,
  hero,
}: {
  goal: ChecklistGoal;
  done: boolean;
  hero: boolean;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        opacity: done ? 0.7 : 1,
      }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          borderWidth: done ? 0 : 1.5,
          borderColor: t.border,
          backgroundColor: done ? t.success : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
        accessibilityLabel={done ? "Completed" : "Not done"}
      >
        {done ? (
          <Text
            // Decorative tick inside a fixed 20pt dot; "Completed" is spoken
            // by the dot's own a11y label.
            allowFontScaling={false}
            style={{ color: t.accentFg, fontSize: 11, fontFamily: FONT.bold }}
          >
            ✓
          </Text>
        ) : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fg,
            ...typeStyle("callout"),
            fontWeight: hero ? "600" : "500",
            fontFamily: hero ? FONT.semibold : FONT.medium,
            textDecorationLine: done ? "line-through" : "none",
          }}
          numberOfLines={1}
        >
          {goal.label}
        </Text>
        {hero && !done ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              marginTop: 1,
              fontFamily: FONT.regular,
            }}
            numberOfLines={2}
          >
            {goal.description}
          </Text>
        ) : null}
      </View>
      {!done ? (
        <Pressable
          onPress={() =>
            router.push(routeForOnboardingKey(goal.ctaRouteKey) as never)
          }
          accessibilityRole="button"
          accessibilityLabel={`Go to ${goal.label}`}
          hitSlop={8}
          style={{
            minHeight: MIN_TAP_TARGET,
            minWidth: 56,
            paddingHorizontal: 12,
            justifyContent: "center",
            alignItems: "center",
            borderRadius: 9,
            borderWidth: 1,
            borderColor: hero ? t.accent : t.border,
            backgroundColor: hero ? t.accentSubtle : "transparent",
          }}
        >
          <Text
            {...typeCap("badge")}
            style={{
              color: hero ? t.accent : t.fg,
              ...typeStyle("badge"),
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            Go
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The animated SVG progress ring with a center percentage label. */
function ProgressRing({
  fraction,
  percent,
  ringProps,
}: {
  fraction: number;
  percent: number;
  ringProps: Partial<{ strokeDashoffset: number }>;
}) {
  const { t } = useTheme();
  void fraction;
  return (
    <View
      style={{ width: RING_SIZE, height: RING_SIZE }}
      accessibilityLabel={`${percent} percent complete`}
    >
      <Svg width={RING_SIZE} height={RING_SIZE}>
        <Circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          stroke={t.borderSubtle}
          strokeWidth={RING_STROKE}
          fill="none"
        />
        <AnimatedCircle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          stroke={t.accent}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={RING_CIRCUMFERENCE}
          // Rotate so the ring fills from 12 o'clock.
          originX={RING_SIZE / 2}
          originY={RING_SIZE / 2}
          rotation={-90}
          animatedProps={ringProps}
        />
      </Svg>
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          // Pinned inside a fixed-diameter SVG ring: `numeric`, the tightest
          // tabular ceiling, or the label spills out of the circle.
          {...typeCap("numeric")}
          style={{
            color: t.fg,
            ...typeStyle("numeric"),
            fontWeight: "800",
            fontFamily: FONT.display,
            fontVariant: ["tabular-nums"],
          }}
        >
          {percent}%
        </Text>
      </View>
    </View>
  );
}

/** Header shown when every goal is complete — a brief celebratory beat. */
function AllDoneHeader({ reducedMotion }: { reducedMotion: boolean }) {
  const { t } = useTheme();
  return (
    <View style={{ alignItems: "center", paddingVertical: 4 }}>
      {!reducedMotion ? <ChecklistConfetti /> : null}
      <View
        style={{
          width: 48,
          height: 48,
          borderRadius: 24,
          backgroundColor: t.success,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text
          // Decorative tick inside a fixed 48pt disc.
          allowFontScaling={false}
          style={{ color: t.accentFg, fontSize: 22, fontFamily: FONT.bold }}
        >
          ✓
        </Text>
      </View>
      <Text
        accessibilityRole="header"
        {...typeCap("heading")}
        style={{
          color: t.fg,
          ...typeStyle("heading"),
          fontWeight: "800",
          fontFamily: FONT.display,
          marginTop: 10,
        }}
      >
        You&apos;re fully set up
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          marginTop: 2,
          textAlign: "center",
          fontFamily: FONT.regular,
        }}
      >
        Every getting-started step is done. Nice work.
      </Text>
    </View>
  );
}
