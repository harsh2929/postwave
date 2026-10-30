/**
 * useSheetTriggerRefs — remember which control opened the sheet that is
 * currently up, so dismissing it hands screen-reader focus back to that
 * control.
 *
 * WHY THIS EXISTS. When a `Modal` closes, iOS gives VoiceOver focus to
 * whatever UIKit picks — in practice the top of the presenting screen. The
 * campaign detail screen's action row is up to eleven buttons wide, so a
 * blind operator who opened "Send test", closed it, and wanted "Schedule"
 * next had to swipe the entire header, notices, summary card and half the
 * action row again. Every dismissal cost that re-navigation.
 *
 * `KeyboardFormSheet` already accepts `returnFocusRef` and focuses it a frame
 * after the sheet tears down (setting focus while the modal is still on screen
 * is silently ignored). The missing half was a screen with N triggers and ONE
 * sheet-state variable having no way to say which of the N to go back to.
 *
 * This is that missing half, and nothing more: a lazily-populated map from the
 * sheet key to the ref its trigger is bound to. `refFor` is called during
 * render for each button, so by the time a sheet is open its trigger's ref is
 * already in the map and `activeRef` can resolve it.
 *
 * Deliberately NOT state: a ref object is stable for the life of the screen,
 * and re-rendering because a button mounted would be a re-render for nothing.
 */
import { useCallback, useRef } from "react";
import type { View } from "react-native";

/** A mutable ref cell holding a mounted view, or null before it mounts. */
export type TriggerRef = { current: View | null };

export interface SheetTriggerRefs<K extends string> {
  /**
   * The ref to bind to the control that opens `key`. Stable across renders —
   * the same cell comes back every time, so binding it in a render body does
   * not hand the Pressable a fresh ref on each pass.
   */
  refFor: (key: K) => TriggerRef;
  /**
   * The ref for the sheet that is currently open, or undefined when nothing is
   * open or the open sheet has no registered trigger (a deep link, say). The
   * undefined case is the honest one: focus restoration is best-effort, and a
   * sheet nobody pressed a button to reach has nowhere to return to.
   */
  activeRef: (key: K | null) => TriggerRef | undefined;
}

export function useSheetTriggerRefs<K extends string>(): SheetTriggerRefs<K> {
  const cells = useRef<Map<K, TriggerRef>>(new Map());
  const refFor = useCallback((key: K): TriggerRef => {
    const existing = cells.current.get(key);
    if (existing) return existing;
    const created: TriggerRef = { current: null };
    cells.current.set(key, created);
    return created;
  }, []);
  const activeRef = useCallback(
    (key: K | null): TriggerRef | undefined =>
      key === null ? undefined : cells.current.get(key),
    [],
  );
  return { refFor, activeRef };
}
