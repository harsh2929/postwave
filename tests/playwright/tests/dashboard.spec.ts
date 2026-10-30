import { expect, test } from "@playwright/test";
import { loginAsDemo } from "../helpers/auth";
import { waitForNonEmptyText } from "../helpers/wait";
import { seedSampleData } from "../fixtures/test-data";

test.describe("dashboard", () => {
  test.beforeEach(async ({ page, baseURL }, testInfo) => {
    // The no-script recovery contract is entirely server-rendered and does not
    // consume dashboard data. Keeping it independent from the demo seeder also
    // means a data-fixture outage cannot mask a broken hydration fallback.
    if (
      testInfo.title !==
      "failed hydration leaves an accessible native recovery action"
    ) {
      await seedSampleData(baseURL!);
    }
    await page.route("**/api/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      }),
    );

    // These tests are about the dashboard's own surface, so they run as a
    // RETURNING user rather than a first-run one. Without this the product
    // tour auto-starts a beat after the dashboard settles, and its overlay
    // scrolls the spotlight target into view — which moves the header out
    // from under the Refresh button mid-click ("element is not stable").
    //
    // The tour's authority is the person's recorded decision
    // (GET /api/v1/onboarding/steps), and that record is shared by the whole
    // suite on the demo tenant: actually pressing Skip would write
    // `dismissed` server-side and permanently break a11y.spec's tour scan for
    // every later run. So the precondition is stated per-browser here instead
    // of mutated globally. Register before loginAsDemo — it navigates.
    await page.route("**/api/v1/onboarding/steps", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          steps: { dashboard_tour: { state: "dismissed" } },
        }),
      });
    });

    await loginAsDemo(page);
  });

  test("stat cards render with non-empty values", async ({ page }) => {
    const cards = page.getByTestId("stat-card");
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(3);

    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const value = card.getByTestId("stat-card-value");
      await waitForNonEmptyText(value);
    }
  });

  test("recent campaigns list renders with sample data", async ({ page }) => {
    const list = page.getByTestId("recent-campaigns");
    await expect(list).toBeVisible();
    const items = list.getByRole("listitem");
    await expect(items.first()).toBeVisible();
    expect(await items.count()).toBeGreaterThan(0);
  });

  test("activity feed renders", async ({ page }) => {
    const feed = page.getByTestId("activity-feed");
    await expect(feed).toBeVisible();
    // Sample-data seeding creates subscribers, segments, campaigns and a
    // sequence but writes no activity rows, so a fresh demo tenant renders the
    // feed's genuine empty state. Either shape is a rendered feed; a skeleton
    // or an error alert is not.
    const items = feed.getByRole("listitem");
    if ((await items.count()) > 0) {
      await expect(items.first()).toBeVisible();
    } else {
      await expect(feed).toContainText(/no recent activity yet/i);
    }
  });

  test("failed hydration leaves an accessible native recovery action", async ({
    page,
  }) => {
    // Both configured projects use Chromium. Disable script execution before a
    // fresh document loads so this exercises the server-rendered failure state,
    // not a transient snapshot taken while a healthy React tree is hydrating.
    const noScriptPage = await page.context().newPage();
    try {
      const cdp = await page.context().newCDPSession(noScriptPage);
      await cdp.send("Emulation.setScriptExecutionDisabled", { value: true });
      await noScriptPage.goto("/app", { waitUntil: "domcontentloaded" });

      const shell = noScriptPage.locator('[data-dashboard-hydrated="false"]');
      await expect(shell).toBeVisible();
      // The shell now carries several live regions; the recovery status is the
      // one inside the un-hydrated shell that names the wait.
      const status = shell
        .locator('[role="status"]')
        .filter({ hasText: /preparing your workspace/i });
      await expect(status).toBeVisible();
      await expect(status).toContainText(/preparing your workspace/i);
      await expect(status).not.toHaveAttribute("aria-busy", "true");

      const guardedApplication = shell.locator(
        ':scope > div[aria-busy="true"][inert]',
      );
      await expect(guardedApplication).toHaveCount(1);

      const reload = noScriptPage.getByRole("link", {
        name: "Reload workspace",
      });
      await expect(reload).toBeVisible();
      await expect(reload).toHaveAttribute("href", "/app");
      const reloadBox = await reload.boundingBox();
      expect(reloadBox?.height).toBeGreaterThanOrEqual(44);
      await reload.focus();
      await expect(reload).toBeFocused();
    } finally {
      await noScriptPage.close();
    }

    const hydratedShell = page.locator('[data-dashboard-hydrated="true"]');
    await expect(hydratedShell).toBeVisible();
    await expect(
      page.getByText("Preparing your workspace…", { exact: true }),
    ).toHaveCount(0);
    await expect(hydratedShell.locator(":scope > div[inert]")).toHaveCount(0);
  });

  test("refresh button updates timestamps", async ({ page }) => {
    const refresh = page.getByRole("button", { name: /refresh/i });
    await expect(refresh).toBeVisible();

    // The changing value lives in a `data-updated-at` attribute (an ISO string)
    // rather than visible text, so a machine timestamp never leaks into the
    // customer-facing header. Poll the attribute — it advances on every refetch
    // even within the same wall-clock second.
    const timestamp = page.getByTestId("dashboard-last-updated");
    await expect
      .poll(async () => timestamp.getAttribute("data-updated-at"), {
        timeout: 5_000,
      })
      .not.toBeNull();
    const before = await timestamp.getAttribute("data-updated-at");

    await refresh.click();
    await expect
      .poll(async () => timestamp.getAttribute("data-updated-at"), {
        timeout: 5_000,
      })
      .not.toBe(before);
  });

  for (const width of [320, 375]) {
    test(`mobile header keeps controls intact at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });

      const header = page.locator('header[role="banner"]');
      const main = page.locator("main#main-content");
      await expect(header).toBeVisible();
      await expect(main).toBeVisible();

      // These are the mobile-critical actions. Ambient presence and the
      // duplicate theme shortcut intentionally yield until the desktop rail
      // replaces the navigation button.
      await expect(
        header.getByRole("button", { name: "Open navigation" }),
      ).toBeVisible();
      await expect(
        header.getByRole("button", { name: /^Current workspace:/ }),
      ).toBeVisible();
      await expect(
        header.getByRole("button", { name: "Open search" }),
      ).toBeVisible();
      await expect(
        header.getByRole("button", { name: "Create", exact: true }),
      ).toBeVisible();
      await expect(
        header.getByRole("button", { name: /^Notifications/ }),
      ).toBeVisible();
      await expect(
        header.getByRole("button", { name: /^Account menu for/ }),
      ).toBeVisible();
      await expect(
        header.getByRole("button", { name: /^Theme:/ }),
      ).toBeHidden();

      const headerBox = await header.boundingBox();
      expect(headerBox).not.toBeNull();
      const buttons = header.locator("button:visible");
      const boxes = (
        await Promise.all(
          Array.from({ length: await buttons.count() }, (_, index) =>
            buttons.nth(index).boundingBox(),
          ),
        )
      )
        .filter((box): box is NonNullable<typeof box> => box !== null)
        .sort((a, b) => a.x - b.x);

      expect(boxes.length).toBeGreaterThanOrEqual(6);
      for (const box of boxes) {
        expect(box.width).toBeGreaterThanOrEqual(32);
        expect(box.x).toBeGreaterThanOrEqual(headerBox!.x - 0.5);
        expect(box.x + box.width).toBeLessThanOrEqual(
          headerBox!.x + headerBox!.width + 0.5,
        );
      }
      for (let index = 1; index < boxes.length; index += 1) {
        const previous = boxes[index - 1]!;
        const current = boxes[index]!;
        expect(current.x).toBeGreaterThanOrEqual(
          previous.x + previous.width - 0.5,
        );
      }

      const viewport = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        bodyHeight: document.body.scrollHeight,
        innerHeight: window.innerHeight,
        mainOverflowY: getComputedStyle(
          document.querySelector("main#main-content")!,
        ).overflowY,
      }));
      expect(viewport.documentWidth).toBeLessThanOrEqual(viewport.innerWidth);
      expect(viewport.bodyWidth).toBeLessThanOrEqual(viewport.innerWidth);
      expect(viewport.bodyHeight).toBeLessThanOrEqual(viewport.innerHeight + 1);
      expect(viewport.mainOverflowY).toBe("auto");
    });
  }
});
