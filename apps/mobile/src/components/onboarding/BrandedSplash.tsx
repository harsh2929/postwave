/**
 * BrandedSplash — a lightweight branded launch overlay shown briefly on
 * cold start, painted OVER the native Expo splash as it dismisses so the
 * hand-off to the app reads as one continuous brand moment rather than a
 * hard cut to a blank screen.
 *
 * We deliberately do NOT generate or wire binary splash assets here (that
 * is risky to do safely from code). Instead this composes the wordmark
 * from styled Views + Text on the brand ink canvas (app.json already sets
 * `expo.splash.backgroundColor` to the same ink, so there's no flash
 * between the native splash and this overlay).
 *
 * Lifecycle: mount it at the root once the app is `ready`; it fades itself
 * out after a short beat and then unmounts via `onDone`. Reduced-motion
 * users get an instant dismissal. STATIC styles only.
 */
import { useEffect } from "react";
import { Text, View } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  useReducedMotion,
} from "react-native-reanimated";

import { motion, dark as brandDark } from "@postwave/design-tokens";

import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";

interface BrandedSplashProps {
  /** Called once the overlay has fully faded out and should unmount. */
  onDone: () => void;
  /** How long to hold the brand mark before fading (ms). Default 650. */
  holdMs?: number;
}

export function BrandedSplash({ onDone, holdMs = 650 }: BrandedSplashProps) {
  const opacity = useSharedValue(1);
  const markScale = useSharedValue(0.96);
  // One source for the preference (reanimated's hook, which is synchronous
  // and tracks OS changes), instead of an async AccessibilityInfo read that
  // every animating component re-implemented and that left the first paint
  // waiting on a promise.
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion) {
      // Instant: no animation, hand off on the next tick.
      opacity.value = 0;
      const id = setTimeout(() => onDone(), 0);
      return () => clearTimeout(id);
    }
    markScale.value = withTiming(1, {
      duration: motion.durations.tooltipEnterMs,
      easing: Easing.bezier(...motion.easing.spring.bezier),
    });
    opacity.value = withDelay(
      holdMs,
      withTiming(
        0,
        {
          duration: motion.durations.exitMs,
          easing: Easing.bezier(...motion.easing.accelerate.bezier),
        },
        (finished) => {
          if (finished) runOnJS(onDone)();
        },
      ),
    );
    return undefined;
  }, [reducedMotion, holdMs, opacity, markScale, onDone]);

  const containerStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const markStyle = useAnimatedStyle(() => ({
    transform: [{ scale: markScale.value }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          backgroundColor: brandDark.bg,
          alignItems: "center",
          justifyContent: "center",
        },
        containerStyle,
      ]}
    >
      <Animated.View style={[{ alignItems: "center" }, markStyle]}>
        {/* Ember spark over the wordmark — the single brand accent. */}
        <View
          style={{
            width: 14,
            height: 14,
            borderRadius: 7,
            backgroundColor: brandDark.accent,
            marginBottom: 14,
          }}
        />
        <Text
          // The wordmark is a BRAND MARK inside a centred splash, not copy:
          // it is the whole screen and reflowing it at 3x would break the
          // logo lockup. Capped like a hero figure, never uncapped.
          {...typeCap("figure")}
          style={{
            color: brandDark.fg,
            fontSize: 34,
            fontWeight: "800",
            fontFamily: FONT.display,
            letterSpacing: -0.8,
          }}
        >
          Moosewave
        </Text>
      </Animated.View>
    </Animated.View>
  );
}
