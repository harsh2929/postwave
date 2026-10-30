/**
 * TourTooltip — the floating speech bubble with copy + Next/Back/Skip.
 *
 * Placement strategy:
 *
 *   - "center" (welcome / outro): horizontally + vertically centered.
 *   - "top": tooltip sits above the spotlight rect.
 *   - "bottom": tooltip sits below the spotlight rect.
 *   - "auto": pick the side with more vertical space.
 *
 * A step's side is a PREFERENCE, not an instruction — it is honoured only
 * when the card fits there, and the resolved rect is always clamped inside
 * the safe area. That arithmetic moved out to `@/lib/tourTooltipPlacement`,
 * which carries the full account of the trap it replaces (an anchored card
 * placed below the bottom of the screen, with no reachable control on it).
 * It is pure and node-tested; this component only feeds it geometry.
 *
 * Feeding it geometry means knowing our own HEIGHT, which the old code went
 * out of its way to avoid — it anchored "top" placements by `bottom:` for
 * exactly that reason. We measure with `onLayout` instead and re-resolve;
 * before the first layout pass a deliberate over-estimate stands in, because
 * over-estimating flips the card early (harmless) while under-estimating
 * hangs it off an edge (the bug).
 *
 * Width is clamped to the safe band (and ≤420) so we never run into the
 * left/right edges. Buttons have ≥44pt hit targets per iOS HIG.
 *
 * Animation: scale 0.96 → 1 + opacity 0 → 1 over 220ms when the step
 * changes. Reduced-motion users get instant.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dimensions,
  type LayoutChangeEvent,
  type LayoutRectangle,
  Pressable,
  Text,
  View,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { EdgeInsets } from "react-native-safe-area-context";

import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { resolveTooltipPlacement } from "@/lib/tourTooltipPlacement";
import { typeCap, typeStyle } from "@/lib/typeScale";

import type { TourRect, TourStep } from "./types";

const MIN_TAP_TARGET = 44;
/**
 * Stand-in height for the frame before `onLayout` reports the real one:
 * heading + two lines of body + the dot row + a 44pt action row inside 18pt
 * padding, rounded UP. Erring high is the safe direction — see the header.
 */
const ESTIMATED_CARD_HEIGHT = 260;

interface TourTooltipProps {
  step: TourStep;
  stepIndex: number;
  totalSteps: number;
  rect: TourRect | null;
  windowSize: LayoutRectangle;
  insets: EdgeInsets;
  reducedMotion: boolean;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

export function TourTooltip({
  step,
  stepIndex,
  totalSteps,
  rect,
  windowSize,
  insets,
  reducedMotion,
  onNext,
  onBack,
  onSkip,
}: TourTooltipProps) {
  const { t } = useTheme();
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.96);

