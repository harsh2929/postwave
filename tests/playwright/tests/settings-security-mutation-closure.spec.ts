import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const DEMO_USER_ID = "11111111-1111-4111-8111-111111111111";
const DEMO_TENANT_ID = "22222222-2222-4222-8222-222222222222";

interface FixtureState {
  domainAttempts: number;
  domainPresent: boolean;
  googleAttempts: number;
  googleConnected: boolean;
  mappingAttempts: number;
  mappingPresent: boolean;
  passkeyDeleteAttempts: number;
  passkeyName: string;
  passkeyPresent: boolean;
  passkeyRenameAttempts: number;
  roleGrantAttempts: number;
  roleGranted: boolean;
  sampleAttempts: number;
  sampleSeeded: boolean;
  slackAttempts: number;
  slackConnected: boolean;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function delayedFailure(
  route: Route,
  attempt: number,
  message: string,
): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 220));
  if (attempt !== 1) return false;
  // This journey certifies component-level failure recovery. A 503 is retried
  // inside the shared idempotent transport shell, so it can succeed before the
  // component ever receives an error. Use a permanent application response to
  // deterministically expose the inline error and require an explicit retry.
  await json(route, { message, error: { message } }, 422);
  return true;
}

async function installFixtures(page: Page): Promise<FixtureState> {
  const state: FixtureState = {
    domainAttempts: 0,
    domainPresent: true,
    googleAttempts: 0,
    googleConnected: true,
    mappingAttempts: 0,
    mappingPresent: true,
    passkeyDeleteAttempts: 0,
    passkeyName: "Security key",
    passkeyPresent: true,
    passkeyRenameAttempts: 0,
    roleGrantAttempts: 0,
    roleGranted: false,
    sampleAttempts: 0,
    sampleSeeded: true,
    slackAttempts: 0,
    slackConnected: true,
  };

  await page.addInitScript(() => {
    if (typeof window.PublicKeyCredential !== "function") {
      Object.defineProperty(window, "PublicKeyCredential", {
        configurable: true,
        value: function PublicKeyCredential() {},
      });
    }
    if (!navigator.credentials) {
      Object.defineProperty(navigator, "credentials", {
        configurable: true,
        value: { create: async () => null, get: async () => null },
      });
    }
  });

  // Keep the app's online manager deterministic while every mutation below is
  // intercepted. An unresolved dev-server health probe can otherwise finish
  // after the mocked API reads and incorrectly flip the client offline before
  // the first write, so the write never reaches this fixture at all.
  await page.route("**/api/health", async (route) => {
    await json(route, { status: "ok" });
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/v1/auth/me") {
      await json(route, {
        // Must match the server-rendered dev-bypass identity exactly. Fresh
        // authority checks intentionally refuse a fixture that swaps the
        // principal between hydration and the write.
        user_id: DEMO_USER_ID,
        tenant_id: DEMO_TENANT_ID,
        email: "owner@postwave.test",
        role: "owner",
        effective_role: "owner",
        auth_provider: "password",
        email_verified: true,
        totp_enabled: false,
        workspace_name: "Audit Workspace",
        workspace_slug: "demo",
      });
      return;
    }

    if (path === "/api/v1/auth/webauthn/credentials" && method === "GET") {
      await json(route, {
        items: state.passkeyPresent
          ? [
              {
                id: "passkey-1",
                name: state.passkeyName,
                created_at: "2026-08-20T09:00:00Z",
                last_used_at: "2026-08-25T09:00:00Z",
                backed_up: true,
              },
            ]
          : [],
      });
      return;
    }
    if (
      path === "/api/v1/auth/webauthn/credentials/passkey-1" &&
      method === "PATCH"
    ) {
      state.passkeyRenameAttempts += 1;
      if (
        await delayedFailure(
          route,
          state.passkeyRenameAttempts,
          "Passkey rename failed.",
        )
      )
        return;
      const input = request.postDataJSON() as { name: string };
      state.passkeyName = input.name;
      await json(route, { ok: true, name: input.name });
      return;
    }
    if (
      path === "/api/v1/auth/webauthn/credentials/passkey-1" &&
      method === "DELETE"
    ) {
      state.passkeyDeleteAttempts += 1;
      if (
        await delayedFailure(
          route,
          state.passkeyDeleteAttempts,
          "Passkey removal failed.",
        )
      )
        return;
      state.passkeyPresent = false;
      await json(route, { ok: true });
      return;
    }

    if (path === "/api/v1/auth/oauth/identities" && method === "GET") {
      await json(route, {
        identities: state.googleConnected
          ? [
              {
                provider: "google",
                email: "owner@example.test",
                linked_at: "2026-08-20T09:00:00Z",
              },
            ]
          : [],
        has_password: true,
        has_passkey: state.passkeyPresent,
      });
      return;
    }
    if (path === "/api/v1/auth/oauth/google/link" && method === "DELETE") {
      state.googleAttempts += 1;
      if (
        await delayedFailure(
          route,
          state.googleAttempts,
          "Google disconnect failed.",
        )
      )
        return;
      state.googleConnected = false;
      await json(route, { ok: true });
      return;
    }

    if (path === "/api/v1/scim/tokens" && method === "GET") {
      await json(route, { tokens: [] });
      return;
    }
    if (path === "/api/v1/scim/role-mappings" && method === "GET") {
      await json(route, {
        mappings: state.mappingPresent
          ? [
              {
                id: "mapping-1",
                group_name: "okta-admins",
                role: "admin",
                precedence: 10,
                created_at: "2026-08-20T09:00:00Z",
              },
            ]
          : [],
      });
      return;
    }
    if (
      path === "/api/v1/scim/role-mappings/mapping-1" &&
      method === "DELETE"
    ) {
      state.mappingAttempts += 1;
      if (
        await delayedFailure(
          route,
          state.mappingAttempts,
          "Mapping delete failed.",
        )
      )
        return;
      state.mappingPresent = false;
      await json(route, { ok: true });
      return;
    }

    if (path === "/api/v1/security/settings" && method === "GET") {
      await json(route, {
        require_2fa_for_admins: false,
        require_2fa_for_all: false,
        allow_trusted_devices: true,
        sso_provider: "",
        sso_metadata_url: "",
        session_max_minutes: null,
      });
      return;
    }
    if (path === "/api/v1/auth/sessions" && method === "GET") {
      await json(route, { sessions: [] });
      return;
    }
    if (path === "/api/v1/auth/trusted-devices" && method === "GET") {
      await json(route, {
        trusted_devices: [],
        allowed: true,
        allowed_durations: [30, 90, 180],
        max_days: 180,
        default_days: 30,
      });
      return;
    }
    if (path === "/api/v1/audit" && method === "GET") {
      await json(route, { rows: [] });
      return;
    }

    if (path === "/api/v1/workspace/members" && method === "GET") {
      await json(route, {
        members: [
          {
            id: "owner-1",
            email: "owner@example.test",
            role: "owner",
            status: "active",
            authProvider: "password",
            emailVerified: true,
            effectiveScopes: [],
            isSelf: true,
            createdAt: "2026-08-20T09:00:00Z",
            updatedAt: "2026-08-20T09:00:00Z",
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
        assignableRoles: ["owner", "admin", "editor", "viewer"],
        assignableStatus: ["active", "suspended"],
        callerIsOwner: true,
      });
      return;
    }
    if (path === "/api/v1/workspace/invites" && method === "GET") {
      await json(route, { invites: [] });
      return;
    }
    if (path === "/api/v1/roles" && method === "GET") {
      await json(route, {
        roles: [
          {
            id: "role-editor",
            name: "editor",
            description: "Content authors",
            assignedScopes: state.roleGranted ? ["audit:execute_actions"] : [],
            createdAt: "2026-08-20T09:00:00Z",
            updatedAt: "2026-08-20T09:00:00Z",
          },
        ],
        availableScopes: ["audit:execute_actions"],
      });
      return;
    }
    if (path === "/api/v1/roles/role-editor/scopes" && method === "PUT") {
      state.roleGrantAttempts += 1;
      if (
        await delayedFailure(
          route,
          state.roleGrantAttempts,
          "Scope grant failed.",
        )
      )
        return;
      state.roleGranted = true;
      await json(route, { ok: true });
      return;
    }

    if (path === "/api/v1/custom-domains" && method === "GET") {
      await json(
        route,
        state.domainPresent
          ? [
              {
                id: "domain-1",
                tenantId: DEMO_TENANT_ID,
                domain: "news.example.test",
                purpose: "forms",
                verified: true,
                dns_records: [],
                createdAt: "2026-08-20T09:00:00Z",
              },
            ]
          : [],
      );
      return;
    }
    if (path === "/api/v1/custom-domains/domain-1" && method === "DELETE") {
      state.domainAttempts += 1;
      if (
        await delayedFailure(
          route,
          state.domainAttempts,
          "Domain removal failed.",
        )
      )
        return;
      state.domainPresent = false;
      await json(route, { ok: true });
      return;
    }

    if (
      path === "/api/v1/integrations/slack/availability" &&
      method === "GET"
    ) {
      await json(route, { configured: true, requires_session: true });
      return;
    }
    if (path === "/api/v1/integrations/slack-workspace" && method === "GET") {
      await json(route, {
        connected: state.slackConnected,
        slack_team_name: "Moosewave Test",
        default_channel_name: "launches",
      });
      return;
    }
    if (
      path === "/api/v1/integrations/slack-workspace" &&
      method === "DELETE"
    ) {
      state.slackAttempts += 1;
      if (
        await delayedFailure(
          route,
          state.slackAttempts,
          "Slack disconnect failed.",
        )
      )
        return;
      state.slackConnected = false;
      await json(route, { ok: true, deleted: true });
      return;
    }

    if (path === "/api/v1/onboarding/sample-data" && method === "GET") {
      await json(route, { seeded: state.sampleSeeded });
      return;
    }
    if (path === "/api/v1/onboarding/sample-data" && method === "DELETE") {
      state.sampleAttempts += 1;
      if (
        await delayedFailure(
          route,
          state.sampleAttempts,
          "Sample removal failed.",
        )
      )
        return;
      state.sampleSeeded = false;
      await json(route, { ok: true });
      return;
    }

    await route.fallback();
  });
  return state;
}

async function prepare(page: Page, testInfo: TestInfo): Promise<boolean> {
  const mobile = testInfo.project.name.includes("mobile");
  await page.setViewportSize(
    mobile ? { width: 320, height: 800 } : { width: 1280, height: 900 },
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await loginAsDemo(page, { navigate: false });
  return mobile;
}

async function certifyPage(page: Page, path: string): Promise<void> {
  await expect(page.locator("main#main-content")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveCount(1);
  const geometry = await page.evaluate(() => ({
    viewport: innerWidth,
    width: Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ),
  }));
  expect(geometry.width, `${path} page overflow`).toBeLessThanOrEqual(
    geometry.viewport + 1,
  );
  const axe = await new AxeBuilder({ page })
    .include("main#main-content")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

async function certifyDialog(page: Page, mobile: boolean): Promise<void> {
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
  await expect(dialog.getByRole("heading")).toHaveCount(1);
  expect(
    await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"]');
      return Boolean(modal?.contains(document.activeElement));
    }),
  ).toBe(true);
  const geometry = await dialog.evaluate((element, checkTouch) => {
    const visible = (node: HTMLElement): boolean => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    };
    return {
      undersized: checkTouch
        ? Array.from(
            element.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
            ),
          )
            .filter(visible)
            .map((target) => {
              const rect = target.getBoundingClientRect();
              return {
                label: target.getAttribute("aria-label") ?? target.textContent,
                width: rect.width,
                height: rect.height,
              };
            })
            .filter((target) => target.width < 44 || target.height < 44)
        : [],
      viewport: innerWidth,
      width: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ),
    };
  }, mobile);
  expect(geometry.width).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.undersized).toEqual([]);
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

