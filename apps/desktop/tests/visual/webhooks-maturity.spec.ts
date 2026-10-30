import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { ConsoleMessage, Page, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const outboundWebhook = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  url: "https://receiver.example.test/…?…",
  url_status: "ready",
  description: "Customer lifecycle receiver",
  events: ["campaign.sent", "subscriber.added", "list.subscriber.added"],
  active: true,
  created_at: "2026-07-23T08:00:00.000Z",
  updated_at: "2026-07-23T08:30:00.000Z",
  last_succeeded_at: "2026-07-23T09:00:00.000Z",
  last_failed_at: "2026-07-23T08:55:00.000Z",
  consecutive_failures: 1,
  signing_algorithm: "hmac_sha256",
  auth_config: {
    type: "headers",
    header_names: ["X-Api-Key"],
    secret_redacted: true,
  },
  auth_config_status: "ready",
  filter_expression: "subscriber.status == active",
  transform_template: {
    email: "/subscriber/email",
    status: "/subscriber/status",
  },
  delivery_policy_status: "ready",
};

const blockedOutboundWebhook = {
  ...outboundWebhook,
  id: "77777777-7777-4777-8777-777777777777",
  url: "https://legacy-receiver.example.test/…?…",
  url_status: "invalid",
  description: "Legacy receiver needs repair",
  active: false,
  auth_config: undefined,
  auth_config_status: "ready",
  filter_expression: undefined,
  transform_template: undefined,
  delivery_policy_status: "ready",
  last_succeeded_at: undefined,
  last_failed_at: undefined,
  consecutive_failures: 0,
};

const inboundEndpoint = {
  id: "22222222-2222-4222-8222-222222222222",
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  slug: "billing-events-a1b2c3",
  name: "Billing event adapter",
  enabled: true,
  transform_jq: "{ type, invoice_id }",
  createdAt: "2026-07-22T10:00:00.000Z",
};

