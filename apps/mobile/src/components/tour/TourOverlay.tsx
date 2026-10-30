/**
 * TourOverlay — full-screen backdrop + spotlight cut-out + tooltip.
 *
 * The spotlight is implemented as four rectangles painted around the
 * target's measured rect:
 *
 *   ┌──────────────────────┐
 *   │       TOP            │
 *   ├─────┬──────────┬─────┤
 *   │ L   │  HOLE    │  R  │
 *   ├─────┴──────────┴─────┤
 *   │       BOTTOM         │
 *   └──────────────────────┘
 *
 * Each is a darkened View; the union covers the screen except for the
 * target's rect, simulating a cut-out without `<MaskedView>` (which
 * isn't a default Expo dependency). Rounded corners on the hole are
 * faked with a semi-transparent rounded-corner ring rendered on top of
 * the four-rect mask.
 *
 * For "no-target" steps (welcome, outro), we render a single full-
 * screen backdrop and let the tooltip center itself.
 *
 * The component is a single source of truth for animation. The
 * spotlight rect animates between steps via a 280ms ease-out, the
 * tooltip crossfades + scales 220ms. A subtle pulse loop (1.6s) draws
 * a glow ring around the cut-out to reinforce "look here". Reduced-
 * motion users get instant transitions and no pulse.
 *
 * Confetti on the outro is intentionally tiny: 18 small Views with
 * randomized rotation/translation animated for 1.2s. No third-party
 * library — reanimated handles the math, mounting/unmounting via the
 * `isLastStep` flag.
 */
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dimensions,
  type LayoutRectangle,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { motion, reducedMotion as reducedMotionTokens } from "@postwave/design-tokens";

import { useTheme } from "@/lib/theme";

import { useTour } from "./TourProvider";
import { TourScrim } from "./TourScrim";
import { TourTooltip } from "./TourTooltip";
import type { TourRect, TourStep } from "./types";

const SPOTLIGHT_PADDING_DEFAULT = 12;
const SPOTLIGHT_RADIUS = 12;
const BACKDROP_COLOR = "rgba(8, 12, 24, 0.78)";

/** A best-effort no-target rect (centered, off-screen) for welcome/outro. */
function makeCenterRect(): TourRect {
  const { width, height } = Dimensions.get("window");
  return {
    x: width / 2 - 1,
    y: height / 2 - 1,
    width: 2,
    height: 2,
  };
}

