/**
 * ScrollToTop — "tap the active tab to return to the top", without crashing a
 * screen that is rendered outside a navigator.
 *
 * `useScrollToTop` subscribes to the parent tab navigator's own tabPress
 * event, which means it calls `useRoute()` — and `useRoute()` THROWS
 * ("Couldn't find a route object") when no route context is above it. Inside
 * the app that context always exists. Inside a render test, a screenshot
 * harness, or any isolated mount of a screen component, it does not, and the
 * whole screen fails to render for the sake of a convenience gesture.
 *
 * A hook cannot be called conditionally, so the check lives in a parent that
 * decides whether to MOUNT the subscriber at all. The context's presence does
 * not flip during a screen's life, so this never changes hook order.
 */
import { useScrollToTop, NavigationRouteContext } from "@react-navigation/native";
import { useContext, type RefObject } from "react";
import type { ScrollView } from "react-native";

/**
 * Any scrollable react-navigation can drive, described STRUCTURALLY.
 *
 * `useScrollToTop` probes for `scrollToTop` → `scrollTo` → `scrollToOffset` →
 * `scrollResponderScrollTo` at call time, so a FlatList (which has
 * `scrollToOffset`) works exactly as well as a ScrollView. The prop used to be
 * typed `RefObject<ScrollView>`, which made the gesture unavailable to every
 * list screen in the app — the screens where "return to the top" matters most.
 *
 * A union of the concrete classes does NOT work: `FlatList<T>` is invariant in
 * its item type under `exactOptionalPropertyTypes`, so `FlatList<Row>` is not
 * assignable to `FlatList<unknown>`. Naming the methods is both accurate and
 * assignable from every list type.
 */
export interface ScrollToTopTarget {
  scrollToTop?: unknown;
  scrollTo?: unknown;
  scrollToOffset?: unknown;
  scrollResponderScrollTo?: unknown;
}

export interface ScrollToTopProps {
  /** The scrollable this gesture returns to the top. */
  targetRef: RefObject<ScrollToTopTarget | null>;
}

export function ScrollToTop({ targetRef }: ScrollToTopProps) {
  const route = useContext(NavigationRouteContext);
  if (!route) return null;
  return <ScrollToTopBinder targetRef={targetRef} />;
}

function ScrollToTopBinder({ targetRef }: ScrollToTopProps) {
  useScrollToTop(targetRef as RefObject<ScrollView>);
  return null;
}