async function fulfill(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

interface WebhookApiControl {
  makeTriggersAvailable: () => void;
}

async function installWebhookApi(page: Page): Promise<WebhookApiControl> {
  let outboundState = { ...outboundWebhook };
  let inboundState = { ...inboundEndpoint };
  let triggerApiAvailable = false;
  const trigger = {
    id: "33333333-3333-4333-8333-333333333333",
    tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    webhook_id: inboundEndpoint.id,
    name: "Paid invoice",
    active: true,
    match_jsonpath: "$.type",
    match_operator: "equals",
    match_value: "invoice.paid",
    email_jsonpath: "$.customer.email",
    action_type: "add_tag",
    action_target_id: "paid-customer",
    fired_count: 4,
    last_fired_at: "2026-07-23T09:06:00.000Z",
    created_at: "2026-07-22T10:00:00.000Z",
    updated_at: "2026-07-23T09:06:00.000Z",
  };
  await page.route("**/api/v1/outbound-webhooks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === "/api/v1/outbound-webhooks"
    ) {
      await fulfill(route, {
        webhooks: [outboundState, blockedOutboundWebhook],
        next_cursor: "",
      });
      return;
    }
    if (
      request.method() === "PATCH" &&
      url.pathname === `/api/v1/outbound-webhooks/${outboundWebhook.id}`
    ) {
      outboundState = {
        ...outboundState,
        ...(request.postDataJSON() as Partial<typeof outboundWebhook>),
      };
      await fulfill(route, outboundState);
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname ===
        `/api/v1/outbound-webhooks/${outboundWebhook.id}/deliveries`
    ) {
      await fulfill(route, {
        deliveries: [
          {
            id: "44444444-4444-4444-8444-444444444442",
            webhook_id: outboundWebhook.id,
            event_type: "subscriber.added",
            attempt_count: 7,
            status: "exhausted",
            last_status_code: 503,
            last_error:
              "receiver returned https://receiver.example.test/failure?token=private-receiver-token&trace=trace-visible",
            created_at: "2026-07-23T08:55:00.000Z",
          },
          {
            id: "44444444-4444-4444-8444-444444444441",
            webhook_id: outboundWebhook.id,
            event_type: "campaign.sent",
            attempt_count: 1,
            status: "delivered",
            last_status_code: 202,
            last_response_body_truncated: "accepted",
            created_at: "2026-07-23T08:59:58.000Z",
            delivered_at: "2026-07-23T09:00:00.000Z",
          },
          {
            id: "44444444-4444-4444-8444-444444444443",
            webhook_id: outboundWebhook.id,
            event_type: "list.subscriber.added",
            attempt_count: 0,
            status: "skipped",
            last_error: "endpoint deleted before first attempt",
            created_at: "2026-07-23T08:40:00.000Z",
          },
        ],
        next_cursor: "",
      });
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname === `/api/v1/outbound-webhooks/${outboundWebhook.id}/health`
    ) {
      await fulfill(route, {
        deliveries_total: 25,
        deliveries_succeeded: 22,
        deliveries_failed: 1,
        deliveries_pending: 1,
        deliveries_skipped: 1,
        latency_p50_ms: 184,
        latency_p99_ms: 920,
        status_breakdown: {
          delivered: 22,
          exhausted: 1,
          pending: 1,
          skipped: 1,
        },
        top_errors: [
          { status_code: 503, message: "Receiver unavailable", count: 1 },
        ],
        consecutive_failures: 1,
        auto_disabled: false,
        last_succeeded_at: "2026-07-23T09:00:00.000Z",
        last_failed_at: "2026-07-23T08:55:00.000Z",
      });
      return;
    }
    await fulfill(route, { error: { code: "unexpected_test_request" } }, 500);
  });

  await page.route("**/api/v1/inbound-webhooks**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === "/api/v1/inbound-webhooks"
    ) {
      await fulfill(route, { items: [inboundState], next_cursor: "" });
      return;
    }
    if (
      request.method() === "PATCH" &&
      url.pathname === `/api/v1/inbound-webhooks/${inboundEndpoint.id}`
    ) {
      inboundState = {
        ...inboundState,
        ...(request.postDataJSON() as Partial<typeof inboundEndpoint>),
      };
      await fulfill(route, inboundState);
      return;
    }
    if (
      request.method() === "POST" &&
      url.pathname === "/api/v1/inbound-webhooks/transform/preview"
    ) {
      await fulfill(route, {
        body: { type: "invoice.paid", invoice_id: "inv_42" },
      });
      return;
    }
    if (
      request.method() === "GET" &&
      url.pathname === `/api/v1/inbound-webhooks/${inboundEndpoint.id}/events`
    ) {
      await fulfill(route, {
        items: [
          {
            id: 401,
            endpoint_id: inboundEndpoint.id,
            headers: {
              "content-type": "application/json",
              "x-postwave-event-id": "sha256:event-401",
            },
            body: '{"type":"invoice.paid","invoice_id":"inv_42"}',
            signature_valid: true,
            received_at: "2026-07-23T09:05:00.000Z",
          },
        ],
        next_cursor: "",
      });
      return;
    }
    if (url.pathname.endsWith("/triggers") && request.method() === "GET") {
      if (!triggerApiAvailable) {
        await fulfill(
          route,
          {
            error: {
              code: "temporary",
              message: "Trigger catalog unavailable",
            },
          },
          503,
        );
      } else {
        await fulfill(route, { items: [trigger] });
      }
      return;
    }
    if (url.pathname.endsWith("/triggers") && request.method() === "POST") {
      await fulfill(
        route,
        { ...trigger, ...(request.postDataJSON() as Record<string, unknown>) },
        201,
      );
      return;
    }
    if (url.pathname.includes("/triggers/") && request.method() === "PATCH") {
      await fulfill(route, {
        ...trigger,
        ...(request.postDataJSON() as Record<string, unknown>),
      });
      return;
    }
    if (url.pathname.includes("/triggers/") && request.method() === "DELETE") {
      await fulfill(route, { ok: true });
      return;
    }
    await fulfill(route, { error: { code: "unexpected_test_request" } }, 500);
  });

  await page.route("**/api/v1/voice/sequences", (route) =>
    fulfill(route, {
      items: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          name: "Customer onboarding",
        },
      ],
    }),
  );
  await page.route("**/api/v1/tags**", (route) =>
    fulfill(route, {
      items: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          name: "paid-customer",
        },
      ],
    }),
  );
  return {
    makeTriggersAvailable: () => {
      triggerApiAvailable = true;
    },
  };
}

