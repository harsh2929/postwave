/**
 * useNavigateTo — navigate without growing the back stack forever.
 *
 * Deep links, App-Intent routes, share hand-offs, search hits and notification
 * taps all called `router.push()` unconditionally, so re-entering the screen
 * you are already on stacked another copy of it. The decision lives in
 * lib/navigateTo (pure, unit-tested); this is the two-line binding to
 * expo-router that needs a component context to read the current path.
 */
import { router, usePathname } from "expo-router";
import { useCallback, useRef } from "react";

import {
  navigationMode,
  targetFromHref,
  type NavigationTarget,
} from "@/lib/navigateTo";

export type { NavigationTarget };

export function useNavigateTo(): (target: NavigationTarget) => void {
  const pathname = usePathname();
  // The returned callback has a STABLE identity on purpose. Three of its
  // callers are app-lifecycle effects mounted by ShellLifecycle — deep links,
  // the share inbox, notification taps — and each lists it in a dependency
  // array. A callback that changed on every navigation would tear down and
  // re-subscribe the `Linking` and `Notifications` listeners after every route
  // change, and re-run the one-shot flush effects. So the path is read through
  // a ref that is refreshed each render rather than closed over.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  return useCallback((target: NavigationTarget) => {
    const href = (
      target.params
        ? { pathname: target.pathname, params: target.params }
        : target.pathname
    ) as never;
    if (navigationMode(pathnameRef.current, target) === "replace") {
      router.replace(href);
    } else {
      router.push(href);
    }
  }, []);
}

/**
 * The same decision for callers that hold an expo-router `Href` rather than a
 * NavigationTarget — `planDeepLinkNavigation`, `actionForSharedItem`,
 * `takePendingRoute` and `routeForNotification` all return the string |
 * {pathname, params} union.
 *
 * Returns false when the href is not a usable route, so a caller that must
 * distinguish "navigated" from "nothing to navigate to" still can. Identity is
 * stable for the same reason `useNavigateTo`'s is.
 */
export function useNavigateToHref(): (href: unknown) => boolean {
  const navigateTo = useNavigateTo();
  return useCallback(
    (href: unknown) => {
      const target = targetFromHref(href);
      if (!target) return false;
      navigateTo(target);
      return true;
    },
    [navigateTo],
  );
}
