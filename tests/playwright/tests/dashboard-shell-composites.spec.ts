import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

type FixtureMode = "pending" | "error" | "empty" | "ready";

interface FixtureGate {
  mode: FixtureMode;
  waiters: Array<() => void>;
}

interface ShellHarness {
  notificationMarkAllWrites: number;
  notificationMarkSeenWrites: number;
  notificationReads: number;
  searchReads: number;
  workspaceReads: number;
  setNotifications: (mode: FixtureMode) => void;
  setSearch: (mode: FixtureMode) => void;
  setWorkspaces: (mode: FixtureMode) => void;
}

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

function gate(mode: FixtureMode): FixtureGate {
  return { mode, waiters: [] };
}

function setGate(target: FixtureGate, mode: FixtureMode): void {
  target.mode = mode;
  if (mode === "pending") return;
  for (const release of target.waiters.splice(0)) release();
}

async function resolvedMode(target: FixtureGate): Promise<FixtureMode> {
  if (target.mode !== "pending") return target.mode;
  await new Promise<void>((resolve) => target.waiters.push(resolve));
  return target.mode;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installShellHarness(
  page: Page,
  initial: {
    notifications: FixtureMode;
    search: FixtureMode;
    workspaces: FixtureMode;
  },
): Promise<ShellHarness> {
  const notifications = gate(initial.notifications);
  const search = gate(initial.search);
  const workspaces = gate(initial.workspaces);
  let notificationUnread = true;

  const harness: ShellHarness = {
    notificationMarkAllWrites: 0,
    notificationMarkSeenWrites: 0,
    notificationReads: 0,
    searchReads: 0,
    workspaceReads: 0,
    setNotifications: (mode) => setGate(notifications, mode),
    setSearch: (mode) => setGate(search, mode),
    setWorkspaces: (mode) => setGate(workspaces, mode),
  };

  await page.route("**/api/health", (route) => json(route, { status: "ok" }));

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/v1/auth/me") {
      await json(route, {
        user_id: "user_shell",
        tenant_id: "tenant_shell",
        email: "shell.owner@example.test",
        role: "owner",
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Shell workspace",
        workspace_slug: "shell-workspace",
      });
      return;
    }
    if (path === "/api/v1/onboarding/steps") {
      await json(route, {
        steps: { dashboard_tour: { state: "dismissed" } },
      });
      return;
    }
    if (path === "/api/v1/auth/workspaces") {
      harness.workspaceReads += 1;
      const mode = await resolvedMode(workspaces);
      if (mode === "error") {
        await json(route, { error: "workspace_fixture_unavailable" }, 400);
        return;
      }
      await json(route, {
        workspaces:
          mode === "empty"
            ? [
                {
                  id: "tenant_shell",
                  name: "Shell workspace",
                  slug: "shell-workspace",
                  role: "owner",
                  current: true,
                },
              ]
            : [
                {
                  id: "tenant_shell",
                  name: "Shell workspace",
                  slug: "shell-workspace",
                  role: "owner",
                  current: true,
                },
                {
                  id: "tenant_editorial",
                  name: "Editorial lab",
                  slug: "editorial-lab",
                  role: "editor",
                  current: false,
                },
              ],
      });
      return;
    }
    if (path === "/api/v1/notifications" && method === "GET") {
      harness.notificationReads += 1;
      const mode = await resolvedMode(notifications);
      if (mode === "error") {
        await json(route, { error: "notification_fixture_unavailable" }, 400);
        return;
      }
      if (mode === "empty") {
        await json(route, { items: [], unread_count: 0 });
        return;
      }
      await json(route, {
        items: [
          {
            id: "notification_shell",
            kind: "system",
            title: "Shell certification ready",
            body: "Review the deterministic shell fixture.",
            deep_link: "/app/settings/offline",
            ...(notificationUnread
              ? {}
              : { read_at: "2026-08-27T12:00:00.000Z" }),
            created_at: "2026-08-27T11:59:00.000Z",
          },
        ],
        unread_count: notificationUnread ? 1 : 0,
      });
      return;
    }
    if (path === "/api/v1/notifications/seen" && method === "POST") {
      harness.notificationMarkSeenWrites += 1;
      await json(route, { ok: true });
      return;
    }
    if (path === "/api/v1/notifications/read-all" && method === "POST") {
      harness.notificationMarkAllWrites += 1;
      // Keep the mutation visibly in flight long enough for a second same-tick
      // activation to prove the source-side latch, not merely a disabled paint.
      await new Promise((resolve) => setTimeout(resolve, 80));
      notificationUnread = false;
      await json(route, { ok: true });
      return;
    }
    if (
      path.startsWith("/api/v1/notifications/") &&
      path.endsWith("/read") &&
      method === "POST"
    ) {
      notificationUnread = false;
      await json(route, { ok: true });
      return;
    }
    if (path === "/api/v1/search") {
      harness.searchReads += 1;
      const mode = await resolvedMode(search);
      const query = url.searchParams.get("q") ?? "";
      if (mode === "error") {
        await json(route, { error: "search_fixture_unavailable" }, 400);
        return;
      }
      await json(route, {
        query,
        results:
          mode === "empty"
            ? []
            : [
                {
                  type: "subscriber",
                  id: "subscriber_shell",
                  title: "Shell Fixture Subscriber",
                  detail: "shell.fixture@example.test",
                },
              ],
      });
      return;
    }
    if (path === "/api/v1/integrations/catalog") {
      await json(route, {
        schema_version: "shell-v1",
        target_public_entries: 0,
        target_native_managed: 0,
        honest_badges: [],
        categories: [],
        capabilities: [],
        items: [],
        counts: {},
      });
      return;
    }
    if (path === "/api/v1/approvals") {
      await json(route, { approvals: [] });
      return;
    }
    if (path === "/api/v1/events") {
      await route.fulfill({
        status: 204,
        contentType: "text/event-stream",
        body: "",
      });
      return;
    }

    // The selected settings route has no remote page data. Keep incidental
    // shell probes deterministic without leaking the shared demo tenant into
    // this focused composite contract.
    await json(route, {});
  });

  return harness;
}

