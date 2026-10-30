/**
 * AppShell — the main layout: sidebar + (topbar + content + statusbar).
 * The shell owns one shared 28px top inset so the macOS traffic lights do not
 * overlap either the workspace switcher or the top bar.
 */

import {
  Suspense,
  lazy,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { routeMetaForSection } from "../lib/desktop-routes";
import { settingsItemForAnchor } from "../lib/settings-information-architecture";
import {
  type DesktopRoute,
  type DesktopRouteSource,
  recordDesktopRouteScroll,
  registerDesktopRouteScrollReader,
  useDesktopRouteSnapshot,
} from "../lib/desktop-router";
import { useCommandOpen, useMe, useSection, type Section } from "../lib/store";
import { OfflineBanner } from "./OfflineBanner";
import { RecoverableSuspense } from "./RecoverableSuspense";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TopBar } from "./TopBar";

const CommandPalette = lazy(() =>
  import("./CommandPalette").then((module) => ({
    default: module.CommandPalette,
  })),
);

const DesktopDestinationGate = lazy(() =>
  import("./DesktopDestinationGate").then((module) => ({
    default: module.DesktopDestinationGate,
  })),
);

interface Props {
  children: ReactNode;
  topbarAccessory?: ReactNode;
}

function routeTokenLabel(value: string): string {
  const words = value.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function retentionTabLabel(value: string | undefined): string {
  switch (value) {
    case undefined:
    case "overview":
      return "Overview";
    case "history":
      return "Offer history";
    case "readiness":
      return "Readiness";
    default:
      // Retention's route controller canonicalizes every unknown tab to the
      // overview. Do the same at the shell boundary so an untrusted URL token
      // never becomes a document title or live-region label while repair runs.
      return "Overview";
  }
}

function routeSubviewLabel(
  route: DesktopRoute,
  section: Section,
): string | null {
  if (route.section !== section) return null;
  if (route.overlay) {
    return route.overlay.name === "subscriber-detail"
      ? "Subscriber details"
      : routeTokenLabel(route.overlay.name);
  }
  if (route.settingsAnchor) {
    return settingsItemForAnchor(route.settingsAnchor).label;
  }
  if (route.section === "retentionOffers") {
    return retentionTabLabel(route.tab);
  }
  if (route.tab) return route.tab;
  if (!route.resourceId) return null;
  return route.section === "subscribers"
    ? "Subscriber details"
    : "Record details";
}

function routeOwnsTransientLayer(route: DesktopRoute): boolean {
  return (
    Boolean(route.overlay) ||
    (route.section === "subscribers" && Boolean(route.resourceId))
  );
}

function connectedFocusedTabWithin(main: HTMLElement): HTMLElement | null {
  const activeElement = document.activeElement;
  return activeElement instanceof HTMLElement &&
    activeElement.isConnected &&
    main.contains(activeElement) &&
    activeElement.getAttribute("role") === "tab"
    ? activeElement
    : null;
}

function documentOwnsFallbackFocus(): boolean {
  return (
    document.activeElement === null ||
    document.activeElement === document.body ||
    document.activeElement === document.documentElement
  );
}

function routesShareTabContext(
  previous: DesktopRoute,
  next: DesktopRoute,
): boolean {
  return (
    previous.section === next.section &&
    previous.resourceId === next.resourceId &&
    previous.settingsAnchor === next.settingsAnchor &&
    previous.overlay?.name === next.overlay?.name &&
    previous.overlay?.resourceId === next.overlay?.resourceId
  );
}

function routeHasStructuralChange(
  previous: DesktopRoute | null,
  next: DesktopRoute,
): boolean {
  return (
    previous === null ||
    !routesShareTabContext(previous, next) ||
    previous.tab !== next.tab
  );
}

function routeSourceRestoresReadingPosition(
  source: DesktopRouteSource,
): boolean {
  return (
    source === "history" ||
    source === "restore" ||
    source === "identity" ||
    source === "deep-link"
  );
}

function isDirectTabTransition(
  previous: DesktopRoute | null,
  next: DesktopRoute,
  source: DesktopRouteSource,
): boolean {
  return Boolean(
    previous &&
    source === "navigation" &&
    routesShareTabContext(previous, next) &&
    previous.tab !== next.tab,
  );
}

function isSameSectionTransientTransition(
  previous: DesktopRoute | null,
  next: DesktopRoute,
): boolean {
  return Boolean(
    previous &&
    previous.section === next.section &&
    (routeOwnsTransientLayer(previous) || routeOwnsTransientLayer(next)),
  );
}

function setScrollTopImmediately(
  element: HTMLElement,
  scrollTop: number,
): void {
  const inlineScrollBehavior = element.style.scrollBehavior;
  element.style.scrollBehavior = "auto";
  element.scrollTop = scrollTop;
  element.style.scrollBehavior = inlineScrollBehavior;
}

export function AppShell({ children, topbarAccessory }: Props): ReactElement {
  const routeSnapshot = useDesktopRouteSnapshot();
  // Keep the compatibility selector as the section source while the gradual
  // migration is in flight; the store is synchronously bridged to the router,
  // and isolated shell tests can still provide their established store mock.
  const section = useSection();
  const me = useMe();
  const commandOpen = useCommandOpen();
  const mainRef = useRef<HTMLElement | null>(null);
  const previousRouteRef = useRef<DesktopRoute | null>(null);
  const focusedTabOriginRef = useRef<{
    element: HTMLElement;
    scrollTop: number;
  } | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const tabScrollRestoreFrameRef = useRef<number | null>(null);
  const tabScrollRestoreTokenRef = useRef(0);
  const [announcement, setAnnouncement] = useState("");
  const route = routeMetaForSection(section);
  const subviewLabel = routeSubviewLabel(routeSnapshot.route, section);

  const captureFocusedTabOrigin = useCallback(
    (eventTarget: EventTarget | null): void => {
      const main = mainRef.current;
      const target =
        eventTarget instanceof Element
          ? eventTarget.closest<HTMLElement>('[role="tab"]')
          : null;
      if (!main || !target || !main.contains(target)) {
        focusedTabOriginRef.current = null;
        return;
      }
      focusedTabOriginRef.current = {
        element: target,
        scrollTop: main.scrollTop,
      };
    },
    [],
  );

  useEffect(() => {
    const workspace = me?.tenant?.trim() || "Moosewave";
    const context = subviewLabel ? ` — ${subviewLabel}` : "";
    document.title = `${workspace} — ${route.title}${context} — Moosewave`;
  }, [me?.tenant, route.title, subviewLabel]);

  useEffect(() => {
    const previous = previousRouteRef.current;
    const next = routeSnapshot.route;
    const structuralChange = routeHasStructuralChange(previous, next);
    const restoring = routeSourceRestoresReadingPosition(routeSnapshot.source);
    const directSameSectionTabTransition = isDirectTabTransition(
      previous,
      next,
      routeSnapshot.source,
    );
    setAnnouncement(
      structuralChange || restoring
        ? `Navigated to ${route.title}${subviewLabel ? `, ${subviewLabel}` : ""}`
        : "",
    );
    const main = mainRef.current;
    const focusedTab = main ? connectedFocusedTabWithin(main) : null;
    const capturedDirectTabContext =
      main &&
      focusedTab &&
      directSameSectionTabTransition &&
      focusedTabOriginRef.current?.element === focusedTab
        ? focusedTabOriginRef.current
        : null;
    const preserveDirectTabContext = capturedDirectTabContext !== null;
    const sameRouteNavigationNeedsFocus = Boolean(
      main &&
      previous &&
      !structuralChange &&
      !restoring &&
      routeSnapshot.source === "navigation" &&
      documentOwnsFallbackFocus(),
    );
    const tabScrollRestoreToken = ++tabScrollRestoreTokenRef.current;
    if (tabScrollRestoreFrameRef.current !== null) {
      window.cancelAnimationFrame(tabScrollRestoreFrameRef.current);
      tabScrollRestoreFrameRef.current = null;
    }
    if (
      main &&
      (structuralChange || restoring || sameRouteNavigationNeedsFocus)
    ) {
      const nextOwnsTransientLayer = routeOwnsTransientLayer(next);
      const sameSectionTransientTransition = isSameSectionTransientTransition(
        previous,
        next,
      );
      if (
        !next.settingsAnchor &&
        !nextOwnsTransientLayer &&
        !sameSectionTransientTransition &&
        !preserveDirectTabContext &&
        (structuralChange || restoring)
      ) {
        setScrollTopImmediately(main, routeSnapshot.restoreScrollTop ?? 0);
      }
      // A routed Settings anchor owns focus itself after it resolves the
      // target heading; a routed overlay/resource drawer owns its own focus
      // lifecycle and must not lose the directory's reading position.
      if (
        !next.settingsAnchor &&
        !nextOwnsTransientLayer &&
        !sameSectionTransientTransition &&
        !preserveDirectTabContext
      ) {
        queueMicrotask(() => main.focus());
      }
    }
    if (main && focusedTab && capturedDirectTabContext) {
      const capturedScrollTop = capturedDirectTabContext.scrollTop;
      const restoreFocusedTabScroll = (): void => {
        if (
          tabScrollRestoreTokenRef.current !== tabScrollRestoreToken ||
          !main.isConnected ||
          !focusedTab.isConnected ||
          document.activeElement !== focusedTab ||
          !main.contains(focusedTab)
        ) {
          return;
        }
        setScrollTopImmediately(main, capturedScrollTop);
        recordDesktopRouteScroll(capturedScrollTop);
      };
      // React has committed the new tab panel, but Chromium may perform focus
      // scrolling or scroll anchoring around that commit. Restore immediately,
      // again after passive work, and once at the next rendered frame.
      restoreFocusedTabScroll();
      queueMicrotask(restoreFocusedTabScroll);
      tabScrollRestoreFrameRef.current = window.requestAnimationFrame(() => {
        tabScrollRestoreFrameRef.current = null;
        restoreFocusedTabScroll();
      });
    }
    previousRouteRef.current = next;
  }, [
    route.title,
    routeSnapshot.revision,
    routeSnapshot.restoreScrollTop,
    routeSnapshot.route,
    routeSnapshot.source,
    subviewLabel,
  ]);

  const recordScroll = useCallback((): void => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      recordDesktopRouteScroll(mainRef.current?.scrollTop ?? 0);
    });
  }, []);

  useEffect(() => {
    return registerDesktopRouteScrollReader(
      () => mainRef.current?.scrollTop ?? 0,
    );
  }, []);

  useEffect(() => {
    return () => {
      tabScrollRestoreTokenRef.current += 1;
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      if (tabScrollRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(tabScrollRestoreFrameRef.current);
      }
    };
  }, []);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <div className="app-shell">
        <Sidebar />
        <div className="main">
          <OfflineBanner />
          <TopBar trailingAccessory={topbarAccessory} />
          <main
            ref={mainRef}
            id="main-content"
            className="content"
            tabIndex={-1}
            aria-label={`${route.title} content`}
            onClickCapture={(event) => captureFocusedTabOrigin(event.target)}
            onFocusCapture={(event) => captureFocusedTabOrigin(event.target)}
            onKeyDownCapture={(event) => captureFocusedTabOrigin(event.target)}
            onPointerDownCapture={(event) =>
              captureFocusedTabOrigin(event.target)
            }
            onScroll={recordScroll}
          >
            <RecoverableSuspense
              fallback={
                <div aria-hidden="true" className="muted">
                  Checking destination availability…
                </div>
              }
            >
              <DesktopDestinationGate section={section}>
                {children}
              </DesktopDestinationGate>
            </RecoverableSuspense>
          </main>
          <StatusBar />
        </div>
      </div>
      {commandOpen ? (
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      ) : null}
      <div
        className="sr-only"
        data-app-route-announcement
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>
    </>
  );
}
