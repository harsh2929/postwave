import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

// Keep this fixture deterministic even when the PWA worker would otherwise
// claim API requests before Playwright's route handlers can observe them.
test.use({ serviceWorkers: "block" });

const ENDPOINT_ID = "11111111-1111-4111-8111-111111111111";
const endpoint = {
  id: ENDPOINT_ID,
  tenantId: "tenant-inbound-dialogs",
  slug: "quality-endpoint",
  name: "Quality endpoint",
  enabled: true,
  transform_jq: ".payload",
  createdAt: "2026-08-01T00:00:00.000Z",
};

const verifiedEvent = {
  id: 41,
  endpoint_id: ENDPOINT_ID,
  headers: { "Content-Type": "application/json" },
  body: '{"email":"person@example.test","markup":"<script>nope()</script>"}',
  signature_valid: true,
  received_at: "2026-08-25T12:00:00.000Z",
};

const unverifiedEvent = {
  ...verifiedEvent,
  id: 42,
  body: "",
  signature_valid: false,
};

interface InboundDialogFixture {
  eventReads: number;
  patchBodies: Array<Record<string, unknown>>;
  replayKeys: string[];
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

async function installInboundDialogRoutes(
  page: Page,
): Promise<InboundDialogFixture> {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok" }),
    }),
  );
  const state: InboundDialogFixture = {
    eventReads: 0,
    patchBodies: [],
    replayKeys: [],
  };
  let currentEndpoint = { ...endpoint };

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/v1/auth/me") {
      await json(route, {
        user_id: "user-inbound-dialogs",
        tenant_id: endpoint.tenantId,
        email: "operator@example.test",
        role: "admin",
        effective_role: "admin",
        viewer_mode: false,
        can_use_viewer_mode: true,
        auth_provider: "local",
        email_verified: true,
        workspace_name: "Inbound dialog matrix",
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
    if (path === "/api/v1/inbound-webhooks" && method === "GET") {
      await json(route, { items: [currentEndpoint] });
      return;
    }
    if (
      path === `/api/v1/inbound-webhooks/${ENDPOINT_ID}` &&
      method === "PATCH"
    ) {
      const body = JSON.parse(request.postData() ?? "{}") as Record<
        string,
        unknown
      >;
      state.patchBodies.push(body);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
      if (state.patchBodies.length === 1) {
        await json(
          route,
          { code: "write_conflict", message: "Endpoint changed elsewhere" },
          409,
        );
        return;
      }
      currentEndpoint = {
        ...currentEndpoint,
        name: typeof body.name === "string" ? body.name : currentEndpoint.name,
        enabled:
          typeof body.enabled === "boolean"
            ? body.enabled
            : currentEndpoint.enabled,
        transform_jq:
          typeof body.transform_jq === "string"
            ? body.transform_jq
            : currentEndpoint.transform_jq,
      };
      await json(route, currentEndpoint);
      return;
    }
    if (
      path === `/api/v1/inbound-webhooks/${ENDPOINT_ID}/events` &&
      method === "GET"
    ) {
      state.eventReads += 1;
      // GETs have bounded transport retries. Exhaust that first attempt quickly
      // so the dialog's explicit failure and operator-controlled retry are both
      // observable without adding nondeterministic sleeps.
      if (state.eventReads <= 3) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        await json(
          route,
          {
            code: "temporarily_unavailable",
            message: "Event history unavailable",
          },
          503,
          { "Retry-After": "0" },
        );
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      await json(route, { items: [verifiedEvent, unverifiedEvent] });
      return;
    }
    if (
      path ===
        `/api/v1/inbound-webhooks/${ENDPOINT_ID}/events/${verifiedEvent.id}/replay` &&
      method === "POST"
    ) {
      state.replayKeys.push(request.headers()["idempotency-key"] ?? "");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
      if (state.replayKeys.length === 1) {
        await json(
          route,
          { code: "replay_conflict", message: "Replay receipt conflict" },
          409,
        );
        return;
      }
      await json(
        route,
        {
          ok: true,
          queued: true,
          replay_id: "replay-inbound-dialogs",
          matches: [
            {
              trigger_id: "trigger-inbound-dialogs",
              name: "Add launch tag",
              subscriber_email: "person@example.test",
              action_type: "add_tag",
              action_target_id: "launch",
              queued: true,
              executed: false,
            },
          ],
        },
        202,
      );
      return;
    }

    // This spec owns every mounted API dependency. Fail closed so a newly
    // introduced query cannot silently read from or mutate the shared tenant.
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

  return state;
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
  const geometry = await dialog.evaluate((element, requireTouchTargets) => {
    const rect = element.getBoundingClientRect();
    const candidates = requireTouchTargets
      ? Array.from(
          element.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [role="button"]:not([aria-disabled="true"])',
          ),
        )
      : [];
    const undersized = candidates.flatMap((candidate) => {
      const target =
        candidate instanceof HTMLInputElement && candidate.type === "checkbox"
          ? (candidate.closest("label") ?? candidate)
          : candidate;
      const candidateRect = target.getBoundingClientRect();
      return candidateRect.width < 44 || candidateRect.height < 44
        ? [
            {
              label:
                candidate.getAttribute("aria-label") ??
                candidate.textContent?.trim() ??
                candidate.tagName,
              width: Math.round(candidateRect.width),
              height: Math.round(candidateRect.height),
            },
          ]
        : [];
    });
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      ownsFocus: element.contains(document.activeElement),
      undersized,
    };
  }, mobile);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.ownsFocus).toBe(true);
  expect(geometry.undersized).toEqual([]);

  const accessibility = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    accessibility.violations.filter(
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

test.describe("inbound webhook hidden dialogs", () => {
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
    await loginAsDemo(page, { navigate: false });
  });

  for (const viewport of [
    { label: "desktop", width: 1280, height: 900, project: "chromium-desktop" },
    { label: "320px", width: 320, height: 800, project: "chromium-mobile" },
  ] as const) {
    test(`${viewport.label}: edit and events dialogs recover without duplicate effects`, async ({
      page,
    }) => {
      test.skip(
        test.info().project.name !== viewport.project,
        `Owned by ${viewport.project}`,
      );
      await page.setViewportSize(viewport);
      const fixture = await installInboundDialogRoutes(page);

      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      const response = await page.goto("/app/inbound-webhooks", {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status()).toBeLessThan(400);
      await expect(
        page.getByRole("heading", { level: 1, name: "Inbound webhooks" }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        page.getByText(endpoint.name, { exact: true }),
      ).toBeVisible();
      await expectPageContained(page);

      const editTrigger = page.getByRole("button", { name: "Edit endpoint" });
      await editTrigger.click();
      const editDialog = page.getByRole("dialog", { name: "Edit endpoint" });
      await expectDialogQuality(page, editDialog, viewport.width === 320);
      const name = editDialog.getByLabel("Name", { exact: true });
      await expect(name).toBeFocused();
      const save = editDialog.getByRole("button", { name: "Save changes" });
      await expect(save).toBeDisabled();

      await name.fill("");
      await save.click();
      await expect(editDialog.getByText("Name is required.")).toBeVisible();
      await expect(name).toHaveAttribute("aria-invalid", "true");
      expect(fixture.patchBodies).toHaveLength(0);

      await name.fill("  Renamed quality endpoint  ");
      await editDialog
        .getByLabel("Enabled — receive and process incoming events")
        .uncheck();
      await save.evaluate((element) => {
        (element as HTMLButtonElement).click();
        (element as HTMLButtonElement).click();
      });
      await expect(save).toBeDisabled();
      await expect(
        editDialog.getByRole("button", { name: "Cancel" }),
      ).toBeDisabled();
      await expect(
        editDialog.getByText("Endpoint changed elsewhere", { exact: true }),
      ).toBeVisible();
      expect(fixture.patchBodies).toHaveLength(1);
      expect(fixture.patchBodies[0]).toEqual({
        name: "Renamed quality endpoint",
        enabled: false,
        transform_jq: ".payload",
      });

      await save.click();
      await expect(editDialog).toBeHidden();
      expect(fixture.patchBodies).toHaveLength(2);
      await expect(
        page.getByText("Renamed quality endpoint", { exact: true }),
      ).toBeVisible();
      await expect(editTrigger).toBeFocused();

      const eventsTrigger = page.getByRole("button", { name: "Events" });
      await eventsTrigger.click();
      const eventsDialog = page.getByRole("dialog", {
        name: "Recent events · Renamed quality endpoint",
      });
      await expect(
        eventsDialog.getByRole("status", {
          name: "Loading recent inbound events",
        }),
      ).toBeVisible();
      await expectDialogQuality(page, eventsDialog, viewport.width === 320);
      await expect(
        eventsDialog.getByText("Event history unavailable", { exact: true }),
      ).toBeVisible();
      await expect(eventsDialog.getByText("No events yet")).toHaveCount(0);
      await eventsDialog.getByRole("button", { name: "Retry" }).click();
      await expect(
        eventsDialog.getByText("signature valid", { exact: true }),
      ).toBeVisible();
      await expect(
        eventsDialog.getByText("signature invalid or missing", { exact: true }),
      ).toBeVisible();
      const unavailable = eventsDialog.getByRole("button", {
        name: "Replay unavailable",
      });
      await expect(unavailable).toBeDisabled();
      await unavailable.evaluate((element) =>
        (element as HTMLButtonElement).click(),
      );
      expect(fixture.replayKeys).toHaveLength(0);

      await eventsDialog
        .getByRole("button", { name: "View payload" })
        .first()
        .click();
      const payload = eventsDialog.getByLabel("Inbound event payload");
      await expect(payload).toContainText("<script>nope()</script>");
      await expect(payload.locator("script")).toHaveCount(0);

      await eventsDialog
        .getByRole("button", { name: "Replay", exact: true })
        .click();
      const replayDialog = page.getByRole("dialog", {
        name: "Replay this event?",
      });
      await expectDialogQuality(page, replayDialog, viewport.width === 320);
      const replay = replayDialog.getByRole("button", { name: "Replay event" });
      await replay.evaluate((element) => {
        (element as HTMLButtonElement).click();
        (element as HTMLButtonElement).click();
      });
      await expect(replay).toBeDisabled();
      await expect(
        replayDialog.getByText("Replay receipt conflict", { exact: true }),
      ).toBeVisible();
      expect(fixture.replayKeys).toHaveLength(1);

      await replayDialog.getByRole("button", { name: "Retry replay" }).click();
      await expect(replayDialog).toBeHidden();
      await expect(page.getByText(/1 action queued/u)).toBeVisible();
      expect(fixture.replayKeys).toHaveLength(2);
      expect(fixture.replayKeys[0]).toMatch(/^[0-9a-f-]{36}$/u);
      expect(fixture.replayKeys[1]).toBe(fixture.replayKeys[0]);
      await expect(page.getByText(/action executed\./u)).toHaveCount(0);

      await eventsDialog
        .getByRole("button", { name: "Close", exact: true })
        .last()
        .click();
      await expect(eventsDialog).toBeHidden();
      await expect(eventsTrigger).toBeFocused();
      await expectPageContained(page);
      expect(pageErrors).toEqual([]);
    });
  }
});
