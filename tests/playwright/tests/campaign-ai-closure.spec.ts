import { expect, test, type Page, type Route } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function campaign(id: string, name: string, subject: string) {
  return {
    id,
    tenant_id: "tenant_campaign_ai",
    name,
    subject,
    status: "draft",
    campaign_type: "ab_test",
    editor_mode: "blocks",
    body_html: "<p>Draft</p>",
    created_at: "2026-08-27T00:00:00.000Z",
    updated_at: "2026-08-27T00:00:00.000Z",
  };
}

async function installRoutes(page: Page) {
  let abRequests = 0;
  let abBody: Record<string, unknown> | null = null;

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/v1/auth/me") {
      await json(route, {
        user_id: "user_campaign_ai",
        tenant_id: "tenant_campaign_ai",
        email: "operator@example.test",
        role: "owner",
        effective_role: "owner",
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Campaign AI closure",
        workspace_slug: "campaign-ai-closure",
      });
      return;
    }
    if (path === "/api/v1/onboarding/steps") {
      await json(route, { steps: { dashboard_tour: { state: "dismissed" } } });
      return;
    }
    if (path === "/api/v1/campaigns/count") {
      await json(route, { total: 0, by_status: {} });
      return;
    }
    if (path === "/api/v1/campaigns" && method === "GET") {
      await json(route, []);
      return;
    }
    if (path === "/api/v1/segments" && method === "GET") {
      await json(route, [
        {
          id: "segment_campaign_ai",
          tenantId: "tenant_campaign_ai",
          name: "Engaged readers",
          description: "Deterministic test audience",
          queryAst: {
            op: "condition",
            field: "status",
            comparator: "equals",
            value: "enabled",
          },
          createdAt: "2026-08-27T00:00:00.000Z",
          updatedAt: "2026-08-27T00:00:00.000Z",
        },
      ]);
      return;
    }
    if (path === "/api/v1/voice/generate" && method === "POST") {
      const body = JSON.parse(request.postData() ?? "{}") as {
        prompt?: string;
      };
      if (body.prompt?.includes("First request subject")) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        await json(route, {
          text: "1. Stale first idea\n2. Stale second idea\n3. Stale third idea",
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      await json(route, {
        text: "1. Newest first idea\n2. Newest second idea\n3. Newest third idea",
      });
      return;
    }
    if (path === "/api/v1/campaigns/ab-test" && method === "POST") {
      abRequests += 1;
      abBody = JSON.parse(request.postData() ?? "{}") as Record<
        string,
        unknown
      >;
      // Long enough to assert the committed pending UI on both cold desktop
      // and emulated-mobile renders; the response still completes in-test.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await json(
        route,
        {
          parent: campaign(
            "campaign_ai_parent",
            "Launch experiment",
            "Newest first idea",
          ),
          children: [
            campaign(
              "campaign_ai_a",
              "Launch experiment — variant A",
              "Newest first idea",
            ),
            campaign(
              "campaign_ai_b",
              "Launch experiment — variant B",
              "Newest second idea",
            ),
            campaign(
              "campaign_ai_c",
              "Launch experiment — variant C",
              "Newest third idea",
            ),
          ],
        },
        201,
      );
      return;
    }

    await json(
      route,
      { error: { code: "not_found", message: "not found" } },
      404,
    );
  });

  return {
    body: () => abBody,
    requests: () => abRequests,
  };
}

test.describe("campaign AI closure", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(90_000);
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

  for (const viewport of [
    { label: "desktop", width: 1280, height: 900, project: "chromium-desktop" },
    { label: "320px", width: 320, height: 800, project: "chromium-mobile" },
  ] as const) {
    test(`${viewport.label}: latest suggestions create one audience-bound A/B draft`, async ({
      page,
    }) => {
      test.skip(
        test.info().project.name !== viewport.project,
        `Owned by ${viewport.project}`,
      );
      await page.setViewportSize(viewport);
      const writes = await installRoutes(page);

      await page.goto("/app/campaigns", { waitUntil: "domcontentloaded" });
      await expect(
        page.getByRole("heading", { name: "Campaigns" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "New campaign" }).click();
      const dialog = page.getByRole("dialog", { name: "New campaign" });
      await dialog.getByLabel("Name").fill("Launch experiment");

      const subject = dialog.getByLabel("Subject");
      const firstRequest = page.waitForRequest(
        (request) =>
          new URL(request.url()).pathname === "/api/v1/voice/generate" &&
          request.postData()?.includes("First request subject") === true,
      );
      await subject.fill("First request subject");
      await firstRequest;
      await subject.fill("Second request subject");

      await expect(
        dialog.getByText("Newest first idea", { exact: true }),
      ).toBeVisible();
      await page.waitForTimeout(350);
      await expect(
        dialog.getByText("Stale first idea", { exact: true }),
      ).toHaveCount(0);
      await expect(dialog.getByLabel("Test audience")).toHaveValue(
        "segment_campaign_ai",
      );

      const createTest = dialog.getByRole("button", {
        name: "A/B test all three",
      });
      await createTest.evaluate((element) => {
        (element as HTMLButtonElement).click();
        (element as HTMLButtonElement).click();
      });
      await expect.poll(writes.requests).toBe(1);
      await expect(
        dialog.getByRole("button", { name: "Creating A/B test…" }),
      ).toBeDisabled();
      await expect(dialog).toHaveAttribute("aria-busy", "true");
      await expect(dialog.getByLabel("Name")).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();

      await expect(dialog).toBeHidden();
      expect(writes.requests()).toBe(1);
      expect(writes.body()).toEqual({
        name: "Launch experiment",
        subject_variants: [
          "Newest first idea",
          "Newest second idea",
          "Newest third idea",
        ],
        audience_segment_id: "segment_campaign_ai",
        body_html:
          '<p></p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>',
      });
      await expect(
        page.getByText("A/B test created.", { exact: true }),
      ).toBeVisible();
    });
  }
});
