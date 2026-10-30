import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const ROUTES = [
  ["/app/cohorts", "Cohorts"],
  ["/app/lifecycle", "Lifecycle"],
  ["/app/predictive", "Predictive"],
  ["/app/scoring", "Scoring and tags"],
  ["/app/retention", "Win-back"],
  ["/app/replies", "Replies"],
  ["/app/sms", "SMS"],
  ["/app/routing", "Routing"],
  ["/app/signup-protection", "Signup protection"],
  ["/app/reviews", "Reviews"],
  ["/app/archive-settings", "Archive settings"],
] as const;

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

const SEEDED_SMS_PHONE = "+15552345678";
const SEEDED_SMS_CUTOFF = "2026-08-21T10:00:00Z";

async function installSeededSmsWorkspace(page: Page) {
  // The dashboard layout seeds auth server-side, outside Playwright's browser
  // routes. Reuse that authoritative identity so the hydrated cache and every
  // strict tenant-bound SMS envelope agree.
  const authResponse = await page.request.get("/api/v1/auth/me");
  expect(authResponse.ok(), "authoritative demo identity lookup").toBe(true);
  const me = (await authResponse.json()) as Record<string, unknown>;
  if (typeof me.tenant_id !== "string" || me.tenant_id.length === 0) {
    throw new Error("Authoritative demo identity omitted tenant_id");
  }
  const seededTenant = me.tenant_id;
  const sender = {
    id: "sms-sender-browser-certification",
    provider: "twilio",
    country: "US",
    sender_type: "10dlc",
    phone_number: "+14155550123",
    messaging_service_sid: "MG-browser-certification",
    registration_status: "approved",
    metadata: {},
    created_at: "2026-08-20T08:00:00Z",
    updated_at: "2026-08-20T08:00:00Z",
  };
  const list = {
    id: "sms-list-browser-certification",
    name: "VIP list",
    description: "Seeded browser-certification audience",
    keyword: "VIP",
    sender_profile_id: sender.id,
    recipient_count: 12,
    created_at: "2026-08-20T08:00:00Z",
    updated_at: "2026-08-20T08:00:00Z",
  };
  const campaign = {
    id: "sms-campaign-browser-certification",
    sender_profile_id: sender.id,
    list_id: list.id,
    name: "Seed campaign",
    body: "A seeded SMS campaign.",
    status: "scheduled",
    scheduled_at: "2026-08-27T09:00:00Z",
    metadata: { link_tracking: false },
    created_at: "2026-08-20T08:00:00Z",
    updated_at: "2026-08-20T08:00:00Z",
  };

  await page.route("**/api/v1/auth/me", async (route) => {
    await fulfillJson(route, me);
  });
  await page.route("**/api/v1/sms/**", async (route) => {
    const request = route.request();
    const pathname = decodeURIComponent(new URL(request.url()).pathname);
    const method = request.method();

    if (method === "POST" && pathname.endsWith("/mark-read")) {
      await fulfillJson(route, { ok: true, applied: 1 });
      return;
    }
    if (method !== "GET") {
      await route.fallback();
      return;
    }

    const responses: Record<string, unknown> = {
      "/api/v1/sms/setup": {
        senders: [sender],
        can_send: false,
        blocking_reasons: ["sms_broadcast_dispatch_release_held"],
      },
      "/api/v1/sms/compliance": {
        can_send: false,
        senders: [sender],
        items: [],
      },
      "/api/v1/sms/pilot-readiness": {
        can_pilot: false,
        counts: { blocker: 1 },
        items: [],
      },
      "/api/v1/sms/lists": { items: [list] },
      "/api/v1/sms/campaigns": { items: [campaign] },
      "/api/v1/sms/regions": { items: [] },
      "/api/v1/sms/templates": { items: [] },
      "/api/v1/sms/discount-codes": { items: [] },
      "/api/v1/sms/senders/pilot-certifications": { items: [] },
      "/api/v1/sms/quick-replies": { replies: [] },
      "/api/v1/sms/suppressions": {
        tenantId: seededTenant,
        items: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            phone_e164: SEEDED_SMS_PHONE,
            reason: "manual",
            source: "manual",
            reversible: true,
            created_at: "2026-08-21T09:00:00Z",
          },
        ],
        total: 1,
        snapshotAt: SEEDED_SMS_CUTOFF,
      },
      "/api/v1/sms/keyword-responses": {
        items: [
          {
            id: "keyword-browser-certification",
            keyword: "LEAVE",
            action: "opt_out",
            response_body:
              "You have been unsubscribed and will receive no further messages.",
            response_text:
              "You have been unsubscribed and will receive no further messages.",
            enabled: true,
            autoReplyDispatchAvailable: false,
            autoReplyDispatchUnavailableReason:
              "sms_auto_reply_dispatch_release_held",
            opt_in_count: 0,
            created_at: "2026-08-21T09:00:00Z",
            updated_at: "2026-08-21T09:00:00Z",
          },
        ],
      },
      "/api/v1/sms/conversations": {
        tenantId: seededTenant,
        conversations: [
          {
            phoneE164: SEEDED_SMS_PHONE,
            identityAmbiguous: false,
            subscriberEmail: "reader@example.test",
            lastMessagePreview: "Please help with my subscription",
            lastMessageAt: "2026-08-21T09:00:00Z",
            lastDirection: "inbound",
            messageCount: 1,
            unreadCount: 1,
            oldestUnreadAt: "2026-08-21T09:00:00Z",
          },
        ],
        snapshotAt: SEEDED_SMS_CUTOFF,
        unreadTotal: 1,
        unknownTotal: 0,
        totalConversations: 1,
        activeTotal: 1,
        snoozedTotal: 0,
        archivedTotal: 0,
      },
      [`/api/v1/sms/conversations/${SEEDED_SMS_PHONE}/messages`]: {
        tenantId: seededTenant,
        messages: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            tenant_id: seededTenant,
            phone_e164: SEEDED_SMS_PHONE,
            provider: "twilio",
            direction: "inbound",
            body: "Please help with my subscription",
            segments: 1,
            status: "received",
            cost_micros: 0,
            created_at: "2026-08-21T09:00:00Z",
          },
        ],
        snapshotAt: SEEDED_SMS_CUTOFF,
      },
    };
    const response = responses[pathname];
    if (response === undefined) {
      await route.fallback();
      return;
    }
    await fulfillJson(route, response);
  });
}

