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

type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

interface ApprovalFixture {
  id: string;
  tenantId: string;
  resourceType: string;
  resourceId: string;
  requestedByActorLabel: string;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
  decidedByUserId?: string;
  notes?: string;
}

interface EscalationFixture {
  escalateAfterHours: number | null;
  notifyOwners: boolean;
}

interface FixtureState {
  approvals: ApprovalFixture[];
  approvalsRequests: number;
  authFailures: number;
  authRequests: number;
  decisionAttempts: Record<string, number>;
  decisionBodies: Record<string, unknown[]>;
  decisionFailures: Record<string, number>;
  delegationRequests: number;
  escalationBodies: unknown[];
  escalationFailures: number;
  escalationPolicy: EscalationFixture;
  escalationPutAttempts: number;
  escalationPutFailures: number;
  escalationRequests: number;
  followupFailures: Set<string>;
  holdApprovals: boolean;
  holdAuth: boolean;
  holdDecisionIds: Set<string>;
  holdEscalationPut: boolean;
  holdNextEscalationRead: boolean;
  nextEscalationReadPolicy: EscalationFixture | null;
  queueFailures: number;
  queueFailureStatus: number;
  releaseApprovals: (() => void) | null;
  releaseAuth: (() => void) | null;
  releaseDecisions: Record<string, (() => void) | undefined>;
  releaseEscalationPut: (() => void) | null;
  releaseEscalationRead: (() => void) | null;
  role: "owner" | "admin" | "viewer";
  shellApprovalsRequests: number;
}

function approval(
  id: string,
  resourceId: string,
  status: ApprovalStatus,
  patch: Partial<ApprovalFixture> = {},
): ApprovalFixture {
  return {
    id,
    tenantId: TENANT_ID,
    resourceType: "campaign",
    resourceId,
    requestedByActorLabel: `Requester ${id}`,
    status,
    requestedAt: "2026-08-20T10:00:00.000Z",
    ...patch,
  };
}

