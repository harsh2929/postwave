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

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const TOPIC_ID = "topic-settings-closure";
const SINK_ID = "sink-settings-closure";
const SCHEDULE_ID = "schedule-settings-closure";
const WEBHOOK_ID = "webhook-settings-closure";

const TOPIC_NAME = "Product intelligence";
const SINK_NAME = "Primary audit stream";
const SCHEDULE_RECIPIENT = "compliance@example.test";
const WEBHOOK_URL = "https://hooks.example.test/postwave";

interface FixtureState {
  scheduleCreateAttempts: number;
  scheduleDeleteAttempts: number;
  sinkDeleteAttempts: number;
  sinkEditAttempts: number;
  topicCreateAttempts: number;
  topicDeleteAttempts: number;
  webhookCreateAttempts: number;
  webhookDeleteAttempts: number;
  webhookEditAttempts: number;
  webhookRotateAttempts: number;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function failFirst(
  route: Route,
  attempt: number,
  message: string,
): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 220));
  if (attempt !== 1) return false;
  // Mutations carry an idempotency key, so the shared transport transparently
  // retries 5xx responses up to three times. A 409 is deliberately
  // non-retryable at that layer: it represents the concurrent-state conflicts
  // this matrix is simulating and lets the operator-controlled retry remain
  // observable in the dialog.
  await json(route, { message, error: { message } }, 409);
  return true;
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
    scheduleCreateAttempts: 0,
    scheduleDeleteAttempts: 0,
    sinkDeleteAttempts: 0,
    sinkEditAttempts: 0,
    topicCreateAttempts: 0,
    topicDeleteAttempts: 0,
    webhookCreateAttempts: 0,
    webhookDeleteAttempts: 0,
    webhookEditAttempts: 0,
    webhookRotateAttempts: 0,
  };

  let topics = [
    {
      id: TOPIC_ID,
      tenantId: TENANT_ID,
      slug: "product-intelligence",
      name: TOPIC_NAME,
      description:
        "A deliberately long preference description that must wrap cleanly on a 320 pixel viewport without changing the subscriber-facing default.",
      defaultOptIn: true,
      displayOrder: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      optedInCount: 42,
      optedOutCount: 3,
    },
  ];
  let sinks = [
    {
      id: SINK_ID,
      kind: "http",
      name: SINK_NAME,
      enabled: true,
      config: { url: "https://siem.example.test/audit" },
      output_format: "postwave_native",
      webhook_format: "postwave_v1",
      consecutive_failures: 0,
      auto_disable_after: 100,
      circuit_state: "closed",
      last_success_at: "2026-08-25T12:00:00.000Z",
      last_failure_at: null,
      last_error: null,
    },
  ];
  let schedules = [
    {
      id: SCHEDULE_ID,
      cadence: "weekly",
      recipients: [SCHEDULE_RECIPIENT],
      enabled: true,
      created_by_email: "owner@example.test",
      last_enqueued_at: null,
      created_at: "2026-08-01T00:00:00.000Z",
    },
  ];
  let webhooks = [
    {
      id: WEBHOOK_ID,
      tenantId: TENANT_ID,
      url: WEBHOOK_URL,
      events: ["subscriber.created", "campaign.sent"],
      status: "active",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    },
  ];

  await page.addInitScript(() => {
    const trackedWindow = window as typeof window & {
      __POSTWAVE_FORCE_REAL_API_FOR_E2E__?: boolean;
      __settingsClipboardAttempts?: number;
    };
    trackedWindow.__POSTWAVE_FORCE_REAL_API_FOR_E2E__ = true;
    trackedWindow.__settingsClipboardAttempts = 0;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          trackedWindow.__settingsClipboardAttempts =
            (trackedWindow.__settingsClipboardAttempts ?? 0) + 1;
          if (trackedWindow.__settingsClipboardAttempts === 1) {
            throw new Error("Clipboard permission denied.");
          }
        },
      },
    });
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/v1/auth/me") {
      await json(route, {
        user_id: "owner-settings-closure",
        tenant_id: TENANT_ID,
        email: "owner@example.test",
        role: "owner",
        effective_role: "owner",
        viewer_mode: false,
        can_use_viewer_mode: true,
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Settings dialog closure",
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

    if (path === "/api/v1/topics" && method === "GET") {
      await json(route, topics);
      return;
    }
    if (path === "/api/v1/topics" && method === "POST") {
      state.topicCreateAttempts += 1;
      if (
        await failFirst(
          route,
          state.topicCreateAttempts,
          "Topic creation conflicted with another operator.",
        )
      )
        return;
      const input = request.postDataJSON() as {
        defaultOptIn: boolean;
        description?: string;
        displayOrder: number;
        name: string;
        slug: string;
      };
      const created = {
        id: "topic-created-settings-closure",
        tenantId: TENANT_ID,
        ...input,
        description: input.description ?? "",
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
        optedInCount: 0,
        optedOutCount: 0,
      };
      topics = [...topics, created];
      await json(route, created, 201);
      return;
    }
    if (path === `/api/v1/topics/${TOPIC_ID}` && method === "DELETE") {
      state.topicDeleteAttempts += 1;
      if (
        await failFirst(
          route,
          state.topicDeleteAttempts,
          "Topic deletion was not committed.",
        )
      )
        return;
      topics = topics.filter((topic) => topic.id !== TOPIC_ID);
      await json(route, { ok: true });
      return;
    }

    if (path === "/api/v1/audit" && method === "GET") {
      await json(route, {
        rows: [
          {
            id: 9001,
            action: "campaign.updated",
            resourceType: "campaign",
            resourceId: "campaign-settings-closure",
            actorType: "human",
            actorLabel: "owner.with.a.long.identifier@example.test",
            userId: "owner-settings-closure",
            ip: "203.0.113.42",
            userAgent:
              "A deliberately long user agent value used to prove metadata containment at the narrow viewport",
            metadata: {
              context: { correlation_id: "request/settings-closure/9001" },
              before: { subject: "A long campaign subject before editing" },
              after: {
                subject:
                  "A substantially longer campaign subject after editing that must wrap rather than create horizontal page overflow",
              },
            },
            at: "2026-08-25T12:00:00.000Z",
          },
        ],
      });
      return;
    }

    if (path === "/api/v1/audit-sinks" && method === "GET") {
      await json(route, { sinks });
      return;
    }
    if (path === `/api/v1/audit-sinks/${SINK_ID}` && method === "PATCH") {
      state.sinkEditAttempts += 1;
      if (
        await failFirst(
          route,
          state.sinkEditAttempts,
          "Audit sink changed while this dialog was open.",
        )
      )
        return;
      const input = request.postDataJSON() as {
        name?: string;
        output_format?: string;
        webhook_format?: string;
      };
      sinks = sinks.map((sink) =>
        sink.id === SINK_ID
          ? {
              ...sink,
              ...(input.name ? { name: input.name } : {}),
              ...(input.output_format
                ? { output_format: input.output_format }
                : {}),
              ...(input.webhook_format
                ? { webhook_format: input.webhook_format }
                : {}),
            }
          : sink,
      );
      await json(route, { id: SINK_ID, ...input });
      return;
    }
    if (path === `/api/v1/audit-sinks/${SINK_ID}` && method === "DELETE") {
      state.sinkDeleteAttempts += 1;
      if (
        await failFirst(
          route,
          state.sinkDeleteAttempts,
          "Audit sink deletion is temporarily blocked.",
        )
      )
        return;
      sinks = sinks.filter((sink) => sink.id !== SINK_ID);
      await json(route, { deleted: true });
      return;
    }
    if (path === "/api/v1/audit/export-schedules" && method === "GET") {
      await json(route, { schedules });
      return;
    }
    if (path === "/api/v1/audit/export-schedules" && method === "POST") {
      state.scheduleCreateAttempts += 1;
      if (
        await failFirst(
          route,
          state.scheduleCreateAttempts,
          "The compliance mailbox policy rejected this schedule.",
        )
      )
        return;
      const input = request.postDataJSON() as {
        cadence: "weekly" | "monthly";
        recipients: string[];
      };
      const created = {
        id: "schedule-created-settings-closure",
        ...input,
        enabled: true,
        created_by_email: "owner@example.test",
        last_enqueued_at: null,
        created_at: "2026-08-26T00:00:00.000Z",
      };
      schedules = [created, ...schedules];
      await json(route, created, 201);
      return;
    }
    if (
      path === `/api/v1/audit/export-schedules/${SCHEDULE_ID}` &&
      method === "DELETE"
    ) {
      state.scheduleDeleteAttempts += 1;
      if (
        await failFirst(
          route,
          state.scheduleDeleteAttempts,
          "The export scheduler is still reconciling this schedule.",
        )
      )
        return;
      schedules = schedules.filter((schedule) => schedule.id !== SCHEDULE_ID);
      await json(route, { deleted: true });
      return;
    }

    if (path === "/api/v1/webhooks" && method === "GET") {
      await json(route, webhooks);
      return;
    }
    if (path === "/api/v1/webhooks" && method === "POST") {
      state.webhookCreateAttempts += 1;
      if (
        await failFirst(
          route,
          state.webhookCreateAttempts,
          "Webhook creation collided with a concurrent update.",
        )
      )
        return;
      const input = request.postDataJSON() as {
        events: string[];
        url: string;
      };
      const webhook = {
        id: "webhook-created-settings-closure",
        tenantId: TENANT_ID,
        ...input,
        status: "active",
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      };
      webhooks = [webhook, ...webhooks];
      await json(
        route,
        {
          webhook,
          secret: "whsec_created_one_time_settings_closure_123456789",
        },
        201,
      );
      return;
    }
    if (path === `/api/v1/webhooks/${WEBHOOK_ID}` && method === "PATCH") {
      state.webhookEditAttempts += 1;
      if (
        await failFirst(
          route,
          state.webhookEditAttempts,
          "Webhook endpoint changed while this dialog was open.",
        )
      )
        return;
      const input = request.postDataJSON() as {
        events?: string[];
        status?: string;
        url?: string;
      };
      webhooks = webhooks.map((webhook) =>
        webhook.id === WEBHOOK_ID
          ? {
              ...webhook,
              ...input,
              updatedAt: "2026-08-26T00:00:00.000Z",
            }
          : webhook,
      );
      await json(
        route,
        webhooks.find((webhook) => webhook.id === WEBHOOK_ID),
      );
      return;
    }
    if (
      path === `/api/v1/webhooks/${WEBHOOK_ID}/rotate-secret` &&
      method === "POST"
    ) {
      state.webhookRotateAttempts += 1;
      if (
        await failFirst(
          route,
          state.webhookRotateAttempts,
          "The signing key service is temporarily locked.",
        )
      )
        return;
      await json(route, {
        webhook: webhooks.find((webhook) => webhook.id === WEBHOOK_ID),
        secret: "whsec_rotated_one_time_settings_closure_987654321",
      });
      return;
    }
    if (path === `/api/v1/webhooks/${WEBHOOK_ID}` && method === "DELETE") {
      state.webhookDeleteAttempts += 1;
      if (
        await failFirst(
          route,
          state.webhookDeleteAttempts,
          "Webhook deliveries are still draining.",
        )
      )
        return;
      webhooks = webhooks.filter((webhook) => webhook.id !== WEBHOOK_ID);
      await json(route, { ok: true });
      return;
    }

    await route.fallback();
  });

  return state;
}