async function expectPageContained(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => ({
    viewportWidth: innerWidth,
    documentWidth: Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ),
    mainCount: document.querySelectorAll("main#main-content").length,
    duplicateIds: Array.from(document.querySelectorAll<HTMLElement>("[id]"))
      .map((element) => element.id)
      .filter((id, index, all) => all.indexOf(id) !== index),
  }));
  expect(geometry.documentWidth).toBeLessThanOrEqual(
    geometry.viewportWidth + 1,
  );
  expect(geometry.mainCount).toBe(1);
  expect(geometry.duplicateIds).toEqual([]);
}

async function expectSurfaceQuality(
  page: Page,
  surface: Locator,
  selector: string,
  mobile: boolean,
): Promise<void> {
  await expect(surface).toBeVisible();
  await surface.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter((animation) => {
          const iterations = animation.effect?.getTiming().iterations;
          return typeof iterations === "number" && Number.isFinite(iterations);
        })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const geometry = await surface.evaluate((element, auditTouchTargets) => {
    const rect = element.getBoundingClientRect();
    const targets = auditTouchTargets
      ? Array.from(
          element.querySelectorAll<HTMLElement>(
            'button, a[href], input, select, textarea, [role="button"], [role="option"]',
          ),
        )
          .filter((target) => {
            const style = getComputedStyle(target);
            const box = target.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              box.width > 0 &&
              box.height > 0 &&
              !target.matches(":disabled")
            );
          })
          .map((target) => {
            const effectiveTarget =
              target instanceof HTMLInputElement
                ? (target.closest<HTMLElement>("label") ?? target)
                : target;
            const box = effectiveTarget.getBoundingClientRect();
            return {
              label:
                target.getAttribute("aria-label") ||
                target.textContent?.trim().replace(/\s+/g, " ").slice(0, 60) ||
                target.tagName,
              width: Math.round(box.width * 10) / 10,
              height: Math.round(box.height * 10) / 10,
            };
          })
          .filter(({ width, height }) => width < 43.5 || height < 43.5)
      : [];
    return {
      bottom: rect.bottom,
      left: rect.left,
      ownsFocus: element.contains(document.activeElement),
      right: rect.right,
      top: rect.top,
      targets,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
    };
  }, mobile);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.ownsFocus).toBe(true);
  expect(geometry.targets).toEqual([]);

  const axe = await new AxeBuilder({ page })
    .include(selector)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = axe.violations.filter(
    (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

async function expectMobileHeaderQuality(page: Page): Promise<void> {
  const header = page.locator('header[role="banner"]');
  await expect(header).toBeVisible();
  for (const name of [
    "Open navigation",
    /^Current workspace:/,
    "Open search",
    "Create",
    /^Notifications/,
    /^Account menu for/,
  ]) {
    await expect(header.getByRole("button", { name })).toBeVisible();
  }
  const audit = await header.evaluate((element) => {
    const headerRect = element.getBoundingClientRect();
    const boxes = Array.from(
      element.querySelectorAll<HTMLButtonElement>("button"),
    )
      .filter((button) => {
        const style = getComputedStyle(button);
        const box = button.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          box.width > 0 &&
          box.height > 0
        );
      })
      .map((button) => {
        const box = button.getBoundingClientRect();
        return {
          label:
            button.getAttribute("aria-label") ?? button.textContent?.trim(),
          bottom: box.bottom,
          height: box.height,
          left: box.left,
          right: box.right,
          top: box.top,
          width: box.width,
        };
      });
    const overlaps: string[] = [];
    for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < boxes.length;
        rightIndex += 1
      ) {
        const left = boxes[leftIndex]!;
        const right = boxes[rightIndex]!;
        if (
          Math.min(left.right, right.right) - Math.max(left.left, right.left) >
            0.5 &&
          Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) >
            0.5
        ) {
          overlaps.push(`${left.label} / ${right.label}`);
        }
      }
    }
    return {
      boxes,
      headerLeft: headerRect.left,
      headerRight: headerRect.right,
      overlaps,
    };
  });
  for (const box of audit.boxes) {
    expect(box.width, `${box.label} width`).toBeGreaterThanOrEqual(43.5);
    expect(box.height, `${box.label} height`).toBeGreaterThanOrEqual(43.5);
    expect(box.left).toBeGreaterThanOrEqual(audit.headerLeft - 0.5);
    expect(box.right).toBeLessThanOrEqual(audit.headerRight + 0.5);
  }
  expect(audit.overlaps).toEqual([]);
  await expectPageContained(page);
}