function standardApprovals(): ApprovalFixture[] {
  return [
    approval("approval-pending-one", "campaign-pending-one", "pending"),
    approval("approval-pending-two", "campaign-pending-two", "pending"),
    approval("approval-approved", "campaign-approved", "approved", {
      decidedAt: "2026-08-21T10:00:00.000Z",
      decidedByUserId: USER_ID,
      notes: "Ready to ship",
    }),
    approval("approval-rejected", "campaign-rejected", "rejected"),
    approval("approval-expired", "campaign-expired", "expired"),
    approval("approval-cancelled", "campaign-cancelled", "cancelled"),
  ];
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function waitForRelease(
  assign: (release: () => void) => void,
): Promise<void> {
  await new Promise<void>((resolve) => assign(resolve));
}

async function installFixtures(page: Page): Promise<FixtureState> {
  const state: FixtureState = {
    approvals: standardApprovals(),
    approvalsRequests: 0,
    authFailures: 0,
    authRequests: 0,
    decisionAttempts: {},
    decisionBodies: {},
    decisionFailures: {},
    delegationRequests: 0,
    escalationBodies: [],
    escalationFailures: 0,
    escalationPolicy: { escalateAfterHours: 24, notifyOwners: false },
    escalationPutAttempts: 0,
    escalationPutFailures: 0,
    escalationRequests: 0,
    followupFailures: new Set(),
    holdApprovals: false,
    holdAuth: false,
    holdDecisionIds: new Set(),
    holdEscalationPut: false,
    holdNextEscalationRead: false,
    nextEscalationReadPolicy: null,
    queueFailures: 0,
    queueFailureStatus: 500,
    releaseApprovals: null,
    releaseAuth: null,
    releaseDecisions: {},
    releaseEscalationPut: null,
    releaseEscalationRead: null,
    role: "owner",
    shellApprovalsRequests: 0,
  };

  await page.route("**/api/health", (route) => json(route, { status: "ok" }));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/v1/auth/me" && method === "GET") {
      state.authRequests += 1;
      if (state.authFailures > 0) {
        state.authFailures -= 1;
        await json(
          route,
          {
            error: "Identity service unavailable.",
            message: "Identity service unavailable.",
          },
          503,
        );
        return;
      }
      if (state.holdAuth) {
        state.holdAuth = false;
        await waitForRelease((release) => {
          state.releaseAuth = release;
        });
      }
      await json(route, {
        user_id: USER_ID,
        tenant_id: TENANT_ID,
        email: `${state.role}@example.test`,
        role: state.role === "viewer" ? "owner" : state.role,
        effective_role: state.role,
        viewer_mode: state.role === "viewer",
        can_use_viewer_mode: true,
        auth_provider: "local",
        email_verified: true,
        workspace_name: "Approval closure",
        workspace_slug: "demo",
      });
      return;
    }
    if (path === "/api/v1/auth/me/viewer-mode" && method === "PATCH") {
      const body = request.postDataJSON() as { enabled?: unknown };
      const enabled = body.enabled === true;
      state.role = enabled ? "viewer" : "owner";
      await json(route, {
        viewer_mode: enabled,
        role: "owner",
        effective_role: enabled ? "viewer" : "owner",
      });
      return;
    }
    if (path === "/api/v1/auth/workspaces" && method === "GET") {
      await json(route, {
        workspaces: [
          {
            id: TENANT_ID,
            name: "Approval closure",
            slug: "demo",
            role: state.role,
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
    if (path === "/api/v1/events" && method === "GET") {
      await route.fulfill({
        status: 200,
        headers: {
          "Cache-Control": "no-cache",
          "Content-Type": "text/event-stream",
        },
        body: "retry: 60000\n\n",
      });
      return;
    }

    if (path === "/api/v1/approvals/delegations" && method === "GET") {
      state.delegationRequests += 1;
      await json(route, { delegations: [] });
      return;
    }
    if (path === "/api/v1/approvals/escalation-policy" && method === "GET") {
      state.escalationRequests += 1;
      if (state.escalationFailures > 0) {
        state.escalationFailures -= 1;
        await json(
          route,
          { error: "Policy read failed.", message: "Policy read failed." },
          400,
        );
        return;
      }
      if (state.holdNextEscalationRead) {
        state.holdNextEscalationRead = false;
        const response =
          state.nextEscalationReadPolicy ?? state.escalationPolicy;
        state.nextEscalationReadPolicy = null;
        await waitForRelease((release) => {
          state.releaseEscalationRead = release;
        });
        await json(route, response);
        return;
      }
      await json(route, state.escalationPolicy);
      return;
    }
    if (path === "/api/v1/approvals/escalation-policy" && method === "PUT") {
      state.escalationPutAttempts += 1;
      const body = request.postDataJSON() as EscalationFixture;
      state.escalationBodies.push(body);
      if (state.escalationPutFailures > 0) {
        state.escalationPutFailures -= 1;
        await json(
          route,
          {
            error: "Policy changed elsewhere.",
            message: "Policy changed elsewhere.",
          },
          409,
        );
        return;
      }
      if (state.holdEscalationPut) {
        state.holdEscalationPut = false;
        await waitForRelease((release) => {
          state.releaseEscalationPut = release;
        });
      }
      state.escalationPolicy = body;
      await json(route, body);
      return;
    }
    if (path === "/api/v1/approvals" && method === "GET") {
      const isShellBadgeRequest =
        url.searchParams.get("status") === "pending" &&
        url.searchParams.get("limit") === "100" &&
        [...url.searchParams.keys()].length === 2;
      if (isShellBadgeRequest) {
        state.shellApprovalsRequests += 1;
        if (state.role === "viewer") {
          await json(
            route,
            {
              error: "Admin access required.",
              message: "Admin access required.",
            },
            403,
          );
          return;
        }
        await json(route, {
          approvals: state.approvals
            .filter((item) => item.status === "pending")
            .slice(0, 100),
        });
        return;
      }

      state.approvalsRequests += 1;
      expect(url.searchParams.get("limit")).toBe("200");
      expect(url.searchParams.has("status")).toBe(false);
      if (state.queueFailures > 0) {
        state.queueFailures -= 1;
        await json(
          route,
          { error: "Queue unavailable.", message: "Queue unavailable." },
          state.queueFailureStatus,
        );
        return;
      }
      if (state.holdApprovals) {
        state.holdApprovals = false;
        await waitForRelease((release) => {
          state.releaseApprovals = release;
        });
      }
      await json(route, { approvals: state.approvals });
      return;
    }

    const decisionMatch = path.match(
      /^\/api\/v1\/approvals\/([^/]+)\/(approve|reject)$/u,
    );
    if (decisionMatch && method === "POST") {
      const id = decodeURIComponent(decisionMatch[1] ?? "");
      const kind = decisionMatch[2] as "approve" | "reject";
      state.decisionAttempts[id] = (state.decisionAttempts[id] ?? 0) + 1;
      (state.decisionBodies[id] ??= []).push(request.postDataJSON());
      if ((state.decisionFailures[id] ?? 0) > 0) {
        state.decisionFailures[id] -= 1;
        await json(
          route,
          {
            error: "Decision changed elsewhere.",
            message: "Decision changed elsewhere.",
          },
          409,
        );
        return;
      }
      if (state.holdDecisionIds.has(id)) {
        state.holdDecisionIds.delete(id);
        await waitForRelease((release) => {
          state.releaseDecisions[id] = release;
        });
      }
      state.approvals = state.approvals.map((item) =>
        item.id === id
          ? {
              ...item,
              status: kind === "approve" ? "approved" : "rejected",
              decidedAt: "2026-08-27T10:00:00.000Z",
              decidedByUserId: USER_ID,
              notes: String(
                (request.postDataJSON() as { notes?: string }).notes ?? "",
              ),
            }
          : item,
      );
      await json(route, {
        ok: true,
        ...(kind === "approve" && state.followupFailures.has(id)
          ? { followup_error: `Follow-up failed for ${id}.` }
          : {}),
      });
      return;
    }

    await json(route, {});
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

async function certifyDialog(page: Page, mobile: boolean): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const geometry = await dialog.evaluate((element, checkTouch) => {
    const rect = element.getBoundingClientRect();
    const undersized = checkTouch
      ? Array.from(
          element.querySelectorAll<HTMLElement>(
            "button:not(:disabled), a[href], textarea:not(:disabled)",
          ),
        )
          .filter((target) => {
            const targetRect = target.getBoundingClientRect();
            return targetRect.width > 0 && targetRect.height > 0;
          })
          .map((target) => {
            const targetRect = target.getBoundingClientRect();
            return {
              label: target.getAttribute("aria-label") ?? target.textContent,
              width: targetRect.width,
              height: targetRect.height,
            };
          })
          .filter((target) => target.width < 43.5 || target.height < 43.5)
      : [];
    return {
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      undersized,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
    };
  }, mobile);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
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

function row(page: Page, resourceId: string) {
  return page.getByRole("listitem").filter({ hasText: resourceId });
}

async function openApprovals(page: Page): Promise<void> {
  await page.goto("/app/approvals", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { level: 1, name: "Approvals" }),
  ).toBeVisible();
}

const runtimeIssues = new WeakMap<
  Page,
  { consoleErrors: string[]; pageErrors: string[] }
>();

test.describe("approval queue and escalation closure", () => {
  test.use({ serviceWorkers: "block" });

  test.beforeEach(({ page }) => {
    const issues = {
      consoleErrors: [] as string[],
      pageErrors: [] as string[],
    };
    runtimeIssues.set(page, issues);
    page.on("console", (message) => {
      if (message.type() === "error") issues.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => issues.pageErrors.push(error.message));
  });

  test.afterEach(({ page }) => {
    const issues = runtimeIssues.get(page);
    expect(issues?.pageErrors ?? [], "uncaught page errors").toEqual([]);
    expect(
      (issues?.consoleErrors ?? []).filter(
        (message) => !message.includes("Failed to load resource"),
      ),
      "unexpected application console errors",
    ).toEqual([]);
  });

  test("status URL history, focus links, selection indeterminate state, clear, and pruning stay coherent", async ({
    page,
  }, testInfo) => {
    await prepare(page, testInfo);
    await installFixtures(page);
    await openApprovals(page);

    const pendingTab = page.getByRole("tab", { name: /^Pending/u });
    await expect(pendingTab).toHaveAttribute("aria-selected", "true");
    await expect(row(page, "campaign-pending-one")).toBeVisible();
    await pendingTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(/\?status=approved$/u);
    await expect(page.getByRole("tab", { name: /^Approved/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(row(page, "campaign-approved")).toBeVisible();

    await page.getByRole("tab", { name: /^Rejected/u }).click();
    await expect(page).toHaveURL(/\?status=rejected$/u);
    await page.goBack();
    await expect(page).toHaveURL(/\?status=approved$/u);
    await expect(page.getByRole("tab", { name: /^Approved/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/approvals$/u);
    await expect(pendingTab).toHaveAttribute("aria-selected", "true");
    await page.goForward();
    await expect(page).toHaveURL(/\?status=approved$/u);
    await page.reload();
    await expect(page.getByRole("tab", { name: /^Approved/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await page.goto("/app/approvals?status=not-a-status");
    await expect(page).toHaveURL(/\/app\/approvals$/u);
    await expect(page.getByRole("tab", { name: /^Pending/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await page.goto("/app/approvals?focus=approval-approved");
    await expect(page.getByRole("tab", { name: /^All/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const focused = row(page, "campaign-approved");
    await expect(focused).toHaveAttribute("data-focus-target", "true");
    await expect(focused).toBeFocused();
    await page.getByRole("tab", { name: /^Pending/u }).click();
    await expect(page).toHaveURL(/\?focus=approval-approved&status=pending$/u);
    await expect(row(page, "campaign-approved")).toBeHidden();
    await page.goBack();
    await expect(page.getByRole("tab", { name: /^All/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(focused).toBeFocused();
    await page.goto("/app/approvals?focus=approval%2Fmissing");
    await expect(
      page.getByRole("alert").filter({ hasText: "not in this loaded window" }),
    ).toContainText("approval/missing");
    await expect(
      page.getByRole("link", { name: "Open direct approval detail" }),
    ).toHaveAttribute("href", "/app/approvals/approval%2Fmissing");

    await page.goto("/app/approvals");
    const first = page.getByLabel("Select campaign campaign-pending-one");
    const second = page.getByLabel("Select campaign campaign-pending-two");
    const selectAll = page.getByLabel("Select all pending");
    await first.check();
    await expect(selectAll).toHaveJSProperty("indeterminate", true);
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    await selectAll.check();
    await expect(first).toBeChecked();
    await expect(second).toBeChecked();
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(first).not.toBeChecked();
    await expect(second).not.toBeChecked();
    await first.check();
    await second.check();
    await page.getByRole("tab", { name: /^Approved/u }).click();
    await expect(page.getByText("2 selected", { exact: true })).toBeHidden();
    await page.getByRole("tab", { name: /^Pending/u }).click();
    await expect(first).not.toBeChecked();
    await expect(second).not.toBeChecked();
  });

  test("row rejection validates, restores focus, survives failure, locks while pending, and dedupes activation", async ({
    page,
  }, testInfo) => {
    const mobile = await prepare(page, testInfo);
    const state = await installFixtures(page);
    state.decisionFailures["approval-pending-one"] = 1;
    await openApprovals(page);

    const trigger = row(page, "campaign-pending-one").getByRole("button", {
      name: "Reject",
    });
    await trigger.click();
    await certifyDialog(page, mobile);
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("link", { name: "Inspect campaign-pending-one" }),
    ).toHaveAttribute("target", "_blank");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await dialog.getByRole("button", { name: "Reject", exact: true }).click();
    const validation = dialog.getByRole("alert");
    await expect(validation).toContainText("rejection reason is required");
    await expect(validation).toBeFocused();
    expect(state.decisionAttempts["approval-pending-one"] ?? 0).toBe(0);
    await dialog
      .getByLabel("Reason (required)")
      .fill("Please resolve the compliance mismatch.");
    await dialog.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(validation).toContainText("Decision changed elsewhere");
    await expect(validation).toBeFocused();
    await expect(dialog).toBeVisible();

    state.holdDecisionIds.add("approval-pending-one");
    const submit = dialog.getByRole("button", { name: "Reject", exact: true });
    await submit.evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await expect(dialog).toHaveAttribute("aria-busy", "true");
    await expect(dialog.getByLabel("Reason (required)")).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect
      .poll(() => Boolean(state.releaseDecisions["approval-pending-one"]))
      .toBe(true);
    expect(state.decisionAttempts["approval-pending-one"]).toBe(2);
    state.releaseDecisions["approval-pending-one"]?.();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("tab", { name: /^Pending/u })).toBeFocused();
    expect(state.decisionBodies["approval-pending-one"]).toEqual([
      { notes: "Please resolve the compliance mismatch." },
      { notes: "Please resolve the compliance mismatch." },
    ]);
  });

  test("row approval accepts an optional note and reports follow-up failure as a recorded decision", async ({
    page,
  }, testInfo) => {
    await prepare(page, testInfo);
    const state = await installFixtures(page);
    state.followupFailures.add("approval-pending-two");
    await openApprovals(page);

    await row(page, "campaign-pending-two")
      .getByRole("button", { name: "Approve" })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Note (optional)").fill("Approved after review.");
    await dialog.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText("Approval recorded, but the follow-up action failed."),
    ).toBeVisible();
    expect(state.decisionAttempts["approval-pending-two"]).toBe(1);
    expect(state.decisionBodies["approval-pending-two"]).toEqual([
      { notes: "Approved after review." },
    ]);
  });

  test("bulk approval preserves only failed rows, discloses follow-up failure, and retries only the remainder", async ({
    page,
  }, testInfo) => {
    const mobile = await prepare(page, testInfo);
    const state = await installFixtures(page);
    state.followupFailures.add("approval-pending-one");
    state.decisionFailures["approval-pending-two"] = 1;
    await openApprovals(page);

    await page.getByLabel("Select campaign campaign-pending-one").check();
    await page.getByLabel("Select campaign campaign-pending-two").check();
    await page.getByRole("button", { name: "Approve 2" }).click();
    await certifyDialog(page, mobile);
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Note (optional)").fill("Batch review complete.");
    await dialog.getByRole("button", { name: "Approve 2" }).click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText("1 decision was recorded; 1 failed");
    await expect(alert).toContainText("follow-up action failure");
    await expect(alert).toBeFocused();
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    await expect(
      page.getByLabel("Select campaign campaign-pending-two"),
    ).toBeChecked();
    await expect(
      dialog.getByRole("button", { name: "Approve 1" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Approve 1" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("tab", { name: /^Pending/u })).toBeFocused();
    expect(state.decisionAttempts).toMatchObject({
      "approval-pending-one": 1,
      "approval-pending-two": 2,
    });
  });

  test("bulk rejection validates shared reason, blocks dismissal while pending, and submits each row once", async ({
    page,
  }, testInfo) => {
    const mobile = await prepare(page, testInfo);
    const state = await installFixtures(page);
    await openApprovals(page);
    await page.getByLabel("Select all pending").check();
    await page.getByRole("button", { name: "Reject 2" }).click();
    await certifyDialog(page, mobile);
    const dialog = page.getByRole("dialog");
    const submit = dialog.getByRole("button", { name: "Reject 2" });
    await submit.click();
    const validation = dialog.getByRole("alert");
    await expect(validation).toContainText("reason is required");
    await expect(validation).toBeFocused();
    expect(state.decisionAttempts).toEqual({});
    await dialog
      .getByLabel("Reason (required)")
      .fill("The shared evidence is incomplete.");
    state.holdDecisionIds.add("approval-pending-one");
    await submit.evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await expect(dialog).toHaveAttribute("aria-busy", "true");
    await expect(dialog.getByLabel("Reason (required)")).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect
      .poll(() => Boolean(state.releaseDecisions["approval-pending-one"]))
      .toBe(true);
    expect(state.decisionAttempts["approval-pending-one"]).toBe(1);
    state.releaseDecisions["approval-pending-one"]?.();
    await expect(dialog).toBeHidden();
    expect(state.decisionAttempts).toMatchObject({
      "approval-pending-one": 1,
      "approval-pending-two": 1,
    });
    expect(state.decisionBodies["approval-pending-two"]).toEqual([
      { notes: "The shared evidence is incomplete." },
    ]);
  });

  test("access, loading, empty, forbidden-request, 403 retry, and 200-item cap states stay distinct", async ({
    page,
  }, testInfo) => {
    const mobile = await prepare(page, testInfo);
    const state = await installFixtures(page);
    state.holdApprovals = true;
    const navigation = page.goto("/app/approvals", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("status", { name: "Loading approval queue" }),
    ).toBeVisible({ timeout: 30_000 });
    // DashboardLayout verifies identity on the server and QueryProvider seeds
    // that result before this client page mounts. There must be no duplicate
    // browser whoami request (and therefore no client auth-pending flash).
    expect(state.authRequests).toBe(0);
    await expect.poll(() => Boolean(state.releaseApprovals)).toBe(true);
    state.releaseApprovals?.();
    await navigation;
    await expect(row(page, "campaign-pending-one")).toBeVisible();

    state.approvals = [];
    await page.reload();
    await expect(page.getByText("Nothing to review")).toBeVisible();

    state.approvals = Array.from({ length: 200 }, (_, index) =>
      approval(
        `approval-cap-${index}`,
        `campaign-cap-${String(index).padStart(3, "0")}`,
        "pending",
      ),
    );
    await page.reload();
    await expect(
      page.getByText("Showing the newest 200 approvals"),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: /^All/u })).toContainText("200");

    state.queueFailures = 10;
    state.queueFailureStatus = 400;
    await page.reload();
    await expect(
      page.getByText("Could not load the approval queue"),
    ).toBeVisible();
    await expect(
      page.getByText(
        "This is a failed request, not an empty queue. Nothing was reviewed or changed.",
      ),
    ).toBeVisible();
    state.queueFailures = 0;
    await page.getByRole("button", { name: "Try again" }).first().click();
    await expect(
      page.getByText("Showing the newest 200 approvals"),
    ).toBeVisible();

    state.queueFailures = 1;
    state.queueFailureStatus = 403;
    await page.reload();
    await expect(
      page.getByText("Could not load the approval queue"),
    ).toBeVisible();
    await expect(
      page.getByText("You need admin access to review approvals."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).first().click();
    await expect(
      page.getByText("Showing the newest 200 approvals"),
    ).toBeVisible();

    await page.goto("/app/maintenance", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { level: 1, name: "Maintenance" }),
    ).toBeVisible();
    const beforeAuth = state.authRequests;
    await page.getByRole("button", { name: "Enter viewer mode" }).click();
    await expect.poll(() => state.authRequests).toBeGreaterThan(beforeAuth);
    await expect(
      page.getByRole("button", { name: "Leave viewer mode" }),
    ).toBeEnabled();

    const beforeQueue = state.approvalsRequests;
    const beforeDelegations = state.delegationRequests;
    const beforeEscalation = state.escalationRequests;
    if (mobile) {
      await page.getByRole("button", { name: "Open navigation" }).click();
    }
    await page
      .locator('button[data-dashboard-nav-group="account"]:visible')
      .click();
    await page
      .locator(
        'button[data-dashboard-nav-collection="account-workspace-management"]:visible',
      )
      .click();
    await page
      .getByRole("link", { name: /Approvals/u })
      .filter({ visible: true })
      .click();
    await expect(
      page.getByText("Owner or admin access is required"),
    ).toBeVisible();
    expect(state.approvalsRequests).toBe(beforeQueue);
    expect(state.delegationRequests).toBe(beforeDelegations);
    expect(state.escalationRequests).toBe(beforeEscalation);
  });

  test("escalation load retry and 1–720-or-blank validation are explicit and focus the error", async ({
    page,
  }, testInfo) => {
    await prepare(page, testInfo);
    const state = await installFixtures(page);
    state.escalationFailures = 10;
    await openApprovals(page);
    const section = page.locator(
      'section[aria-labelledby="escalation-policy"]',
    );
    await expect(
      section.getByText("Escalation policy could not be loaded"),
    ).toBeVisible();
    state.escalationFailures = 0;
    await section.getByRole("button", { name: "Try again" }).click();
    const hours = section.getByLabel("Escalate after (hours)");
    await expect(hours).toHaveValue("24");
    const save = section.getByRole("button", { name: "Save policy" });
    await expect(save).toBeEnabled();

    for (const invalid of ["0", "721", "1.5"]) {
      await hours.fill(invalid);
      await save.click();
      const alert = section.getByRole("alert");
      await expect(alert).toContainText("whole number from 1 to 720");
      await expect(alert).toBeFocused();
    }
    expect(state.escalationPutAttempts).toBe(0);
    await hours.fill("");
    await save.click();
    await expect.poll(() => state.escalationPutAttempts).toBe(1);
    await expect(save).toBeEnabled();
    expect(state.escalationBodies).toEqual([
      { escalateAfterHours: null, notifyOwners: false },
    ]);
  });

  test("escalation save failure retries once, locks duplicate activation, and a stale refetch cannot erase a newer edit", async ({
    page,
  }, testInfo) => {
    await prepare(page, testInfo);
    const state = await installFixtures(page);
    state.escalationPutFailures = 1;
    await openApprovals(page);
    const section = page.locator(
      'section[aria-labelledby="escalation-policy"]',
    );
    const hours = section.getByLabel("Escalate after (hours)");
    const notify = section.getByRole("checkbox", {
      name: "Notify owners when a request escalates",
    });
    const save = section.getByRole("button", { name: "Save policy" });
    await hours.fill("48");
    await notify.check();
    await save.click();
    const failure = section.getByRole("alert");
    await expect(failure).toContainText("Policy changed elsewhere");
    await expect(failure).toBeFocused();
    await expect(hours).toHaveValue("48");

    state.holdEscalationPut = true;
    state.holdNextEscalationRead = true;
    state.nextEscalationReadPolicy = {
      escalateAfterHours: 24,
      notifyOwners: false,
    };
    await save.evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await expect(save).toHaveAttribute("aria-busy", "true");
    await expect(hours).toBeDisabled();
    await expect.poll(() => Boolean(state.releaseEscalationPut)).toBe(true);
    expect(state.escalationPutAttempts).toBe(2);
    state.releaseEscalationPut?.();
    await expect(hours).toBeEnabled();
    await expect.poll(() => Boolean(state.releaseEscalationRead)).toBe(true);
    await hours.fill("72");
    const staleResponse = page.waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === "GET" &&
        new URL(response.url()).pathname ===
          "/api/v1/approvals/escalation-policy"
      );
    });
    state.releaseEscalationRead?.();
    await staleResponse;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(hours).toHaveValue("72");
    await expect(save).toBeEnabled();
    expect(state.escalationBodies).toEqual([
      { escalateAfterHours: 48, notifyOwners: true },
      { escalateAfterHours: 48, notifyOwners: true },
    ]);
  });
});
