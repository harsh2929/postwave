import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("desktop route lifecycle source contract", () => {
  it("funnels every public typed navigation helper and Back/Forward through the route lifecycle intent", () => {
    const router = source("lib/desktop-router.ts");
    const coordinator = source("lib/lifecycle-coordinator.ts");

    expect(coordinator).toContain('| "route-change"');
    expect(coordinator).toContain("if (pending) return true;");
    expect(router).toContain("requestDesktopRouteNavigation(route, options)");
    expect(router).toContain(
      "requestDesktopRouteNavigation(routeForDesktopSection(section), options)",
    );
    expect(router).toContain(
      "requestDesktopRouteNavigation({ section, resourceId }, options)",
    );
    expect(router).toContain("desktopRouter.setHistoryTransitionGuard({");
    expect(router).toContain(
      "!isInPlaceSettingsAnchorTransition(transition.from, transition.to)",
    );
    expect(router).toContain(
      "!isInPlacePersistentTabTransition(transition.from, transition.to)",
    );
    expect(router).toContain(
      "isInPlaceSettingsAnchorTransition(current.route, parsed.route)",
    );
    expect(router).toContain('kind: "route-change"');
    expect(router).toContain('disposition: "navigate"');
  });

  it("retains indexed history rollback while process-owned transfers and outbox work continue across routes", () => {
    const router = source("lib/desktop-router.ts");
    const transfers = source("lib/file-transfer-history.ts");
    const windowLifecycle = source("lib/desktop-window-lifecycle.ts");

    expect(router).toContain(
      "Monotonic position for lossless Back/Forward lifecycle rollback.",
    );
    expect(router).toContain("this.#environment.go(delta)");
    expect(router).toContain("this.#environment.go(-transition.delta)");
    expect(transfers).toContain("kinds: PROCESS_EXIT_INTENTS");
    expect(windowLifecycle).toContain("kinds: PROCESS_EXIT_INTENTS");
    expect(transfers).not.toContain('"route-change",');
  });
});