async function gotoRoute(page: Page, path: string, heading: string) {
  const response = await page.goto(path, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  expect(response?.status() ?? 0, `${path}: document response`).toBeLessThan(
    400,
  );
  const root = page.locator('#main-content [data-slot="page-transition"]');
  await expect(page.locator("main#main-content")).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(
    root.getByRole("heading", { level: 1, name: heading, exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveTitle(
    new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
  );
  await expect(root.locator('[class*="animate-pw-shimmer"]')).toHaveCount(0, {
    timeout: 60_000,
  });
  await root.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

async function auditRoute(page: Page, path: string, mobile: boolean) {
  const root = page.locator('#main-content [data-slot="page-transition"]');
  const layout = await root.evaluate((routeRoot, requireTouchTargets) => {
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const ids = Array.from(routeRoot.querySelectorAll<HTMLElement>("[id]")).map(
      (element) => element.id,
    );
    const undersized = requireTouchTargets
      ? Array.from(
          routeRoot.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [role="button"]:not([aria-disabled="true"]), [role="tab"]:not([aria-disabled="true"])',
          ),
        )
          .filter(visible)
          .map((element) => {
            const hitTarget =
              element instanceof HTMLInputElement &&
              ["checkbox", "radio"].includes(element.type)
                ? (element.closest<HTMLElement>("label") ?? element)
                : element;
            const rect = hitTarget.getBoundingClientRect();
            return {
              label:
                element.getAttribute("aria-label") ??
                element.getAttribute("title") ??
                element.textContent
                  ?.trim()
                  .replace(/\s+/gu, " ")
                  .slice(0, 70) ??
                element.tagName,
              width: Math.round(rect.width * 10) / 10,
              height: Math.round(rect.height * 10) / 10,
            };
          })
          .filter(({ width, height }) => width < 43.5 || height < 43.5)
      : [];
    const main = document.querySelector<HTMLElement>("main#main-content");
    const mainRect = main?.getBoundingClientRect();
    let mainScrollsHorizontally = false;
    if (main) {
      const previous = main.scrollLeft;
      main.scrollLeft = 10_000;
      mainScrollsHorizontally = main.scrollLeft > 1;
      main.scrollLeft = previous;
    }
    const overflowDiagnostics = Array.from(
      routeRoot.querySelectorAll<HTMLElement>("*"),
    )
      .filter((element) => {
        if (!visible(element)) return false;
        const rect = element.getBoundingClientRect();
        return (
          element.scrollWidth - element.clientWidth > 1 ||
          Boolean(
            mainRect &&
            (rect.left < mainRect.left - 1 || rect.right > mainRect.right + 1),
          )
        );
      })
      .slice(0, 16)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          slot: element.dataset.slot,
          label:
            element.getAttribute("aria-label") ??
            element.textContent?.trim().replace(/\s+/gu, " ").slice(0, 70),
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          left: Math.round(rect.left * 10) / 10,
          right: Math.round(rect.right * 10) / 10,
        };
      });
    const clipped = Array.from(routeRoot.querySelectorAll<HTMLElement>("*"))
      .filter((element) => {
        if (!visible(element)) return false;
        const rect = element.getBoundingClientRect();
        if (rect.left >= -1 && rect.right <= window.innerWidth + 1)
          return false;
        let parent = element.parentElement;
        while (parent && parent !== routeRoot) {
          if (
            ["auto", "scroll", "hidden", "clip"].includes(
              getComputedStyle(parent).overflowX,
            )
          ) {
            return false;
          }
          parent = parent.parentElement;
        }
        return true;
      })
      .slice(0, 12)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          label:
            element.getAttribute("aria-label") ??
            element.textContent?.trim().replace(/\s+/gu, " ").slice(0, 60),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        };
      });
    return {
      mainCount: document.querySelectorAll("main").length,
      h1Count: routeRoot.querySelectorAll("h1").length,
      duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
      documentOverflow:
        Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth,
        ) - window.innerWidth,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : -1,
      mainScrollsHorizontally,
      overflowDiagnostics,
      clipped,
      undersized,
    };
  }, mobile);

  const axe = await new AxeBuilder({ page })
    .include('#main-content [data-slot="page-transition"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = axe.violations.filter(
    (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
  );

  expect.soft(layout.mainCount, `${path}: one main`).toBe(1);
  expect.soft(layout.h1Count, `${path}: one h1`).toBe(1);
  expect.soft(layout.duplicateIds, `${path}: duplicate ids`).toEqual([]);
  expect
    .soft(layout.documentOverflow, `${path}: document overflow`)
    .toBeLessThanOrEqual(1);
  expect
    .soft(
      layout.mainOverflow,
      `${path}: main overflow; ${JSON.stringify(layout.overflowDiagnostics, null, 2)}`,
    )
    .toBeLessThanOrEqual(1);
  expect
    .soft(layout.mainScrollsHorizontally, `${path}: main horizontal scrolling`)
    .toBe(false);
  expect.soft(layout.clipped, `${path}: clipped viewport content`).toEqual([]);
  expect.soft(layout.undersized, `${path}: mobile touch targets`).toEqual([]);
  expect
    .soft(blocking, `${path}: ${JSON.stringify(blocking, null, 2)}`)
    .toEqual([]);
}

