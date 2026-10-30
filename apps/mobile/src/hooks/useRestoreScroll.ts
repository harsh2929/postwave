/**
 * useRestoreScroll — put a ScrollView back where the user left it.
 *
 *   const scroll = useRestoreScroll("more");
 *   <ScrollView ref={scroll.ref} onScroll={scroll.onScroll}
 *               scrollEventThrottle={scroll.scrollEventThrottle}>
 *
 * Applies to the two long shell screens (More, Settings): navigating into a
 * destination and coming back used to drop you at the top, so a user
 * configuring webhooks re-scrolled the full height of Settings every time.
 *
 * Restoration is NEVER animated. An animated restore reads as the screen
 * scrolling itself while the user is looking at it, and would ignore the
 * reduce-motion preference for no benefit — the point is to arrive where you
 * were, not to be shown the journey.
 *
 * The restore is deferred one frame because on return the ScrollView's content
 * has not been laid out yet, and scrollTo beyond the current content height is
 * clamped away.
 */
import { useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";
import type {
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
} from "react-native";

import { recallScrollOffset, rememberScrollOffset } from "@/lib/scrollMemory";

export interface RestoreScrollBinding {
  ref: React.RefObject<ScrollView | null>;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  scrollEventThrottle: number;
}

export function useRestoreScroll(key: string): RestoreScrollBinding {
  const ref = useRef<ScrollView | null>(null);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      rememberScrollOffset(key, event.nativeEvent.contentOffset?.y);
    },
    [key],
  );

  useFocusEffect(
    useCallback(() => {
      const y = recallScrollOffset(key);
      if (y === null) return;
      // One frame of slack: on return the content has not been measured yet,
      // and a scrollTo past the current content height is silently clamped.
      const frame = requestAnimationFrame(() => {
        ref.current?.scrollTo({ y, animated: false });
      });
      return () => cancelAnimationFrame(frame);
    }, [key]),
  );

  return { ref, onScroll, scrollEventThrottle: 64 };
}
