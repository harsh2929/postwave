import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

// This matrix deliberately supplies every sequence/render response. A root
// service worker can bypass Playwright's page routes after it claims the page,
// so block it in this test context instead of ever falling through to live
// tenant data.
test.use({ serviceWorkers: "block" });

const SEQUENCE_ID = "cross-client-audit";

interface HiddenSurfaceFixture {
  renderBodies: Array<Record<string, unknown>>;
}

async function json(
  route: Route,
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body),
  });
}

async function installRoutes(page: Page): Promise<HiddenSurfaceFixture> {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok" }),
    }),
  );
  const fixture: HiddenSurfaceFixture = { renderBodies: [] };
  const emptyEnvelopePaths = new Set([
    "/api/v1/crm/integrations",
    "/api/v1/review-integrations",
    "/api/v1/loyalty-integrations",
    "/api/v1/subscription-integrations",
    "/api/v1/analytics-integrations",
    "/api/v1/marketing-integrations",
  ]);
  const emptyArrayPaths = new Set([
    "/api/v1/commerce/integrations",
    "/api/v1/integrations/slack",
    "/api/v1/integrations/discord",
    "/api/v1/integrations/teams",
  ]);

  await page.route("https://images.example.test/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#f4f4f5"/></svg>',
    });
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/v1/auth/me") {
      await json(route, {
        user_id: "user-hidden-integration-editor",
        tenant_id: "tenant-hidden-integration-editor",
        email: "operator@example.test",
        role: "admin",
        effective_role: "admin",
        viewer_mode: false,
        can_use_viewer_mode: true,
        auth_provider: "local",
        email_verified: true,
        workspace_name: "Hidden surface matrix",
        workspace_slug: "demo",
      });
      return;
    }
    if (path === "/api/v1/onboarding/steps") {
      await json(route, {
        steps: { dashboard_tour: { state: "dismissed" } },
      });
      return;
    }
    if (path === "/api/v1/integrations/catalog") {
      await json(route, {
        schema_version: "hidden-surface-v1",
        target_public_entries: 1,
        target_native_managed: 0,
        honest_badges: ["planned"],
        categories: [{ key: "crm", label: "CRM" }],
        capabilities: [],
        items: [
          {
            slug: "known-crm",
            name: "Known CRM",
            category: "crm",
            badge: "planned",
            runtime_status: "planned",
            summary: "Catalog control row",
            capabilities: [],
            native: false,
          },
        ],
        counts: { native: 0, available: 0 },
      });
      return;
    }
    if (emptyEnvelopePaths.has(path)) {
      await json(route, { items: [] });
      return;
    }
    if (emptyArrayPaths.has(path)) {
      await json(route, []);
      return;
    }
    if (path === `/api/v1/voice/sequences/${SEQUENCE_ID}` && method === "GET") {
      await json(route, {
        id: SEQUENCE_ID,
        version: 3,
        template_id: "welcome",
        name: "Cross-client audit sequence",
        status: "draft",
        emails: [
          {
            position: 1,
            delay_seconds: 0,
            subject: "Cross-client quality",
            body: "Browser-ready content for the cross-client matrix.",
            body_html:
              "<p>Browser-ready content for the cross-client matrix.</p>",
            voice_fidelity_score: 88,
          },
        ],
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-25T00:00:00.000Z",
      });
      return;
    }
    if (
      path === `/api/v1/voice/sequences/${SEQUENCE_ID}/performance` &&
      method === "GET"
    ) {
      await json(route, { reached: 0, opened: 0, clicked: 0, positions: [] });
      return;
    }
    if (path === "/api/v1/render" && method === "POST") {
      fixture.renderBodies.push(
        JSON.parse(request.postData() ?? "{}") as Record<string, unknown>,
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      // The API request layer retries idempotent 5xx responses three times.
      // Exhaust that bounded attempt, then let the explicit UI retry succeed.
      if (fixture.renderBodies.length <= 3) {
        await json(route, { error: "Renderer temporarily unavailable" }, 503, {
          "Retry-After": "0",
        });
        return;
      }
      await json(route, {
        cache_hit: false,
        renders: [
          {
            environment: {
              name: "outlook_2019_desktop",
              viewport_width: 900,
              viewport_height: 1200,
              user_agent: "Outlook 16",
              dark_mode: false,
            },
            image_url: "https://images.example.test/outlook.svg",
            width: 900,
            height: 600,
            issues: [
              "border-radius is ignored in Outlook 2019; this deliberately long issue must wrap without escaping the dialog at 320 pixels.",
            ],
          },
          {
            environment: {
              name: "gmail_ios",
              viewport_width: 390,
              viewport_height: 844,
              user_agent: "Gmail iOS",
              dark_mode: false,
            },
            image_url: "https://images.example.test/gmail.svg",
            width: 390,
            height: 422,
            issues: [],
          },
        ],
      });
      return;
    }

    // The fixture is deliberately exhaustive. Unknown API traffic is a test
    // failure signal, never permission to fall through to the shared tenant.
    await json(
      route,
      {
        error: {
          code: "unmapped_test_route",
          message: `Unmapped test route: ${method} ${path}`,
        },
      },
      404,
    );
  });

  return fixture;
}

