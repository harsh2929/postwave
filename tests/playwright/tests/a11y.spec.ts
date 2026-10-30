import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { loginAsDemo } from "../helpers/auth";
import { seedSampleData } from "../fixtures/test-data";

/**
 * Accessibility scans on the most important pages.
 *
 * We filter to `critical` and `serious` only — `moderate` and `minor`
 * issues are surfaced via the HTML report but do not fail the suite.
 * Bumping the bar to include moderate is a follow-up once the first set
 * of criticals is clean.
 */

const SEVERITY_FAIL = new Set(["critical", "serious"]);

/**
 * Put the dashboard tour back in front of a first-time visitor.
 *
 * The auto-launch gate moved: `postwave_tour_dashboard_completed_at` in
 * localStorage is now only a CACHE, and a decision recorded against
 * `PUT /api/v1/onboarding/steps` OUTRANKS it in both directions (see
 * `apps/web/src/components/tour/tour-routing.ts::tourAutoStartGate`). The demo
 * tenant carries `dashboard_tour: dismissed` on the server, so clearing browser
 * storage alone leaves the gate `blocked` and the overlay never mounts.
 *
 * `snoozed` is the vocabulary's restore state — the same one the product's own
 * "Show it again" control writes — so this re-establishes the precondition the
 * test needs without inventing a state the server would reject.
 */
