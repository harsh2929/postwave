import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const FROM_USER = "33333333-3333-4333-8333-333333333333";
const TO_USER = "44444444-4444-4444-8444-444444444444";

interface FixtureState {
  createDelegationAttempts: number;
  createdDelegation: boolean;
  inviteAttempts: number;
  inviteCreated: boolean;
  releaseCreateDelegation: (() => void) | null;
  releaseInvite: (() => void) | null;
  revokeDelegationAttempts: number;
  revokedDelegation: boolean;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installFixtures(page: Page): Promise<FixtureState> {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok" }),
    }),
  );
  const state: FixtureState = {
    createDelegationAttempts: 0,
    createdDelegation: false,
    inviteAttempts: 0,
    inviteCreated: false,
    releaseCreateDelegation: null,
    releaseInvite: null,
    revokeDelegationAttempts: 0,
    revokedDelegation: false,
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/v1/auth/me") {
      await json(route, {
        user_id: USER_ID,
        tenant_id: TENANT_ID,
        email: "owner@example.test",
        role: "owner",
        effective_role: "owner",
        viewer_mode: false,
        can_use_viewer_mode: true,
        auth_provider: "local",
        email_verified: true,
        workspace_name: "Dialog quality matrix",
        workspace_slug: "demo",
      });
      return;
    }
    if (path === "/api/v1/auth/workspaces" && method === "GET") {
      await json(route, {
        workspaces: [
          {
            id: TENANT_ID,
            name: "Dialog quality matrix",
            slug: "demo",
            role: "owner",
            current: true,
          },
        ],
      });
      return;
    }
    if (path === "/api/v1/onboarding/steps" && method === "GET") {
      await json(route, {
        steps: { dashboard_tour: { state: "dismissed" } },
      });
      return;
    }
    if (path === "/api/v1/notifications" && method === "GET") {
      await json(route, { items: [], unread_count: 0 });
      return;
    }

    if (path === "/api/v1/approvals/delegations" && method === "GET") {
      const delegations: Array<Record<string, unknown>> = [];
      if (!state.revokedDelegation) {
        delegations.push({
          id: "delegation-active",
          tenantId: TENANT_ID,
          fromUserId: "55555555-5555-4555-8555-555555555555",
          toUserId: "66666666-6666-4666-8666-666666666666",
          startsAt: "2026-08-01T00:00:00.000Z",
          endsAt: "2099-08-31T23:59:59.999Z",
          reason: "Launch coverage",
          createdAt: "2026-08-01T00:00:00.000Z",
        });
      }
      if (state.createdDelegation) {
        delegations.push({
          id: "delegation-created",
          tenantId: TENANT_ID,
          fromUserId: FROM_USER,
          toUserId: TO_USER,
          startsAt: "2026-08-26T00:00:00.000Z",
          endsAt: null,
          reason: "Browser retry proof",
          createdAt: "2026-08-26T00:00:00.000Z",
        });
      }
      await json(route, { delegations });
      return;
    }
    if (path === "/api/v1/approvals/delegations" && method === "POST") {
      state.createDelegationAttempts += 1;
      if (state.createDelegationAttempts === 1) {
        await json(
          route,
          {
            error: "Delegation overlaps existing coverage.",
            message: "Delegation overlaps existing coverage.",
          },
          409,
        );
        return;
      }
      await new Promise<void>((resolve) => {
        state.releaseCreateDelegation = resolve;
      });
      state.createdDelegation = true;
      await json(route, {
        id: "delegation-created",
        tenantId: TENANT_ID,
        fromUserId: FROM_USER,
        toUserId: TO_USER,
        startsAt: "2026-08-26T00:00:00.000Z",
        endsAt: null,
        reason: "Browser retry proof",
        createdAt: "2026-08-26T00:00:00.000Z",
      });
      return;
    }
    if (
      path === "/api/v1/approvals/delegations/delegation-active" &&
      method === "DELETE"
    ) {
      state.revokeDelegationAttempts += 1;
      if (state.revokeDelegationAttempts === 1) {
        await json(
          route,
          {
            error: "Delegation changed elsewhere. Retry from this dialog.",
            message: "Delegation changed elsewhere. Retry from this dialog.",
          },
          409,
        );
        return;
      }
      state.revokedDelegation = true;
      await json(route, { ok: true });
      return;
    }
    if (path === "/api/v1/approvals/escalation-policy") {
      await json(route, { escalateAfterHours: null, notifyOwners: false });
      return;
    }
    if (path === "/api/v1/approvals" && method === "GET") {
      await json(route, { approvals: [] });
      return;
    }

    if (path === "/api/v1/workspace/members" && method === "GET") {
      await json(route, {
        members: [
          {
            id: USER_ID,
            email: "owner@example.test",
            role: "owner",
            status: "active",
            authProvider: "local",
            emailVerified: true,
            effectiveScopes: [],
            isSelf: true,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
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
      await json(route, {
        invites: state.inviteCreated
          ? [
              {
                id: "invite-created",
                email: "person@example.test",
                role: "admin",
                createdAt: "2026-08-26T00:00:00.000Z",
                expiresAt: "2099-09-02T00:00:00.000Z",
              },
            ]
          : [],
      });
      return;
    }
    if (path === "/api/v1/workspace/invites" && method === "POST") {
      state.inviteAttempts += 1;
      if (state.inviteAttempts === 1) {
        await json(
          route,
          {
            error: "An active invite already exists.",
            message: "An active invite already exists.",
          },
          409,
        );
        return;
      }
      await new Promise<void>((resolve) => {
        state.releaseInvite = resolve;
      });
      state.inviteCreated = true;
      await json(route, {
        invite: {
          id: "invite-created",
          email: "person@example.test",
          role: "admin",
          createdAt: "2026-08-26T00:00:00.000Z",
          expiresAt: "2099-09-02T00:00:00.000Z",
        },
        token: "invite token/with reserved value",
      });
      return;
    }
    if (path === "/api/v1/roles" && method === "GET") {
      await json(route, { roles: [], availableScopes: [] });
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

function collectRuntimeErrors(page: Page): () => void {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const onConsole = (message: { type(): string; text(): string }): void => {
    if (message.type() === "error") consoleErrors.push(message.text());
  };
  const onPageError = (error: Error): void => {
    pageErrors.push(error.message);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  return () => {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    expect(pageErrors, "uncaught page errors").toEqual([]);
    expect(
      consoleErrors.filter(
        (message) =>
          !(
            message.includes("Failed to load resource") &&
            message.includes("409")
          ),
      ),
      "app console errors",
    ).toEqual([]);
  };
}

async function certifyDialog(page: Page, mobile: boolean): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const geometry = await dialog.evaluate((element, checkTouch) => {
    const visible = (node: HTMLElement): boolean => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    };
    const undersized = checkTouch
      ? Array.from(
          element.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
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
          .filter((target) => target.width < 43.5 || target.height < 43.5)
      : [];
    return {
      viewport: innerWidth,
      pageWidth: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ),
      undersized,
    };
  }, mobile);
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport + 1);
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

test.describe("governance and team dialog closure", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ serviceWorkers: "block" });

  test("approval delegation create and revoke failures remain safe and retryable", async ({
    page,
  }, testInfo) => {
    test.slow();
    const mobile = await prepare(page, testInfo);
    const state = await installFixtures(page);
    const assertRuntimeClean = collectRuntimeErrors(page);
    await page.goto("/app/approvals", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { level: 1, name: "Approvals" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Add delegation" }).click();
    await expect(page.getByLabel("From reviewer UUID")).toBeFocused();
    await certifyDialog(page, mobile);
    await page.getByLabel("From reviewer UUID").fill(FROM_USER);
    await page.getByLabel("Covering reviewer UUID").fill(FROM_USER);
    await page.getByRole("button", { name: "Create delegation" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "must be different" }),
    ).toBeVisible();
    await certifyDialog(page, mobile);
    expect(state.createDelegationAttempts).toBe(0);

    await page.getByLabel("Covering reviewer UUID").fill(TO_USER);
    await page.getByLabel("Reason (optional)").fill("Browser retry proof");
    await page.getByRole("button", { name: "Create delegation" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "overlaps existing coverage" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toBeVisible();
    await certifyDialog(page, mobile);

    await page.getByRole("button", { name: "Create delegation" }).click();
    await expect(page.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByLabel("From reviewer UUID")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect.poll(() => Boolean(state.releaseCreateDelegation)).toBe(true);
    state.releaseCreateDelegation?.();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(state.createDelegationAttempts).toBe(2);

    const activeRow = page
      .getByRole("listitem")
      .filter({ hasText: "55555555-5555-4555-8555-555555555555" });
    await activeRow.getByRole("button", { name: "Revoke" }).click();
    await certifyDialog(page, mobile);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Revoke" })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "changed elsewhere" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toBeVisible();
    await certifyDialog(page, mobile);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Revoke" })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(state.revokeDelegationAttempts).toBe(2);
    assertRuntimeClean();
  });

  test("team invite failure, retry, encoded link, reset, and focus lifecycle are truthful", async ({
    page,
  }, testInfo) => {
    test.slow();
    const mobile = await prepare(page, testInfo);
    const state = await installFixtures(page);
    const assertRuntimeClean = collectRuntimeErrors(page);
    await page.goto("/app/settings/team", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { level: 1, name: "Team" }),
    ).toBeVisible();

    const trigger = page.getByRole("button", { name: "Invite", exact: true });
    await trigger.click();
    await expect(page.getByLabel("Email")).toBeFocused();
    await certifyDialog(page, mobile);
    await page.getByLabel("Email").fill("  Person@Example.TEST  ");
    await page.getByLabel("Role", { exact: true }).selectOption("admin");
    await page.getByRole("button", { name: "Create invite link" }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "active invite already exists" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toBeVisible();
    await certifyDialog(page, mobile);

    await page.getByRole("button", { name: "Create invite link" }).click();
    await expect(page.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByLabel("Email")).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect.poll(() => Boolean(state.releaseInvite)).toBe(true);
    state.releaseInvite?.();
    await expect(
      page.getByText(
        /accept-invite\?token=invite%20token%2Fwith%20reserved%20value/u,
      ),
    ).toBeVisible();
    expect(state.inviteAttempts).toBe(2);

    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(page.getByLabel("Email")).toHaveValue("");
    await expect(page.getByLabel("Role", { exact: true })).toHaveValue(
      "editor",
    );
    await expect(page.getByText(/invite%20token/u)).toHaveCount(0);
    assertRuntimeClean();
  });
});