export function TourOverlay() {
  const { active, stepIndex, steps, getTarget, reducedMotion, next, back, skip } =
    useTour();
  const { t } = useTheme();
  const insets = useSafeAreaInsets();

  const step: TourStep | undefined = active ? steps[stepIndex] : undefined;

  // The target rect (in window coords). We measure imperatively when
  // the step changes — we don't want to keep this in render-driven
  // state because measureInWindow is fundamentally async.
  const [rect, setRect] = useState<TourRect | null>(null);

  // Track screen size for tooltip placement bounds. Update on rotate.
  const [windowSize, setWindowSize] = useState<LayoutRectangle>(() => {
    const dims = Dimensions.get("window");
    return { x: 0, y: 0, width: dims.width, height: dims.height };
  });

  useEffect(() => {
    const sub = Dimensions.addEventListener("change", ({ window }) => {
      setWindowSize({ x: 0, y: 0, width: window.width, height: window.height });
    });
    return () => sub.remove();
  }, []);

  // Animated values for the spotlight rect. We animate between rects
  // using shared values + reanimated worklets so the transition runs
  // on the UI thread.
  const spotX = useSharedValue(0);
  const spotY = useSharedValue(0);
  const spotW = useSharedValue(0);
  const spotH = useSharedValue(0);
  const spotOpacity = useSharedValue(0);
  const pulse = useSharedValue(0);

  // Track whether we've ever measured a rect for the current step so we
  // can hold the backdrop opaque while waiting on the first measure
  // (prevents a flash of empty overlay).
  const prevStepIdRef = useRef<string | null>(null);

  // ——— Resolve the target rect for the current step ———
  useEffect(() => {
    if (!step || !active) {
      setRect(null);
      spotOpacity.value = withTiming(0, { duration: 180 });
      return;
    }

    let cancelled = false;
    let measureTimer: ReturnType<typeof setTimeout> | null = null;

    async function resolve() {
      // Cross-tab navigation: jump first, then measure after layout
      // settles.
      if (step?.navigateTo) {
        try {
          // `replace` rather than `push` so the back stack stays clean
          // when the user finishes the tour.
          router.replace(step.navigateTo as never);
        } catch {
          // Bad route shouldn't crash the tour — fall through and try to
          // measure the target anyway.
        }
        // Wait for layout. Two animation frames is usually enough for
        // expo-router to mount the screen + run the first paint.
        await new Promise<void>((r) => {
          measureTimer = setTimeout(r, 220);
        });
      }
      if (cancelled) return;

      // Center / no-target steps: use a synthetic rect.
      if (!step?.targetId || step.placement === "center") {
        const centered = step?.fixedRect ?? makeCenterRect();
        setRect(centered);
        return;
      }

      const target = getTarget(step.targetId);
      if (!target?.ref.current) {
        // Target not registered yet — retry once after a short wait.
        // Common when the user starts the tour mid-load.
        measureTimer = setTimeout(() => {
          if (cancelled) return;
          const t2 = getTarget(step.targetId!);
          if (t2?.ref.current) {
            t2.ref.current.measureInWindow((x, y, w, h) => {
              if (cancelled) return;
              if (
                Number.isFinite(x) &&
                Number.isFinite(y) &&
                w > 0 &&
                h > 0
              ) {
                setRect({ x, y, width: w, height: h });
              } else {
                setRect(makeCenterRect());
              }
            });
          } else {
            setRect(makeCenterRect());
          }
        }, 220);
        return;
      }

      target.ref.current.measureInWindow((x, y, w, h) => {
        if (cancelled) return;
        if (Number.isFinite(x) && Number.isFinite(y) && w > 0 && h > 0) {
          setRect({ x, y, width: w, height: h });
        } else {
          setRect(makeCenterRect());
        }
      });
    }

    void resolve();
    return () => {
      cancelled = true;
      if (measureTimer != null) clearTimeout(measureTimer);
    };
  }, [step, active, getTarget, spotOpacity]);

  // ——— Drive the spotlight animation when rect changes ———
  useEffect(() => {
    if (!rect || !step) return;
    const padding = step.spotlightPadding ?? SPOTLIGHT_PADDING_DEFAULT;
    const isCenter = step.placement === "center" || !step.targetId;
    const targetX = isCenter ? rect.x : rect.x - padding;
    const targetY = isCenter ? rect.y : rect.y - padding;
    const targetW = isCenter ? rect.width : rect.width + padding * 2;
    const targetH = isCenter ? rect.height : rect.height + padding * 2;

    const isFirstShow = prevStepIdRef.current !== step.id;
    prevStepIdRef.current = step.id;

    // Shared Reduce Motion rule (design-tokens), not a local ternary.
    const dur = (reducedMotion ? reducedMotionTokens(motion) : motion).durations.spotlightTravelMs;
    const easing = Easing.bezier(...motion.easing.decelerate.bezier);

    if (isFirstShow && spotOpacity.value === 0) {
      // Hard-set position, then fade in opacity.
      spotX.value = targetX;
      spotY.value = targetY;
      spotW.value = targetW;
      spotH.value = targetH;
      spotOpacity.value = withTiming(1, { duration: dur, easing });
    } else {
      spotX.value = withTiming(targetX, { duration: dur, easing });
      spotY.value = withTiming(targetY, { duration: dur, easing });
      spotW.value = withTiming(targetW, { duration: dur, easing });
      spotH.value = withTiming(targetH, { duration: dur, easing });
      spotOpacity.value = withTiming(1, { duration: dur, easing });
    }
  }, [rect, step, reducedMotion, spotX, spotY, spotW, spotH, spotOpacity]);

  // ——— Pulse loop on the highlight ring ———
  useEffect(() => {
    if (!active || reducedMotion) {
      cancelAnimation(pulse);
      pulse.value = 0;
      return;
    }
    pulse.value = 0;
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 800, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: 800, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
    );
    return () => {
      cancelAnimation(pulse);
    };
  }, [active, reducedMotion, pulse]);

  // ——— Animated style derivations ———
  const animatedTopStyle = useAnimatedStyle(() => ({
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: Math.max(0, spotY.value),
    backgroundColor: BACKDROP_COLOR,
  }));

  const animatedBottomStyle = useAnimatedStyle(() => ({
    position: "absolute",
    left: 0,
    right: 0,
    top: spotY.value + spotH.value,
    bottom: 0,
    backgroundColor: BACKDROP_COLOR,
  }));

  const animatedLeftStyle = useAnimatedStyle(() => ({
    position: "absolute",
    left: 0,
    top: spotY.value,
    width: Math.max(0, spotX.value),
    height: spotH.value,
    backgroundColor: BACKDROP_COLOR,
  }));

  const animatedRightStyle = useAnimatedStyle(() => ({
    position: "absolute",
    left: spotX.value + spotW.value,
    right: 0,
    top: spotY.value,
    height: spotH.value,
    backgroundColor: BACKDROP_COLOR,
  }));

  const animatedHoleBorderStyle = useAnimatedStyle(() => ({
    position: "absolute",
    left: spotX.value,
    top: spotY.value,
    width: spotW.value,
    height: spotH.value,
    borderRadius: SPOTLIGHT_RADIUS,
    borderWidth: 1.5,
    borderColor: "rgba(255, 255, 255, 0.18)",
    opacity: spotOpacity.value,
  }));

  const animatedPulseStyle = useAnimatedStyle(() => {
    const scale = 1 + pulse.value * 0.05;
    const ringOpacity = (1 - pulse.value) * 0.55;
    return {
      position: "absolute",
      left: spotX.value,
      top: spotY.value,
      width: spotW.value,
      height: spotH.value,
      borderRadius: SPOTLIGHT_RADIUS + 4,
      borderWidth: 2,
      borderColor: t.accent,
      opacity: ringOpacity,
      transform: [{ scale }],
    };
  });

  // Whether to render the highlight ring at all (skip on center steps).
  const showSpotlightChrome = useMemo(() => {
    if (!step) return false;
    if (step.placement === "center") return false;
    if (!step.targetId) return false;
    return true;
  }, [step]);

  if (!active || !step) return null;
  const isLastStep = stepIndex === steps.length - 1;

  return (
    <View
      style={StyleSheet.absoluteFillObject}
      pointerEvents="box-none"
      accessibilityViewIsModal
      accessibilityLabel="Product tour"
    >
      {/* Full-screen tap-blocker behind everything. It also DISMISSES: see
          TourScrim for why that rule changed. */}
      <TourScrim onDismiss={skip} />

      {/* Backdrop: either four rects around the spotlight, or a single
          full-screen veil for center steps. */}
      {showSpotlightChrome ? (
        <>
          <Animated.View style={animatedTopStyle} pointerEvents="none" />
          <Animated.View style={animatedBottomStyle} pointerEvents="none" />
          <Animated.View style={animatedLeftStyle} pointerEvents="none" />
          <Animated.View style={animatedRightStyle} pointerEvents="none" />
          <Animated.View style={animatedHoleBorderStyle} pointerEvents="none" />
          <Animated.View style={animatedPulseStyle} pointerEvents="none" />
        </>
      ) : (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: BACKDROP_COLOR } as ViewStyle,
          ]}
          pointerEvents="none"
        />
      )}

      {/* Tooltip floats on top, positioned by step.placement + rect. */}
      <TourTooltip
        step={step}
        stepIndex={stepIndex}
        totalSteps={steps.length}
        rect={rect}
        windowSize={windowSize}
        insets={insets}
        reducedMotion={reducedMotion}
        onNext={next}
        onBack={back}
        onSkip={skip}
      />

      {/* Confetti on the outro for a tiny celebratory beat. */}
      {isLastStep ? <Confetti reducedMotion={reducedMotion} /> : null}
    </View>
  );
}

