import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const MATRIX_DISCOUNT = "MATRIX-SAVE";
const MATRIX_POOL = "matrix-pool";

interface CommerceWrites {
  affiliateRequests: string[];
  agencyChildPosts: number;
  brandingPatches: number;
  couponRequests: string[];
  discountDeletes: number;
  discountPatches: number;
  payoutPatches: number;
}

const billingState = {
  tier: "studio_ltd_cloud",
  startedAt: "2026-08-01",
  sendingAddon: {
    monthlyCap: 50_000,
    used: 12_500,
    daysRemaining: 5,
    overageEnabled: false,
    overageUnits: 0,
    overageCap: null,
    overageChargeable: false,
    overageBillingConfigured: false,
  },
  card: { brand: "visa", last4: "4242" },
} as const;

const discount = {
  id: "discount-matrix",
  tenant_id: "tenant-matrix",
  code: MATRIX_DISCOUNT,
  percent_off: 20,
  amount_off_cents: null,
  currency: "usd",
  max_redemptions: 50,
  times_redeemed: 2,
  expires_at: "2030-01-01T00:00:00Z",
  created_at: "2026-08-01T00:00:00Z",
} as const;

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installCommerceRoutes(page: Page): Promise<CommerceWrites> {
  const writes: CommerceWrites = {
    affiliateRequests: [],
    agencyChildPosts: 0,
    brandingPatches: 0,
    couponRequests: [],
    discountDeletes: 0,
    discountPatches: 0,
    payoutPatches: 0,
  };

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path.includes("/admin/affiliates")) {
      writes.affiliateRequests.push(`${method} ${path}`);
      await route.continue();
      return;
    }

    if (path.startsWith("/api/v1/coupon-pools")) {
      writes.couponRequests.push(`${method} ${path}`);
      await json(route, { code: "not_found", message: "Not mounted" }, 404);
      return;
    }

    if (path === "/api/v1/billing/state") {
      await json(route, billingState);
      return;
    }
    if (path === "/api/v1/billing/usage") {
      await json(route, [
        { date: "2026-08-24", sent: 1_200 },
        { date: "2026-08-25", sent: 1_450 },
      ]);
      return;
    }
    if (path === "/api/v1/billing/invoices") {
      await json(route, [
        {
          id: "invoice-matrix",
          number: "PW-2026-0001",
          date: "2026-08-01",
          amount: "$29.00",
          status: "paid",
          downloadUrl: "",
        },
      ]);
      return;
    }
    if (path === "/api/v1/billing/plan-summary") {
      await json(route, {
        tier: "sending",
        current_period_end: "2026-09-01T00:00:00Z",
        resources: [
          {
            resource: "monthly_sends",
            current: 12_500,
            limit: 50_000,
            percent: 25,
            exceeded: false,
          },
        ],
        sends_projection: {
          current: 12_500,
          limit: 50_000,
          as_of: "2026-08-26T00:00:00Z",
          period_start: "2026-08-01T00:00:00Z",
          period_end: "2026-09-01T00:00:00Z",
          avg_per_day: 480,
          days_elapsed: 26,
          days_in_period: 31,
          projected_end_of_period: 14_880,
          projected_exceed_date: null,
          on_track_to_exceed: false,
        },
      });
      return;
    }
    if (path === "/api/v1/limits/usage") {
      await json(route, {
        tier: "sending",
        rows: [
          {
            resource: "contacts",
            current: 125,
            limit: 5_000,
            percent: 2.5,
            exceeded: false,
          },
        ],
      });
      return;
    }
    if (path === "/api/v1/billing/overage" && method === "PUT") {
      await json(route, billingState);
      return;
    }

    if (path === `/api/v1/discounts/${MATRIX_DISCOUNT}/check`) {
      await json(route, {
        code: MATRIX_DISCOUNT,
        valid: true,
        currently_redeemable: true,
      });
      return;
    }
    if (path === `/api/v1/discounts/${MATRIX_DISCOUNT}/redemptions`) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const requested = Number(url.searchParams.get("limit") ?? 26);
      const rows = Array.from(
        { length: offset === 0 ? requested : 2 },
        (_, index) => ({
          id: offset + index + 1,
          discount_id: discount.id,
          discount_code: MATRIX_DISCOUNT,
          subscriber_id: `subscriber-${offset + index + 1}`,
          subscriber_email: `very.long.address.${offset + index + 1}@example.test`,
          redeemed_at: "2026-08-25T12:00:00Z",
        }),
      );
      await json(route, { items: rows });
      return;
    }
    if (path === `/api/v1/discounts/${MATRIX_DISCOUNT}` && method === "PATCH") {
      writes.discountPatches += 1;
      await json(route, discount);
      return;
    }
    if (
      path === `/api/v1/discounts/${MATRIX_DISCOUNT}` &&
      method === "DELETE"
    ) {
      writes.discountDeletes += 1;
      await json(route, { ok: true });
      return;
    }
    if (path === "/api/v1/discounts") {
      await json(route, { items: [discount] });
      return;
    }

    if (path === "/api/v1/agency/children") {
      if (method === "POST") {
        writes.agencyChildPosts += 1;
        await json(route, {
          id: "child-created",
          slug: "created-child",
          name: "Created child",
          tier: "studio",
          billing_mode: "self",
        });
        return;
      }
      await json(route, {
        children: [
          {
            id: "child-matrix",
            slug: "a-very-long-child-workspace-slug-for-layout-testing",
            name: "A very long child workspace name for responsive testing",
            tier: "sending",
            billing_mode: "parent",
            reseller_markup_bps: 750,
            whitelabel_enabled: true,
            created_at: "2026-08-01T00:00:00Z",
          },
        ],
        count: 1,
      });
      return;
    }
    if (path === "/api/v1/agency/branding") {
      if (method === "PATCH") {
        writes.brandingPatches += 1;
        await new Promise((resolve) => setTimeout(resolve, 120));
        await json(route, JSON.parse(request.postData() ?? "{}"));
      } else {
        await json(route, {
          whitelabel_enabled: true,
          brand_name: "Matrix Agency",
          custom_domain: "mail.matrix.test",
          logo_url: "https://cdn.matrix.test/logo.svg",
          primary_color: "#3157d5",
          support_email: "support@matrix.test",
          legal_entity: "Matrix Agency LLC",
        });
      }
      return;
    }
    if (path === "/api/v1/agency/invoice-preview") {
      await json(route, {
        agency_tenant_id: "tenant-matrix",
        window_days: 30,
        price_per_thousand_usd: 0.5,
        lines: [
          {
            child_tenant_id: "child-matrix",
            child_slug: "a-very-long-child-workspace-slug-for-layout-testing",
            child_tier: "sending",
            billing_mode: "parent",
            sends_last_30d: 12_345,
            base_cost_usd: 6.1725,
            reseller_markup_bps: 750,
            markup_usd: 0.4629,
            line_total_usd: 6.6354,
          },
        ],
        subtotal_usd: 6.1725,
        total_usd: 6.6354,
        note: "Preview only; final invoice pricing is authoritative.",
      });
      return;
    }

    if (path === "/api/v1/referrals/stats") {
      await json(route, {
        funnel: {
          conversions_7d: 3,
          conversions_30d: 8,
          conversions_90d: 14,
          clicks_total: 120,
          fraud_filtered_count: 2,
        },
        top_referrers: [
          {
            subscriber_id: "subscriber-referrer-1",
            count: 8,
            last_at: "2026-08-25T00:00:00Z",
          },
        ],
        recent: [
          {
            referrer_id: "subscriber-referrer-1",
            referee_id: "subscriber-referee-with-a-long-identifier",
            created_at: "2026-08-25T00:00:00Z",
          },
        ],
      });
      return;
    }
    if (path === "/api/v1/referrals/leaderboard") {
      await json(route, {
        window_days: 90,
        items: [
          {
            referrer_email_masked: "m***x@very-long-example-domain.test",
            conversions: 8,
            milestone: 5,
            rank: 1,
          },
        ],
      });
      return;
    }
    if (path === "/api/v1/referrals/payouts/export") {
      await route.fulfill({
        status: 200,
        contentType: "text/csv",
        body: "id,status\n",
      });
      return;
    }
    if (path === "/api/v1/referrals/payouts" && method === "GET") {
      await json(route, {
        total: 1,
        items: [
          {
            id: "reward-matrix",
            referrer_id: "subscriber-referrer-1",
            milestone: 5,
            reward_label: "A carefully reviewed launch reward",
            status: "pending",
            created_at: "2026-08-20T00:00:00Z",
            updated_at: "2026-08-20T00:00:00Z",
          },
        ],
      });
      return;
    }
    if (
      path === "/api/v1/referrals/payouts/reward-matrix" &&
      method === "PATCH"
    ) {
      writes.payoutPatches += 1;
      await json(route, {
        id: "reward-matrix",
        referrer_id: "subscriber-referrer-1",
        milestone: 5,
        reward_label: "A carefully reviewed launch reward",
        status: "approved",
        created_at: "2026-08-20T00:00:00Z",
        updated_at: "2026-08-26T00:00:00Z",
      });
      return;
    }
    if (path === "/api/v1/referral-programs/current") {
      await json(route, {
        id: "program-matrix",
        active: true,
        expires_at: "2030-01-01T00:00:00Z",
        verification_window_days: 14,
        referee_reward_kind: "custom",
        referee_reward_label: "Welcome credit",
        milestones: [
          { count: 5, reward_kind: "custom", reward_label: "Launch reward" },
        ],
      });
      return;
    }
    if (path === "/api/v1/referral-programs" && method === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      await json(route, { id: "program-matrix-next", active: true, ...body });
      return;
    }

    await route.continue();
  });

  return writes;
}

