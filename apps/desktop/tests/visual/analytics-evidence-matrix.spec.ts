import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./fixture";
import {
  attachAnalyticsLedger,
  type AnalyticsEvidenceControl,
  expectAnalyticsViewportContained,
  expectNoAnalyticsOverflow,
  expectNoInvalidAnalyticsText,
  observeAnalyticsRenderer,
  openAnalyticsEvidence,
  saveAnalyticsEvidenceSegments,
  seriousAnalyticsAxeViolations,
  settleAnalytics,
} from "./analytics-evidence-harness";

test.describe.configure({ timeout: 180_000 });

const ANALYTICS_TABS = [
  "Overview",
  "Campaigns",
  "Audience",
  "Revenue",
  "Predictive",
  "Reports",
] as const;

type AnalyticsTabName = (typeof ANALYTICS_TABS)[number];

const TAB_HEADINGS: Record<AnalyticsTabName, string> = {
  Overview: "What changed, what matters, and where to look next",
  Campaigns: "Compare outcomes without losing the denominator",
  Audience: "See who is growing, engaging, and drifting away",
  Revenue: "Separate total conversion value from attributed value",
  Predictive: "Use projections with their coverage and confidence visible",
  Reports: "Build, run, and schedule reports from one controlled surface",
};

interface EvidenceViewport {
  height: number;
  name: string;
  tab: AnalyticsTabName;
  width: number;
}

const ROUTE_VIEWPORTS: EvidenceViewport[] = [
  { name: "desktop-1440", width: 1440, height: 900, tab: "Overview" },
  { name: "compact-720", width: 720, height: 900, tab: "Campaigns" },
  { name: "narrow-400", width: 400, height: 800, tab: "Audience" },
  { name: "minimum-360", width: 360, height: 800, tab: "Revenue" },
  { name: "zoom-200-proxy", width: 440, height: 280, tab: "Predictive" },
  { name: "zoom-400-proxy", width: 320, height: 200, tab: "Reports" },
];

const PRIMARY_CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";

function analyticsTab(page: Page, name: AnalyticsTabName): Locator {
  return page.getByRole("tab", { name, exact: true });
}

function selectedPanel(page: Page): Locator {
  return page.locator('[role="tabpanel"]:not([hidden])');
}

async function selectAnalyticsTab(
  page: Page,
  control: AnalyticsEvidenceControl,
  name: AnalyticsTabName,
): Promise<Locator> {
  const tab = analyticsTab(page, name);
  await tab.scrollIntoViewIfNeeded();
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", {
      name: TAB_HEADINGS[name],
      exact: true,
    }),
  ).toBeVisible();
  await settleAnalytics(page, control);
  const panel = selectedPanel(page);
  await expect(panel).toBeVisible();
  return panel;
}

async function expectCanonicalTabContent(
  page: Page,
  name: AnalyticsTabName,
): Promise<void> {
  if (name === "Overview") {
    await expect(page.locator('[data-kpi-metric="subscribers"]')).toContainText(
      "18,642",
    );
    await expect(
      page
        .locator(".section-title")
        .filter({ hasText: /^Campaign performance/u }),
    ).toBeVisible();
    return;
  }
  if (name === "Campaigns") {
    await expect(
      page
        .locator(".section-title")
        .filter({ hasText: /^Campaign performance/u }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Open analytics for Summer retention launch",
        exact: true,
      }),
    ).toBeVisible();
    return;
  }
  if (name === "Audience") {
    await expect(
      page.locator(".section-title").filter({ hasText: /^Subscriber growth/u }),
    ).toBeVisible();
    const deferredAudience = page.getByText(
      "Preparing audience intelligence…",
      {
        exact: true,
      },
    );
    if (await deferredAudience.isVisible()) {
      await deferredAudience.scrollIntoViewIfNeeded();
    }
    await expect(deferredAudience).toBeHidden({ timeout: 20_000 });
    await expect(
      page.getByText(/\d[\d,]* campaign-uniq/u).first(),
    ).toBeVisible();
    await page.locator(".analytics-route-header").scrollIntoViewIfNeeded();
    return;
  }
  if (name === "Revenue") {
    await expect(
      page
        .locator(".section-title")
        .filter({ hasText: /^Conversion revenue and campaign attribution/u }),
    ).toBeVisible();
    await expect(
      page.getByRole("table", { name: "Revenue by campaign" }),
    ).toContainText("Summer retention launch");
    return;
  }
  if (name === "Predictive") {
    await expect(
      page
        .locator(".section-title")
        .filter({ hasText: /^Predictive analytics/u }),
    ).toBeVisible();
    await expect(
      page.getByRole("cell", {
        name: "Subscriber …-vip-001",
        exact: true,
      }),
    ).toBeVisible();
    return;
  }
  await expect(page.getByText("Report builder", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Scheduled reports", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ask a scoped question", exact: true }),
  ).toBeVisible();
}

