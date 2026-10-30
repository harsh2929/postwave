import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { ConsoleMessage, Page, TestInfo } from "@playwright/test";

import { expect, test, unexpectedTauriCommands } from "./fixture";
import {
  BLOCKED_OUTBOUND_ID,
  LIST_WEBHOOK_ID,
  OUTBOUND_ID,
  PUBLIC_KEY,
  bootEvidenceRoute,
  type WebhookEvidenceHarness,
  type WebhookEvidenceOptions,
} from "./webhooks-evidence-harness";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

type Theme = "dark" | "light";
type BootApp = (page: Page) => Promise<void>;

test.afterEach(async ({ page }) => {
  expect(
    await unexpectedTauriCommands(page),
    "Webhook evidence invoked native commands without deterministic fixture semantics",
  ).toEqual([]);
});

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
      // axe-core computes author colors against Chromium's forced system
      // background and reports false contrast failures in forced-colors mode.
      // Structural/semantic rules still run; the rendered screenshot is the
      // authoritative forced-color visual evidence.
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
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
    content: (() => {
      const content = document.querySelector<HTMLElement>(".content");
      return content ? content.scrollWidth - content.clientWidth : 0;
    })(),
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.content).toBeLessThanOrEqual(1);
}

async function saveEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    fullPage: false,
  });
}

function observeRenderer(
  page: Page,
  {
    allowExpectedHttpFailures = false,
  }: { allowExpectedHttpFailures?: boolean } = {},
): {
  expectClean: () => void;
} {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    expectClean: () => {
      const unexpectedConsoleErrors = allowExpectedHttpFailures
        ? consoleErrors.filter(
            (message) =>
              !message.startsWith(
                "Failed to load resource: the server responded with a status of 503",
              ),
          )
        : consoleErrors;
      expect(unexpectedConsoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    },
  };
}

async function openRoute({
  page,
  bootApp,
  setTheme,
  theme,
  path,
  options,
}: {
  page: Page;
  bootApp: BootApp;
  setTheme: (page: Page, theme: Theme) => Promise<void>;
  theme: Theme;
  path: string;
  options?: WebhookEvidenceOptions;
}): Promise<WebhookEvidenceHarness> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setTheme(page, theme);
  return bootEvidenceRoute({ page, bootApp, path, options });
}

function outboundRow(page: Page) {
  return page
    .getByRole("row")
    .filter({ hasText: "Customer lifecycle receiver" });
}

function blockedOutboundRow(page: Page) {
  return page
    .getByRole("row")
    .filter({ hasText: "Legacy receiver needs repair" });
}

async function expectOutboundReady(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Outbound webhooks", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Outbound", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(outboundRow(page)).toContainText(
    "Receiver auth: 1 custom header",
  );
  await expect(blockedOutboundRow(page)).toContainText("URL blocked");
  const blockedTest = blockedOutboundRow(page).getByRole("button", {
    name: /Send a synthetic test delivery/u,
  });
  await expect(blockedTest).toBeDisabled();
  const reasonId = await blockedTest.getAttribute("aria-describedby");
  expect(reasonId).toBeTruthy();
  await expect(page.locator(`#${reasonId!}`)).toContainText(
    "Replace the complete destination URL in Edit",
  );
}

async function expectInboundReady(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Inbound webhooks", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Inbound", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByText("Billing event adapter", { exact: true }),
  ).toBeVisible();
}

async function expectSimulatorReady(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Webhook Simulator", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Webhook simulator controls" }),
  ).toBeVisible();
  const controls = page.getByRole("group", {
    name: "Webhook simulator controls",
  });
  await expect(controls.getByRole("combobox").nth(0)).toHaveValue(OUTBOUND_ID);
  await expect(controls.getByRole("combobox").nth(1)).toHaveValue(
    "campaign.sent",
  );
  await expect(
    page.getByRole("button", { name: "Fire event" }),
  ).toHaveAttribute("aria-disabled", "false");
}

