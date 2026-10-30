/**
 * useRestoreListScroll — the FlatList sibling of useRestoreScroll.
 *
 *   const scroll = useRestoreListScroll("campaigns");
 *   <FlatList ref={scroll.ref} onScroll={scroll.onScroll}
 *             scrollEventThrottle={scroll.scrollEventThrottle} />
 *
 * Separate from useRestoreScroll because the two imperative APIs are not the
 * same: ScrollView exposes `scrollTo`, FlatList exposes `scrollToOffset`, and
 * a single hook typed for both would have to widen its ref to `any`.
 *
 * WHY IT MATTERS MORE HERE. The shell screens it was written for are a fixed
 * height; an auto-paginating list is not. The campaigns list loads page after
 * page as you scroll, so returning from a campaign detail did not merely drop
 * you at the top — it dropped you at the top of a list you had spent several
 * fetches getting to the bottom of, making deep browsing impractical.
 *
 * Restoration is never animated, and it is deferred one frame: on return the
 * list has not re-measured its content, and `scrollToOffset` past the current
 * content height is silently clamped to the end.
 */
import { useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";
import type {
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from "react-native";

import { recallScrollOffset, rememberScrollOffset } from "@/lib/scrollMemory";

export interface RestoreListScrollBinding<T> {
  ref: React.RefObject<FlatList<T> | null>;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  scrollEventThrottle: number;
  /** Jump to the top — for a "back to top" affordance or a filter change. */
  scrollToTop: () => void;
}

export function useRestoreListScroll<T>(
  key: string,
): RestoreListScrollBinding<T> {
  const ref = useRef<FlatList<T> | null>(null);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      rememberScrollOffset(key, event.nativeEvent.contentOffset?.y);
    },
    [key],
  );

  const scrollToTop = useCallback(() => {
    ref.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  useFocusEffect(
    useCallback(() => {
      const y = recallScrollOffset(key);
      if (y === null) return;
      const frame = requestAnimationFrame(() => {
        ref.current?.scrollToOffset({ offset: y, animated: false });
      });
      return () => cancelAnimationFrame(frame);
    }, [key]),
  );

  return { ref, onScroll, scrollEventThrottle: 64, scrollToTop };
}