function expectStrictLedger(control: AnalyticsEvidenceControl): void {
  expect(control.unexpected, "Unhandled Analytics fixture requests").toEqual(
    [],
  );
}

test("canonical admin Analytics exposes six coherent, contract-backed tabs", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renderer = observeAnalyticsRenderer(page);
  const control = await openAnalyticsEvidence({
    page,
    bootApp,
    setTheme,
    scenario: "populated",
    role: "admin",
    theme: "dark",
  });

  const tablist = page.getByRole("tablist", { name: "Analytics sections" });
  await expect(tablist).toBeVisible();
  await expect(tablist.getByRole("tab")).toHaveCount(ANALYTICS_TABS.length);

  for (const name of ANALYTICS_TABS) {
    await selectAnalyticsTab(page, control, name);
    await expectCanonicalTabContent(page, name);
    await expectNoAnalyticsOverflow(page);
    await expectNoInvalidAnalyticsText(page);
    expect
      .soft(
        await seriousAnalyticsAxeViolations(page),
        `${name} has no serious or critical Axe violations`,
      )
      .toEqual([]);
    await saveAnalyticsEvidenceSegments(
      page,
      testInfo,
      `analytics-admin-${name}`,
      { maxSegments: 2 },
    );
  }

  expectStrictLedger(control);
  expect(control.errors).toEqual([]);
  expect(control.writes).toEqual([]);
  renderer.expectClean(control);
  await attachAnalyticsLedger(control, testInfo, "canonical-admin-tabs");
});

