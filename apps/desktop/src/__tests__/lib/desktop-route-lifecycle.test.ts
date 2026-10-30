// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelLifecycleTransition,
  discardAndRecheckLifecycleTransition,
  getLifecycleDecisionState,
  registerLifecycleGuard,
  resetLifecycleCoordinatorForTests,
} from "../../lib/lifecycle-coordinator";
import {
  DesktopRouterController,
  getDesktopRoute,
  isInPlacePersistentTabTransition,
  requestDesktopRouteBackNavigation,
  requestDesktopRouteNavigation,
} from "../../lib/desktop-router";

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

afterEach(async () => {
  resetLifecycleCoordinatorForTests();
  await requestDesktopRouteNavigation(
    { section: "dashboard" },
    { replace: true },
  );
  vi.restoreAllMocks();
});

describe("desktop route lifecycle", () => {
  it("limits the in-place playground exception to an exact tab-only change", () => {
    expect(
      isInPlacePersistentTabTransition(
        { section: "apiPlayground" },
        { section: "apiPlayground", tab: "history" },
      ),
    ).toBe(true);
    expect(
      isInPlacePersistentTabTransition(
        { section: "apiPlayground", tab: "explore" },
        {
          section: "apiPlayground",
          tab: "history",
          overlay: { name: "unexpected" },
        },
      ),
    ).toBe(false);
    expect(
      isInPlacePersistentTabTransition(
        { section: "apiPlayground" },
        { section: "settings", tab: "history" },
      ),
    ).toBe(false);
  });

  it("moves between mounted Settings anchors without asking to abandon Settings drafts", async () => {
    await requestDesktopRouteNavigation({
      section: "settings",
      settingsAnchor: "api-keys",
    });
    const inspect = vi.fn(() => ({ level: "warning" as const }));
    registerLifecycleGuard({
      id: "settings-draft",
      label: "Settings changes",
      inspect,
    });

    await expect(
      requestDesktopRouteNavigation({
        section: "settings",
        settingsAnchor: "appearance",
      }),
    ).resolves.toBe("proceeded");
    expect(getDesktopRoute()).toEqual({
      section: "settings",
      settingsAnchor: "appearance",
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("moves among API Playground views without abandoning its lifted workbench", async () => {
    await requestDesktopRouteNavigation({ section: "apiPlayground" });
    const inspect = vi.fn(() => ({ level: "blocking" as const }));
    registerLifecycleGuard({
      id: "api-playground-workbench-test",
      label: "API Playground workbench",
      inspect,
    });

    await expect(
      requestDesktopRouteNavigation({
        section: "apiPlayground",
        tab: "history",
      }),
    ).resolves.toBe("proceeded");
    expect(getDesktopRoute()).toEqual({
      section: "apiPlayground",
      tab: "history",
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("keeps the current destination mounted until a blocking draft is explicitly discarded", async () => {
    await requestDesktopRouteNavigation({ section: "campaigns" });
    let dirty = true;
    registerLifecycleGuard({
      id: "route-draft",
      label: "Campaign changes",
      inspect: (intent) =>
        intent.kind === "route-change" && dirty
          ? {
              level: "blocking",
              detail: "Unsaved campaign changes remain.",
            }
          : null,
      discard: () => {
        dirty = false;
      },
    });

    const result = requestDesktopRouteNavigation({ section: "settings" });
    await settle();

    expect(getDesktopRoute()).toEqual({ section: "campaigns" });
    expect(getLifecycleDecisionState()).toMatchObject({
      phase: "review",
      intent: {
        kind: "route-change",
        disposition: "navigate",
        title: "Leave Campaigns?",
        targetLabel: "Settings",
      },
      concerns: [{ guardId: "route-draft", level: "blocking" }],
    });

    await discardAndRecheckLifecycleTransition();
    await expect(result).resolves.toBe("proceeded");
    expect(getDesktopRoute()).toEqual({ section: "settings" });
  });

  it("cancels a route intent without changing route or history state", async () => {
    await requestDesktopRouteNavigation({ section: "campaigns" });
    registerLifecycleGuard({
      id: "recoverable-route-draft",
      label: "Campaign recovery copy",
      inspect: () => ({ level: "warning" }),
    });

    const result = requestDesktopRouteNavigation({ section: "templates" });
    await settle();
    cancelLifecycleTransition();

    await expect(result).resolves.toBe("cancelled");
    expect(getDesktopRoute()).toEqual({ section: "campaigns" });
  });

  it("cancels a same-identity route intent superseded during lifecycle review", async () => {
    await requestDesktopRouteNavigation({ section: "campaigns" });
    let dirty = true;
    const identity = "tenant-a";
    let intentVersion = 1;
    const initiatingIntentVersion = intentVersion;
    registerLifecycleGuard({
      id: "same-identity-draft",
      label: "Same-identity draft",
      inspect: () => (dirty ? { level: "blocking" as const } : null),
      discard: () => {
        dirty = false;
      },
    });

    const result = requestDesktopRouteNavigation(
      { section: "templates" },
      {
        isStillCurrent: () =>
          identity === "tenant-a" && intentVersion === initiatingIntentVersion,
      },
    );
    await settle();
    intentVersion += 1;
    await discardAndRecheckLifecycleTransition();

    await expect(result).resolves.toBe("cancelled");
    expect(getDesktopRoute()).toEqual({ section: "campaigns" });
  });

  it("classifies a superseded approved Back as cancelled", async () => {
    await requestDesktopRouteNavigation({ section: "subscribers" });
    const detailRoute = {
      section: "subscribers",
      overlay: {
        name: "subscriber-detail",
        resourceId: "subscriber-42",
      },
    } as const;
    await requestDesktopRouteNavigation(detailRoute);
    vi.spyOn(
      DesktopRouterController.prototype,
      "navigateApprovedBackTo",
    ).mockResolvedValue("superseded");

    await expect(
      requestDesktopRouteBackNavigation({ section: "subscribers" }, () => true),
    ).resolves.toBe("cancelled");
    expect(getDesktopRoute()).toEqual(detailRoute);
  });

  it("keeps process-owned guards out of ordinary navigation", async () => {
    const inspect = vi.fn(() => ({ level: "blocking" as const }));
    registerLifecycleGuard({
      id: "process-transfer",
      label: "Process transfer",
      kinds: ["quit-app", "sign-out", "update-restart"],
      inspect,
    });

    const result = requestDesktopRouteNavigation({ section: "assets" });

    expect(getDesktopRoute()).toEqual({ section: "assets" });
    await expect(result).resolves.toBe("proceeded");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("prepares a safe route-scoped owner before opening the target", async () => {
    const prepare = vi.fn();
    registerLifecycleGuard({
      id: "trailing-save",
      label: "Trailing save",
      inspect: () => null,
      prepare,
    });

    const result = requestDesktopRouteNavigation({ section: "lists" });

    await expect(result).resolves.toBe("proceeded");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(getDesktopRoute()).toEqual({ section: "lists" });
  });
});