async function openShellPage(page: Page): Promise<void> {
  await page.goto("/app/settings/offline", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByRole("heading", { level: 1, name: "Offline Sync" }),
  ).toBeVisible();
  await expect(page.locator('[data-dashboard-hydrated="true"]')).toBeVisible();
  await expectPageContained(page);
}

test.describe("dashboard shell hidden composites", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      (
        window as typeof window & {
          __POSTWAVE_FORCE_REAL_API_FOR_E2E__?: boolean;
        }
      ).__POSTWAVE_FORCE_REAL_API_FOR_E2E__ = true;
    });
    await loginAsDemo(page, { navigate: false });
  });

  test("desktop composes pending, ready, empty, keyboard, and focus states", async ({
    page,
  }) => {
    const harness = await installShellHarness(page, {
      workspaces: "pending",
      notifications: "pending",
      search: "pending",
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await openShellPage(page);

    const workspace = page.getByRole("button", {
      name: /^Current workspace:/,
    });
    await workspace.click();
    const workspacePanel = page.locator("[data-header-menu-panel]");
    await expect(
      workspacePanel
        .getByRole("status")
        .filter({ hasText: "Loading workspaces" }),
    ).toBeVisible();
    await expectSurfaceQuality(
      page,
      workspacePanel,
      "[data-header-menu-panel]",
      false,
    );
    // A non-modal header disclosure still owns focus; the global palette must
    // not stack a second keyboard layer over it.
    await page.keyboard.press("Control+k");
    await expect(
      page.getByRole("dialog", { name: "Command palette" }),
    ).toHaveCount(0);
    harness.setWorkspaces("ready");
    await expect(
      workspacePanel.getByRole("button", { name: /Editorial lab/ }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(workspace).toBeFocused();

    await workspace.click();
    const editorial = workspacePanel.getByRole("button", {
      name: /Editorial lab/,
    });
    await expect(editorial).toBeFocused();
    await page.keyboard.press("End");
    await expect(
      workspacePanel.getByRole("link", { name: "Team access" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(workspace).toBeFocused();

    const create = page.getByRole("button", { name: "Create", exact: true });
    await create.click();
    const createPanel = page.locator("[data-header-menu-panel]");
    await expect(
      createPanel.getByRole("link", { name: "New campaign" }),
    ).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      createPanel.getByRole("link", { name: "New sequence" }),
    ).toBeFocused();
    await expectSurfaceQuality(
      page,
      createPanel,
      "[data-header-menu-panel]",
      false,
    );
    await page.keyboard.press("Escape");
    await expect(create).toBeFocused();

    const bell = page.getByRole("button", { name: /^Notifications/ });
    await bell.click();
    const notificationPanel = page.getByRole("dialog", {
      name: "Notifications",
    });
    await expect(
      notificationPanel
        .getByRole("status")
        .filter({ hasText: "Loading notifications" }),
    ).toBeVisible();
    harness.setNotifications("empty");
    await expect(notificationPanel).toContainText("No notifications yet.");
    await expectSurfaceQuality(
      page,
      notificationPanel,
      '[role="dialog"][aria-label="Notifications"]',
      false,
    );
    await page.keyboard.press("Escape");
    await expect(bell).toBeFocused();

    const commandTrigger = page.getByRole("button", {
      name: "Open command palette",
    });
    await commandTrigger.click();
    const palette = page.getByRole("dialog", { name: "Command palette" });
    const searchInput = palette.getByPlaceholder(
      "Search subscribers, segments, pages…",
    );
    await expect(searchInput).toBeFocused();
    await searchInput.fill("shell fixture needle");
    await expect(
      palette.getByRole("status").filter({ hasText: "Searching" }).first(),
    ).toBeVisible();
    harness.setSearch("ready");
    await expect(palette.getByText("Shell Fixture Subscriber")).toBeVisible();
    await expectSurfaceQuality(page, palette, '[role="dialog"]', false);
    await page.keyboard.press("Escape");
    await expect(commandTrigger).toBeFocused();

    await commandTrigger.click();
    harness.setSearch("error");
    await palette
      .getByPlaceholder("Search subscribers, segments, pages…")
      .fill("shell fixture outage");
    await expect(
      palette.getByRole("alert").filter({ hasText: "temporarily unavailable" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(commandTrigger).toBeFocused();

    await commandTrigger.focus();
    await page.evaluate(() =>
      window.dispatchEvent(new Event("pw:open-queue-tray")),
    );
    const queue = page.getByRole("dialog", { name: "Offline queue" });
    await expect(queue).toContainText("No queued changes");
    await expect(
      queue.getByRole("button", { name: "Retry all" }),
    ).toBeDisabled();
    await expectSurfaceQuality(
      page,
      queue,
      '[role="dialog"][aria-label="Offline queue"]',
      false,
    );
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(commandTrigger).toBeFocused();
    await expectPageContained(page);

    expect(harness.workspaceReads).toBe(1);
    expect(harness.notificationReads).toBe(1);
    expect(harness.searchReads).toBe(2);
  });

  test("320px composes error recovery, modal isolation, and 44px controls", async ({
    page,
  }) => {
    const harness = await installShellHarness(page, {
      workspaces: "error",
      notifications: "error",
      search: "error",
    });
    await page.setViewportSize({ width: 320, height: 800 });
    await openShellPage(page);
    await expectMobileHeaderQuality(page);

    const openNavigation = page.getByRole("button", {
      name: "Open navigation",
    });
    await openNavigation.click();
    const drawer = page.getByRole("dialog", {
      name: "Dashboard mobile navigation",
    });
    await expect(
      drawer.getByRole("button", { name: "Close navigation" }),
    ).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe("hidden");
    await drawer.getByRole("link", { name: "Moosewave" }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(drawer.locator(":focus")).toHaveCount(1);
    await expectSurfaceQuality(
      page,
      drawer,
      '[role="dialog"][aria-label="Dashboard mobile navigation"]',
      true,
    );
    await page.keyboard.press("Escape");
    await expect(openNavigation).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe("");

    const workspace = page.getByRole("button", {
      name: /^Current workspace:/,
    });
    await workspace.click();
    const workspacePanel = page.locator("[data-header-menu-panel]");
    await expect(
      workspacePanel
        .getByRole("alert")
        .filter({ hasText: "could not be loaded" }),
    ).toBeVisible();
    harness.setWorkspaces("ready");
    await workspacePanel.getByRole("button", { name: "Retry" }).click();
    await expect(
      workspacePanel.getByRole("button", { name: /Editorial lab/ }),
    ).toBeVisible();
    await expectSurfaceQuality(
      page,
      workspacePanel,
      "[data-header-menu-panel]",
      true,
    );
    await page.keyboard.press("Escape");
    await expect(workspace).toBeFocused();

    const create = page.getByRole("button", { name: "Create", exact: true });
    await create.click();
    const createPanel = page.locator("[data-header-menu-panel]");
    await expect(
      createPanel.getByRole("link", { name: "New campaign" }),
    ).toBeFocused();
    await expectSurfaceQuality(
      page,
      createPanel,
      "[data-header-menu-panel]",
      true,
    );
    await page.keyboard.press("Escape");
    await expect(create).toBeFocused();

    const bell = page.getByRole("button", { name: /^Notifications/ });
    await bell.click();
    const notificationPanel = page.getByRole("dialog", {
      name: "Notifications",
    });
    await expect(
      notificationPanel
        .getByRole("alert")
        .filter({ hasText: "could not be loaded" }),
    ).toBeVisible();
    harness.setNotifications("ready");
    await notificationPanel.getByRole("button", { name: "Retry" }).click();
    await expect(
      notificationPanel.getByText("Shell certification ready"),
    ).toBeVisible();
    const markAll = notificationPanel.getByRole("button", {
      name: "Mark all read",
    });
    await markAll.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect.poll(() => harness.notificationMarkAllWrites).toBe(1);
    await expect(
      notificationPanel.getByRole("button", { name: "Mark all read" }),
    ).toHaveCount(0);
    await expectSurfaceQuality(
      page,
      notificationPanel,
      '[role="dialog"][aria-label="Notifications"]',
      true,
    );
    await page.keyboard.press("Escape");
    await expect(bell).toBeFocused();

    const mobileSearch = page.getByRole("button", { name: "Open search" });
    await mobileSearch.click();
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette
      .getByPlaceholder("Search subscribers, segments, pages…")
      .fill("shell fixture outage");
    await expect(
      palette.getByRole("alert").filter({ hasText: "temporarily unavailable" }),
    ).toBeVisible();
    await expectSurfaceQuality(page, palette, '[role="dialog"]', true);
    await page.keyboard.press("Control+k");
    await expect(palette).toHaveCount(0);
    await expect(mobileSearch).toBeFocused();

    const account = page.getByRole("button", {
      name: /^Account menu for/,
    });
    await account.click();
    const accountPanel = page.locator("[data-header-menu-panel]");
    await expect(
      accountPanel.getByRole("link", { name: "Profile" }),
    ).toBeFocused();
    await expectSurfaceQuality(
      page,
      accountPanel,
      "[data-header-menu-panel]",
      true,
    );
    await page.keyboard.press("Escape");
    await expect(account).toBeFocused();

    await openNavigation.focus();
    await page.evaluate(() =>
      window.dispatchEvent(new Event("pw:open-queue-tray")),
    );
    const queue = page.getByRole("dialog", { name: "Offline queue" });
    await expect(queue).toContainText("No queued changes");
    await expectSurfaceQuality(
      page,
      queue,
      '[role="dialog"][aria-label="Offline queue"]',
      true,
    );
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(openNavigation).toBeFocused();

    await expectMobileHeaderQuality(page);
    expect(harness.workspaceReads).toBe(2);
    expect(harness.notificationReads).toBeGreaterThanOrEqual(3);
    expect(harness.searchReads).toBe(1);
  });
});