  // Animate in on every step change.
  useEffect(() => {
    if (reducedMotion) {
      opacity.value = 1;
      scale.value = 1;
      return;
    }
    opacity.value = 0;
    scale.value = 0.96;
    opacity.value = withTiming(1, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
    });
    scale.value = withTiming(1, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
    });
  }, [step.id, reducedMotion, opacity, scale]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  const isFirst = stepIndex === 0;
  const isLast = stepIndex === totalSteps - 1;

  const dims = Dimensions.get("window");
  const screenW = windowSize.width || dims.width;
  const screenH = windowSize.height || dims.height;

  // Our own measured height, fed back into the placement resolver. Held in
  // state on purpose: the resolver needs it, and nothing about the card's
  // layout depends on `top`, so this settles in one extra frame rather than
  // oscillating.
  const [cardHeight, setCardHeight] = useState(ESTIMATED_CARD_HEIGHT);
  const onCardLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.height;
    if (!Number.isFinite(measured) || measured <= 0) return;
    setCardHeight((prev) => (Math.abs(prev - measured) < 0.5 ? prev : measured));
  }, []);

  // A step with no target — or one whose target has not been measured yet —
  // is centered. Never anchored to a stale rect.
  const anchor = step.targetId && step.placement !== "center" ? rect : null;
  const placement = useMemo(
    () =>
      resolveTooltipPlacement({
        anchor,
        requested: step.placement ?? "auto",
        viewport: { width: screenW, height: screenH },
        insets,
        cardHeight,
      }),
    [anchor, step.placement, screenW, screenH, insets, cardHeight],
  );

  const positionStyle = useMemo(
    () => ({
      position: "absolute" as const,
      left: placement.left,
      top: placement.top,
      width: placement.width,
    }),
    [placement],
  );

  return (
    <Animated.View
      style={[positionStyle, animStyle]}
      pointerEvents="box-none"
      // The resolved rect is the thing that traps people when it is wrong, so
      // it is addressable from a test.
      testID="tour-tooltip-card"
    >
      <View
        onLayout={onCardLayout}
        style={{
          width: "100%",
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 18,
          padding: 18,
          // Soft shadow so the bubble lifts off the dimmed backdrop.
          shadowColor: "#000",
          shadowOpacity: 0.35,
          shadowRadius: 18,
          shadowOffset: { width: 0, height: 8 },
          elevation: 10,
        }}
        accessibilityRole="alert"
        accessibilityLabel={`${step.title}. ${step.body}`}
      >
        <Text
          accessibilityRole="header"
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontWeight: "700",
            fontFamily: FONT.bold,
            letterSpacing: -0.2,
            marginBottom: 6,
          }}
        >
          {step.title}
        </Text>
        <Text
          {...typeCap("callout")}
          style={{
            color: t.fgMuted,
            ...typeStyle("callout"),
            fontFamily: FONT.regular,
          }}
        >
          {step.body}
        </Text>

        {/* Dot indicator. Subtle, no "Step N of M" text. */}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "center",
            gap: 6,
            marginTop: 16,
            marginBottom: 14,
          }}
          accessibilityLabel={`Step ${stepIndex + 1} of ${totalSteps}`}
        >
          {Array.from({ length: totalSteps }).map((_, i) => (
            <View
              key={i}
              style={{
                width: i === stepIndex ? 18 : 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: i === stepIndex ? t.accent : t.borderSubtle,
              }}
            />
          ))}
        </View>

        {/* Action row. Touch-friendly: 44pt minimum hit targets. */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Pressable
            onPress={onSkip}
            accessibilityRole="button"
            accessibilityLabel="Skip tour"
            hitSlop={8}
            style={{
              minHeight: MIN_TAP_TARGET,
              paddingHorizontal: 8,
              paddingVertical: 10,
              justifyContent: "center",
              opacity: 1,
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("control"),
                fontWeight: "500",
                fontFamily: FONT.medium,
              }}
            >
              Skip
            </Text>
          </Pressable>

          <View style={{ flexDirection: "row", gap: 8 }}>
            {!isFirst ? (
              <Pressable
                onPress={onBack}
                accessibilityRole="button"
                accessibilityLabel="Previous step"
                hitSlop={8}
                style={{
                  minHeight: MIN_TAP_TARGET,
                  minWidth: 72,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: t.border,
                  backgroundColor: t.surface,
                  alignItems: "center",
                  justifyContent: "center",
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
                  Back
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={onNext}
              accessibilityRole="button"
              accessibilityLabel={isLast ? "Finish tour" : "Next step"}
              hitSlop={8}
              style={{
                minHeight: MIN_TAP_TARGET,
                minWidth: 96,
                paddingHorizontal: 16,
                paddingVertical: 10,
                borderRadius: 10,
                backgroundColor: t.accent,
                alignItems: "center",
                justifyContent: "center",
                opacity: 1,
              }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: t.accentFg,
                  ...typeStyle("control"),
                  fontWeight: "700",
                  fontFamily: FONT.bold,
                }}
              >
                {isLast ? "Finish" : isFirst ? "Let's go" : "Next"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Animated.View>
  );
}