// ————————————————————————————————————————————————————————————————
// Confetti — 18 tiny Views animated for ~1.2s.
// ————————————————————————————————————————————————————————————————

// Particle count reconciled to the shared motion token (was 18 here vs
// 24 on web/desktop). Colors come from the brand confetti palette per theme.
const CONFETTI_COUNT = motion.confetti.count;

function Confetti({ reducedMotion }: { reducedMotion: boolean }) {
  const { theme } = useTheme();
  const palette =
    theme === "light"
      ? motion.confetti.paletteLight
      : motion.confetti.paletteDark;
  const items = useMemo(() => {
    return Array.from({ length: CONFETTI_COUNT }, (_, i) => {
      const dx = (Math.random() - 0.5) * 280;
      const dy = -120 - Math.random() * 220;
      const rot = (Math.random() - 0.5) * 720;
      const color = palette[i % palette.length] ?? palette[0];
      const size = 6 + Math.random() * 6;
      const delay = Math.random() * 120;
      return { i, dx, dy, rot, color, size, delay };
    });
  }, [palette]);

  if (reducedMotion) return null;

  const { width, height } = Dimensions.get("window");
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: width / 2,
        top: height * 0.55,
      }}
    >
      {items.map((c) => (
        <ConfettiPiece key={c.i} {...c} />
      ))}
    </View>
  );
}

function ConfettiPiece({
  dx,
  dy,
  rot,
  color,
  size,
  delay,
}: {
  dx: number;
  dy: number;
  rot: number;
  color: string;
  size: number;
  delay: number;
}) {
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const rotate = useSharedValue(0);
  const opacity = useSharedValue(1);

  useEffect(() => {
    translateX.value = withTiming(dx, {
      duration: 1100,
      easing: Easing.out(Easing.cubic),
    });
    translateY.value = withSequence(
      withTiming(dy, {
        duration: 600,
        easing: Easing.out(Easing.cubic),
      }),
      withTiming(dy + 280, {
        duration: 700,
        easing: Easing.in(Easing.quad),
      }),
    );
    rotate.value = withTiming(rot, { duration: 1200 });
    opacity.value = withSequence(
      withTiming(1, { duration: delay }),
      withTiming(1, { duration: 800 }),
      withTiming(0, { duration: 400 }),
    );
  }, [dx, dy, rot, delay, translateX, translateY, rotate, opacity]);

  const style = useAnimatedStyle(() => ({
    position: "absolute",
    width: size,
    height: size * 0.5,
    borderRadius: 2,
    backgroundColor: color,
    opacity: opacity.value,
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { rotate: `${rotate.value}deg` },
    ],
  }));

  return <Animated.View style={style} />;
}