async function installBrowserBridges(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (
      window as typeof window & {
        __POSTWAVE_FORCE_REAL_API_FOR_E2E__?: boolean;
      }
    ).__POSTWAVE_FORCE_REAL_API_FOR_E2E__ = true;
    const state = {
      mode: "success" as "success" | "failure",
      writes: [] as string[],
      mailto: "",
    };
    Object.defineProperty(window, "__requestIntegrationAudit", {
      configurable: true,
      value: state,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          state.writes.push(value);
          if (state.mode === "failure") throw new Error("Clipboard denied");
        },
      },
    });
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        const anchor =
          target instanceof Element
            ? target.closest<HTMLAnchorElement>('a[href^="mailto:"]')
            : null;
        if (!anchor) return;
        event.preventDefault();
        state.mailto = anchor.href;
      },
      true,
    );
  });
}

async function expectDialogQuality(
  page: Page,
  dialog: Locator,
  mobile: boolean,
): Promise<void> {
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const quality = await dialog.evaluate((element, requireTouchTargets) => {
    const rect = element.getBoundingClientRect();
    const controls = requireTouchTargets
      ? Array.from(
          element.querySelectorAll<HTMLElement>(
            "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled])",
          ),
        )
      : [];
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      ownsFocus: element.contains(document.activeElement),
      undersized: controls.flatMap((control) => {
        const target =
          control instanceof HTMLInputElement && control.type === "checkbox"
            ? (control.closest("label") ?? control)
            : control;
        const controlRect = target.getBoundingClientRect();
        return controlRect.width < 44 || controlRect.height < 44
          ? [
              {
                label:
                  control.getAttribute("aria-label") ??
                  control.textContent?.trim() ??
                  control.tagName,
                width: Math.round(controlRect.width),
                height: Math.round(controlRect.height),
              },
            ]
          : [];
      }),
    };
  }, mobile);
  expect(quality.left).toBeGreaterThanOrEqual(0);
  expect(quality.right).toBeLessThanOrEqual(quality.viewportWidth);
  expect(quality.top).toBeGreaterThanOrEqual(0);
  expect(quality.bottom).toBeLessThanOrEqual(quality.viewportHeight);
  expect(quality.ownsFocus).toBe(true);
  expect(quality.undersized).toEqual([]);

  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
}

async function expectPageContained(page: Page): Promise<void> {
  await expect(page.locator("main#main-content")).toHaveCount(1);
  await expect(page.locator("main#main-content h1")).toHaveCount(1);
  const geometry = await page.evaluate(() => ({
    viewport: window.innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    duplicateIds: Array.from(document.querySelectorAll("[id]"))
      .map((element) => element.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index),
  }));
  expect(Math.max(geometry.html, geometry.body)).toBeLessThanOrEqual(
    geometry.viewport + 1,
  );
  expect(geometry.duplicateIds).toEqual([]);
}

