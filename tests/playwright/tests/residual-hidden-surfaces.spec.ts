import { expect, test, type Page, type Route } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

interface ResidualWrites {
  activationRequests: number;
  regenerationRequests: number;
  renamePatches: number;
  suppressionPatches: number;
}

const flow = {
  id: "flow_residual",
  tenant_id: "tenant_residual",
  name: "Residual welcome journey",
  status: "draft",
  version: 3,
  re_enrollment: "once",
  graph: { nodes: [], edges: [], triggers: [] },
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-25T00:00:00.000Z",
};

const suppression = {
  id: "suppression_residual",
  email: "long.blocked.address.for.residual.testing@example.test",
  reason: "list_manual",
  source: "operator",
  channel: "email",
  scope: "marketing",
  created_at: "2026-08-20T00:00:00.000Z",
  expires_at: "2030-01-01T00:00:00.000Z",
};

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installResidualRoutes(page: Page): Promise<ResidualWrites> {
  const writes: ResidualWrites = {
    activationRequests: 0,
    regenerationRequests: 0,
    renamePatches: 0,
    suppressionPatches: 0,
  };
  let currentFlow = { ...flow };

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/v1/auth/me") {
      await json(route, {
        user_id: "user_residual",
        tenant_id: "tenant_residual",
        email: "operator@example.test",
        role: "admin",
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Residual matrix",
        workspace_slug: "residual-matrix",
      });
      return;
    }
    if (path === "/api/v1/onboarding/steps") {
      await json(route, {
        steps: { dashboard_tour: { state: "dismissed" } },
      });
      return;
    }

    if (path.includes("/activate")) {
      writes.activationRequests += 1;
      await json(route, { error: "release_held" }, 503);
      return;
    }
    if (path.includes("/regenerate")) {
      writes.regenerationRequests += 1;
      await json(route, { error: "release_held" }, 503);
      return;
    }
    if (path === "/api/v1/flow-builder/catalog") {
      await json(route, {
        schema_version: "residual-v1",
        triggers: [],
        nodes: [],
        actions: [],
        statuses: ["draft", "active", "paused", "archived"],
      });
      return;
    }
    if (path === "/api/v1/flow-builder/flows" && method === "GET") {
      await json(route, { items: [currentFlow] });
      return;
    }
    if (
      path === "/api/v1/flow-builder/flows/flow_residual" &&
      method === "PATCH"
    ) {
      writes.renamePatches += 1;
      const body = JSON.parse(request.postData() ?? "{}") as { name?: string };
      currentFlow = {
        ...currentFlow,
        ...(body.name ? { name: body.name } : {}),
        updated_at: "2026-08-26T00:00:00.000Z",
      };
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
      await json(route, currentFlow);
      return;
    }
    if (path === "/api/v1/flow-builder/flows/flow_residual") {
      await json(route, currentFlow);
      return;
    }
    if (path === "/api/v1/campaign-templates/search") {
      await json(route, { items: [], total: 0, facets: {}, next_cursor: null });
      return;
    }

    if (path === "/api/v1/voice/sequences/sequence_residual/performance") {
      await json(route, { reached: 0, opened: 0, clicked: 0, positions: [] });
      return;
    }
    if (path === "/api/v1/voice/sequences/sequence_residual") {
      await json(route, {
        id: "sequence_residual",
        version: 4,
        template_id: "welcome",
        name: "Stored residual sequence",
        status: "active",
        emails: [
          {
            position: 1,
            subject: "Welcome",
            body: "Stored body",
            body_html: "<p>Stored body</p>",
            delay_seconds: 0,
            voice_fidelity_score: 80,
          },
        ],
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-25T00:00:00.000Z",
      });
      return;
    }

    if (path === "/api/v1/suppressions/trend") {
      await json(route, { points: [] });
      return;
    }
    if (
      path ===
      "/api/v1/suppressions/long.blocked.address.for.residual.testing%40example.test/audit"
    ) {
      await json(route, {
        items: [
          {
            id: "audit_residual",
            action: "expiry_updated",
            reason: "list_manual",
            source: "long-source-value-that-must-wrap-without-page-overflow",
            actor: "operator.with.a.long.identifier@example.test",
            created_at: "2026-08-25T00:00:00.000Z",
          },
        ],
      });
      return;
    }
    if (
      path === "/api/v1/suppressions/suppression_residual" &&
      method === "PATCH"
    ) {
      writes.suppressionPatches += 1;
      const body = JSON.parse(request.postData() ?? "{}") as {
        expires_at?: string | null;
      };
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
      await json(route, {
        ...suppression,
        expires_at: body.expires_at ?? null,
      });
      return;
    }
    if (path === "/api/v1/deliverability/suppressions") {
      await json(route, {
        items: [suppression],
        total: 1,
        page: 1,
        size: 100,
      });
      return;
    }

    await route.continue();
  });

  return writes;
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
      .filter((id, index, all) => all.indexOf(id) !== index),
  }));
  expect(Math.max(geometry.html, geometry.body)).toBeLessThanOrEqual(
    geometry.viewport + 1,
  );
  expect(geometry.duplicateIds).toEqual([]);
}

async function expectDialogContained(page: Page): Promise<void> {
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
      ownsFocus: element.contains(document.activeElement),
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.ownsFocus).toBe(true);
}