async function openWebhooks(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
): Promise<WebhookApiControl> {
  await bootApp(page);
  const apiControl = await installWebhookApi(page);
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  const item = page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="webhooks"]');
  await item.click();
  await expect(item).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Outbound webhooks", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Customer lifecycle receiver", { exact: true }),
  ).toBeVisible();
  return apiControl;
}

async function seriousAxeViolations(
  page: Page,
  options: { forcedColors?: boolean } = {},
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async ({ forcedColors }) => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Document,
            options: {
              runOnly: { type: "tag"; values: string[] };
              rules?: Record<string, { enabled: boolean }>;
            },
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[]; failureSummary?: string }>;
            }>;
          }>;
        };
      }
    ).axe;
    const result = await axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
      // Axe compares author colors with Chromium's forced system background
      // and reports false contrast failures in forced-colors emulation.
      // Keep every structural rule active; screenshots cover the rendered
      // system-color result.
      ...(forcedColors
        ? { rules: { "color-contrast": { enabled: false } } }
        : {}),
    });
    return result.violations
      .filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      )
      .map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failure: node.failureSummary,
        })),
      }));
  }, options);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const contentEvidence = (() => {
      const content = document.querySelector<HTMLElement>(".content");
      if (!content) return { overflow: 0, offenders: [] as string[] };
      const boundary = content.getBoundingClientRect();
      const offenders = Array.from(content.querySelectorAll<HTMLElement>("*"))
        .map((element) => ({
          element,
          rect: element.getBoundingClientRect(),
        }))
        .filter(
          ({ rect }) =>
            rect.width > 0 &&
            (rect.right > boundary.right + 1 || rect.left < boundary.left - 1),
        )
        .slice(0, 8)
        .map(
          ({ element, rect }) =>
            `${element.tagName.toLowerCase()}.${element.className || "(no-class)"} "${element.textContent?.trim().slice(0, 60) ?? ""}" parent=${element.parentElement?.className || element.parentElement?.tagName || "none"} [${Math.round(rect.left)}, ${Math.round(rect.right)}]`,
        );
      return {
        overflow: content.scrollWidth - content.clientWidth,
        offenders,
      };
    })();
    return {
      document: document.documentElement.scrollWidth - window.innerWidth,
      body: document.body.scrollWidth - window.innerWidth,
      content: contentEvidence.overflow,
      offenders: contentEvidence.offenders,
    };
  });
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(
    overflow.content,
    `Overflowing content descendants: ${overflow.offenders.join("; ")}`,
  ).toBeLessThanOrEqual(1);
}