async function expectDialogQuality(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async (element) => {
    const finiteAnimations = element
      .getAnimations({ subtree: true })
      .filter((animation) => {
        const iterations = animation.effect?.getTiming().iterations;
        return typeof iterations === "number" && Number.isFinite(iterations);
      });
    await Promise.all(
      finiteAnimations.map((animation) =>
        animation.finished.catch(() => undefined),
      ),
    );
  });
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations.filter(
      (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
    ),
  ).toEqual([]);
}

test.describe("engagement and channel surface quality", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      }),
    );
    await loginAsDemo(page, { navigate: false });
  });

  for (const viewport of [
    { label: "desktop", width: 1280, height: 900 },
    { label: "375px", width: 375, height: 800 },
    { label: "320px", width: 320, height: 800 },
  ]) {
    test(`${viewport.label}: all 11 routes are responsive and accessible`, async ({
      page,
    }) => {
      const expectsMobileProject = viewport.label !== "desktop";
      test.skip(
        (test.info().project.name === "chromium-mobile") !==
          expectsMobileProject,
        "Desktop runs in Desktop Chrome; narrow touch matrices run in mobile Chromium.",
      );
      test.slow();
      test.setTimeout(420_000);
      await page.setViewportSize(viewport);

      for (const [path, heading] of ROUTES) {
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const onConsole = (message: { type(): string; text(): string }) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        };
        const onPageError = (error: Error) => pageErrors.push(error.message);
        page.on("console", onConsole);
        page.on("pageerror", onPageError);

        await gotoRoute(page, path, heading);
        await auditRoute(page, path, viewport.width <= 375);

        page.off("console", onConsole);
        page.off("pageerror", onPageError);
        const javascriptErrors = consoleErrors.filter(
          (message) => !message.includes("Failed to load resource"),
        );
        expect.soft(pageErrors, `${path}: uncaught page errors`).toEqual([]);
        expect
          .soft(javascriptErrors, `${path}: app console errors`)
          .toEqual([]);
      }
    });
  }

  test("320px: route creation and all SMS tabs remain keyboard-operable", async ({
    page,
  }) => {
    test.skip(
      test.info().project.name !== "chromium-mobile",
      "The interaction matrix exercises the narrow touch context.",
    );
    test.slow();
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 320, height: 800 });

    let createdRoute: Record<string, unknown> | null = null;
    await page.route("**/api/v1/inbound-routes", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      createdRoute = route.request().postDataJSON() as Record<string, unknown>;
      await fulfillJson(route, {
        id: "route-browser-certification",
        ...createdRoute,
        enabled: true,
        actions: [],
      });
    });

    await gotoRoute(page, "/app/routing", "Routing");
    const routeTrigger = page.getByRole("button", { name: "New route" });
    await routeTrigger.click();
    await expectDialogQuality(page);
    const routeDialog = page.getByRole("dialog");
    await routeDialog.getByLabel("Name").fill("   ");
    await routeDialog.getByRole("button", { name: "Create route" }).click();
    await expect(routeDialog.getByText("Enter a route name.")).toBeVisible();
    await expect(routeDialog.getByLabel("Name")).toBeFocused();
    await routeDialog.getByLabel("Name").fill("  Support replies  ");
    await routeDialog.getByLabel("Match recipient (glob)").fill(" support@* ");
    await routeDialog.getByRole("button", { name: "Create route" }).click();
    await expect(routeDialog).toBeHidden();
    await expect(routeTrigger).toBeFocused();
    expect(createdRoute).toMatchObject({
      name: "Support replies",
      match_recipient: "support@*",
    });

    await gotoRoute(page, "/app/sms", "SMS");
    const tabs = page.getByRole("tablist", { name: "SMS workspace section" });
    await expect(tabs.getByRole("tab")).toHaveCount(6);
    const overview = tabs.getByRole("tab", { name: "Overview" });
    await overview.focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.getByRole("tab", { name: "Audience" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page).toHaveURL(/\?tab=audience(?:#.*)?$/u);
    await tabs.getByRole("tab", { name: "Campaigns" }).click();
    await expect(page).toHaveURL(/\?tab=campaigns(?:#.*)?$/u);
    await page.getByLabel(/Message \(/u).fill("A reusable SMS draft.");
    const saveTemplate = page.getByRole("button", {
      name: "Save as template",
    });
    await saveTemplate.click();
    await expectDialogQuality(page);
    const templateDialog = page.getByRole("dialog");
    await templateDialog.getByRole("button", { name: "Save template" }).click();
    await expect(
      templateDialog.getByText("Enter both a template name and message."),
    ).toBeVisible();
    await expect(templateDialog.getByLabel("Template name")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(templateDialog).toBeHidden();
    await expect(saveTemplate).toBeFocused();
  });

  test("375px: SMS Registration, Inbox, and Testing deep links are complete", async ({
    page,
  }) => {
    test.skip(
      test.info().project.name !== "chromium-mobile",
      "The SMS sub-surface journey exercises a narrow touch context.",
    );
    test.slow();
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 375, height: 800 });
    await installSeededSmsWorkspace(page);

    await gotoRoute(page, "/app/sms?tab=registration", "SMS");
    let tabs = page.getByRole("tablist", { name: "SMS workspace section" });
    await expect(
      tabs.getByRole("tab", { name: "Registration" }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("SMS Sender", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Stored carrier evidence is read-only", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save sender" }),
    ).toBeDisabled();
    await page
      .getByRole("checkbox", { name: "Enforce quiet hours for this sender" })
      .check();
    await expect(page.getByLabel("Timezone")).toBeVisible();
    await auditRoute(page, "/app/sms?tab=registration", true);

    await gotoRoute(page, "/app/sms?tab=inbox", "SMS");
    tabs = page.getByRole("tablist", { name: "SMS workspace section" });
    await expect(tabs.getByRole("tab", { name: "Inbox" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByText("Message log", { exact: true })).toBeVisible();
    const conversation = page.getByRole("button", {
      name: new RegExp(`Open conversation with \\${SEEDED_SMS_PHONE}`, "u"),
    });
    await conversation.click();
    await expect(
      page.getByText("Please help with my subscription", { exact: true }),
    ).toBeVisible();
    await auditRoute(page, "/app/sms?tab=inbox (open thread)", true);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(conversation).toBeFocused();

    await gotoRoute(page, "/app/sms?tab=testing", "SMS");
    tabs = page.getByRole("tablist", { name: "SMS workspace section" });
    await expect(tabs.getByRole("tab", { name: "Testing" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const testingPanel = page.getByRole("tabpanel", { name: "Testing" });
    await expect(
      testingPanel.getByText("Test Send", { exact: true }),
    ).toBeVisible();
    await expect(
      testingPanel.getByText("SMS reply dispatch is release-held", {
        exact: false,
      }),
    ).toBeVisible();
    await testingPanel.getByLabel("Recipient").fill("+14155551212");
    await testingPanel
      .getByLabel("Message")
      .fill("Browser certification only.");
    await testingPanel
      .getByLabel("MMS media URL")
      .fill("https://cdn.example.test/certification.jpg");
    await expect(
      testingPanel.getByRole("button", { name: "Send test" }),
    ).toBeDisabled();
    await auditRoute(page, "/app/sms?tab=testing", true);
  });

  test("375px: seeded SMS confirmation dialogs stay bounded and restore focus", async ({
    page,
  }) => {
    test.skip(
      test.info().project.name !== "chromium-mobile",
      "The hidden-dialog journey exercises the narrow touch context.",
    );
    test.slow();
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 375, height: 800 });
    await installSeededSmsWorkspace(page);

    await gotoRoute(page, "/app/sms", "SMS");
    const pauseSender = page.getByRole("button", { name: "Pause sender" });
    await pauseSender.click();
    await expectDialogQuality(page);
    await expect(
      page.getByRole("dialog").getByText("Pause this sender?"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(pauseSender).toBeFocused();

    const tabs = page.getByRole("tablist", { name: "SMS workspace section" });
    await tabs.getByRole("tab", { name: "Audience" }).click();
    const listsCard = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "SMS Lists" });
    await listsCard.getByRole("button", { name: /VIP list/u }).click();
    const deleteList = listsCard.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await deleteList.click();
    await expectDialogQuality(page);
    await expect(
      page.getByRole("dialog").getByText("Delete this SMS list?"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(deleteList).toBeFocused();

    const suppressionsCard = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Suppressions" });
    const removeHold = suppressionsCard.getByRole("button", {
      name: "Remove manual hold",
    });
    await removeHold.click();
    await expectDialogQuality(page);
    await expect(
      page.getByLabel(/Type \+15552345678 to confirm/u),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(removeHold).toBeFocused();

    const keywordCard = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Keyword state rules" });
    const deleteKeyword = keywordCard.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await deleteKeyword.click();
    await expectDialogQuality(page);
    await expect(
      page.getByRole("dialog").getByText("Delete this keyword rule?"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(deleteKeyword).toBeFocused();

    await tabs.getByRole("tab", { name: "Campaigns" }).click();
    const campaignActions = page.getByRole("button", {
      name: "Actions for Seed campaign",
    });
    await campaignActions.click();
    await page.getByRole("menuitem", { name: "Cancel campaign" }).click();
    await expectDialogQuality(page);
    await expect(
      page.getByRole("dialog").getByText("Cancel this campaign?"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(campaignActions).toBeFocused();
    await expect(page.getByRole("button", { name: "Queue" })).toBeDisabled();
  });

  test("reply failure is not an empty claim and Retry recovers", async ({
    page,
  }) => {
    test.skip(
      test.info().project.name !== "chromium-desktop",
      "The recovery contract needs one browser context only.",
    );
    let calls = 0;
    let allowRecovery = false;
    await page.route("**/api/v1/replies/summary", async (route) => {
      calls += 1;
      if (!allowRecovery) {
        await fulfillJson(
          route,
          { error: { code: "bad_request", message: "Unavailable" } },
          400,
        );
        return;
      }
      await fulfillJson(route, {
        total: 7,
        human_replies: 4,
        excluded_non_human: 2,
        unclassified_replies: 1,
        matched: 5,
        unmatched: 2,
        window_days: 30,
        top_campaigns: [],
      });
    });

    await gotoRoute(page, "/app/replies", "Replies");
    const classification = page.getByRole("region", {
      name: "Reply classification",
    });
    await expect(
      classification.getByText("Reply classification could not be loaded"),
    ).toBeVisible();
    await expect(classification.getByText("Replies received")).toHaveCount(0);
    const attemptsBeforeRetry = calls;
    expect(attemptsBeforeRetry).toBeGreaterThan(0);
    allowRecovery = true;
    await classification.getByRole("button", { name: "Retry" }).click();
    await expect(classification.getByText("Replies received")).toBeVisible();
    await expect(classification.getByText("7", { exact: true })).toBeVisible();
    expect(calls).toBe(attemptsBeforeRetry + 1);
  });
});
