/**
 * Structural guards on the (tabs) shell that cannot be expressed as a render.
 *
 * `app/(tabs)/_layout.tsx` imports expo-router and react-native, so a
 * node-environment suite cannot load it — but it CAN read it, which is the same
 * technique nav.consistency.test.ts uses to prove every route is registered.
 * Two regressions are worth catching in the text, because both are invisible in
 * a rendered tree and both were real:
 *
 *  - SHELL#64: `usePathname` re-renders its caller on every navigation. Called
 *    in TabsLayout it rebuilt the whole <Tabs> element tree — 56 Tabs.Screen
 *    children and every `tabBarIcon` closure — on each push, including pushes
 *    inside nested stacks. It belongs in a leaf (SecondaryRouteGuard), never
 *    in the component that owns the navigator.
 *  - NATIVE#25 precondition: Android predictive back
 *    (`expo.android.predictiveBackGestureEnabled`) opts the activity into
 *    `OnBackInvokedCallback`, under which a legacy
 *    `BackHandler.addEventListener("hardwareBackPress", …)` no longer behaves
 *    the same way. The shell used to register one — it existed only because a
 *    role denial had unmounted the navigator and left back with nothing to pop.
 *    With the navigator always mounted, back is React Navigation's own and the
 *    listener is gone. This asserts it STAYS gone, so the flag can be flipped
 *    without silently breaking back.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const TABS_LAYOUT = "app/(tabs)/_layout.tsx";

/** Comment-stripped, so the file may explain in prose what it must not DO. */
function layoutSource(): string {
  return stripComments(readFileSync(join(process.cwd(), TABS_LAYOUT), "utf8"));
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      sourceFiles(abs, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(abs);
    }
  }
  return out;
}

describe("(tabs) shell structure", () => {
  it("does not subscribe the navigator's own component to the current route", () => {
    expect(layoutSource()).not.toContain("usePathname");
  });

  it("delegates the route-dependent denial to a leaf beside the navigator", () => {
    const src = layoutSource();
    expect(src).toContain("<SecondaryRouteGuard");
    // The denial is rendered AFTER the navigator closes, inside the same
    // filling parent — never returned in its place.
    const tabsClose = src.indexOf("</Tabs>");
    const guard = src.indexOf("<SecondaryRouteGuard");
    expect(tabsClose).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(tabsClose);
    expect(src).not.toContain("return <MobileRouteAccessDenied");
  });

  it("builds no tabBarIcon closure inline, so icons keep their identity", () => {
    expect(layoutSource()).not.toContain("tabBarIcon: ({");
  });

  it("registers no legacy hardwareBackPress listener anywhere in the app", () => {
    const offenders: string[] = [];
    for (const dir of ["app", "src"]) {
      for (const file of sourceFiles(join(process.cwd(), dir))) {
        // Comments are stripped first: the modules that REMOVED the listener
        // explain why in prose, and prose is not a listener.
        const src = stripComments(readFileSync(file, "utf8"));
        if (src.includes("hardwareBackPress") || /\bBackHandler\b/.test(src)) {
          offenders.push(relative(process.cwd(), file));
        }
      }
    }
    // If back must be intercepted under predictive back, use React Navigation's
    // `beforeRemove` listener, not BackHandler.
    expect(offenders).toEqual([]);
  });
});