async function prepare(page: Page, testInfo: TestInfo): Promise<boolean> {
  const mobile = testInfo.project.name === "chromium-mobile";
  await page.setViewportSize(
    mobile ? { width: 320, height: 800 } : { width: 1280, height: 900 },
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await loginAsDemo(page, { navigate: false });
  return mobile;
}

async function certifyPage(page: Page, path: string): Promise<void> {
  await expect(page.locator("main#main-content")).toHaveCount(1);
  await expect(page.locator("main#main-content h1")).toHaveCount(1);
  const geometry = await page.evaluate(() => ({
    viewport: innerWidth,
    width: Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ),
    duplicateIds: Array.from(document.querySelectorAll("[id]"))
      .map((element) => element.id)
      .filter((id, index, all) => all.indexOf(id) !== index),
  }));
  expect(geometry.width, `${path} page overflow`).toBeLessThanOrEqual(
    geometry.viewport + 1,
  );
  expect(geometry.duplicateIds, `${path} duplicate DOM ids`).toEqual([]);

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

function dialogNamed(page: Page, title: string): Locator {
  return page.getByRole("dialog", { name: title, exact: true });
}

async function settledAnimations(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => {
        const iterations = animation.effect?.getTiming().iterations;
        return typeof iterations === "number" && Number.isFinite(iterations);
      })
      .every((animation) => animation.playState === "finished"),
  );
}