for (const theme of ["dark", "light"] as const) {
  test(`webhooks route is truthful, inspectable, and responsive in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await setTheme(page, theme);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message: ConsoleMessage) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const webhookApi = await openWebhooks(page, bootApp);
    await expect(
      page.getByRole("tab", { name: "Outbound", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByText("Receiver auth: 1 custom header"),
    ).toBeVisible();
    const outboundRow = page
      .getByRole("row")
      .filter({ hasText: "Customer lifecycle receiver" });
    const blockedOutboundRow = page
      .getByRole("row")
      .filter({ hasText: "Legacy receiver needs repair" });
    await expect(blockedOutboundRow).toContainText("URL blocked");
    const blockedTest = blockedOutboundRow.getByRole("button", {
      name: /Send a synthetic test delivery/u,
    });
    await expect(blockedTest).toBeDisabled();
    const blockedReasonId = await blockedTest.getAttribute("aria-describedby");
    expect(blockedReasonId).toBeTruthy();
    await expect(page.locator(`#${blockedReasonId!}`)).toContainText(
      "Replace the complete destination URL in Edit",
    );
    await expect(blockedTest).not.toHaveAttribute("title", /.+/u);
    await expectNoHorizontalOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`webhooks-outbound-${theme}.png`),
      fullPage: false,
    });

    await page
      .getByRole("button", { name: "Outbound event catalog", exact: true })
      .click();
    const catalog = page.getByRole("dialog", {
      name: "Outbound event catalog",
    });
    await expect(catalog).toBeVisible();
    await expect(
      catalog.getByRole("tab", { name: /campaign\.sent/u }),
    ).toBeVisible();
    await expect(catalog).toContainText("X-Postwave-Signature");
    await expect(catalog).toContainText("X-Postwave-Event-Id");
    await expect(catalog).toContainText("X-Postwave-Test: true");
    await expect(catalog).toContainText("4fd5c4c8-156f-4f0d-9346-02ab38e928d8");
    await page.keyboard.press("Escape");
    await expect(catalog).toBeHidden();

    await outboundRow
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const outboundEdit = page.getByRole("dialog", {
      name: "Edit outbound webhook",
    });
    await expect(outboundEdit).toBeVisible();
    await expect(outboundEdit).toContainText("Current destination");
    await expect(outboundEdit.locator("#wh-edit-url")).toHaveValue("");
    await expect(outboundEdit).toContainText("Configured");
    await expect(
      outboundEdit.getByRole("textbox", { name: "Deliver only when" }),
    ).toHaveValue("subscriber.status == active");
    await expect(
      outboundEdit.getByRole("textbox", {
        name: "Projection 1 JSON Pointer",
      }),
    ).toHaveValue("/subscriber/email");
    expect(await seriousAxeViolations(page)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`webhooks-outbound-policy-${theme}.png`),
      fullPage: false,
    });
    await page.keyboard.press("Escape");
    await expect(outboundEdit).toBeHidden();

    await outboundRow
      .getByRole("button", { name: "Deliveries", exact: true })
      .click();
    const deliveries = page.getByRole("dialog", { name: "Recent deliveries" });
    await expect(deliveries).toBeVisible();
    await expect(deliveries).toContainText("Retries exhausted");
    await expect(deliveries).toContainText("Cancelled by deletion");
    await expect(deliveries).toContainText("Endpoint deletion");
    await expect(deliveries).toContainText("excluded from failures");
    await expect(deliveries).toContainText("subscriber.status == active");
    await expect(deliveries).toContainText("2 projected output fields");
    await expect(
      deliveries.getByRole("button", { name: "Replay", exact: true }).first(),
    ).toBeEnabled();
    await expect(deliveries).toContainText("Custom headers: X-Api-Key");
    await expect(deliveries).toContainText("REDACTED");
    await expect(deliveries).not.toContainText("private-receiver-token");
    expect(await seriousAxeViolations(page)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`webhooks-deliveries-${theme}.png`),
      fullPage: false,
    });
    await page.keyboard.press("Escape");
    await expect(deliveries).toBeHidden();

    await page.setViewportSize({ width: 360, height: 800 });
    await expect(
      page.getByRole("heading", { name: "Outbound webhooks", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New destination", exact: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`webhooks-outbound-${theme}-360.png`),
      fullPage: false,
    });
    await outboundRow.scrollIntoViewIfNeeded();
    await expect(
      page.getByLabel("More actions for Customer lifecycle receiver"),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`webhooks-outbound-card-${theme}-360.png`),
      fullPage: false,
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(".content").evaluate((element) => {
      element.scrollTop = 0;
    });
    const inboundTab = page.getByRole("tab", {
      name: "Inbound",
      exact: true,
    });
    await inboundTab.focus();
    await page.keyboard.press("Enter");
    await expect(inboundTab).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("heading", { name: "Inbound webhooks", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Billing event adapter", { exact: true }),
    ).toBeVisible();
    const inboundRow = page
      .getByRole("list", { name: "Inbound endpoint results" })
      .getByRole("listitem")
      .filter({ hasText: "Billing event adapter" });
    await inboundRow
      .getByRole("button", {
        name: "Edit inbound endpoint Billing event adapter",
      })
      .click();
    const inboundEdit = page.getByRole("dialog", {
      name: "Edit inbound endpoint",
    });
    await expect(inboundEdit).toBeVisible();
    await expect(inboundEdit.locator("#inbound-transform-jq")).toHaveValue(
      "{ type, invoice_id }",
    );
    await inboundEdit
      .getByRole("button", { name: "Run server preview", exact: true })
      .click();
    await expect(inboundEdit).toContainText("invoice.paid");
    expect(await seriousAxeViolations(page)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`webhooks-inbound-edit-${theme}.png`),
      fullPage: false,
    });
    await page.keyboard.press("Escape");
    await expect(inboundEdit).toBeHidden();

    await inboundRow
      .getByRole("button", {
        name: "Disable inbound endpoint Billing event adapter",
      })
      .click();
    const disableEndpoint = page.getByRole("alertdialog", {
      name: "Disable this endpoint?",
    });
    await expect(disableEndpoint).toBeVisible();
    await expect(disableEndpoint).toContainText(
      "New requests will be rejected until you enable it again.",
    );
    await disableEndpoint
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(disableEndpoint).toBeHidden();

    await inboundRow
      .getByRole("button", {
        name: "Open inbound webhook Billing event adapter",
      })
      .click();
    const inboundDetail = page.getByRole("dialog", {
      name: "Billing event adapter",
    });
    await expect(inboundDetail).toBeVisible();
    await expect(inboundDetail).toContainText("Verified");
    await expect(inboundDetail).toContainText("invoice.paid");
    await expect(inboundDetail).toContainText("Couldn't load triggers.");
    await expect(inboundDetail).toContainText(
      "Server error. Please try again.",
    );
    webhookApi.makeTriggersAvailable();
    await inboundDetail
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await expect(inboundDetail).toContainText("Paid invoice");

    await inboundDetail
      .getByRole("button", { name: "Add trigger", exact: true })
      .click();
    const createTrigger = page.getByRole("dialog", { name: "Add trigger" });
    await createTrigger.locator("#trig-name").fill("Malformed path example");
    await createTrigger.locator("#trig-jp").fill("$.customer[");
    await expect(createTrigger).toContainText("Invalid path");
    await expect(createTrigger).toContainText("Preview withheld");
    await expect(createTrigger).not.toContainText("Trigger fires");
    expect(await seriousAxeViolations(page)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`webhooks-trigger-validation-${theme}.png`),
      fullPage: false,
    });
    await createTrigger
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    const discardTrigger = page.getByRole("alertdialog", {
      name: "Discard trigger changes?",
    });
    await discardTrigger
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await expect(createTrigger).toBeHidden();

    await inboundDetail
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    const editTrigger = page.getByRole("dialog", { name: "Edit trigger" });
    await expect(editTrigger).toContainText("1 available target loaded");
    await page.keyboard.press("Escape");
    await expect(editTrigger).toBeHidden();

    await inboundDetail
      .getByRole("button", { name: "Pause", exact: true })
      .click();
    await expect(inboundDetail).toContainText("Paused");
    await inboundDetail
      .getByRole("button", { name: "Delete Paid invoice", exact: true })
      .click();
    const deleteTrigger = page.getByRole("alertdialog", {
      name: "Delete this trigger?",
    });
    await expect(deleteTrigger).toContainText(
      "Pause it instead for a reversible stop.",
    );
    await deleteTrigger
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(deleteTrigger).toBeHidden();

    await page.setViewportSize({ width: 360, height: 800 });
    await expect(inboundDetail).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`webhooks-inbound-detail-${theme}-360.png`),
      fullPage: false,
    });
    await page.keyboard.press("Escape");
    await expect(inboundDetail).toBeHidden();

    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await seriousAxeViolations(page)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`webhooks-inbound-${theme}.png`),
      fullPage: false,
    });

    await page.setViewportSize({ width: 360, height: 800 });
    await expect(
      page.getByRole("heading", { name: "Inbound webhooks", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open details", exact: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`webhooks-inbound-${theme}-360.png`),
      fullPage: false,
    });

    if (theme === "dark") {
      await page.emulateMedia({
        reducedMotion: "reduce",
        forcedColors: "active",
      });
      await expectNoHorizontalOverflow(page);
      expect(await seriousAxeViolations(page, { forcedColors: true })).toEqual(
        [],
      );
      await page.screenshot({
        path: testInfo.outputPath(
          "webhooks-inbound-forced-colors-reduced-motion.png",
        ),
        fullPage: false,
      });
      await page.emulateMedia({
        reducedMotion: "no-preference",
        forcedColors: "none",
      });
    }

    const expectedRecoveryMessage: string =
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
    const expectedRecoveryErrors = consoleErrors.filter(
      (message) => message === expectedRecoveryMessage,
    );
    expect(expectedRecoveryErrors.length).toBeGreaterThan(0);
    expect(
      consoleErrors.filter((message) => message !== expectedRecoveryMessage),
    ).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
