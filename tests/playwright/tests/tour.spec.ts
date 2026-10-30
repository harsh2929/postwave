import { expect, test, type Page, type Route } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const TOUR_LOCAL_KEYS = [
  "postwave_tour_dashboard_completed_at",
  "postwave_tour_dashboard_step",
  "postwave_tour_marketing_completed_at",
  "postwave_tour_marketing_step",
] as const;

const progressSteps = [
  "verified_sending_identity",
  "configured_dkim_dmarc",
  "created_subscriber",
  "uploaded_subscribers_bulk",
  "designed_first_campaign",
  "sent_first_campaign",
  "created_signup_form",
  "configured_unsubscribe_brand",
  "invited_team_member",
  "connected_product_events",
] as const;

interface TourFixture {
  releaseProgress: () => void;
  decisionWrites: Array<Record<string, unknown>>;
}

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installTourFixture(
  page: Page,
  options: { delayProgress?: boolean } = {},
): Promise<TourFixture> {
  const decisionWrites: Array<Record<string, unknown>> = [];
  let decisionState = "snoozed";
  let releaseProgress = (): void => {};
  const progressGate = options.delayProgress
    ? new Promise<void>((resolve) => {
        releaseProgress = resolve;
      })
    : Promise.resolve();

  await page.route("**/api/v1/onboarding/steps", async (route) => {
    if (route.request().method() === "GET") {
      await json(route, {
        steps: { dashboard_tour: { state: decisionState } },
      });
      return;
    }
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<
      string,
      unknown
    >;
    decisionWrites.push(body);
    if (typeof body.state === "string") decisionState = body.state;
    await json(route, { ok: true });
  });

  await page.route("**/api/v1/onboarding-progress", async (route) => {
    await progressGate;
    const completedKeys = new Set([
      "created_subscriber",
      "verified_sending_identity",
    ]);
    await json(route, {
      steps: progressSteps.map((key) => ({
        key,
        label: key,
        description: key,
        completed: completedKeys.has(key),
      })),
      completed: completedKeys.size,
      total: progressSteps.length,
      percent: 20,
      all_done: false,
    });
  });

  return { releaseProgress, decisionWrites };
}

test.describe("dashboard tour closure", () => {
  test.beforeEach(async ({ context, page }) => {
    test.setTimeout(90_000);
    await context.addInitScript((keys: readonly string[]) => {
      try {
        for (const key of keys) window.localStorage.removeItem(key);
      } catch {
        // Storage can be unavailable before the first real document.
      }
    }, TOUR_LOCAL_KEYS);
    await page.route("**/api/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      }),
    );
  });

  test("auto-start waits for adaptive progress instead of freezing the request race", async ({
    page,
  }) => {
    const fixture = await installTourFixture(page, { delayProgress: true });
    await loginAsDemo(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // The decision has answered, and the old 600ms launch window has elapsed.
    // Until progress settles there is no deterministic adapted step list.
    await page.waitForTimeout(1_200);
    await expect(page.getByTestId("tour-overlay")).toHaveCount(0);

    fixture.releaseProgress();
    const overlay = page.getByTestId("tour-overlay");
    await expect(overlay).toBeVisible({ timeout: 10_000 });
    const dialog = overlay.getByRole("dialog");
    await expect(dialog).toContainText("Everything lives in this rail.");
    // Ten canonical steps minus the Subscriber route + dependent spotlight and
    // the already-completed Settings navigation step.
    await expect(dialog.locator('div[aria-hidden="true"] > span')).toHaveCount(
      7,
    );
  });

  test("a resumed adaptive tour always exposes Finish and Escape restores launcher focus", async ({
    page,
  }) => {
    const fixture = await installTourFixture(page);
    await loginAsDemo(page, { startPath: "/app/sequences" });
    await page.evaluate(() => {
      window.localStorage.setItem("postwave_tour_dashboard_step", "999");
    });

    const launcher = page.getByRole("button", {
      name: "Open product tour menu",
    });
    const launcherBox = await launcher.boundingBox();
    expect(launcherBox?.width).toBeGreaterThanOrEqual(44);
    expect(launcherBox?.height).toBeGreaterThanOrEqual(44);
    await launcher.click();
    await page.getByRole("button", { name: "Take the tour" }).click();

    const overlay = page.getByTestId("tour-overlay");
    const dialog = overlay.getByRole("dialog", { name: "You're set." });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/\/app\/sequences(?:[/?#]|$)/u);
    const finish = dialog.getByRole("button", { name: "Finish" });
    await expect(finish).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    await expect(launcher).toBeFocused();
    await expect.poll(() => fixture.decisionWrites.length).toBe(1);
    expect(fixture.decisionWrites[0]).toMatchObject({
      step_key: "dashboard_tour",
      state: "dismissed",
    });
  });

  test("Finish is exactly-once, motion-safe, and hands focus back to Help", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fixture = await installTourFixture(page);
    await loginAsDemo(page, { startPath: "/app/sequences" });
    await page.evaluate(() => {
      window.localStorage.setItem("postwave_tour_dashboard_step", "999");
    });

    const launcher = page.getByRole("button", {
      name: "Open product tour menu",
    });
    await launcher.click();
    await page.getByRole("button", { name: "Take the tour" }).click();
    const finish = page
      .getByRole("dialog", { name: "You're set." })
      .getByRole("button", { name: "Finish" });
    await expect(finish).toBeFocused();
    await finish.evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });

    await expect(page.getByTestId("tour-overlay")).toHaveCount(0);
    await expect(page.getByTestId("confetti-canvas")).toBeVisible();
    await expect(launcher).toBeFocused();
    await expect.poll(() => fixture.decisionWrites.length).toBe(1);
    const localState = await page.evaluate(() => ({
      completed: window.localStorage.getItem(
        "postwave_tour_dashboard_completed_at",
      ),
      step: window.localStorage.getItem("postwave_tour_dashboard_step"),
    }));
    expect(localState.completed).not.toBeNull();
    expect(localState.step).toBeNull();
  });

  test("a responsive target can disappear and return without orphaning the dialog", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "The persistent sidebar target is desktop-only",
    );
    await installTourFixture(page);
    await loginAsDemo(page);
    const overlay = page.getByTestId("tour-overlay");
    await expect(overlay).toBeVisible({ timeout: 10_000 });
    const dialog = overlay.getByRole("dialog");
    const next = dialog.getByRole("button", { name: "Next" });
    await expect(next).toBeFocused();
    await expect(page.getByTestId("tour-spotlight")).toBeVisible();

    const target = page.locator('[data-tour="dashboard-sidebar"]');
    await target.evaluate((element) => element.setAttribute("hidden", ""));
    await expect(page.getByTestId("tour-spotlight")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(next).toBeFocused();

    await target.evaluate((element) => element.removeAttribute("hidden"));
    await expect(page.getByTestId("tour-spotlight")).toBeVisible();
    await expect(next).toBeFocused();
  });
});
