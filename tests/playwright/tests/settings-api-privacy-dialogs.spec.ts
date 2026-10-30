import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

// These tests own deterministic API fixtures. The production PWA worker can
// otherwise claim the page between hydration and the first client fetch;
// Playwright routes cannot observe worker-owned requests, which leaks live
// tenant data into this matrix and makes an early click race hydration.
test.use({ serviceWorkers: "block" });

const CASES = [
  {
    name: "desktop",
    project: "chromium-desktop",
    viewport: { width: 1440, height: 900 },
  },
  {
    name: "exact 320px",
    project: "chromium-mobile",
    viewport: { width: 320, height: 800 },
  },
] as const;

const NOW = "2026-08-26T12:00:00.000Z";
const READY = "2026-08-27T12:00:00.000Z";

interface CapturedMutation {
  body: Record<string, unknown>;
  idempotencyKey: string;
}

interface SettingsFixture {
  api: {
    createCalls: number;
    editCalls: number;
    usageCalls: number;
    revokeCalls: number;
    rotateCalls: number;
    keys: Array<Record<string, unknown>>;
  };
  privacy: Record<string, CapturedMutation[]>;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function apiError(message: string): Record<string, unknown> {
  return { error: { code: "conflict", message } };
}

function apiKey(
  id: string,
  label: string,
  prefix: string,
): Record<string, unknown> {
  return {
    id,
    tenantId: "tenant-settings-hidden",
    label,
    prefix,
    scopes: ["read:subscribers"],
    createdAt: "2026-08-01T00:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
    sandboxOnly: false,
    expiresAt: null,
  };
}

function workflowAck(requestId: string): Record<string, unknown> {
  return {
    request_id: requestId,
    status: "queued",
    requested_at: NOW,
    estimated_ready_at: READY,
  };
}

function capturePrivacy(
  fixture: SettingsFixture,
  path: string,
  route: Route,
): CapturedMutation[] {
  const bucket = (fixture.privacy[path] ??= []);
  const body = JSON.parse(route.request().postData() ?? "{}") as Record<
    string,
    unknown
  >;
  bucket.push({
    body,
    idempotencyKey: route.request().headers()["idempotency-key"] ?? "missing",
  });
  return bucket;
}

async function installRoutes(page: Page): Promise<SettingsFixture> {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok" }),
    }),
  );
  const fixture: SettingsFixture = {
    api: {
      createCalls: 0,
      editCalls: 0,
      usageCalls: 0,
      revokeCalls: 0,
      rotateCalls: 0,
      keys: [
        apiKey("key-production", "Production", "pw_live_prod"),
        apiKey("key-secondary", "Secondary", "pw_live_secondary"),
      ],
    },
    privacy: {},
  };

  await page.route(/\/login\?account-deletion=requested$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Deletion requested</title><main>Personal account deletion requested</main>",
    });
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/v1/auth/me" && method === "GET") {
      await json(route, {
        user_id: "owner-settings-hidden",
        tenant_id: "tenant-settings-hidden",
        email: "owner@example.test",
        role: "owner",
        effective_role: "owner",
        viewer_mode: false,
        can_use_viewer_mode: true,
        auth_provider: "password",
        // The dashboard layout seeds auth/me server-side from the demo user,
        // whose TOTP is intentionally disabled. Keep any later client refetch
        // consistent; the enabled-MFA deletion branch is covered directly in
        // settings-privacy-dialogs.test.tsx.
        totp_enabled: false,
        email_verified: true,
        workspace_name: "Settings hidden surfaces",
        workspace_slug: "demo",
      });
      return;
    }
    if (path === "/api/v1/onboarding/steps" && method === "GET") {
      await json(route, {
        steps: { dashboard_tour: { state: "dismissed" } },
      });
      return;
    }

    if (path === "/api/v1/api-keys" && method === "GET") {
      await json(route, fixture.api.keys);
      return;
    }
    if (path === "/api/v1/api-keys" && method === "POST") {
      fixture.api.createCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (fixture.api.createCalls === 1) {
        await json(
          route,
          apiError("Key quota changed. Review and retry."),
          409,
        );
        return;
      }
      const body = JSON.parse(request.postData() ?? "{}") as {
        label?: string;
        scopes?: string[];
      };
      const created = {
        ...apiKey("key-automation", body.label ?? "Automation", "pw_live_auto"),
        scopes: body.scopes ?? ["read:subscribers"],
      };
      fixture.api.keys.unshift(created);
      await json(route, { key: created, plaintext: "pw_live_secret-once" });
      return;
    }
    if (path === "/api/v1/api-keys/key-automation" && method === "PATCH") {
      fixture.api.editCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (fixture.api.editCalls === 1) {
        await json(route, apiError("The key changed in another session."), 409);
        return;
      }
      const body = JSON.parse(request.postData() ?? "{}") as {
        label?: string;
        scopes?: string[];
      };
      const index = fixture.api.keys.findIndex(
        (key) => key.id === "key-automation",
      );
      fixture.api.keys[index] = {
        ...fixture.api.keys[index],
        label: body.label ?? "Automation",
        scopes: body.scopes ?? ["read:subscribers"],
      };
      await json(route, fixture.api.keys[index]);
      return;
    }
    if (path === "/api/v1/mcp/executions" && method === "GET") {
      fixture.api.usageCalls += 1;
      if (fixture.api.usageCalls === 1) {
        await json(
          route,
          apiError("Recent requests are temporarily locked."),
          409,
        );
        return;
      }
      await json(route, {
        rows: [
          {
            id: 71,
            method: "POST",
            path: "/api/v1/subscribers",
            toolName: "subscribers.create",
            statusCode: 202,
            latencyMs: 29,
            calledAt: NOW,
          },
        ],
      });
      return;
    }
    if (path === "/api/v1/api-keys/key-automation" && method === "DELETE") {
      fixture.api.revokeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (fixture.api.revokeCalls === 1) {
        await json(route, apiError("The key is still attached to a job."), 409);
        return;
      }
      fixture.api.keys = fixture.api.keys.filter(
        (key) => key.id !== "key-automation",
      );
      await json(route, { ok: true });
      return;
    }
    if (
      path === "/api/v1/api-keys/key-production/rotate" &&
      method === "POST"
    ) {
      fixture.api.rotateCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (fixture.api.rotateCalls === 1) {
        await json(route, apiError("Recent authentication expired."), 409);
        return;
      }
      const rotated = apiKey(
        "key-production-rotated",
        "Production",
        "pw_live_rotated",
      );
      fixture.api.keys = [
        rotated,
        ...fixture.api.keys.filter((key) => key.id !== "key-production"),
      ];
      await json(route, {
        key: rotated,
        plaintext: "pw_live_rotated-secret",
        revoked_id: "key-production",
      });
      return;
    }

    if (path === "/api/v1/settings/privacy" && method === "GET") {
      await json(route, {
        tenant_id: "tenant-settings-hidden",
        audit_log_retention_days: 365,
        email_event_retention_days: 365,
        unsubscribed_subscriber_retention_days: 730,
        updated_at: NOW,
      });
      return;
    }
    if (path === "/api/v1/privacy/requests" && method === "GET") {
      await json(route, { requests: [] });
      return;
    }
    if (path === "/api/v1/privacy/export-requests" && method === "POST") {
      const calls = capturePrivacy(fixture, path, route);
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (calls.length === 1) {
        await json(route, apiError("Export capacity changed."), 409);
        return;
      }
      await json(route, workflowAck("export/audit-1"));
      return;
    }
    if (path === "/api/v1/privacy/requests" && method === "POST") {
      const calls = capturePrivacy(fixture, path, route);
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (calls.length === 1) {
        await json(
          route,
          apiError("The subject already has an open request."),
          409,
        );
        return;
      }
      await json(route, {
        ...workflowAck("dsar-audit-1"),
        request_type: calls.at(-1)?.body.request_type,
      });
      return;
    }
    if (path === "/api/v1/privacy/deletion-requests" && method === "POST") {
      const calls = capturePrivacy(fixture, path, route);
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (calls.length === 1) {
        await json(route, apiError("Ownership review changed."), 409);
        return;
      }
      await json(route, workflowAck("workspace-delete-audit-1"));
      return;
    }
    if (path === "/api/v1/account" && method === "DELETE") {
      const calls = capturePrivacy(fixture, path, route);
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (calls.length === 1) {
        await json(route, apiError("Recent authentication is required."), 409);
        return;
      }
      await json(route, {
        request: {
          request_id: "personal-delete-audit-1",
          status: "queued",
        },
        replayed: false,
        scope: {
          deletes: ["personal profile"],
          keeps: ["workspace audit trail"],
          legal_hold_may_delay: true,
          backup_expiry_policy: "Expires under the retention schedule.",
          certificate_retained_until: READY,
        },
      });
      return;
    }
    if (path === "/api/v1/auth/logout" && method === "POST") {
      await json(route, { ok: true });
      return;
    }

    await json(route, apiError(`Unmapped test route: ${method} ${path}`), 404);
  });

  return fixture;
}