const SURFACES = [
  { path: "/app/billing", settled: "Current plan" },
  { path: "/app/billing/upgrade", settled: "Provisional billing plans" },
  { path: "/app/discounts", settled: "Discount codes" },
  {
    path: `/app/discounts/${MATRIX_DISCOUNT}`,
    settled: "Live redeemability",
  },
  {
    path: `/app/discounts/coupon-pools/${MATRIX_POOL}`,
    settled: "Coupon pools are release-held",
  },
  { path: "/app/affiliates", settled: "Production qualification required" },
  {
    path: "/app/affiliates/matrix-record",
    settled: "Production qualification required",
  },
  { path: "/app/referrals", settled: "Historical link clicks" },
  {
    path: "/app/agency",
    settled: "A very long child workspace name for responsive testing",
  },
] as const;

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

test.describe("commerce and business administration quality matrix", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    test.setTimeout(240_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      (
        window as typeof window & {
          __POSTWAVE_FORCE_REAL_API_FOR_E2E__?: boolean;
        }
      ).__POSTWAVE_FORCE_REAL_API_FOR_E2E__ = true;
    });
    await page.route("**/api/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      }),
    );
    await loginAsDemo(page, { navigate: false });
  });

  test("every route has one page landmark, one h1, no overflow, and no blocking axe findings", async ({
    page,
  }) => {
    await installCommerceRoutes(page);

    for (const surface of SURFACES) {
      const response = await page.goto(surface.path, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      expect(
        response?.status(),
        `${surface.path} document response`,
      ).toBeLessThan(400);
      await expect(page.locator("main#main-content")).toHaveCount(1);
      await expect(page.locator("main#main-content h1")).toHaveCount(1);
      await expect(page.locator("main#main-content h1")).toBeVisible();

      if (surface.settled === "Current plan") {
        await expect(
          page.getByRole("heading", { name: /^Current plan/ }),
        ).toBeVisible({ timeout: 30_000 });
      } else if (surface.settled === "Provisional billing plans") {
        await expect(page.getByLabel(surface.settled)).toBeVisible({
          timeout: 30_000,
        });
      } else {
        await expect(
          page.getByText(surface.settled, { exact: true }).first(),
        ).toBeVisible({
          timeout: 30_000,
        });
      }

      const geometry = await page.evaluate(() => ({
        viewport: window.innerWidth,
        html: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        duplicateIds: Array.from(document.querySelectorAll("[id]"))
          .map((node) => node.id)
          .filter((id, index, ids) => ids.indexOf(id) !== index),
      }));
      expect(
        Math.max(geometry.html, geometry.body),
        `${surface.path} overflows ${geometry.viewport}px`,
      ).toBeLessThanOrEqual(geometry.viewport + 1);
      expect(geometry.duplicateIds, `${surface.path} duplicate ids`).toEqual(
        [],
      );

      if ((page.viewportSize()?.width ?? 1_024) < 768) {
        const undersized = await page
          .locator(
            "main#main-content button, main#main-content a, main#main-content select, main#main-content textarea, main#main-content input:not([type=checkbox]):not([type=radio]):not([type=hidden])",
          )
          .evaluateAll((nodes) =>
            nodes.flatMap((node) => {
              const element = node as HTMLElement;
              const rect = element.getBoundingClientRect();
              const style = window.getComputedStyle(element);
              if (
                rect.width === 0 ||
                rect.height === 0 ||
                style.visibility === "hidden" ||
                style.display === "none" ||
                element.getAttribute("aria-hidden") === "true"
              ) {
                return [];
              }
              return rect.height < 43.5 || rect.width < 43.5
                ? [
                    `${element.tagName.toLowerCase()}[${
                      element.getAttribute("aria-label") ??
                      element.textContent?.trim().slice(0, 40) ??
                      "unlabelled"
                    }] ${Math.round(rect.width)}x${Math.round(rect.height)}`,
                  ]
                : [];
            }),
          );
        expect(undersized, `${surface.path} undersized mobile targets`).toEqual(
          [],
        );
      }

      const axe = await new AxeBuilder({ page })
        .include("main#main-content")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = axe.violations.filter(
        (violation) =>
          violation.impact && BLOCKING_IMPACTS.has(violation.impact),
      );
      expect(
        blocking,
        `${surface.path}\n${JSON.stringify(blocking, null, 2)}`,
      ).toEqual([]);
    }
  });

  test("URL state, keyboard tabs, browser history, and guarded writes stay coherent", async ({
    page,
  }) => {
    const writes = await installCommerceRoutes(page);

    await page.goto("/app/agency", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByText(
        "A very long child workspace name for responsive testing",
        {
          exact: true,
        },
      ),
    ).toBeVisible({ timeout: 30_000 });
    const subaccounts = page.getByRole("tab", { name: "Sub-accounts" });
    await expect(subaccounts).toHaveAttribute("aria-selected", "true");
    await subaccounts.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(/\/app\/agency\?tab=branding$/);
    await expect(page.getByLabel("Brand name")).toHaveValue("Matrix Agency");
    await page.getByLabel("Brand name").fill("Matrix Agency Updated");
    await page
      .getByRole("button", { name: "Save branding" })
      .evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
      });
    await expect.poll(() => writes.brandingPatches).toBe(1);
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/agency$/);
    await expect(subaccounts).toHaveAttribute("aria-selected", "true");
    await page.goForward();
    await expect(page).toHaveURL(/tab=branding/);

    await page.goto("/app/referrals", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("Historical link clicks", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: "Reward fulfillment" }).click();
    await expect(page).toHaveURL(/tab=payouts/);
    const payoutFilter = page.getByLabel("Filter reward fulfillment by status");
    await payoutFilter.selectOption("approved");
    await expect(page).toHaveURL(/status=approved/);
    await page.goBack();
    await expect(payoutFilter).toHaveValue("all");
    await page.getByRole("tab", { name: "Program" }).click();
    await expect(page.getByLabel("Verification window (days)")).toHaveValue(
      "14",
    );

    await page.goto("/app/discounts", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByText(MATRIX_DISCOUNT, { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    const search = page.getByLabel("Search discount codes");
    await search.fill("MATRIX SAVE");
    await expect(page).toHaveURL(/q=MATRIX\+SAVE/, { timeout: 10_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(search).toHaveValue("MATRIX SAVE");

    await page.goto(`/app/discounts/${MATRIX_DISCOUNT}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page).toHaveURL(/page=2/);
    await page.goBack();
    await expect(page).not.toHaveURL(/page=2/);

    await page.goto(`/app/discounts/coupon-pools/${MATRIX_POOL}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByText("No inventory or issuance is being simulated"),
    ).toBeVisible();
    expect(writes.couponRequests).toEqual([]);

    await page.goto("/app/affiliates", { waitUntil: "domcontentloaded" });
    await page.goto("/app/affiliates/matrix-record", {
      waitUntil: "domcontentloaded",
    });
    expect(writes.affiliateRequests).toEqual([]);
  });

  test("discovers mounted dialogs while release-held commerce actions stay absent", async ({
    page,
  }) => {
    const writes = await installCommerceRoutes(page);

    await page.goto("/app/agency", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByText(
        "A very long child workspace name for responsive testing",
        {
          exact: true,
        },
      ),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "New sub-account" }).click();
    const childDialog = page.getByRole("dialog", { name: "New sub-account" });
    await expect(childDialog).toBeVisible();
    await expect(childDialog.getByLabel("Workspace name")).toBeVisible();
    await expect(
      childDialog.getByRole("button", { name: "Create workspace" }),
    ).toBeDisabled();
    await childDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(childDialog).toBeHidden();
    expect(writes.agencyChildPosts).toBe(0);

    await page.goto("/app/referrals?tab=payouts", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByText("A carefully reviewed launch reward", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Approve" }).click();
    const payoutDialog = page.getByRole("dialog", {
      name: "Approve this reward?",
    });
    await expect(payoutDialog).toContainText("ready for fulfillment");
    await payoutDialog.getByRole("button", { name: "Cancel" }).click();
    expect(writes.payoutPatches).toBe(0);

    await page.goto("/app/discounts", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByText(MATRIX_DISCOUNT, { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: /New discount|Duplicate/i }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Redemptions" }).click();
    const redemptionsDialog = page.getByRole("dialog", {
      name: `Redemptions · ${MATRIX_DISCOUNT}`,
    });
    await expect(
      redemptionsDialog.getByLabel(`Recent redemptions for ${MATRIX_DISCOUNT}`),
    ).toBeVisible();
    await redemptionsDialog.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editDialog = page.getByRole("dialog", {
      name: `Edit ${MATRIX_DISCOUNT}`,
    });
    await expect(
      editDialog.getByLabel("Max redemptions (blank = uncapped)"),
    ).toHaveValue("50");
    await expect(
      editDialog.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
    await editDialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const deleteDialog = page.getByRole("dialog", {
      name: `Delete discount ${MATRIX_DISCOUNT}?`,
    });
    await expect(deleteDialog).toContainText(
      "Existing redemption records are kept",
    );
    await deleteDialog.getByRole("button", { name: "Cancel" }).click();
    expect(writes.discountDeletes).toBe(0);
    expect(writes.discountPatches).toBe(0);

    await expect(
      page.getByRole("button", {
        name: /New coupon pool|Create pool|Import codes|Assign coupon/i,
      }),
    ).toHaveCount(0);
    expect(writes.couponRequests).toEqual([]);

    await page.goto(`/app/discounts/coupon-pools/${MATRIX_POOL}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByText("Coupon pools are release-held", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /Create pool|Import codes|Assign coupon|Pause|Archive/i,
      }),
    ).toHaveCount(0);
    expect(writes.couponRequests).toEqual([]);

    await page.goto("/app/affiliates", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("Partner enrollment", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Payout execution", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /New affiliate|Initiate payout|Create payout/i,
      }),
    ).toHaveCount(0);

    await page.goto("/app/affiliates/matrix-record", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", {
        name: "Affiliate record access is unavailable",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /New affiliate|Initiate payout|Create payout/i,
      }),
    ).toHaveCount(0);
    expect(writes.affiliateRequests).toEqual([]);
  });
});