async function restoreDashboardTour(baseURL: string): Promise<void> {
  const response = await fetch(`${baseURL}/api/v1/onboarding/steps`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Tenant-Slug": "demo",
    },
    body: JSON.stringify({ step_key: "dashboard_tour", state: "snoozed" }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to restore dashboard tour (${response.status}): ${await response.text()}`,
    );
  }
}

async function scan(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact && SEVERITY_FAIL.has(v.impact),
  );
  return { results, blocking };
}

test.describe("a11y", () => {
  // `networkidle` is unreachable inside the app shell: it holds two permanent
  // SSE streams open (`/api/v1/events?topics=…` for the event bus and
  // `?topics=presence.update` for presence), so there is never a 500ms window
  // with zero in-flight requests. Wait on the rendered content the scan is
  // meant to cover instead — that is a stronger settle signal anyway, because
  // it proves the data landed rather than that the socket went quiet.
  test("dashboard passes axe-core scan", async ({ page, baseURL }) => {
    await seedSampleData(baseURL!);
    await loginAsDemo(page);
    // Stat cards only mount once the overview query resolves, so this waits
    // for a data-complete dashboard rather than the loading skeleton.
    // 30s matches the budget the replaced `waitForLoadState` had (it inherits
    // navigationTimeout), not the 10s expect default — this is the settle
    // wait, not the assertion under test.
    await expect(page.getByTestId("stat-card").first()).toBeVisible({
      timeout: 30_000,
    });
    const { blocking } = await scan(page);
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });

  test("login passes axe scan", async ({ page }) => {
    // The stack under test is `next dev`, which compiles a route the first time
    // it is requested. A cold `/login` measured 16-25s here and overran the 30s
    // `navigationTimeout` once the suite reached it, so this navigation gets its
    // own budget. Nothing about the scan itself is relaxed.
    test.slow();
    await page.goto("/login", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    // Same reasoning as the app-shell tests: wait on rendered content rather
    // than on the network going quiet. It proves the page painted, which is
    // what the scan needs, and it does not depend on request timing.
    // `exact` because the card also offers "Sign in with another device",
    // which the substring match would tie with.
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const { blocking } = await scan(page);
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });

  test("settings passes axe scan", async ({ page }) => {
    await loginAsDemo(page, { startPath: "/app/settings" });
    // Same SSE caveat as above. The workspace-name field stays `disabled`
    // until the settings fetch resolves, so "enabled" is this page's
    // data-complete signal.
    await expect(page.getByLabel("Workspace name")).toBeEnabled({
      timeout: 30_000,
    });
    const { blocking } = await scan(page);
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });

  test("newsletter template library passes axe scan", async ({ page }) => {
    // `/app/templates` is one of the heavier dev-mode compiles in this app
    // (24s cold, measured), which overran the 30s `navigationTimeout` that
    // `loginAsDemo`'s own `page.goto` inherits. Attach the tenant cookies
    // without navigating, then drive the navigation here so it can carry its
    // own budget. Every assertion below is unchanged.
    test.slow();
    await loginAsDemo(page, { navigate: false });
    await page.goto("/app/templates", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await expect(
      page.getByRole("heading", { name: "Newsletter templates" }),
    ).toBeVisible({ timeout: 30_000 });
    // Next.js keeps an empty route-announcer with role=alert mounted. Scope
    // this assertion to product errors inside the page instead of treating
    // that framework-owned live region as a failed catalogue request.
    await expect(page.locator("#main-content [role='alert']")).toHaveCount(0);
    // Either real cards or a real empty state — never a stuck skeleton. The
    // alternatives are the five titles `_components/browser.tsx` can actually
    // render (`No favorite designs yet`, `No archived templates`, `No designs
    // match these filters`, `You haven’t made a template yet`, `No designs for
    // this goal yet`). On a migrated database Inspiration lists the built-in
    // starters, so the cards branch is the one expected here.
    await expect(
      page
        .getByRole("article")
        .or(
          page.getByText(
            /No favorite designs yet|No archived templates|No designs match these filters|You haven’t made a template yet|No designs for this goal yet/i,
          ),
        )
        .first(),
    ).toBeVisible({ timeout: 30_000 });
    const { blocking } = await scan(page);
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });

  test("new campaign modal passes axe scan", async ({ page, baseURL }) => {
    await seedSampleData(baseURL!);
    await loginAsDemo(page, { startPath: "/app/campaigns" });
    await page.getByRole("button", { name: /new campaign/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // Radix plays a fade/zoom enter on both the scrim and the panel, and axe
    // samples COMPUTED colors. Scanning mid-fade measures the half-transparent
    // panel blended over `bg-black/50` and reports contrast for colors that are
    // never actually painted: two runs flagged the same description text at
    // 3.09 and 3.69, where at rest it is #5c5c5c on #fdfcf7 = 6.9:1. Wait for
    // the enter animation to finish so the scan sees the resting frame. Scoped
    // to the dialog subtree because the app shell runs indefinite animations
    // that would never report `finished`.
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;
      const scrim = dialog.parentElement?.querySelector(
        '[aria-hidden="true"][data-state="open"]',
      );
      const roots = [dialog, scrim].filter(Boolean) as Element[];
      return roots.every(
        (root) =>
          getComputedStyle(root).opacity === "1" &&
          root
            .getAnimations({ subtree: true })
            .every((animation) => animation.playState === "finished"),
      );
    });
    const { blocking } = await scan(page);
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });

  test("tour overlay passes axe scan", async ({ page, context, baseURL }) => {
    await restoreDashboardTour(baseURL!);
    // The real keys are `postwave_tour_<tourId>_{completed_at,step}` — see
    // `TourProvider.tsx::lsKey`. The two colon-separated names this used to
    // remove have never existed, so this step was a no-op.
    await context.addInitScript(() => {
      try {
        window.localStorage.removeItem("postwave_tour_dashboard_completed_at");
        window.localStorage.removeItem("postwave_tour_dashboard_step");
      } catch {
        // ignore
      }
    });
    await loginAsDemo(page);
    // The gate deliberately waits for `GET /api/v1/onboarding/steps` before it
    // launches anything (no-flash rule), and only then arms a 600ms timer, so
    // the overlay lands one round-trip plus a beat after the shell paints.
    await expect(page.getByTestId("tour-overlay")).toBeVisible({
      timeout: 30_000,
    });
    const { blocking } = await scan(page);
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });

  test("status page passes axe scan", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto("/status");
    await page.waitForLoadState("networkidle");
    const { blocking } = await scan(page);
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });
});