async function installClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (
      window as typeof window & {
        __POSTWAVE_FORCE_REAL_API_FOR_E2E__?: boolean;
      }
    ).__POSTWAVE_FORCE_REAL_API_FOR_E2E__ = true;
    const writes: string[] = [];
    Object.defineProperty(window, "__settingsKeyClipboard", {
      configurable: true,
      value: writes,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          writes.push(value);
        },
      },
    });
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
        // Settle the dialog's finite entry transform before measuring CSS
        // pixels, without ever waiting on a future persistent animation.
        .filter((animation) => {
          const iterations = animation.effect?.getTiming().iterations;
          return typeof iterations === "number" && Number.isFinite(iterations);
        })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const geometry = await dialog.evaluate((element, requireTouchTargets) => {
    const rect = element.getBoundingClientRect();
    const controls = requireTouchTargets
      ? Array.from(
          element.querySelectorAll<HTMLElement>(
            "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
          ),
        ).map((control) => {
          const target =
            control instanceof HTMLInputElement && control.type === "checkbox"
              ? (control.closest<HTMLElement>("label") ?? control)
              : control;
          const targetRect = target.getBoundingClientRect();
          return {
            label:
              control.getAttribute("aria-label") ??
              control.textContent?.trim() ??
              control.id,
            width: targetRect.width,
            height: targetRect.height,
          };
        })
      : [];
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      ownsFocus: element.contains(document.activeElement),
      controls,
    };
  }, mobile);
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.top).toBeGreaterThanOrEqual(-1);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
  expect(geometry.ownsFocus).toBe(true);
  for (const control of geometry.controls) {
    expect(
      control.width,
      `${control.label} touch-target width`,
    ).toBeGreaterThanOrEqual(44);
    expect(
      control.height,
      `${control.label} touch-target height`,
    ).toBeGreaterThanOrEqual(44);
  }

  const result = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = result.violations.filter(
    (violation) =>
      violation.impact === "critical" || violation.impact === "serious",
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

async function expectPageContainment(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    duplicateIds: Array.from(document.querySelectorAll("[id]"))
      .map((element) => element.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index),
  }));
  expect(Math.max(layout.html, layout.body)).toBeLessThanOrEqual(
    layout.viewport + 1,
  );
  expect(layout.duplicateIds).toEqual([]);
}