async function certifyDialog(
  page: Page,
  title: string,
  mobile: boolean,
): Promise<Locator> {
  const dialog = dialogNamed(page, title);
  await expect(dialog).toBeVisible();
  // Dialog enters from 95% scale. Measuring the first visible frame turns a
  // real 44px control into 41.8px and produces a false mobile touch failure.
  await settledAnimations(page);
  await expect(
    dialog.getByRole("heading", { name: title, exact: true }),
  ).toHaveCount(1);
  const geometry = await dialog.evaluate((element, checkTouchTargets) => {
    const visible = (node: HTMLElement): boolean => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const controls = Array.from(
      element.querySelectorAll<HTMLElement>(
        "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
      ),
    ).filter(visible);
    const undersized = checkTouchTargets
      ? controls
          .map((control) => {
            const isChoice =
              control instanceof HTMLInputElement &&
              ["checkbox", "radio"].includes(control.type);
            const target = isChoice
              ? ((control.closest("label") as HTMLElement | null) ?? control)
              : control;
            const rect = target.getBoundingClientRect();
            return {
              label:
                control.getAttribute("aria-label") ??
                control.textContent?.trim() ??
                control.getAttribute("name") ??
                control.tagName,
              width: rect.width,
              height: rect.height,
            };
          })
          .filter((target) => target.width < 43.5 || target.height < 43.5)
      : [];
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      left: rect.left,
      ownsFocus: element.contains(document.activeElement),
      right: rect.right,
      top: rect.top,
      undersized,
      viewportHeight: innerHeight,
      viewportWidth: innerWidth,
      width: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ),
    };
  }, mobile);
  expect(geometry.left, `${title} left containment`).toBeGreaterThanOrEqual(0);
  expect(geometry.top, `${title} top containment`).toBeGreaterThanOrEqual(0);
  expect(geometry.right, `${title} right containment`).toBeLessThanOrEqual(
    geometry.viewportWidth,
  );
  expect(geometry.bottom, `${title} bottom containment`).toBeLessThanOrEqual(
    geometry.viewportHeight,
  );
  expect(geometry.width, `${title} document overflow`).toBeLessThanOrEqual(
    geometry.viewportWidth + 1,
  );
  expect(geometry.ownsFocus, `${title} owns focus`).toBe(true);
  expect(geometry.undersized, `${title} mobile touch targets`).toEqual([]);

  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact ?? ""),
    ),
    `${title} accessibility violations`,
  ).toEqual([]);
  return dialog;
}