async function openCancelRestore(
  page: Page,
  trigger: Locator,
  mobile: boolean,
): Promise<void> {
  await trigger.click();
  await certifyDialog(page, mobile);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await certifyDialog(page, mobile);
}

async function failThenRetry({
  attempts,
  confirmLabel,
  errorText,
  page,
}: {
  attempts: () => number;
  confirmLabel: string;
  errorText: string;
  page: Page;
}): Promise<void> {
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", {
    name: confirmLabel,
    exact: true,
  });
  await confirm.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect.poll(attempts).toBe(1);
  const alert = dialog.getByRole("alert").filter({ hasText: errorText });
  await expect(alert).toBeVisible();
  await expect(alert).toBeFocused();
  await confirm.click();
  await expect.poll(attempts).toBe(2);
  await expect(dialog).toBeHidden();
}

test.describe("settings security mutation closure", () => {
  test.describe.configure({ mode: "serial" });

  test("Security, Team, Domain, Slack, and Developer mutations recover at desktop and exact 320", async ({
    page,
  }, testInfo) => {
    test.slow();
    test.setTimeout(300_000);
    const mobile = await prepare(page, testInfo);
    const state = await installFixtures(page);

    await page.goto("/app/settings/security", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { level: 1, name: "Security" }),
    ).toBeVisible();
    await expect(page.getByText("Security key", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await certifyPage(page, "/app/settings/security");

    let trigger = page.getByRole("button", { name: "Rename Security key" });
    await openCancelRestore(page, trigger, mobile);
    const nameInput = page.getByLabel("Name", { exact: true });
    await expect(nameInput).toBeFocused();
    await expect(
      page.getByRole("dialog").getByRole("button", { name: "Save" }),
    ).toBeDisabled();
    await nameInput.fill("Travel key");
    await failThenRetry({
      attempts: () => state.passkeyRenameAttempts,
      confirmLabel: "Save",
      errorText: "Passkey rename failed.",
      page,
    });
    await expect(page.getByText("Travel key", { exact: true })).toBeVisible();

    trigger = page.getByRole("button", { name: "Delete Travel key" });
    await openCancelRestore(page, trigger, mobile);
    await expect(page.getByRole("dialog")).toContainText("Travel key");
    await failThenRetry({
      attempts: () => state.passkeyDeleteAttempts,
      confirmLabel: "Remove passkey",
      errorText: "Passkey removal failed.",
      page,
    });

    trigger = page.getByRole("button", { name: "Delete", exact: true });
    await openCancelRestore(page, trigger, mobile);
    await expect(page.getByRole("dialog")).toContainText("okta-admins");
    await failThenRetry({
      attempts: () => state.mappingAttempts,
      confirmLabel: "Delete",
      errorText: "Mapping delete failed.",
      page,
    });

    trigger = page.getByRole("button", { name: "Disconnect", exact: true });
    await openCancelRestore(page, trigger, mobile);
    await failThenRetry({
      attempts: () => state.googleAttempts,
      confirmLabel: "Disconnect",
      errorText: "Google disconnect failed.",
      page,
    });

    await page.goto("/app/settings/team", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { level: 1, name: "Team" }),
    ).toBeVisible();
    await certifyPage(page, "/app/settings/team");
    const highPrivilege = page.getByLabel("editor: audit:execute_actions");
    await highPrivilege.click();
    await certifyDialog(page, mobile);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(highPrivilege).toBeFocused();
    await highPrivilege.click();
    await failThenRetry({
      attempts: () => state.roleGrantAttempts,
      confirmLabel: "Grant scope",
      errorText: "Scope grant failed.",
      page,
    });
    await expect(highPrivilege).toBeChecked();

    await page.goto("/app/settings/domain", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { level: 1, name: "Domain & DNS" }),
    ).toBeVisible();
    await certifyPage(page, "/app/settings/domain");
    await expect(
      page.getByText("Custom-domain operations are release-held", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Registration, DNS re-check, replacement, and removal controls are intentionally unavailable.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove", exact: true }),
    ).toHaveCount(0);

    await page.goto("/app/settings/integrations", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { level: 1, name: "Integrations" }),
    ).toBeVisible();
    await certifyPage(page, "/app/settings/integrations");
    trigger = page.getByRole("button", { name: "Disconnect", exact: true });
    await openCancelRestore(page, trigger, mobile);
    await failThenRetry({
      attempts: () => state.slackAttempts,
      confirmLabel: "Disconnect",
      errorText: "Slack disconnect failed.",
      page,
    });

    await page.goto("/app/settings/developer", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { level: 1, name: "Developer" }),
    ).toBeVisible();
    await certifyPage(page, "/app/settings/developer");
    trigger = page.getByRole("button", {
      name: "Remove sample data",
      exact: true,
    });
    await openCancelRestore(page, trigger, mobile);
    await failThenRetry({
      attempts: () => state.sampleAttempts,
      confirmLabel: "Remove",
      errorText: "Sample removal failed.",
      page,
    });
  });
});