test.describe("integration request and editor preview hidden surfaces", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    test.setTimeout(240_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await loginAsDemo(page, { navigate: false });
    await installBrowserBridges(page);
  });

  for (const viewport of [
    { label: "desktop", width: 1280, height: 900, project: "chromium-desktop" },
    { label: "320px", width: 320, height: 800, project: "chromium-mobile" },
  ] as const) {
    test(`${viewport.label}: request and cross-client dialogs preserve truth`, async ({
      page,
    }) => {
      test.skip(
        test.info().project.name !== viewport.project,
        `Owned by ${viewport.project}`,
      );
      await page.setViewportSize(viewport);
      const fixture = await installRoutes(page);
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      let response = await page.goto("/app/integrations/catalog", {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status()).toBeLessThan(400);
      await expect(
        page.getByRole("heading", { level: 1, name: "Integration catalog" }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("Known CRM", { exact: true })).toBeVisible();

      const headerRequest = page
        .getByRole("button", { name: "Request an integration" })
        .first();
      await headerRequest.click();
      let requestDialog = page.getByRole("dialog", {
        name: "Request an integration",
      });
      await expectDialogQuality(page, requestDialog, viewport.width === 320);
      const provider = requestDialog.getByLabel("Provider name");
      await expect(provider).toBeFocused();
      await requestDialog.getByRole("link", { name: "Compose email" }).click();
      await expect(
        requestDialog.getByText("Enter a provider name."),
      ).toBeVisible();
      await expect(provider).toHaveAttribute("aria-invalid", "true");
      await expect(requestDialog).toBeVisible();

      await requestDialog.getByRole("button", { name: "Copy address" }).click();
      await expect(
        requestDialog.getByRole("button", { name: "Address copied" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            (
              window as unknown as {
                __requestIntegrationAudit: { writes: string[] };
              }
            ).__requestIntegrationAudit.writes,
        ),
      ).toEqual(["integrations@postwave.app"]);
      await requestDialog.getByRole("button", { name: "Close" }).click();
      await expect(headerRequest).toBeFocused();

      await page.evaluate(() => {
        (
          window as unknown as {
            __requestIntegrationAudit: { mode: "success" | "failure" };
          }
        ).__requestIntegrationAudit.mode = "failure";
      });
      await headerRequest.click();
      requestDialog = page.getByRole("dialog", {
        name: "Request an integration",
      });
      await requestDialog.getByRole("button", { name: "Copy address" }).click();
      await expect(
        page.getByText("Could not copy to the clipboard."),
      ).toBeVisible();
      await expect(
        requestDialog.getByRole("button", { name: "Address copied" }),
      ).toHaveCount(0);
      await expect(
        requestDialog.getByText("integrations@postwave.app"),
      ).toBeVisible();
      await requestDialog.getByRole("button", { name: "Close" }).click();

      await page
        .getByRole("searchbox", { name: "Search integrations" })
        .fill("Acme CRM & Sync");
      await expect(
        page.getByText("No integrations match your filters."),
      ).toBeVisible();
      const contextualRequest = page
        .getByRole("button", { name: "Request an integration" })
        .last();
      await contextualRequest.click();
      requestDialog = page.getByRole("dialog", {
        name: "Request an integration",
      });
      await expect(requestDialog.getByLabel("Provider name")).toHaveValue(
        "Acme CRM & Sync",
      );
      const compose = requestDialog.getByRole("link", {
        name: "Compose email",
      });
      await expect(compose).toHaveAttribute(
        "href",
        "mailto:integrations@postwave.app?subject=Integration%20request%3A%20Acme%20CRM%20%26%20Sync&body=Provider%3A%20Acme%20CRM%20%26%20Sync%0AUse%20case%3A%20%0AApproximate%20monthly%20volume%3A%20",
      );
      await compose.click();
      await expect(requestDialog).toBeHidden();
      await expect(contextualRequest).toBeFocused();
      expect(
        await page.evaluate(
          () =>
            (
              window as unknown as {
                __requestIntegrationAudit: { mailto: string };
              }
            ).__requestIntegrationAudit.mailto,
        ),
      ).toContain("subject=Integration%20request%3A%20Acme%20CRM%20%26%20Sync");
      await expectPageContained(page);

      response = await page.goto(`/app/sequences/${SEQUENCE_ID}`, {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status()).toBeLessThan(400);
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Edit sequence: Cross-client audit sequence",
        }),
      ).toBeVisible({ timeout: 60_000 });
      const clientsTab = page.getByRole("tab", {
        name: "Cross-client preview",
      });
      await clientsTab.click();
      await expect(clientsTab).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByRole("status", { name: "Loading cross-client previews" }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByRole("alert").getByText("Renderer temporarily unavailable"),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByRole("button", {
          name: "Open Outlook 2019 (Desktop) preview full-size",
        }),
      ).toHaveCount(0);

      await page.getByRole("button", { name: "Retry previews" }).click();
      const outlook = page.getByRole("button", {
        name: "Open Outlook 2019 (Desktop) preview full-size",
      });
      await expect(outlook).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByRole("button", {
          name: "Open Gmail (iOS) preview full-size",
        }),
      ).toBeVisible();
      expect(fixture.renderBodies).toHaveLength(4);
      expect(
        fixture.renderBodies.every(
          (body) => body.html === fixture.renderBodies[0]?.html,
        ),
      ).toBe(true);
      expect(String(fixture.renderBodies[0]?.html)).toContain(
        "Browser-ready content",
      );

      await outlook.click();
      const previewDialog = page.getByRole("dialog", {
        name: "Outlook 2019 (Desktop)",
      });
      await expectDialogQuality(page, previewDialog, viewport.width === 320);
      await expect(previewDialog).toContainText("900×1200 · Light mode");
      await expect(
        previewDialog.getByAltText(
          "Full-size preview for Outlook 2019 (Desktop)",
        ),
      ).toBeVisible();
      await expect(previewDialog).toContainText(
        "this deliberately long issue must wrap",
      );
      await previewDialog
        .getByRole("button", { name: "Close", exact: true })
        .last()
        .click();
      await expect(previewDialog).toBeHidden();
      await expect(outlook).toBeFocused();
      await expectPageContained(page);
      expect(pageErrors).toEqual([]);
    });
  }
});