for (const theme of ["dark", "light"] as const) {
  test(`canonical outbound is independently inspectable and axe-clean in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const renderer = observeRenderer(page);
    await openRoute({
      page,
      bootApp,
      setTheme,
      theme,
      path: "/app/webhooks?tab=outbound",
    });
    await expectOutboundReady(page);
    await expectNoHorizontalOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await saveEvidence(page, testInfo, `webhooks-outbound-canonical-${theme}`);

    await page
      .getByRole("button", { name: "Outbound event catalog", exact: true })
      .click();
    const catalog = page.getByRole("dialog", {
      name: "Outbound event catalog",
    });
    await expect(catalog).toContainText("X-Postwave-Signature");
    await expect(catalog).toContainText("X-Postwave-Event-Id");
    await expect(catalog).toContainText("X-Postwave-Test: true");
    const selectedSample = catalog.getByRole("region", {
      name: "campaign.sent representative signed body",
    });
    await expect(selectedSample).toHaveAttribute("tabindex", "0");
    await selectedSample.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(selectedSample).toBeFocused();
    await expect(selectedSample).toHaveCSS("outline-style", "solid");
    expect(await seriousAxeViolations(page)).toEqual([]);
    await saveEvidence(page, testInfo, `webhooks-outbound-catalog-${theme}`);
    await page.keyboard.press("Escape");
    await expect(catalog).toBeHidden();
    renderer.expectClean();
  });

  test(`canonical inbound is independently inspectable and axe-clean in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const renderer = observeRenderer(page);
    await openRoute({
      page,
      bootApp,
      setTheme,
      theme,
      path: "/app/webhooks?tab=inbound",
    });
    await expectInboundReady(page);
    await expectNoHorizontalOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await saveEvidence(page, testInfo, `webhooks-inbound-canonical-${theme}`);
    renderer.expectClean();
  });

  test(`webhook Simulator is independently inspectable and axe-clean in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const renderer = observeRenderer(page);
    await openRoute({
      page,
      bootApp,
      setTheme,
      theme,
      path: "/app/webhook-simulator",
    });
    await expectSimulatorReady(page);
    await expect(page.getByText("Signing: HMAC-SHA256")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await saveEvidence(page, testInfo, `webhook-simulator-canonical-${theme}`);
    renderer.expectClean();
  });
}

test("outbound pagination failure retains evidence, filtered probes stay unsigned, replay is explicit, and delete is typed", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page, {
    allowExpectedHttpFailures: true,
  });
  const harness = await openRoute({
    page,
    bootApp,
    setTheme,
    theme: "dark",
    path: "/app/webhooks?tab=outbound",
    options: {
      outboundNextCursor: true,
      outboundPageFailureCount: 3,
      filteredOutboundTest: true,
    },
  });
  await expectOutboundReady(page);

  await page
    .getByRole("button", { name: "Load more destinations", exact: true })
    .click();
  await expect(
    page.getByText("Couldn't load more destinations", { exact: false }),
  ).toBeVisible();
  await expect(outboundRow(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry loading more", exact: true }),
  ).toBeVisible();
  await saveEvidence(page, testInfo, "webhooks-outbound-pagination-retained");

  await page
    .getByRole("button", { name: "Retry loading more", exact: true })
    .click();
  await expect(
    page.getByText("Recovered pagination receiver", { exact: true }),
  ).toBeVisible();
  expect(harness.counters.outboundPage).toBe(4);

  await outboundRow(page)
    .getByRole("button", { name: /Send a synthetic test delivery/u })
    .click();
  const liveTest = page.getByRole("alertdialog", {
    name: "Send a live test delivery?",
  });
  await expect(liveTest).toContainText(
    "This action is never queued or retried by the desktop client.",
  );
  await liveTest
    .getByRole("button", { name: "Send test", exact: true })
    .click();
  await expect(liveTest).toContainText("Filtered before delivery");
  await expect(liveTest).toContainText(
    "no payload was signed, and HTTP 204 is Moosewave's internal filtered outcome",
  );
  await expect(liveTest).not.toContainText("Receiver returned HTTP");
  await saveEvidence(page, testInfo, "webhooks-outbound-filtered-probe");
  await liveTest
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();

  await outboundRow(page)
    .getByRole("button", { name: "Deliveries", exact: true })
    .click();
  const deliveries = page.getByRole("dialog", { name: "Recent deliveries" });
  await expect(deliveries).toContainText("Retries exhausted");
  await expect(deliveries).toContainText("Cancelled by deletion");
  await expect(deliveries).not.toContainText("private-receiver-token");
  await deliveries
    .getByRole("button", { name: "Replay", exact: true })
    .first()
    .click();
  const replay = page.getByRole("alertdialog", {
    name: "Replay this live delivery?",
  });
  await expect(replay).toContainText("side effects may repeat");
  await expect(replay).toContainText(
    "Original delivery: 44444444-4444-4444-8444-444444444442",
  );
  await saveEvidence(page, testInfo, "webhooks-outbound-replay-ceremony");
  await replay.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(deliveries).toBeHidden();

  await outboundRow(page)
    .getByLabel("More actions for Customer lifecycle receiver")
    .click();
  await outboundRow(page)
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  const deletion = page.getByRole("alertdialog", {
    name: "Permanently delete this destination?",
  });
  const confirmDelete = deletion.getByRole("button", {
    name: "Delete permanently",
    exact: true,
  });
  await expect(confirmDelete).toBeDisabled();
  const typed = deletion.getByPlaceholder("DELETE");
  await typed.fill("delete");
  await expect(confirmDelete).toBeDisabled();
  await typed.fill("DELETE");
  await expect(confirmDelete).toBeEnabled();
  await expect(deletion).toContainText(
    "destination/auth/signing secrets are shredded",
  );
  await saveEvidence(page, testInfo, "webhooks-outbound-typed-delete");
  expect(await seriousAxeViolations(page)).toEqual([]);
  await deletion.getByRole("button", { name: "Cancel", exact: true }).click();

  expect(harness.counters.outboundList).toBeGreaterThanOrEqual(3);
  renderer.expectClean();
});

test("inbound history keeps invalid payloads guarded, paginates fail-closed, and replays only verified events", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page, {
    allowExpectedHttpFailures: true,
  });
  const harness = await openRoute({
    page,
    bootApp,
    setTheme,
    theme: "light",
    path: "/app/webhooks?tab=inbound",
    options: {
      inboundNextCursor: true,
      inboundPageFailureCount: 3,
    },
  });
  await expectInboundReady(page);

  const endpoint = page
    .getByRole("list", { name: "Inbound endpoint results" })
    .getByRole("listitem")
    .filter({ hasText: "Billing event adapter" });
  await endpoint
    .getByRole("button", {
      name: "Open inbound webhook Billing event adapter",
    })
    .click();
  const detail = page.getByRole("dialog", { name: "Billing event adapter" });
  const framing = detail.getByRole("region", {
    name: "Inbound webhook HMAC v2 signature framing",
  });
  await expect(framing).toHaveAttribute("tabindex", "0");
  await framing.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(framing).toBeFocused();
  await expect(framing).toHaveCSS("outline-style", "solid");
  await saveEvidence(page, testInfo, "webhooks-inbound-framing-focus");
  await expect(detail).toContainText("Verified");
  await expect(detail).toContainText("Invalid signature");
  await expect(detail).toContainText(
    "Payload hidden because signature verification failed",
  );
  await expect(detail).not.toContainText("must-stay-hidden");
  const invalidReplay = detail.getByRole("button", {
    name: "Replay unavailable: invalid signature",
  });
  await expect(invalidReplay).toBeDisabled();

  await detail
    .getByRole("button", { name: "Replay event", exact: true })
    .click();
  const replay = page.getByRole("alertdialog", {
    name: "Replay this event?",
  });
  await expect(replay).toContainText("real side effects may repeat");
  await replay
    .getByRole("button", { name: "Replay event", exact: true })
    .click();
  await expect(
    page.getByText(/Replay queued — 1 matching trigger action/u),
  ).toBeVisible();
  expect(harness.counters.inboundReplay).toBe(1);

  await detail
    .getByRole("button", { name: "Load older events", exact: true })
    .click();
  await expect(detail).toContainText("Couldn't load older events");
  await expect(detail).toContainText("previously loaded events remain visible");
  await expect(
    detail.getByRole("button", {
      name: "Retry loading older events",
      exact: true,
    }),
  ).toBeVisible();
  await saveEvidence(page, testInfo, "webhooks-inbound-history-fail-closed");
  await detail
    .getByRole("button", {
      name: "Retry loading older events",
      exact: true,
    })
    .click();
  await expect(detail).toContainText("invoice.refunded");
  expect(harness.counters.inboundEventPage).toBe(4);
  await expect(detail).toContainText("Paid invoice");
  expect(await seriousAxeViolations(page)).toEqual([]);
  await saveEvidence(page, testInfo, "webhooks-inbound-verified-replay");
  renderer.expectClean();
});

test("Simulator exposes algorithm-specific verification and truthful filtered outcomes after live-effect confirmation", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page, {
    allowExpectedHttpFailures: true,
  });
  const harness = await openRoute({
    page,
    bootApp,
    setTheme,
    theme: "dark",
    path: "/app/webhook-simulator",
    options: {
      outboundNextCursor: true,
      outboundPageFailureCount: 3,
      filteredSimulatorFire: true,
    },
  });
  await expectSimulatorReady(page);

  await page
    .getByRole("button", { name: "Verify signature →", exact: true })
    .click();
  const verifier = page.getByRole("dialog", {
    name: "Verify webhook signature",
  });
  await expect(verifier).toContainText("HMAC-SHA256");
  await expect(verifier).toContainText("X-Postwave-Signature");
  await saveEvidence(page, testInfo, "webhook-simulator-hmac-verifier");
  await page.keyboard.press("Escape");
  await expect(verifier).toBeHidden();

  await page
    .getByRole("button", { name: "Load more targets", exact: true })
    .click();
  await expect(
    page.getByText(
      "Couldn't load more webhook targets: Server error. Please try again.",
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry more targets", exact: true })
    .click();
  expect(harness.counters.outboundPage).toBe(4);

  await page.getByRole("button", { name: "Fire event", exact: true }).click();
  const productionConfirm = page.getByRole("alertdialog", {
    name: "Send a real signed webhook request?",
  });
  await expect(productionConfirm).toContainText(
    "Your downstream handler can trigger orders, notifications, billing, or other side effects",
  );
  await expect(productionConfirm).toContainText("Fire ID");
  await productionConfirm
    .getByRole("button", {
      name: "Send this one logical fire",
      exact: true,
    })
    .click();
  await expect(page.getByRole("heading", { name: "Response" })).toBeVisible();
  await expect(
    page.getByText("FILTERED", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("No receiver request was made.")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Request headers", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Recent fires", { exact: true })).toBeVisible();
  await page
    .getByText("No receiver request was made.")
    .scrollIntoViewIfNeeded();
  expect(harness.counters.simulatorFire).toBe(1);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await saveEvidence(page, testInfo, "webhook-simulator-filtered-outcome");
  renderer.expectClean();
});

for (const material of [
  {
    algorithm: "hmac_sha256",
    option: "HMAC-SHA256 (shared secret)",
    evidenceName: "webhooks-hmac-shown-once",
  },
  {
    algorithm: "ecdsa_p256",
    option: "ECDSA P-256 (public key verification)",
    evidenceName: "webhooks-asymmetric-public-only",
  },
] as const) {
  test(`new outbound ${material.algorithm} destinations expose only algorithm-appropriate material`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const renderer = observeRenderer(page);
    const harness = await openRoute({
      page,
      bootApp,
      setTheme,
      theme: material.algorithm === "hmac_sha256" ? "dark" : "light",
      path: "/app/webhooks?tab=outbound",
    });
    await expectOutboundReady(page);
    await page
      .getByRole("button", { name: "New destination", exact: true })
      .click();
    const connect = page.getByRole("dialog", {
      name: "Connect to Your own server",
    });
    await connect
      .getByLabel("Receiver URL")
      .fill("https://visual.receiver.example.test/postwave");
    await connect
      .getByLabel("Signing algorithm")
      .selectOption(material.algorithm);
    await connect.getByRole("button", { name: "Connect", exact: true }).click();

    const reveal = page.getByRole("dialog", { name: "Destination created" });
    await expect(reveal).toBeVisible();
    if (material.algorithm === "hmac_sha256") {
      await expect(reveal).toContainText("Shared signing secret");
      await expect(reveal).toContainText("whsec_visual_shown_once_7f9e2d");
      await expect(reveal).not.toContainText("Public verification key");
      const done = reveal.getByRole("button", {
        name: "I've stored it securely",
        exact: true,
      });
      await expect(done).toBeDisabled();
      await reveal
        .getByLabel(
          "I stored the shared signing secret in an approved secret manager and understand it cannot be shown again.",
        )
        .check();
      await expect(done).toBeEnabled();
    } else {
      await expect(reveal).toContainText("Public verification key");
      await expect(reveal).toContainText(PUBLIC_KEY);
      await expect(reveal).toContainText(
        "private signing key server-side and never returns it to clients",
      );
      await expect(reveal).not.toContainText("Shared signing secret");
      await expect(
        reveal.getByRole("button", { name: "Done", exact: true }),
      ).toBeEnabled();
    }
    await saveEvidence(page, testInfo, material.evidenceName);
    expect(await seriousAxeViolations(page)).toEqual([]);
    expect(harness.counters.createdAlgorithms).toEqual([material.algorithm]);
    renderer.expectClean();
  });
}

test("list-scoped Webhooks preserves paged evidence, uses typed deletion, and keeps its HMAC secret shown once", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page, {
    allowExpectedHttpFailures: true,
  });
  const harness = await openRoute({
    page,
    bootApp,
    setTheme,
    theme: "dark",
    path: "/app/lists",
    options: {
      listWebhookNextCursor: true,
      listWebhookPageFailureCount: 3,
    },
  });
  await expect(page.getByRole("heading", { name: "Lists" })).toBeVisible();
  const listRow = page
    .getByText("VIP customers", { exact: true })
    .locator("..");
  await listRow.getByRole("button", { name: "Open", exact: true }).click();
  const listDetail = page.getByRole("dialog", { name: "VIP customers" });
  await listDetail.getByRole("tab", { name: "Webhooks", exact: true }).click();
  await expect(listDetail).toContainText(
    "https://list-receiver.example.test/…?…",
  );
  await expect(listDetail).toContainText("list.subscriber.added");

  await listDetail
    .getByRole("button", { name: "Load older webhooks", exact: true })
    .click();
  await expect(listDetail).toContainText(
    "Couldn't load webhooks: Server error. Please try again.",
  );
  await expect(listDetail).toContainText(
    "https://list-receiver.example.test/…?…",
  );
  await expect(
    listDetail.getByRole("button", {
      name: "Load older webhooks",
      exact: true,
    }),
  ).toBeVisible();
  await saveEvidence(page, testInfo, "list-webhooks-pagination-retained");
  await listDetail
    .getByRole("button", { name: "Load older webhooks", exact: true })
    .click();
  await expect(listDetail).toContainText(
    "https://recovered-list-receiver.example.test/…?…",
  );
  expect(harness.counters.listWebhookPage).toBe(4);

  await listDetail
    .getByRole("button", { name: "Add webhook", exact: true })
    .click();
  const add = page.getByRole("dialog", {
    name: "Add webhook to VIP customers",
  });
  await add
    .getByLabel("URL")
    .fill("https://new-list-receiver.example.test/postwave");
  await add.getByRole("button", { name: "Add webhook", exact: true }).click();
  const secret = page.getByRole("dialog", {
    name: "Store your signing secret",
  });
  await expect(secret).toContainText("list_whsec_visual_shown_once_29ef");
  await expect(secret).toContainText(
    "HMAC-SHA256 secret is shown exactly once",
  );
  const stored = secret.getByRole("button", {
    name: "I've stored it securely",
    exact: true,
  });
  await expect(stored).toBeDisabled();
  await secret
    .getByLabel(
      "I stored this secret securely and understand it cannot be shown again.",
    )
    .check();
  await expect(stored).toBeEnabled();
  await saveEvidence(page, testInfo, "list-webhooks-shown-once-secret");
  await stored.click();

  await listDetail
    .getByRole("button", {
      name: /Delete webhook https:\/\/list-receiver\.example\.test/u,
    })
    .click();
  const deletion = page.getByRole("alertdialog", {
    name: "Delete webhook?",
  });
  const confirm = deletion.getByRole("button", {
    name: "Delete webhook",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await deletion.getByPlaceholder("DELETE").fill("DELETE");
  await expect(confirm).toBeEnabled();
  await expect(deletion).toContainText(
    "signing/destination secrets are shredded",
  );
  await saveEvidence(page, testInfo, "list-webhooks-typed-delete");
  expect(await seriousAxeViolations(page)).toEqual([]);
  expect(harness.counters.listWebhookCreate).toBe(1);
  renderer.expectClean();
});

test("Settings is a read-only webhook summary and its deep link hands control to the canonical owner", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  await openRoute({
    page,
    bootApp,
    setTheme,
    theme: "light",
    path: "/app/settings?anchor=outbound-webhooks",
    options: { outboundNextCursor: true },
  });
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  const summary = page
    .locator('[data-settings-anchor="outbound-webhooks"]')
    .filter({ hasText: "Outbound webhooks" });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("2+ subscriptions");
  await expect(summary).toContainText("Counts are lower bounds");
  await expect(summary).toContainText(
    "Delivery tests, signing-secret reveals, retries and CRUD stay in the canonical Webhooks workspace",
  );
  await expect(summary.getByRole("button")).toHaveCount(1);
  await summary.scrollIntoViewIfNeeded();
  await saveEvidence(page, testInfo, "settings-webhook-read-only-summary");
  await summary
    .getByRole("button", { name: "Manage webhooks", exact: true })
    .click();
  await expect(page).toHaveURL(/\/app\/webhooks\?tab=outbound$/u);
  await expectOutboundReady(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  renderer.expectClean();
});

test("viewer deep links to canonical Webhooks fail closed before protected reads", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await setTheme(page, "dark");
  const harness = await bootEvidenceRoute({
    page,
    bootApp,
    role: "viewer",
    path: "/app/webhooks?tab=inbound",
  });
  const gate = page.locator(".capability-gate");
  await expect(gate).toContainText("Access required");
  await expect(gate).toContainText(
    "has not loaded this destination's remote content",
  );
  await expect(
    page.getByRole("heading", { name: "Inbound webhooks", exact: true }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/webhooks\?tab=inbound$/u);
  expect(harness.counters.protectedRequests).toBe(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await saveEvidence(page, testInfo, "webhooks-viewer-deep-link-fail-closed");
});

test("viewer deep links to Simulator fail closed before catalog reads", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await setTheme(page, "light");
  const harness = await bootEvidenceRoute({
    page,
    bootApp,
    role: "viewer",
    path: "/app/webhook-simulator",
  });
  const gate = page.locator(".capability-gate");
  await expect(gate).toContainText("Access required");
  await expect(gate).toContainText(
    "has not loaded this destination's remote content",
  );
  await expect(
    page.getByRole("group", { name: "Webhook simulator controls" }),
  ).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/webhook-simulator$/u);
  expect(harness.counters.protectedRequests).toBe(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await saveEvidence(page, testInfo, "webhook-simulator-viewer-fail-closed");
});

test("viewer list Webhooks tab remains discoverable but requests no destination data", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await setTheme(page, "dark");
  const harness = await bootEvidenceRoute({
    page,
    bootApp,
    role: "viewer",
    path: "/app/lists",
  });
  await expect(page.getByRole("heading", { name: "Lists" })).toBeVisible();
  const listRow = page
    .getByText("VIP customers", { exact: true })
    .locator("..");
  await listRow.getByRole("button", { name: "Open", exact: true }).click();
  const listDetail = page.getByRole("dialog", { name: "VIP customers" });
  await listDetail.getByRole("tab", { name: "Webhooks", exact: true }).click();
  await expect(listDetail).toContainText("Admin access required");
  await expect(listDetail).toContainText("No webhook data was requested");
  expect(harness.counters.protectedRequests).toBe(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await saveEvidence(page, testInfo, "list-webhooks-viewer-fail-closed");
});

const accessibilitySurfaces = [
  {
    name: "canonical outbound",
    path: "/app/webhooks?tab=outbound",
    ready: expectOutboundReady,
  },
  {
    name: "canonical inbound",
    path: "/app/webhooks?tab=inbound",
    ready: expectInboundReady,
  },
  {
    name: "Simulator",
    path: "/app/webhook-simulator",
    ready: expectSimulatorReady,
  },
] as const;

for (const surface of accessibilitySurfaces) {
  test(`${surface.name} remains operable under reduced motion and forced colors`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.emulateMedia({
      reducedMotion: "reduce",
      forcedColors: "active",
    });
    await setTheme(page, "dark");
    await bootEvidenceRoute({
      page,
      bootApp,
      path: surface.path,
    });
    await surface.ready(page);
    expect(
      await page.evaluate(
        () =>
          matchMedia("(prefers-reduced-motion: reduce)").matches &&
          matchMedia("(forced-colors: active)").matches,
      ),
    ).toBe(true);
    await expectNoHorizontalOverflow(page);
    expect(await seriousAxeViolations(page, { forcedColors: true })).toEqual(
      [],
    );
    await saveEvidence(
      page,
      testInfo,
      `webhooks-${surface.name.toLowerCase().replaceAll(" ", "-")}-forced-colors-reduced-motion`,
    );
  });
}

test("list-scoped and Settings webhook ownership surfaces also survive compact forced-color mode", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 760, height: 720 });
  await page.emulateMedia({
    reducedMotion: "reduce",
    forcedColors: "active",
  });
  await setTheme(page, "light");
  await bootEvidenceRoute({
    page,
    bootApp,
    path: "/app/lists",
  });
  const listRow = page
    .getByText("VIP customers", { exact: true })
    .locator("..");
  await listRow.getByRole("button", { name: "Open", exact: true }).click();
  const listDetail = page.getByRole("dialog", { name: "VIP customers" });
  await listDetail.getByRole("tab", { name: "Webhooks", exact: true }).click();
  await expect(listDetail).toContainText(
    "https://list-receiver.example.test/…?…",
  );
  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page, { forcedColors: true })).toEqual([]);
  await saveEvidence(
    page,
    testInfo,
    "list-webhooks-compact-forced-colors-reduced-motion",
  );

  await page.goto("/app/settings?anchor=outbound-webhooks");
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-settings-anchor="outbound-webhooks"]'),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page, { forcedColors: true })).toEqual([]);
  await saveEvidence(
    page,
    testInfo,
    "settings-webhooks-compact-forced-colors-reduced-motion",
  );
});

test("evidence fixture ids stay canonical and do not accidentally target compatibility routes", () => {
  expect(OUTBOUND_ID).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(BLOCKED_OUTBOUND_ID).not.toBe(OUTBOUND_ID);
  expect(LIST_WEBHOOK_ID).not.toBe(OUTBOUND_ID);
});