for (const viewport of ROUTE_VIEWPORTS) {
  test(`Analytics remains contained and legible at ${viewport.name}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    // Chromium has no stable installed-app zoom API. 440×280 models an
    // 880×560 surface at 200%; 320×200 models 1280×800 at 400%.
    await page.setViewportSize(viewport);
    const renderer = observeAnalyticsRenderer(page);
    const control = await openAnalyticsEvidence({
      page,
      bootApp,
      setTheme,
      scenario: "populated",
      role: "admin",
      theme: viewport.width <= 400 ? "light" : "dark",
    });
    const panel = await selectAnalyticsTab(page, control, viewport.tab);
    await expectCanonicalTabContent(page, viewport.tab);

    const tablist = page.getByRole("tablist", { name: "Analytics sections" });
    await expect(tablist).toBeVisible();
    const tablistGeometry = await tablist.evaluate((element) => ({
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
    }));
    expect(tablistGeometry.overflowX).toMatch(/auto|scroll/u);
    expect(tablistGeometry.clientWidth).toBeGreaterThan(0);
    expect(tablistGeometry.scrollWidth).toBeGreaterThanOrEqual(
      tablistGeometry.clientWidth,
    );

    await expectNoAnalyticsOverflow(page);
    await expectNoInvalidAnalyticsText(page);
    if (viewport.height >= 800) {
      await expectAnalyticsViewportContained(
        page.locator(".analytics-route-header"),
        page,
      );
    }
    await panel.scrollIntoViewIfNeeded();
    await saveAnalyticsEvidenceSegments(
      page,
      testInfo,
      `analytics-${viewport.name}-${viewport.tab}`,
      { maxSegments: 2 },
    );
    expectStrictLedger(control);
    expect(control.errors).toEqual([]);
    renderer.expectClean(control);
    await attachAnalyticsLedger(
      control,
      testInfo,
      `responsive-${viewport.name}`,
    );
  });
}

test("empty Analytics distinguishes a new workspace from unavailable data", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renderer = observeAnalyticsRenderer(page);
  const control = await openAnalyticsEvidence({
    page,
    bootApp,
    setTheme,
    scenario: "empty",
    role: "admin",
    theme: "light",
  });

  await expect(
    page.getByRole("heading", {
      name: "Your decision workspace is ready for its first send.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("Couldn't", { exact: false })).toHaveCount(0);
  await saveAnalyticsEvidenceSegments(
    page,
    testInfo,
    "analytics-empty-overview",
    { maxSegments: 2 },
  );

  await selectAnalyticsTab(page, control, "Campaigns");
  await expect(
    page.getByText("No campaigns yet", { exact: true }),
  ).toBeVisible();

  await selectAnalyticsTab(page, control, "Revenue");
  await expect(
    page.getByText(/No monetary conversion activity was recorded/u),
  ).toBeVisible();

  await selectAnalyticsTab(page, control, "Predictive");
  await expect(
    page.getByText(/Predictive scores appear after a recompute runs/u),
  ).toBeVisible();

  await selectAnalyticsTab(page, control, "Reports");
  await page
    .getByRole("button", { name: "Scheduled reports", exact: true })
    .click();
  await expect(
    page.getByText("Turn a verified report into a dependable cadence", {
      exact: true,
    }),
  ).toBeVisible();
  await saveAnalyticsEvidenceSegments(
    page,
    testInfo,
    "analytics-empty-reports",
    { maxSegments: 2 },
  );

  await expectNoAnalyticsOverflow(page);
  await expectNoInvalidAnalyticsText(page);
  expectStrictLedger(control);
  expect(control.errors).toEqual([]);
  expect(control.writes).toEqual([]);
  renderer.expectClean(control);
  await attachAnalyticsLedger(control, testInfo, "empty-state");
});

test("partial Analytics retains verified sections and identifies each unavailable source", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 720, height: 900 });
  const renderer = observeAnalyticsRenderer(page);
  const control = await openAnalyticsEvidence({
    page,
    bootApp,
    setTheme,
    scenario: "partial",
    role: "admin",
    theme: "dark",
  });

  const issueStack = page.getByLabel("Analytics data issues");
  await expect(issueStack).toContainText("Top responders");
  await expect(page.locator('[data-kpi-metric="subscribers"]')).toContainText(
    "18,642",
  );

  await selectAnalyticsTab(page, control, "Revenue");
  await expect(
    page.getByRole("alert").filter({
      hasText: "Couldn't load the revenue timeseries",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Revenue by campaign" }),
  ).toContainText("Summer retention launch");
  await saveAnalyticsEvidenceSegments(
    page,
    testInfo,
    "analytics-partial-revenue",
    { maxSegments: 2 },
  );

  await selectAnalyticsTab(page, control, "Predictive");
  await expect(
    page.getByRole("cell", {
      name: "Subscriber …-vip-001",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(/predictive catalog could not be verified/u),
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Couldn't load fatigue analysis",
    }),
  ).toBeVisible();
  await saveAnalyticsEvidenceSegments(
    page,
    testInfo,
    "analytics-partial-predictive",
    { maxSegments: 2 },
  );

  await expectNoAnalyticsOverflow(page);
  await expectNoInvalidAnalyticsText(page);
  expectStrictLedger(control);
  expect(control.errors.length).toBeGreaterThan(0);
  expect(control.errors.every((error) => error.status === 503)).toBe(true);
  expect(control.writes).toEqual([]);
  renderer.expectClean(control);
  await attachAnalyticsLedger(control, testInfo, "partial-state");
});

test("viewer navigation performs no state-changing requests and exposes no fixture PII", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renderer = observeAnalyticsRenderer(page);
  const control = await openAnalyticsEvidence({
    page,
    bootApp,
    setTheme,
    scenario: "populated",
    role: "viewer",
    theme: "dark",
  });

  for (const name of ANALYTICS_TABS) {
    await selectAnalyticsTab(page, control, name);
  }

  await selectAnalyticsTab(page, control, "Predictive");
  await expect(
    page.getByRole("alert").filter({
      hasText: "Couldn't verify predictive data",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Recompute", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText("ada.analytics@example.invalid")).toHaveCount(0);
  await expect(page.getByText("grace.risk@example.invalid")).toHaveCount(0);

  await selectAnalyticsTab(page, control, "Reports");
  await page
    .getByRole("button", { name: "Scheduled reports", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "New report", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Admin-only delivery settings")).toBeVisible();
  await saveAnalyticsEvidenceSegments(
    page,
    testInfo,
    "analytics-viewer-reports",
    { maxSegments: 2 },
  );

  await selectAnalyticsTab(page, control, "Audience");
  await expect(page.getByText("one@gmail.com", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("complaint@yahoo.com", { exact: true }),
  ).toHaveCount(0);

  expect(control.writes, "Viewer Analytics emitted a write").toEqual([]);
  expectStrictLedger(control);
  expect(control.errors.every((error) => error.status === 403)).toBe(true);
  await expectNoAnalyticsOverflow(page);
  await expectNoInvalidAnalyticsText(page);
  renderer.expectClean(control);
  await attachAnalyticsLedger(control, testInfo, "canonical-viewer");
});

test("mixed-currency revenue is disclosed and never presented as one converted total", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renderer = observeAnalyticsRenderer(page);
  const control = await openAnalyticsEvidence({
    page,
    bootApp,
    setTheme,
    scenario: "mixed-currency",
    role: "admin",
    theme: "light",
  });
  await selectAnalyticsTab(page, control, "Revenue");

  await expect(page.getByText(/2 currencies were recorded/u)).toBeVisible();
  await expect(page.getByText(/USD .+133 conv\./u)).toBeVisible();
  await expect(page.getByText(/EUR .+19 conv\./u)).toBeVisible();
  await expect(
    page.getByText(/Amounts are not converted or summed across currencies\./u),
  ).toBeVisible();
  await expect(
    page
      .locator(".muted")
      .filter({ hasText: /^Workspace conversion revenue \(net\)/u })
      .first(),
  ).toBeVisible();

  await expectNoInvalidAnalyticsText(page);
  await expectNoAnalyticsOverflow(page);
  expectStrictLedger(control);
  expect(control.errors).toEqual([]);
  renderer.expectClean(control);
  await saveAnalyticsEvidenceSegments(
    page,
    testInfo,
    "analytics-mixed-currency-revenue",
    { maxSegments: 3 },
  );
  await attachAnalyticsLedger(control, testInfo, "mixed-currency");
});

test("scheduled reports expose timezone-aware durable receipts without leaking recipients or queuing work", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renderer = observeAnalyticsRenderer(page);
  const control = await openAnalyticsEvidence({
    page,
    bootApp,
    setTheme,
    scenario: "populated",
    role: "admin",
    theme: "dark",
  });

  await selectAnalyticsTab(page, control, "Reports");
  await page
    .getByRole("button", { name: "Scheduled reports", exact: true })
    .click();
  await settleAnalytics(page, control);

  await expect(
    page.getByText("2 definitions · 2 active · 1 need review", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Delivery evidence, not an inbox claim", { exact: true }),
  ).toBeVisible();

  const acceptedCard = page.getByRole("article", {
    name: "Monday growth pulse",
    exact: true,
  });
  await expect(acceptedCard).toContainText("Weekly on Monday at 09:00");
  await expect(acceptedCard).toContainText("Asia/Kolkata");
  await expect(acceptedCard).toContainText("Latest durable run");
  await expect(acceptedCard).toContainText("Accepted");
  await expect(
    acceptedCard.locator(
      'dl[aria-label="Latest run outcomes for Monday growth pulse"]',
    ),
  ).toContainText("Provider accepted");

  const reviewCard = page.getByRole("article", {
    name: "Month-end deliverability review",
    exact: true,
  });
  await reviewCard.scrollIntoViewIfNeeded();
  await expect(reviewCard).toContainText("Monthly on day 28 at 16:30");
  await expect(reviewCard).toContainText("America/New_York");
  await expect(reviewCard).toContainText("Needs review");
  const reviewOutcomes = reviewCard.locator(
    'dl[aria-label="Latest run outcomes for Month-end deliverability review"]',
  );
  await expect(reviewOutcomes).toContainText("Provider accepted");
  await expect(reviewOutcomes).toContainText("Unknown");
  await expect(reviewOutcomes).toContainText("2");
  await expect(reviewCard).toContainText(
    "During fall-back, the first occurrence is used",
  );

  const recipientAddresses = [
    "analytics-owner@example.invalid",
    "deliverability-owner@example.invalid",
    "security-reviewer@example.invalid",
    "operations-lead@example.invalid",
  ];
  for (const recipient of recipientAddresses) {
    await expect(page.getByText(recipient, { exact: true })).toHaveCount(0);
  }
  expect(
    await page
      .locator("input, textarea")
      .evaluateAll(
        (elements, recipients) =>
          elements
            .map((element) => (element as HTMLInputElement).value)
            .filter((value) => recipients.includes(value)),
        recipientAddresses,
      ),
    "Collapsed report cards must not expose recipient addresses in form controls",
  ).toEqual([]);

  expect
    .soft(
      await seriousAnalyticsAxeViolations(page),
      "Expanded scheduled reports have no serious or critical Axe violations",
    )
    .toEqual([]);
  await saveAnalyticsEvidenceSegments(
    page,
    testInfo,
    "analytics-scheduled-durable-receipts",
    { maxSegments: 3 },
  );

  const writesBeforeReviews = control.writes.length;
  const sendReviewTrigger = reviewCard.getByRole("button", {
    name: "Review a one-off run of Month-end deliverability review",
    exact: true,
  });
  await sendReviewTrigger.click();
  const sendReview = page.getByRole("dialog", {
    name: "Queue one run of “Month-end deliverability review”?",
    exact: true,
  });
  await expect(sendReview).toContainText("All 3 configured recipients");
  await expect(sendReview).toContainText(
    "Monthly on day 28 at 16:30 · America/New_York",
  );
  await expect(sendReview).toContainText(
    "The latest run has unknown provider outcomes.",
  );
  await expect(
    sendReview.getByRole("button", {
      name: "Queue another run",
      exact: true,
    }),
  ).toBeVisible();
  expect(control.writes).toHaveLength(writesBeforeReviews);
  await sendReview.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(sendReview).toBeHidden();
  await expect(sendReviewTrigger).toBeFocused();

  const editTrigger = acceptedCard.getByRole("button", {
    name: "Edit",
    exact: true,
  });
  await editTrigger.click();
  const editor = page.getByRole("dialog", {
    name: "Edit Monday growth pulse",
    exact: true,
  });
  await expect(editor.getByLabel(/^Timezone/u)).toHaveValue("Asia/Kolkata");
  await expect(editor.getByLabel(/^Recipients/u)).toHaveValue(
    "analytics-owner@example.invalid",
  );
  await expect(
    editor.getByText(
      "Asia/Kolkata wall-clock time. During fall-back, the first occurrence is used; during spring-forward, a missing time moves to the first valid minute.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(editor.getByLabel(/^Template/u)).toBeDisabled();
  expect(control.writes).toHaveLength(writesBeforeReviews);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toBeHidden();

  expect(
    control.ledger.filter(
      (entry) =>
        entry.method === "GET" && entry.path === "/api/v1/scheduled-reports",
    ),
  ).toHaveLength(1);
  expect(
    control.ledger.filter((entry) =>
      entry.path.includes("/scheduled-reports/"),
    ),
    "Review-only interactions must not queue, edit, or delete a report",
  ).toEqual([]);
  expectStrictLedger(control);
  expect(control.errors).toEqual([]);
  expect(control.writes).toEqual([]);
  await expectNoAnalyticsOverflow(page);
  await expectNoInvalidAnalyticsText(page);
  renderer.expectClean(control);
  await attachAnalyticsLedger(control, testInfo, "scheduled-report-receipts");
});

test("fixed-query AI discloses the external question boundary and renders the local-summary contract", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  const renderer = observeAnalyticsRenderer(page);
  const control = await openAnalyticsEvidence({
    page,
    bootApp,
    setTheme,
    scenario: "populated",
    role: "admin",
    theme: "light",
  });
  await selectAnalyticsTab(page, control, "Reports");

  const input = page.getByRole("textbox", {
    name: "Natural-language analytics query",
    exact: true,
  });
  const privacyNote = page.getByRole("note").filter({
    hasText: "Your question text is sent to Anthropic",
  });
  await expect(privacyNote).toContainText("Result rows stay inside Moosewave");
  await expect(privacyNote).toContainText(
    "Do not include personal, secret, or client confidential data",
  );
  const privacyNoteId = await privacyNote.getAttribute("id");
  expect(privacyNoteId).toBeTruthy();
  await expect(input).toHaveAttribute("aria-describedby", privacyNoteId!);

  const question = "Which campaign had the strongest click rate?";
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/analytics/nlq",
  );
  await input.fill(question);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const response = await responsePromise;
  const responseBody = (await response.json()) as {
    summary_text: string;
    trace: { summary_tokens: number };
  };
  expect(responseBody.trace.summary_tokens).toBe(0);
  expect(responseBody.summary_text).toBe(
    "Returned 1 result row(s) for the last 30 days.",
  );
  await settleAnalytics(page, control);

  const answer = page.getByTestId("analytics-nlq-answer");
  await expect(answer).toContainText(
    "Returned 1 result row(s) for the last 30 days.",
  );
  await expect(
    page.getByRole("region", {
      name: "Natural-language analytics result table",
      exact: true,
    }),
  ).toContainText("Summer retention launch");
  await expect(answer).toContainText(
    "Interpreted as: campaign_performance · last 30 days · limit 10",
  );
  await expect(answer).toContainText(
    "Query-selection rationale: Used the verified campaign performance template.",
  );
  expect(
    control.ledger.filter(
      (entry) =>
        entry.method === "POST" && entry.path === "/api/v1/analytics/nlq",
    ),
  ).toEqual([
    expect.objectContaining({
      classification: "control",
      requestBody: { question: "<redacted>" },
      status: 200,
    }),
  ]);
  expect(control.writes).toEqual([]);
  expectStrictLedger(control);
  expect(control.errors).toEqual([]);
  await expectNoAnalyticsOverflow(page);
  await expectNoInvalidAnalyticsText(page);
  expect
    .soft(
      await seriousAnalyticsAxeViolations(page),
      "Fixed-query answer has no serious or critical Axe violations",
    )
    .toEqual([]);
  renderer.expectClean(control);
  await saveAnalyticsEvidenceSegments(page, testInfo, "analytics-fixed-query", {
    maxSegments: 2,
  });
  await attachAnalyticsLedger(control, testInfo, "fixed-query-ai");
});

test("producer-shaped predictive and benchmark contracts render real evidence", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renderer = observeAnalyticsRenderer(page);
  const control = await openAnalyticsEvidence({
    page,
    bootApp,
    setTheme,
    scenario: "populated",
    role: "admin",
    theme: "dark",
  });

  await selectAnalyticsTab(page, control, "Predictive");
  await expect(
    page.getByRole("cell", {
      name: "Subscriber …-vip-001",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", {
      name: "Subscriber …risk-002",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Estimate", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(/low sample.+interpret with caution/u),
  ).toBeVisible();
  await expect(page.getByText("ada.analytics@example.invalid")).toHaveCount(0);

  await selectAnalyticsTab(page, control, "Campaigns");
  const trigger = page.getByRole("button", {
    name: "Open analytics for Summer retention launch",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Summer retention launch",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Benchmark vs your 90-day baseline");
  await expect(dialog).toContainText("12 comparison campaigns");
  await expect(dialog).toContainText("open rate");
  await expect(dialog).toContainText("above");

  const predictiveRequest = control.ledger.find(
    (entry) =>
      entry.method === "GET" && entry.path === "/api/v1/predictive/profiles",
  );
  expect(predictiveRequest?.status).toBe(200);
  const benchmarkRequests = control.ledger.filter(
    (entry) => entry.method === "GET" && entry.path.endsWith("/benchmark"),
  );
  expect(benchmarkRequests.length).toBeGreaterThan(0);
  expect(benchmarkRequests.every((entry) => entry.status === 200)).toBe(true);

  await saveAnalyticsEvidenceSegments(
    page,
    testInfo,
    "analytics-producer-contracts",
    { maxSegments: 2 },
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  expectStrictLedger(control);
  expect(control.errors).toEqual([]);
  renderer.expectClean(control);
  await attachAnalyticsLedger(control, testInfo, "producer-contracts");
});

test("campaign analytics demand-loads each semantic section and reviews personal-data export without downloading", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renderer = observeAnalyticsRenderer(page);
  const control = await openAnalyticsEvidence({
    page,
    bootApp,
    setTheme,
    scenario: "populated",
    role: "admin",
    theme: "dark",
  });
  await selectAnalyticsTab(page, control, "Campaigns");

  const campaignPathPrefix = `/api/v1/campaigns/${PRIMARY_CAMPAIGN_ID}/`;
  const campaignRequests = () =>
    control.ledger.filter(
      (entry) =>
        entry.method === "GET" && entry.path.startsWith(campaignPathPrefix),
    );
  const campaignRequestCount = (endpoint: string): number =>
    campaignRequests().filter(
      (entry) => entry.path === `${campaignPathPrefix}${endpoint}`,
    ).length;
  const knownEndpoints = [
    "anomalies",
    "benchmark",
    "bounces",
    "devices",
    "engagement",
    "geography",
    "goal-results",
    "link-report",
    "locale-report",
    "report",
    "timeseries",
  ] as const;
  const beforeDrawer = Object.fromEntries(
    knownEndpoints.map((endpoint) => [
      endpoint,
      campaignRequestCount(endpoint),
    ]),
  ) as Record<(typeof knownEndpoints)[number], number>;

  const trigger = page.getByRole("button", {
    name: "Open analytics for Summer retention launch",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: "Summer retention launch",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await settleAnalytics(page, control);

  const overviewEndpoints = [
    "anomalies",
    "benchmark",
    "engagement",
    "goal-results",
    "report",
    "timeseries",
  ];
  for (const endpoint of overviewEndpoints) {
    expect(
      campaignRequestCount(endpoint),
      `${endpoint} loads exactly once when Overview opens`,
    ).toBe(beforeDrawer[endpoint as keyof typeof beforeDrawer] + 1);
  }
  await expect(dialog.getByRole("tab", { name: /^Overview/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(dialog).toContainText("All 6 sources are loaded");
  await expect(dialog).toContainText("Benchmark vs your 90-day baseline");

  for (const endpoint of [
    "link-report",
    "geography",
    "devices",
    "locale-report",
    "bounces",
  ]) {
    expect(
      campaignRequestCount(endpoint),
      `${endpoint} remains on demand before its tab opens`,
    ).toBe(beforeDrawer[endpoint as keyof typeof beforeDrawer]);
  }

  const audienceTab = dialog.getByRole("tab", {
    name: /^Audience & links/u,
  });
  await audienceTab.click();
  await expect(audienceTab).toHaveAttribute("aria-selected", "true");
  await settleAnalytics(page, control);
  await expect(dialog).toContainText("All 5 sources are loaded");
  await expect(dialog).toContainText(
    "No recipient identities are loaded into this view.",
  );
  await expect(dialog).toContainText("Top links");
  for (const endpoint of [
    "link-report",
    "geography",
    "devices",
    "locale-report",
  ]) {
    expect(campaignRequestCount(endpoint)).toBe(
      beforeDrawer[endpoint as keyof typeof beforeDrawer] + 1,
    );
  }
  expect(campaignRequestCount("report")).toBe(beforeDrawer.report + 1);
  expect(campaignRequestCount("bounces")).toBe(beforeDrawer.bounces);

  const deliveryTab = dialog.getByRole("tab", { name: /^Delivery/u });
  await deliveryTab.click();
  await expect(deliveryTab).toHaveAttribute("aria-selected", "true");
  await settleAnalytics(page, control);
  await expect(dialog).toContainText("All 2 sources are loaded");
  await expect(dialog).toContainText("Bounce mix");
  await expect(dialog).toContainText("Recipient-level evidence");
  expect(campaignRequestCount("bounces")).toBe(beforeDrawer.bounces + 1);
  expect(campaignRequestCount("report")).toBe(beforeDrawer.report + 1);

  const exportTrigger = dialog.getByRole("button", {
    name: "Review recipient export",
    exact: true,
  });
  const streamTokenRequestsBeforeReview = control.ledger.filter(
    (entry) =>
      entry.method === "POST" && entry.path === "/api/v1/streams/token",
  ).length;
  await exportTrigger.click();
  const exportReview = page.getByRole("dialog", {
    name: "Export recipient-level campaign evidence?",
    exact: true,
  });
  await expect(exportReview).toContainText("Restricted personal data");
  await expect(exportReview).toContainText(
    "Subscriber email; sent, delivered, opened, first-click, bounced, complained, and unsubscribed timestamps; click count",
  );
  await expect(exportReview).toContainText(
    "The server rechecks campaign, report, and subscriber-read permission at download time.",
  );
  await expect(
    exportReview.getByRole("button", {
      name: "Download up to 50,000 rows",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    control.ledger.filter((entry) => entry.path.endsWith("/report.csv")),
    "Opening export review must not fetch personal data",
  ).toEqual([]);
  expect(
    control.ledger.filter(
      (entry) =>
        entry.method === "POST" && entry.path === "/api/v1/streams/token",
    ),
    "Opening export review must not mint a download credential",
  ).toHaveLength(streamTokenRequestsBeforeReview);
  expect(control.writes).toEqual([]);
  expect
    .soft(
      await seriousAnalyticsAxeViolations(page),
      "Campaign export review has no serious or critical Axe violations",
    )
    .toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("analytics-campaign-export-review.png"),
    fullPage: false,
  });
  await exportReview
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(exportReview).toBeHidden();
  await expect(exportTrigger).toBeFocused();

  await dialog.getByRole("tab", { name: /^Overview/u }).click();
  await settleAnalytics(page, control);
  for (const endpoint of [
    ...overviewEndpoints,
    "link-report",
    "geography",
    "devices",
    "locale-report",
    "bounces",
  ]) {
    expect(
      campaignRequestCount(endpoint),
      `${endpoint} is single-flight and cached within the open campaign`,
    ).toBe(beforeDrawer[endpoint as keyof typeof beforeDrawer] + 1);
  }

  expectStrictLedger(control);
  expect(control.errors).toEqual([]);
  expect(control.writes).toEqual([]);
  renderer.expectClean(control);
  await attachAnalyticsLedger(
    control,
    testInfo,
    "campaign-demand-loaded-sections",
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(trigger).toBeFocused();
  await expectNoAnalyticsOverflow(page);
  await expectNoInvalidAnalyticsText(page);
});

test("keyboard tabs, toolbar popover, and campaign slideover restore focus", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const renderer = observeAnalyticsRenderer(page);
  const control = await openAnalyticsEvidence({
    page,
    bootApp,
    setTheme,
    scenario: "populated",
    role: "admin",
    theme: "dark",
  });

  const overview = analyticsTab(page, "Overview");
  const campaigns = analyticsTab(page, "Campaigns");
  await overview.focus();
  await page.keyboard.press("ArrowRight");
  await expect(campaigns).toBeFocused();
  await expect(overview).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(campaigns).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", {
      name: TAB_HEADINGS.Campaigns,
      exact: true,
    }),
  ).toBeVisible();

  await overview.click();
  const groupBy = page.getByRole("button", { name: /^Group by/u });
  await groupBy.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole("menuitemradio", { name: /^None/u }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitemradio", { name: /^Campaign/u }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Group by · Campaign", exact: true }),
  ).toBeFocused();
  await expect
    .poll(() =>
      control.ledger.some(
        (entry) =>
          entry.path === "/api/v1/analytics/timeseries" &&
          entry.query.includes("group_by=campaign"),
      ),
    )
    .toBe(true);

  const groupedTrigger = page.getByRole("button", {
    name: "Group by · Campaign",
    exact: true,
  });
  await groupedTrigger.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(groupedTrigger).toBeFocused();

  await campaigns.click();
  const slideoverTrigger = page.getByRole("button", {
    name: "Open analytics for Summer retention launch",
    exact: true,
  });
  await slideoverTrigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Summer retention launch",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await page.keyboard.press("Tab");
  await expect
    .poll(() =>
      dialog.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await saveAnalyticsEvidenceSegments(
    page,
    testInfo,
    "analytics-keyboard-slideover",
    { maxSegments: 2 },
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(slideoverTrigger).toBeFocused();

  expectStrictLedger(control);
  expect(control.errors).toEqual([]);
  renderer.expectClean(control);
  await attachAnalyticsLedger(control, testInfo, "keyboard-focus");
});

test("forced colours and reduced motion preserve every Analytics tab", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.emulateMedia({
    forcedColors: "active",
    reducedMotion: "reduce",
  });
  const renderer = observeAnalyticsRenderer(page);
  const control = await openAnalyticsEvidence({
    page,
    bootApp,
    setTheme,
    scenario: "populated",
    role: "admin",
    theme: "dark",
  });

  for (const name of ANALYTICS_TABS) {
    const panel = await selectAnalyticsTab(page, control, name);
    await expectCanonicalTabContent(page, name);
    const media = await panel.evaluate((element) => ({
      forced: matchMedia("(forced-colors: active)").matches,
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
      transitionDuration: getComputedStyle(element).transitionDuration,
    }));
    expect(media.forced).toBe(true);
    expect(media.reduced).toBe(true);
    expect(media.transitionDuration).toMatch(
      /^(?:0(?:s|ms)|0\.00001s|1e-05s)(?:,\s*(?:0(?:s|ms)|0\.00001s|1e-05s))*$/u,
    );
    expect
      .soft(
        await seriousAnalyticsAxeViolations(page, { forcedColors: true }),
        `${name} has no serious or critical Axe violations in forced colours`,
      )
      .toEqual([]);
  }

  await expectNoAnalyticsOverflow(page);
  await expectNoInvalidAnalyticsText(page);
  expectStrictLedger(control);
  expect(control.errors).toEqual([]);
  renderer.expectClean(control);
  await saveAnalyticsEvidenceSegments(
    page,
    testInfo,
    "analytics-forced-colors-reduced-motion",
    { maxSegments: 2 },
  );
  await attachAnalyticsLedger(
    control,
    testInfo,
    "forced-colors-reduced-motion",
  );
});