function rowFor(page: Page, label: string): Locator {
  return page.getByRole("row").filter({ hasText: label }).first();
}

function expectStableRetry(calls: CapturedMutation[]): void {
  expect(calls).toHaveLength(2);
  expect(calls[0]?.idempotencyKey).not.toBe("missing");
  expect(calls[1]?.idempotencyKey).toBe(calls[0]?.idempotencyKey);
  expect(calls[1]?.body).toEqual(calls[0]?.body);
}

test.describe("API key and privacy hidden settings dialogs", () => {
  test.describe.configure({ mode: "serial" });

  for (const auditCase of CASES) {
    test(`${auditCase.name}: all six API-key dialogs preserve truth and retry safely`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== auditCase.project);
      test.slow();
      await page.setViewportSize(auditCase.viewport);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await installClipboard(page);
      const fixture = await installRoutes(page);
      await loginAsDemo(page, { navigate: false });
      await page.goto("/app/settings/api", { waitUntil: "domcontentloaded" });
      await expect(
        page.getByRole("heading", { name: "API Keys", level: 1 }),
      ).toBeVisible();

      const createTrigger = page.getByRole("button", {
        name: "Create new key",
      });
      // A fixture-backed row proves the client query and event handlers are
      // hydrated before the first dialog interaction.
      await expect(
        page.getByText("pw_live_prod••••", { exact: true }),
      ).toBeVisible();
      await createTrigger.click();
      let dialog = page.getByRole("dialog", { name: "Create an API key" });
      await expectDialogQuality(page, dialog, auditCase.viewport.width === 320);
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("Enter a label");
      await dialog.getByLabel("Label", { exact: true }).fill("Automation");
      await dialog.getByLabel(/read:subscribers/i).check();
      await dialog.getByLabel("IP allowlist (optional)").fill("999.0.0.1");
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("not a valid IP");
      await dialog.getByLabel("IP allowlist (optional)").fill("203.0.113.7");
      await dialog.getByRole("button", { name: "Create", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toContainText(
        "Key quota changed",
      );
      await dialog.getByRole("button", { name: "Create", exact: true }).click();

      dialog = page.getByRole("dialog", { name: "Save this key now" });
      await expectDialogQuality(page, dialog, auditCase.viewport.width === 320);
      await expect(dialog).toContainText("pw_live_secret-once");
      await dialog.getByRole("button", { name: "Copy", exact: true }).click();
      await expect(
        dialog.getByRole("button", { name: "Copied" }),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("I've stored it safely.").check();
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(createTrigger).toBeFocused();

      let automationRow = rowFor(page, "Automation");
      const editTrigger = automationRow.getByRole("button", { name: "Edit" });
      await editTrigger.click();
      dialog = page.getByRole("dialog", { name: "Edit API key" });
      await expectDialogQuality(page, dialog, auditCase.viewport.width === 320);
      await expect(
        dialog.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
      await dialog.getByLabel("Label", { exact: true }).fill("Automation v2");
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toContainText(
        "changed in another session",
      );
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await expect(dialog).toBeHidden();
      await expect(editTrigger).toBeFocused();

      automationRow = rowFor(page, "Automation v2");
      const usageTrigger = automationRow.getByRole("button", { name: "Usage" });
      await usageTrigger.click();
      dialog = page.getByRole("dialog", { name: "Recent requests" });
      await expectDialogQuality(page, dialog, auditCase.viewport.width === 320);
      await expect(dialog.getByRole("alert")).toContainText(
        "temporarily locked",
      );
      await dialog
        .getByRole("button", { name: "Retry recent requests" })
        .click();
      await expect(dialog).toContainText("subscribers.create");
      await dialog
        .getByRole("button", { name: "Close", exact: true })
        .last()
        .click();
      await expect(dialog).toBeHidden();
      await expect(usageTrigger).toBeFocused();

      automationRow = rowFor(page, "Automation v2");
      await automationRow.getByRole("button", { name: "Revoke" }).click();
      dialog = page.getByRole("dialog", { name: "Revoke this key?" });
      await expectDialogQuality(page, dialog, auditCase.viewport.width === 320);
      const revoke = dialog.getByRole("button", { name: "Revoke key" });
      await expect(revoke).toBeDisabled();
      await dialog
        .getByLabel(/Type Automation v2 to confirm/)
        .fill("automation v2");
      await expect(revoke).toBeDisabled();
      await dialog
        .getByLabel(/Type Automation v2 to confirm/)
        .fill("Automation v2");
      await revoke.click();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toContainText(
        "attached to a job",
      );
      await revoke.click();
      await expect(dialog).toBeHidden();
      await expect(createTrigger).toBeFocused();

      const productionRow = rowFor(page, "Production");
      await productionRow.getByRole("button", { name: "Rotate" }).click();
      dialog = page.getByRole("dialog", { name: "Rotate this key?" });
      await expectDialogQuality(page, dialog, auditCase.viewport.width === 320);
      const rotate = dialog.getByRole("button", {
        name: "Rotate and revoke old key",
      });
      await rotate.click();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toContainText(
        "authentication expired",
      );
      await rotate.click();
      dialog = page.getByRole("dialog", { name: "Save this key now" });
      await expect(dialog).toContainText("pw_live_rotated-secret");
      await dialog.getByLabel("I've stored it safely.").check();
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(dialog).toBeHidden();
      await expect(createTrigger).toBeFocused();

      expect(fixture.api).toMatchObject({
        createCalls: 2,
        editCalls: 2,
        usageCalls: 2,
        revokeCalls: 2,
        rotateCalls: 2,
      });
      await expectPageContainment(page);
    });

    test(`${auditCase.name}: all four privacy dialogs retain stable intent across failure and retry`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== auditCase.project);
      test.slow();
      await page.setViewportSize(auditCase.viewport);
      await page.emulateMedia({ reducedMotion: "reduce" });
      const fixture = await installRoutes(page);
      await loginAsDemo(page, { navigate: false });
      await page.goto("/app/settings/privacy", {
        waitUntil: "domcontentloaded",
      });
      await expect(
        page.getByRole("heading", { name: "Privacy", level: 1 }),
      ).toBeVisible();

      const exportTrigger = page.getByRole("button", {
        name: "Export all data",
      });
      await exportTrigger.click();
      let dialog = page.getByRole("dialog", { name: "Request a full export" });
      await expectDialogQuality(page, dialog, auditCase.viewport.width === 320);
      await dialog.locator("#export-region").selectOption("GDPR");
      await dialog.getByRole("button", { name: "Start export" }).click();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toContainText(
        "Export capacity changed",
      );
      await dialog.getByRole("button", { name: "Try again" }).click();
      await expect(dialog).toBeHidden();
      await expect(exportTrigger).toBeFocused();
      await expect(
        page.locator(
          'a[href="/api/v1/privacy/export-requests/export%2Faudit-1/download"]',
        ),
      ).toBeVisible();

      const dsarTrigger = page.getByRole("button", {
        name: "New subscriber request",
      });
      await dsarTrigger.click();
      dialog = page.getByRole("dialog", {
        name: "New subscriber data request",
      });
      await expectDialogQuality(page, dialog, auditCase.viewport.width === 320);
      await dialog.getByRole("button", { name: "File request" }).click();
      await expect(dialog.locator("#dsar-email-error")).toContainText(
        "email address",
      );
      await dialog.getByLabel("Subject email").fill("subscriber@example.com");
      await dialog.locator("#dsar-region").selectOption("CCPA");
      await dialog.locator("#dsar-notes").fill("Correct the billing name.");
      await dialog.getByRole("button", { name: "File request" }).click();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toContainText(
        "already has an open request",
      );
      await dialog.getByRole("button", { name: "Try filing again" }).click();
      await expect(dialog).toBeHidden();
      await expect(dsarTrigger).toBeFocused();

      const workspaceTrigger = page.getByRole("button", {
        name: "Request workspace deletion",
      });
      await workspaceTrigger.click();
      dialog = page.getByRole("dialog", {
        name: "Request deletion of this workspace?",
      });
      await expectDialogQuality(page, dialog, auditCase.viewport.width === 320);
      const queueWorkspace = dialog.getByRole("button", {
        name: "Queue deletion review",
      });
      await expect(queueWorkspace).toBeDisabled();
      await dialog
        .locator("#confirm-workspace-delete")
        .fill("delete workspace");
      await expect(queueWorkspace).toBeDisabled();
      await dialog
        .locator("#confirm-workspace-delete")
        .fill("DELETE WORKSPACE");
      await dialog.locator("#workspace-delete-region").selectOption("OTHER");
      await queueWorkspace.click();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toContainText(
        "Ownership review changed",
      );
      await dialog.getByRole("button", { name: "Try queueing again" }).click();
      await expect(dialog).toBeHidden();
      await expect(workspaceTrigger).toBeFocused();

      await page.getByRole("button", { name: "Delete my account" }).click();
      dialog = page.getByRole("dialog", {
        name: "Delete your personal account?",
      });
      await expectDialogQuality(page, dialog, auditCase.viewport.width === 320);
      const deleteAccount = dialog.getByRole("button", {
        name: "Permanently delete my account",
      });
      await expect(deleteAccount).toBeDisabled();
      await dialog.locator("#confirm-delete").fill("DELETE MY ACCOUNT");
      await dialog
        .locator("#delete-password")
        .fill("correct horse battery staple");
      await expect(dialog.locator("#delete-mfa-code")).toHaveCount(0);
      await dialog.locator("#delete-region").selectOption("GDPR");
      await deleteAccount.click();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("alert")).toContainText(
        "Recent authentication is required",
      );
      await dialog.getByRole("button", { name: "Try deletion again" }).click();
      await expect(page).toHaveURL(/\/login\?account-deletion=requested$/);

      expectStableRetry(
        fixture.privacy["/api/v1/privacy/export-requests"] ?? [],
      );
      expectStableRetry(fixture.privacy["/api/v1/privacy/requests"] ?? []);
      expectStableRetry(
        fixture.privacy["/api/v1/privacy/deletion-requests"] ?? [],
      );
      expectStableRetry(fixture.privacy["/api/v1/account"] ?? []);
      expect(fixture.privacy["/api/v1/account"]?.[0]?.body).toEqual({
        confirmation: "DELETE MY ACCOUNT",
        password: "correct horse battery staple",
        region: "GDPR",
      });
    });
  }
});