test.describe("residual hidden commerce/content surfaces", () => {
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

  for (const viewport of [
    { label: "desktop", width: 1280, height: 900, project: "chromium-desktop" },
    { label: "320px", width: 320, height: 800, project: "chromium-mobile" },
  ] as const) {
    test(`${viewport.label}: all install tabs and reachable dialogs are deterministic`, async ({
      page,
    }) => {
      test.skip(
        test.info().project.name !== viewport.project,
        `Owned by ${viewport.project}`,
      );
      await page.setViewportSize(viewport);
      page.setDefaultNavigationTimeout(90_000);
      const writes = await installResidualRoutes(page);

      await page.goto("/developers", { waitUntil: "domcontentloaded" });
      const installTabs = page.getByRole("tablist", {
        name: "Install snippets",
      });
      const expectedTabs = [
        ["npm", "npm install @postwave/sdk"],
        ["pnpm", "pnpm add @postwave/sdk"],
        ["Browser events", "npm install @postwave/track"],
        ["pip", "pip install postwave"],
        ["Composer", "composer require postwave/postwave-php"],
        ["CLI", "npm install -g @postwave/cli"],
      ] as const;
      await expect(installTabs.getByRole("tab")).toHaveCount(
        expectedTabs.length,
      );
      for (const [label, snippet] of expectedTabs) {
        const tab = installTabs.getByRole("tab", { name: label, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("tabpanel")).toContainText(snippet);
      }
      await installTabs.getByRole("tab", { name: "CLI" }).focus();
      await page.keyboard.press("Home");
      await expect(
        installTabs.getByRole("tab", { name: "npm", exact: true }),
      ).toBeFocused();
      await expectPageContained(page);

      await page.goto("/app/flows", { waitUntil: "domcontentloaded" });
      await expect(
        page.getByText("Residual welcome journey", { exact: true }),
      ).toBeVisible();
      const flowCard = page
        .getByRole("link", { name: "Residual welcome journey", exact: true })
        .locator("../..");
      await flowCard.getByRole("button", { name: "Edit tags" }).click();
      await expectDialogContained(page);
      await page
        .getByLabel("Tags (comma-separated)")
        .fill("High Value, high value, Promo");
      await page.getByRole("button", { name: "Save tags" }).click();
      await expect(
        flowCard.getByText("high value", { exact: true }),
      ).toBeVisible();
      expect(writes.renamePatches).toBe(0);

      const renameTrigger = flowCard.getByRole("button", {
        name: "Rename flow",
      });
      await renameTrigger.click();
      await expectDialogContained(page);
      const renameDialog = page.getByRole("dialog", { name: "Rename flow" });
      await renameDialog
        .getByRole("textbox", { name: "Name", exact: true })
        .fill("Residual journey renamed");
      const rename = renameDialog.getByRole("button", {
        name: "Rename",
        exact: true,
      });
      await rename.evaluate((element) => {
        (element as HTMLButtonElement).click();
        (element as HTMLButtonElement).click();
      });
      await expect.poll(() => writes.renamePatches).toBe(1);
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect(
        page.getByText("Residual journey renamed", { exact: true }),
      ).toBeVisible();
      await expectPageContained(page);

      await page.goto("/app/flows/flow_residual", {
        waitUntil: "domcontentloaded",
      });
      if (viewport.width < 768) {
        const moreActions = page.getByRole("button", { name: "More" });
        await moreActions.click();
        await expect(moreActions).toHaveAttribute("aria-expanded", "true");
      }
      const activation = page.getByRole("button", {
        name: "Activation unavailable",
      });
      await expect(activation).toBeDisabled();
      await expect(
        page.getByRole("note", { name: "Flow activation status" }),
      ).toContainText("release-held");
      expect(writes.activationRequests).toBe(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expectPageContained(page);

      await page.goto("/app/sequences/sequence_residual", {
        waitUntil: "domcontentloaded",
      });
      const regenerate = page.getByRole("button", {
        name: "AI regeneration unavailable",
      });
      await expect(regenerate).toBeDisabled();
      await regenerate.evaluate((element) =>
        (element as HTMLButtonElement).click(),
      );
      expect(writes.regenerationRequests).toBe(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expectPageContained(page);

      await page.goto("/app/suppressions", { waitUntil: "domcontentloaded" });
      await expect(
        page.getByText(suppression.email, { exact: true }),
      ).toBeVisible();
      const historyTrigger = page.getByRole("button", { name: "History" });
      await historyTrigger.click();
      await expectDialogContained(page);
      const historyDialog = page.getByRole("dialog", {
        name: "Suppression history",
      });
      await expect(
        historyDialog.getByText("expiry updated", { exact: true }),
      ).toBeVisible();
      await historyDialog
        .locator('[data-slot="button"]')
        .filter({ hasText: /^Close$/u })
        .click();
      await expect(historyTrigger).toBeFocused();

      const expiryTrigger = page.getByRole("button", { name: "Expiry" });
      await expiryTrigger.click();
      await expectDialogContained(page);
      const expiryDialog = page.getByRole("dialog", {
        name: "Suppression expiry",
      });
      const expiry = expiryDialog.getByLabel("Expires on");
      await expect(expiry).toHaveAttribute("min", /\d{4}-\d{2}-\d{2}/u);
      await expiry.fill("2032-03-04");
      const saveExpiry = expiryDialog.getByRole("button", {
        name: "Save expiry",
      });
      await saveExpiry.evaluate((element) => {
        (element as HTMLButtonElement).click();
        (element as HTMLButtonElement).click();
      });
      await expect.poll(() => writes.suppressionPatches).toBe(1);
      await expect(page.getByRole("dialog")).toBeHidden();
      await expectPageContained(page);

      expect(writes.activationRequests).toBe(0);
      expect(writes.regenerationRequests).toBe(0);
    });
  }
});
