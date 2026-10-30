/**
 * ChecklistConfetti — the getting-started card's celebratory burst.
 *
 * Split out of OnboardingChecklist so that card stays under its source
 * budget; the behaviour is unchanged. Count, palette, stagger, flight
 * duration and easing all come from the shared @postwave/design-tokens
 * motion tokens, so this burst and the tour's are the same gesture.
 *
 * The CALLER decides whether it runs: OnboardingChecklist only mounts this
 * when reduce-motion is off. Nothing here re-reads that setting, so there is
 * exactly one place the decision lives.
 */
import { useEffect, useMemo } from "react";
import { View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { motion } from "@postwave/design-tokens";

import { useTheme } from "@/lib/theme";

export function ChecklistConfetti() {
  const { theme } = useTheme();
  const palette =
    theme === "light"
      ? motion.confetti.paletteLight
      : motion.confetti.paletteDark;
  const items = useMemo(() => {
    return Array.from({ length: motion.confetti.count }, (_, i) => {
      const dx = (Math.random() - 0.5) * 220;
      const dy = -60 - Math.random() * 140;
      const rot = (Math.random() - 0.5) * 720;
      const color = palette[i % palette.length] ?? palette[0];
      const size = 5 + Math.random() * 5;
      const delay = i * motion.confetti.staggerMs;
      return { i, dx, dy, rot, color, size, delay };
    });
  }, [palette]);

  return (
    <View
      pointerEvents="none"
      style={{ position: "absolute", top: 16, left: "50%" }}
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
  const opacity = useSharedValue(0);

  useEffect(() => {
    const dur = motion.confetti.flightMs;
    const ease = Easing.bezier(...motion.easing.decelerate.bezier);
    // Sequence the opacity (fade in → hold → fade out). Assigning two timings
    // back-to-back would cancel the first, animating 0→0 (invisible burst).
    opacity.value = withSequence(
      withTiming(1, { duration: Math.max(delay, 1) }),
      withTiming(1, { duration: dur * 0.5 }),
      withTiming(0, { duration: dur * 0.5 }),
    );
    translateX.value = withTiming(dx, { duration: dur, easing: ease });
    translateY.value = withTiming(dy, { duration: dur, easing: ease });
    rotate.value = withTiming(rot, { duration: dur });
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