async function openCancelRestore(
  page: Page,
  trigger: Locator,
  title: string,
  mobile: boolean,
): Promise<void> {
  await trigger.click();
  const dialog = await certifyDialog(page, title, mobile);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
}

async function submitDedupedFailure({
  attempts,
  button,
  dialog,
  errorText,
  page,
}: {
  attempts: () => number;
  button: Locator;
  dialog: Locator;
  errorText: string;
  page: Page;
}): Promise<void> {
  await button.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect.poll(attempts).toBe(1);
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  if ((await cancel.count()) > 0) await expect(cancel).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  const alert = dialog.getByRole("alert").filter({ hasText: errorText });
  await expect(alert).toBeVisible();
  await expect(alert).toBeFocused();
}

function actionContainer(
  page: Page,
  uniqueText: string,
  actionLabel: string,
): Locator {
  return page
    .getByText(uniqueText, { exact: true })
    .filter({ visible: true })
    .locator(
      `xpath=ancestor::*[self::tr or .//button[normalize-space()=${JSON.stringify(
        actionLabel,
      )}]][1]`,
    );
}

test.describe("settings audit and webhook hidden-dialog closure", () => {
  test.describe.configure({ mode: "serial" });

  test("Topics, Audit, Audit Streaming, and Webhooks recover at desktop and exact 320", async ({
    page,
  }, testInfo) => {
    test.slow();
    test.setTimeout(360_000);
    const mobile = await prepare(page, testInfo);
    const state = await installFixtures(page);

    await page.goto("/app/settings/topics", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { level: 1, name: "Topics", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(TOPIC_NAME, { exact: true })).toBeVisible();
    await certifyPage(page, "/app/settings/topics");

    const addTopic = page.getByRole("button", {
      name: "Add topic",
      exact: true,
    });
    await addTopic.click();
    let dialog = await certifyDialog(page, "New topic", mobile);
    await dialog.getByLabel("Name", { exact: true }).fill("Security digest");
    await expect(dialog.getByLabel("Slug", { exact: true })).toHaveValue(
      "security-digest",
    );
    let submit = dialog.getByRole("button", { name: "Create", exact: true });
    await submitDedupedFailure({
      attempts: () => state.topicCreateAttempts,
      button: submit,
      dialog,
      errorText: "Topic creation conflicted",
      page,
    });
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
      "Security digest",
    );
    await submit.click();
    await expect.poll(() => state.topicCreateAttempts).toBe(2);
    await expect(dialog).toBeHidden();
    await expect(addTopic).toBeFocused();

    const preview = page.getByRole("button", {
      name: "Preview preference center",
      exact: true,
    });
    await preview.click();
    dialog = await certifyDialog(page, "Preference center preview", mobile);
    await expect(dialog.getByLabel(TOPIC_NAME, { exact: true })).toBeChecked();
    await expect(dialog.getByLabel(TOPIC_NAME, { exact: true })).toBeDisabled();
    await dialog
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
    await expect(dialog).toBeHidden();
    await expect(preview).toBeFocused();

    let container = actionContainer(page, TOPIC_NAME, "Delete");
    let destructive = container.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await openCancelRestore(page, destructive, "Delete topic?", mobile);
    await destructive.click();
    dialog = await certifyDialog(page, "Delete topic?", mobile);
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(addTopic).toBeFocused();
    await expect(page.getByText(TOPIC_NAME, { exact: true })).toBeHidden();
    await expect
      .poll(() => state.topicDeleteAttempts, { timeout: 12_000 })
      .toBe(1);
    await expect(page.getByText(TOPIC_NAME, { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    container = actionContainer(page, TOPIC_NAME, "Delete");
    destructive = container.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await destructive.click();
    dialog = await certifyDialog(page, "Delete topic?", mobile);
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(addTopic).toBeFocused();
    await expect
      .poll(() => state.topicDeleteAttempts, { timeout: 12_000 })
      .toBe(2);
    await expect(page.getByText(TOPIC_NAME, { exact: true })).toBeHidden();

    await page.goto("/app/settings/audit", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { level: 1, name: "Audit Log", exact: true }),
    ).toBeVisible();
    await certifyPage(page, "/app/settings/audit");
    const viewAudit = page.getByRole("button", {
      name: "View audit entry campaign.updated",
      exact: true,
    });
    await viewAudit.click();
    dialog = await certifyDialog(page, "campaign.updated", mobile);
    await expect(dialog).toContainText(
      "owner.with.a.long.identifier@example.test",
    );
    await expect(dialog).toContainText("substantially longer campaign subject");
    await dialog
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
    await expect(dialog).toBeHidden();
    await expect(viewAudit).toBeFocused();

    await page.goto("/app/settings/audit-sinks", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Audit Streaming",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(SINK_NAME, { exact: true })).toBeVisible();
    await expect(
      page.getByText(SCHEDULE_RECIPIENT, { exact: true }),
    ).toBeVisible();
    await certifyPage(page, "/app/settings/audit-sinks");

    const addSink = page.getByRole("button", { name: "Add sink", exact: true });
    await openCancelRestore(page, addSink, "Add streaming sink", mobile);

    container = actionContainer(page, SINK_NAME, "Edit");
    let trigger = container.getByRole("button", { name: "Edit", exact: true });
    await trigger.click();
    dialog = await certifyDialog(page, "Edit sink", mobile);
    submit = dialog.getByRole("button", {
      name: "Save changes",
      exact: true,
    });
    await expect(submit).toBeDisabled();
    await expect(dialog.getByRole("status")).toContainText("Change a field");
    await dialog
      .getByLabel("Name", { exact: true })
      .fill("Recovered audit stream");
    await submitDedupedFailure({
      attempts: () => state.sinkEditAttempts,
      button: submit,
      dialog,
      errorText: "Audit sink changed",
      page,
    });
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
      "Recovered audit stream",
    );
    await submit.click();
    await expect.poll(() => state.sinkEditAttempts).toBe(2);
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText("Recovered audit stream", { exact: true }),
    ).toBeVisible();
    container = actionContainer(page, "Recovered audit stream", "Edit");
    trigger = container.getByRole("button", { name: "Edit", exact: true });
    await expect(trigger).toBeFocused();

    container = actionContainer(page, "Recovered audit stream", "Delete");
    destructive = container.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await openCancelRestore(page, destructive, "Delete sink?", mobile);
    await destructive.click();
    dialog = await certifyDialog(page, "Delete sink?", mobile);
    submit = dialog.getByRole("button", { name: "Delete", exact: true });
    await submitDedupedFailure({
      attempts: () => state.sinkDeleteAttempts,
      button: submit,
      dialog,
      errorText: "Audit sink deletion is temporarily blocked",
      page,
    });
    await submit.click();
    await expect.poll(() => state.sinkDeleteAttempts).toBe(2);
    await expect(dialog).toBeHidden();
    await expect(addSink).toBeFocused();
    await expect(
      page.getByText("Recovered audit stream", { exact: true }),
    ).toBeHidden();

    const addSchedule = page.getByRole("button", {
      name: "Add schedule",
      exact: true,
    });
    await addSchedule.click();
    dialog = await certifyDialog(page, "Add export schedule", mobile);
    submit = dialog.getByRole("button", {
      name: "Create schedule",
      exact: true,
    });
    await submit.click();
    let alert = dialog.getByRole("alert").filter({
      hasText: "Add at least one recipient",
    });
    await expect(alert).toBeVisible();
    await expect(alert).toBeFocused();
    expect(state.scheduleCreateAttempts).toBe(0);
    await dialog
      .getByLabel("Recipients", { exact: true })
      .fill("Security@Example.test, security@example.test");
    await submitDedupedFailure({
      attempts: () => state.scheduleCreateAttempts,
      button: submit,
      dialog,
      errorText: "mailbox policy rejected",
      page,
    });
    await expect(dialog.getByLabel("Recipients", { exact: true })).toHaveValue(
      "Security@Example.test, security@example.test",
    );
    await submit.click();
    await expect.poll(() => state.scheduleCreateAttempts).toBe(2);
    await expect(dialog).toBeHidden();
    await expect(addSchedule).toBeFocused();
    await expect(
      page.getByText("security@example.test", { exact: true }),
    ).toBeVisible();

    container = actionContainer(page, SCHEDULE_RECIPIENT, "Delete");
    destructive = container.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await openCancelRestore(page, destructive, "Delete schedule?", mobile);
    await destructive.click();
    dialog = await certifyDialog(page, "Delete schedule?", mobile);
    submit = dialog.getByRole("button", { name: "Delete", exact: true });
    await submitDedupedFailure({
      attempts: () => state.scheduleDeleteAttempts,
      button: submit,
      dialog,
      errorText: "scheduler is still reconciling",
      page,
    });
    await submit.click();
    await expect.poll(() => state.scheduleDeleteAttempts).toBe(2);
    await expect(dialog).toBeHidden();
    await expect(addSchedule).toBeFocused();
    await expect(
      page.getByText(SCHEDULE_RECIPIENT, { exact: true }),
    ).toBeHidden();

    await page.goto("/app/settings/webhooks", {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { level: 1, name: "Webhooks", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(WEBHOOK_URL, { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    await certifyPage(page, "/app/settings/webhooks");

    const addWebhook = page.getByRole("button", {
      name: "Add webhook",
      exact: true,
    });
    await addWebhook.click();
    dialog = await certifyDialog(page, "Add a webhook", mobile);
    submit = dialog.getByRole("button", { name: "Create", exact: true });
    await submit.click();
    alert = dialog.getByRole("alert").filter({ hasText: "URL must use HTTPS" });
    await expect(alert).toBeVisible();
    await expect(alert).toBeFocused();
    expect(state.webhookCreateAttempts).toBe(0);
    await dialog
      .getByLabel("URL", { exact: true })
      .fill("https://created.example.test/postwave");
    await dialog.getByText("subscriber.created", { exact: true }).click();
    await expect(dialog.getByText("1 selected", { exact: true })).toBeVisible();
    await submitDedupedFailure({
      attempts: () => state.webhookCreateAttempts,
      button: submit,
      dialog,
      errorText: "Webhook creation collided",
      page,
    });
    await expect(dialog.getByLabel("URL", { exact: true })).toHaveValue(
      "https://created.example.test/postwave",
    );
    await submit.click();
    await expect.poll(() => state.webhookCreateAttempts).toBe(2);
    await expect(dialog).toBeHidden();

    let secretDialog = await certifyDialog(
      page,
      "Save your signing secret",
      mobile,
    );
    await expect(secretDialog.getByLabel("Signing secret")).toContainText(
      "whsec_created_one_time",
    );
    await page.keyboard.press("Escape");
    await expect(secretDialog).toBeVisible();
    const copy = secretDialog.getByRole("button", {
      name: "Copy",
      exact: true,
    });
    await copy.evaluate((element: HTMLButtonElement) => {
      element.click();
      element.click();
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __settingsClipboardAttempts?: number;
              }
            ).__settingsClipboardAttempts ?? 0,
        ),
      )
      .toBe(1);
    alert = secretDialog.getByRole("alert").filter({
      hasText: "Clipboard permission denied",
    });
    await expect(alert).toBeVisible();
    await expect(alert).toBeFocused();
    await copy.click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __settingsClipboardAttempts?: number;
              }
            ).__settingsClipboardAttempts ?? 0,
        ),
      )
      .toBe(2);
    await secretDialog.getByLabel("I've saved it safely.").check();
    await secretDialog
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await expect(secretDialog).toBeHidden();
    await expect(addWebhook).toBeFocused();

    container = actionContainer(page, WEBHOOK_URL, "Edit");
    trigger = container.getByRole("button", { name: "Edit", exact: true });
    await trigger.click();
    dialog = await certifyDialog(page, "Edit webhook", mobile);
    submit = dialog.getByRole("button", {
      name: "Save changes",
      exact: true,
    });
    await expect(submit).toBeDisabled();
    await expect(dialog.getByRole("status")).toContainText("Change the URL");
    const recoveredUrl = "https://hooks.example.test/recovered";
    await dialog.getByLabel("URL", { exact: true }).fill(recoveredUrl);
    await submitDedupedFailure({
      attempts: () => state.webhookEditAttempts,
      button: submit,
      dialog,
      errorText: "Webhook endpoint changed",
      page,
    });
    await expect(dialog.getByLabel("URL", { exact: true })).toHaveValue(
      recoveredUrl,
    );
    await submit.click();
    await expect.poll(() => state.webhookEditAttempts).toBe(2);
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText(recoveredUrl, { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    container = actionContainer(page, recoveredUrl, "Edit");
    trigger = container.getByRole("button", { name: "Edit", exact: true });
    await expect(trigger).toBeFocused();

    container = actionContainer(page, recoveredUrl, "Rotate secret");
    trigger = container.getByRole("button", {
      name: "Rotate secret",
      exact: true,
    });
    await openCancelRestore(page, trigger, "Rotate signing secret?", mobile);
    await trigger.click();
    dialog = await certifyDialog(page, "Rotate signing secret?", mobile);
    submit = dialog.getByRole("button", {
      name: "Rotate secret",
      exact: true,
    });
    await submitDedupedFailure({
      attempts: () => state.webhookRotateAttempts,
      button: submit,
      dialog,
      errorText: "signing key service is temporarily locked",
      page,
    });
    await submit.click();
    await expect.poll(() => state.webhookRotateAttempts).toBe(2);
    await expect(dialog).toBeHidden();
    secretDialog = await certifyDialog(
      page,
      "Save your signing secret",
      mobile,
    );
    await expect(secretDialog.getByLabel("Signing secret")).toContainText(
      "whsec_rotated_one_time",
    );
    await secretDialog.getByLabel("I've saved it safely.").check();
    await secretDialog
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await expect(secretDialog).toBeHidden();
    await expect(trigger).toBeFocused();

    container = actionContainer(page, recoveredUrl, "Delete");
    destructive = container.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await openCancelRestore(page, destructive, "Delete webhook?", mobile);
    await destructive.click();
    dialog = await certifyDialog(page, "Delete webhook?", mobile);
    submit = dialog.getByRole("button", { name: "Delete", exact: true });
    await submitDedupedFailure({
      attempts: () => state.webhookDeleteAttempts,
      button: submit,
      dialog,
      errorText: "deliveries are still draining",
      page,
    });
    await submit.click();
    await expect.poll(() => state.webhookDeleteAttempts).toBe(2);
    await expect(dialog).toBeHidden();
    await expect(addWebhook).toBeFocused();
    await expect(page.getByText(recoveredUrl, { exact: true })).toBeHidden();

    expect(state).toEqual({
      scheduleCreateAttempts: 2,
      scheduleDeleteAttempts: 2,
      sinkDeleteAttempts: 2,
      sinkEditAttempts: 2,
      topicCreateAttempts: 2,
      topicDeleteAttempts: 2,
      webhookCreateAttempts: 2,
      webhookDeleteAttempts: 2,
      webhookEditAttempts: 2,
      webhookRotateAttempts: 2,
    });
  });
});
