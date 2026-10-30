import type { Locator, Page } from "@playwright/test";

import {
  AI_CHANGELOG_FIXTURE_IDS,
  AI_CHANGELOG_FIXED_TIME,
  APPROVED_LONG_EVIDENCE,
  COMPLETED_PASS_RESULTS,
  COMPLETED_PASS_RUN,
  LIFECYCLE_RUNS,
  MIXED_ADVISORY_RUN,
  REPLAYED_LONG_EVIDENCE,
  aiRegressionSettingsSection,
  auditAIChangelogA11y,
  captureAIChangelogEvidence,
  expectAIChangelogReducedMotion,
  expectAIChangelogSafety,
  expectNoAIChangelogOverflow,
  openAgentTrustVoiceEvidence,
  openAIChangelog,
  openAIRegressionSettings,
  scrollTargetIntoFrame,
  type AIChangelogHarness,
  type RegressionRunFixture,
} from "./ai-changelog-evidence-harness";
import { expect, test } from "../visual/fixture";

test.describe.configure({ timeout: 300_000 });

const RUNS_PATH = "/api/v1/ai-regression/runs";

function runArticle(page: Page, modelTag: string): Locator {
  return page.getByTestId("model-changelog-run").filter({ hasText: modelTag });
}

function parseRequestBody(body: string | null): Record<string, unknown> {
  expect(body).not.toBeNull();
  return JSON.parse(body ?? "{}") as Record<string, unknown>;
}

async function waitForRunState(
  page: Page,
  modelTag: string,
  state: string,
): Promise<Locator> {
  const article = runArticle(page, modelTag);
  await expect(article).toHaveAttribute("data-evidence-state", state);
  return article;
}

async function resetContentScroll(page: Page): Promise<void> {
  await page.locator(".content").evaluate((element) => {
    element.scrollTo({ top: 0, left: 0, behavior: "instant" });
  });
}

async function openRunEvidence(article: Locator): Promise<void> {
  const toggle = article.locator(".ai-evidence-run__toggle");
  await expect(toggle).toHaveAccessibleName("Review evidence");
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const controlledId = await toggle.getAttribute("aria-controls");
  expect(controlledId).toBeTruthy();
  await expect(article.locator(`#${controlledId ?? "missing"}`)).toBeVisible();
}

async function expectHarnessSafe(
  page: Page,
  harness: AIChangelogHarness,
  selector = ".ai-evidence-workspace",
  options: { includeShellOverflow?: boolean } = {},
): Promise<void> {
  await expectNoAIChangelogOverflow(page, selector, {
    includeShell: options.includeShellOverflow,
  });
  await expectAIChangelogSafety(page, harness);
}

test("initial evidence states distinguish loading, empty, unavailable, and retry recovery", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openAIChangelog(page, bootApp, setTheme, {
    initialModes: { [RUNS_PATH]: "deferred" },
  });
  await expect(page.getByLabel("Loading AI regression evidence")).toBeVisible();
  expect(await auditAIChangelogA11y(page, harness, "initial-loading")).toEqual(
    [],
  );
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-changelog-initial-loading-dark",
    harness,
  );

  harness.setEndpointPayload(RUNS_PATH, { items: [] });
  harness.releaseEndpoint(RUNS_PATH);
  await expect(
    page.getByText("No regression runs yet", { exact: true }),
  ).toBeVisible();
  expect(await auditAIChangelogA11y(page, harness, "initial-empty")).toEqual(
    [],
  );
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-changelog-empty-dark",
    harness,
  );

  harness.setEndpointMode(RUNS_PATH, "error");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "AI Changelog", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("AI regression evidence unavailable", { exact: true }),
  ).toBeVisible();
  expect(await auditAIChangelogA11y(page, harness, "initial-error")).toEqual(
    [],
  );
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-changelog-initial-error-dark",
    harness,
  );

  harness.setEndpointMode(RUNS_PATH, "success");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByText("No regression runs yet", { exact: true }),
  ).toBeVisible();
  expect(
    await auditAIChangelogA11y(page, harness, "empty-after-retry"),
  ).toEqual([]);
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-changelog-empty-recovered-dark",
    harness,
  );
  await expectHarnessSafe(page, harness);
});

test("populated evidence exposes every durable lifecycle and recorded policy outcome without claiming deployment authority", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openAIChangelog(page, bootApp, setTheme);
  const rows = page.getByTestId("model-changelog-run");
  await expect(rows).toHaveCount(11);
  for (const [state, count] of [
    ["queued", 2],
    ["running", 1],
    ["stale", 1],
    ["failed", 1],
    ["completed", 4],
    ["incomplete", 1],
    ["unscored", 1],
  ] as const) {
    await expect(
      page.locator(
        `[data-testid="model-changelog-run"][data-evidence-state="${state}"]`,
      ),
    ).toHaveCount(count);
  }

  await expect(page.getByText("Recorded pass", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Recorded advisory", { exact: true }),
  ).toHaveCount(3);
  await expect(
    page.getByText("Recorded concern", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/queued for retry no earlier than/u),
  ).toBeVisible();
  await expect(
    page.getByText(/server-recorded worker lease expired/u),
  ).toBeVisible();
  await expect(
    page.getByText("Recorded evidence, not release control", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/do not prove that an upgrade was allowed/u),
  ).toBeVisible();

  const pending = runArticle(page, "candidate-pending@2026-08-09");
  await expect(pending.locator(".ai-evidence-run__title-row")).toContainText(
    "Operator correlation label:",
  );
  await expect(pending.locator(".ai-evidence-run__tags")).toContainText(
    "Server-attested provider:",
  );
  await expect(pending.locator(".ai-evidence-run__tags")).toContainText(
    "Server-attested model ID:",
  );
  await expect(pending.locator(".ai-evidence-run__tags")).toContainText(
    "Server-attested prompt policy:",
  );

  const incomplete = runArticle(page, "candidate-incomplete@2026-08-09");
  await expect(incomplete).toContainText(
    "1 unprocessed with no result receipt",
  );
  await expect(incomplete).not.toContainText("1 remaining pending");
  await expect(
    incomplete.getByText(/Recorded (?:pass|advisory|concern)/u),
  ).toHaveCount(0);
  const failed = runArticle(page, "candidate-failed@2026-08-09");
  await expect(failed).toContainText(
    "Unprocessed snapshots are not error receipts.",
  );

  const running = runArticle(page, "candidate-running@2026-08-09");
  await openRunEvidence(running);
  await expect(running).toContainText("Heartbeat");
  await expect(running).toContainText("Lease expires");
  await expect(running).toContainText("1 / 3");
  await expect(running).toContainText(
    "4 processed (4 scored + 0 persisted errors), 6 remaining pending",
  );
  await expect(running).toContainText(
    "Per-example results are not requested while this run remains in-flight.",
  );
  expect(
    await auditAIChangelogA11y(page, harness, "populated-lifecycle-matrix"),
  ).toEqual([]);
  await resetContentScroll(page);
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-changelog-lifecycle-matrix-desktop-dark",
    harness,
  );
  await expectHarnessSafe(page, harness);
});

test("expanded mixed evidence preserves frozen provenance and a safe keyboard-operable approved-versus-replayed comparison", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openAIChangelog(page, bootApp, setTheme, {
    height: 1_080,
    runs: [COMPLETED_PASS_RUN, MIXED_ADVISORY_RUN],
    theme: "light",
    width: 1_920,
  });
  const article = runArticle(page, COMPLETED_PASS_RUN.model_version_tag);
  await openRunEvidence(article);
  await expect(
    article.getByRole("table", { name: "Per-example regression results" }),
  ).toBeVisible();
  await expect(
    article.getByRole("columnheader", { name: "Receipt recorded" }),
  ).toBeVisible();
  await expect(article).toContainText("2 / 2");
  await expect(article).toContainText(/0\s*persisted errors · server receipt/u);
  await expect(article.locator(".ai-evidence-surface")).toHaveCount(2);
  await expect(
    article.locator('.ai-evidence-surface[data-coherent="true"]'),
  ).toHaveCount(2);
  await expect(article.getByText("0/100", { exact: true })).toHaveCount(0);

  const campaignRow = article
    .getByRole("row")
    .filter({ hasText: "Campaign draft" });
  const comparisonSummary = campaignRow
    .locator("summary")
    .filter({ hasText: /approved|compare|output/iu })
    .last();
  await expect(comparisonSummary).toBeVisible();
  await comparisonSummary.focus();
  await expect(comparisonSummary).toBeFocused();
  await comparisonSummary.press("Enter");
  await expect(campaignRow).toContainText(APPROVED_LONG_EVIDENCE.slice(0, 54));
  await expect(campaignRow).toContainText(REPLAYED_LONG_EVIDENCE.slice(0, 54));
  const evidencePanes = campaignRow.locator(".ai-evidence-comparison pre");
  await expect(evidencePanes).toHaveCount(2);
  for (const pane of await evidencePanes.all()) {
    await pane.focus();
    await expect(pane).toBeFocused();
  }

  const provenanceSummary = campaignRow.locator("summary").filter({
    hasText: /snapshot ordinal|snapshot provenance/iu,
  });
  await provenanceSummary.focus();
  await provenanceSummary.press("Enter");
  await expect(campaignRow).toContainText(
    AI_CHANGELOG_FIXTURE_IDS.approvalCampaign,
  );
  await expect(campaignRow).toContainText("approved-model-2026-07");
  await expect(campaignRow).toContainText(
    AI_CHANGELOG_FIXTURE_IDS.agentCampaign,
  );
  await expect(campaignRow).toContainText(
    "does not describe the current mutable golden reference",
  );

  const scoreSummary = campaignRow.locator("summary").filter({
    hasText: "Explain score",
  });
  await scoreSummary.press("Enter");
  await expect(campaignRow).toContainText("Embedding similarity");
  await expect(campaignRow).toContainText("Stylistic match");
  await expect(campaignRow).toContainText("Vocabulary overlap");
  await expect(campaignRow).toContainText("Structural match");
  await expect(campaignRow).toContainText("Combined");

  const mixedArticle = runArticle(page, MIXED_ADVISORY_RUN.model_version_tag);
  await openRunEvidence(mixedArticle);
  await expect(mixedArticle).toContainText("1 / 2");
  await expect(mixedArticle).toContainText(
    /1\s*persisted errors · server receipt/u,
  );
  await expect(
    mixedArticle.locator('.ai-evidence-surface[data-coherent="true"]'),
  ).toHaveCount(2);
  await expect(mixedArticle).toContainText(
    "persisted error receipts. It is insufficient, non-authoritative evidence.",
  );
  const errorRow = mixedArticle
    .getByRole("row")
    .filter({ hasText: "Sequence draft" });
  const errorComparison = errorRow.locator("summary").filter({
    hasText: /approved|compare|output/iu,
  });
  await errorComparison.press("Enter");
  await expect(errorRow).toContainText("generation_timeout");
  await expect(errorRow).toContainText(
    "The replay did not return a bounded output in time.",
  );
  await expect(errorRow).toContainText(
    "Step one: name the outcome. Step two: offer one next step.",
  );
  await expect(errorRow.getByText("0/100", { exact: true })).toHaveCount(0);

  await expect(page.locator('[data-proof="approved-literal"]')).toHaveCount(0);
  await expect(page.locator('[data-proof="replayed-literal"]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __aiRegressionMarkupExecuted?: boolean })
          .__aiRegressionMarkupExecuted,
    ),
  ).toBeUndefined();
  expect(
    Object.keys(COMPLETED_PASS_RESULTS[0]?.breakdown ?? {}).sort(),
  ).toEqual([
    "combined",
    "embedding_similarity",
    "structural_match",
    "stylistic_distance",
    "vocabulary_overlap",
  ]);

  await scrollTargetIntoFrame(page, campaignRow, 110);
  expect(
    await auditAIChangelogA11y(page, harness, "expanded-comparison"),
  ).toEqual([]);
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-changelog-expanded-approved-versus-replayed-light",
    harness,
  );
  await expectHarnessSafe(page, harness);
});

test("refresh failure retains the last complete snapshot and recovers without erasing evidence", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openAIChangelog(page, bootApp, setTheme, {
    runs: [COMPLETED_PASS_RUN],
  });
  await expect(
    runArticle(page, COMPLETED_PASS_RUN.model_version_tag),
  ).toBeVisible();
  harness.setEndpointMode(RUNS_PATH, "error");
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await expect(
    page.getByText("Refresh failed; retained snapshot shown", { exact: true }),
  ).toBeVisible();
  await expect(
    runArticle(page, COMPLETED_PASS_RUN.model_version_tag),
  ).toBeVisible();
  expect(
    await auditAIChangelogA11y(page, harness, "retained-refresh-error"),
  ).toEqual([]);
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-changelog-retained-refresh-error-dark",
    harness,
  );

  harness.setEndpointMode(RUNS_PATH, "success");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByText("Refresh failed; retained snapshot shown", { exact: true }),
  ).toHaveCount(0);
  await expect(
    runArticle(page, COMPLETED_PASS_RUN.model_version_tag),
  ).toBeVisible();
  expect(
    await auditAIChangelogA11y(page, harness, "refresh-recovered"),
  ).toEqual([]);
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-changelog-refresh-recovered-dark",
    harness,
  );
  await expectHarnessSafe(page, harness);
});

test("durable polling serializes refreshes and advances pending through heartbeat-backed running to terminal evidence", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const pending = {
    ...LIFECYCLE_RUNS[0],
    id: AI_CHANGELOG_FIXTURE_IDS.runPolling,
    model_version_tag: "candidate-polling@2026-08-09",
  } satisfies RegressionRunFixture;
  const harness = await openAIChangelog(page, bootApp, setTheme, {
    runs: [pending],
  });
  await waitForRunState(page, pending.model_version_tag, "queued");

  harness.setEndpointMode(RUNS_PATH, "deferred");
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await expect.poll(() => harness.activeRequestCount(RUNS_PATH)).toBe(1);
  await page.waitForTimeout(5_500);
  expect(harness.maximumConcurrentRequests[RUNS_PATH]).toBe(1);
  expect(
    harness.requests.filter(
      (request) => request.method === "GET" && request.pathname === RUNS_PATH,
    ),
  ).toHaveLength(2);

  const running: RegressionRunFixture = {
    ...pending,
    status: "running",
    attempt_count: 1,
    started_at: "2026-08-09T08:59:00.000Z",
    heartbeat_at: "2026-08-09T08:59:50.000Z",
    lease_expires_at: "2026-08-09T09:04:50.000Z",
    updated_at: "2026-08-09T08:59:50.000Z",
  };
  harness.setEndpointPayload(RUNS_PATH, { items: [running] });
  harness.releaseEndpoint(RUNS_PATH);
  const runningArticle = await waitForRunState(
    page,
    running.model_version_tag,
    "running",
  );
  await openRunEvidence(runningArticle);
  await expect(runningArticle).toContainText("Heartbeat");
  await expect(runningArticle).toContainText("Lease expires");
  expect(await auditAIChangelogA11y(page, harness, "polling-running")).toEqual(
    [],
  );
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-changelog-polling-running-heartbeat-dark",
    harness,
  );

  const completed: RegressionRunFixture = {
    ...COMPLETED_PASS_RUN,
    id: pending.id,
    model_version_tag: pending.model_version_tag,
  };
  harness.setEndpointPayload(RUNS_PATH, { items: [completed] });
  harness.setEndpointPayload(
    `/api/v1/ai-regression/runs/${AI_CHANGELOG_FIXTURE_IDS.runPolling}/results`,
    { items: COMPLETED_PASS_RESULTS },
  );
  await expect
    .poll(
      () =>
        harness.requests.filter(
          (request) =>
            request.method === "GET" && request.pathname === RUNS_PATH,
        ).length,
      { timeout: 12_000 },
    )
    .toBeGreaterThanOrEqual(3);
  const completedArticle = await waitForRunState(
    page,
    completed.model_version_tag,
    "completed",
  );
  await expect(completedArticle).toContainText("Recorded pass");
  await expect(completedArticle).toContainText("2 / 2");
  expect(await auditAIChangelogA11y(page, harness, "polling-terminal")).toEqual(
    [],
  );
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-changelog-polling-terminal-receipt-dark",
    harness,
  );
  expect(harness.maximumConcurrentRequests[RUNS_PATH]).toBe(1);
  await expectHarnessSafe(page, harness);
});

test("Agent Trust exposes one compact queued voice-regression live update without making the outer card live", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openAgentTrustVoiceEvidence(page, bootApp, setTheme);
  const runsButton = page.getByRole("button", {
    name: "Run history",
    exact: true,
  });
  await expect(runsButton).toBeVisible();
  await runsButton.click();
  const trustButton = page.getByRole("button", { name: "Why & preview" });
  await expect(trustButton).toBeVisible();
  await trustButton.click();

  const trust = page.locator(
    `[id="routine-run-trust-${AI_CHANGELOG_FIXTURE_IDS.routineRun}"]`,
  );
  await expect(trust).toBeVisible();
  const badge = trust.getByTestId("voice-regression-badge-pending");
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveAttribute("data-status", "pending");
  await expect(badge).toHaveAttribute("data-evidence-state", "queued");
  await expect(badge).not.toHaveAttribute("role");
  await expect(badge).not.toHaveAttribute("aria-live");
  await expect(badge).toContainText("Operator correlation label:");
  await expect(badge).toContainText("Server-attested provider:");
  await expect(badge).toContainText("Server-attested model ID:");
  await expect(badge).toContainText("Server-attested prompt policy:");

  const liveProgress = badge.locator(".ai-regression-badge__live-progress");
  await expect(liveProgress).toHaveCount(1);
  await expect(liveProgress).toHaveClass(/\bsr-only\b/u);
  await expect(liveProgress).toHaveAttribute("role", "status");
  await expect(liveProgress).toHaveAttribute("aria-live", "polite");
  await expect(liveProgress).toHaveAttribute("aria-atomic", "true");
  await expect(liveProgress).toHaveText("Queued. 0 of 3 processed.");
  expect((await liveProgress.innerText()).length).toBeLessThanOrEqual(64);

  const observedRoutes = new Set(
    harness.requests.map(
      (request) => `${request.method} ${request.pathname}${request.search}`,
    ),
  );
  expect(observedRoutes).toEqual(
    new Set([
      "GET /api/v1/agent-routines",
      `GET /api/v1/agent-routines/${AI_CHANGELOG_FIXTURE_IDS.routine}/runs`,
      "GET /api/v1/ai-regression/runs/latest",
      "GET /api/v1/mcp/executions?limit=8",
    ]),
  );

  await scrollTargetIntoFrame(page, trust, 96);
  expect(
    await auditAIChangelogA11y(
      page,
      harness,
      "agent-trust-queued-voice-regression",
      `[id="routine-run-trust-${AI_CHANGELOG_FIXTURE_IDS.routineRun}"]`,
    ),
  ).toEqual([]);
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-changelog-agent-trust-queued-voice-dark",
    harness,
  );
  await expectHarnessSafe(
    page,
    harness,
    `[id="routine-run-trust-${AI_CHANGELOG_FIXTURE_IDS.routineRun}"]`,
  );
});

test("dark, light, narrow, minimum, and 200-percent proxy layouts remain contained", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openAIChangelog(page, bootApp, setTheme, {
    runs: [COMPLETED_PASS_RUN],
  });
  const viewports = [
    { name: "desktop-dark", width: 1_440, height: 1_000, theme: "dark" },
    { name: "desktop-light", width: 1_440, height: 1_000, theme: "light" },
    { name: "narrow-400-dark", width: 400, height: 800, theme: "dark" },
    { name: "minimum-360-light", width: 360, height: 800, theme: "light" },
    // Chromium has no stable cross-platform browser zoom API. 440 CSS px
    // represents an 880 CSS-pixel desktop app window at 200% zoom.
    { name: "zoom-200-proxy-light", width: 440, height: 560, theme: "light" },
  ] as const;

  for (const viewport of viewports) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, viewport.theme);
    await page.waitForTimeout(300);
    await resetContentScroll(page);
    await expectNoAIChangelogOverflow(page);
    expect(
      await auditAIChangelogA11y(page, harness, `responsive-${viewport.name}`),
    ).toEqual([]);
    await captureAIChangelogEvidence(
      page,
      testInfo,
      `ai-changelog-responsive-${viewport.name}`,
      harness,
    );
  }
  await expectAIChangelogSafety(page, harness);
});

test("forced colors and reduced motion retain visible keyboard state and calm semantics", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({
    colorScheme: "dark",
    forcedColors: "active",
    reducedMotion: "reduce",
  });
  const harness = await openAIChangelog(page, bootApp, setTheme, {
    runs: [COMPLETED_PASS_RUN],
    theme: "system",
  });
  const article = runArticle(page, COMPLETED_PASS_RUN.model_version_tag);
  const toggle = article.getByRole("button", { name: "Review evidence" });
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await expectAIChangelogReducedMotion(page);
  await expectNoAIChangelogOverflow(page);
  expect(
    await auditAIChangelogA11y(
      page,
      harness,
      "forced-colors-reduced-motion",
      ".ai-evidence-workspace",
      { includeColorContrast: false },
    ),
  ).toEqual([]);
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-changelog-forced-colors-reduced-motion",
    harness,
  );
  await expectAIChangelogSafety(page, harness);
});

test("administrator Settings presents advisory policy truth and submits only server-authorized public fields", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openAIRegressionSettings(page, bootApp, setTheme, {
    role: "admin",
    theme: "dark",
  });
  const section = aiRegressionSettingsSection(page);
  const regression = section.getByTestId("ai-regression-settings");
  await expect(regression).toHaveAttribute("data-capability", "admin");
  await expect(regression).toContainText(
    "Policy evidence is advisory to deployment",
  );
  await expect(regression).toContainText("No deployment authority");
  await expect(regression.getByText("2 loaded", { exact: true })).toBeVisible();
  expect(
    await auditAIChangelogA11y(
      page,
      harness,
      "admin-settings-populated",
      '[data-testid="ai-regression-settings"]',
    ),
  ).toEqual([]);
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-regression-settings-admin-populated-dark",
    harness,
  );

  const policyToggle = regression.getByRole("checkbox", {
    name: /Record a threshold pass or concern/u,
  });
  await expect(policyToggle).toBeChecked();
  await policyToggle.click();
  await expect
    .poll(
      () =>
        harness.requests.filter(
          (request) =>
            request.pathname === "/api/v1/ai-regression/settings" &&
            request.method === "PUT",
        ).length,
    )
    .toBe(1);
  const settingsWrite = harness.requests.find(
    (request) =>
      request.pathname === "/api/v1/ai-regression/settings" &&
      request.method === "PUT",
  );
  expect(parseRequestBody(settingsWrite?.body ?? null)).toEqual({
    warn_threshold: 60,
    hard_gate_enabled: false,
    hard_gate_threshold: 55,
    min_examples_for_gate: 2,
  });

  await regression
    .getByRole("textbox", { name: "Operator correlation label" })
    .fill("candidate-settings@2026-08-09");
  await regression.getByRole("button", { name: "Request replay" }).click();
  await expect(regression).toContainText("Replay request accepted as pending");
  await expect(regression).toContainText(
    "Server-attested runtime receipt: provider",
  );
  await expect(regression).toContainText("gemini-3-flash-preview");
  await expect(regression).toContainText("voice-regression-replay-v2");
  const triggerWrite = harness.requests.find(
    (request) => request.pathname === RUNS_PATH && request.method === "POST",
  );
  expect(parseRequestBody(triggerWrite?.body ?? null)).toEqual({
    model_version_tag: "candidate-settings@2026-08-09",
  });

  await regression
    .getByRole("textbox", { name: "Golden example brief" })
    .fill("Preserve an approved reference for exact replay comparison.");
  await regression
    .getByRole("textbox", { name: "Golden example approved output" })
    .fill("Approved output owned by the accountable operator.");
  await regression
    .getByRole("button", { name: "Save golden reference" })
    .click();
  await expect(regression).toContainText("Golden reference saved.");
  const captureWrite = harness.requests.find(
    (request) =>
      request.pathname === "/api/v1/ai-regression/golden-examples" &&
      request.method === "POST",
  );
  const captureBody = parseRequestBody(captureWrite?.body ?? null);
  expect(captureBody).toMatchObject({
    surface_kind: "campaign_draft",
    brief: "Preserve an approved reference for exact replay comparison.",
    approved_output: "Approved output owned by the accountable operator.",
  });
  expect(captureBody["request_id"]).toEqual(
    expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    ),
  );
  expect(captureWrite?.body).not.toContain("model_id");
  expect(captureWrite?.body).not.toContain("approval_id");
  expect(captureWrite?.body).not.toContain("agent_run_id");

  const newGolden = regression
    .getByTestId("golden-example-row")
    .filter({ hasText: "Model manual_reference" });
  await expect(newGolden).toBeVisible();
  await newGolden
    .getByRole("button", { name: /Archive golden reference/u })
    .click();
  const archiveDialog = page.getByRole("alertdialog", {
    name: "Archive golden reference?",
  });
  await expect(archiveDialog).toBeVisible();
  await archiveDialog
    .getByRole("button", { name: "Archive reference", exact: true })
    .click();
  await expect(newGolden).toHaveCount(0);
  expect(
    harness.requests.some(
      (request) =>
        request.method === "DELETE" &&
        request.pathname ===
          `/api/v1/ai-regression/golden-examples/${AI_CHANGELOG_FIXTURE_IDS.goldenManual}`,
    ),
  ).toBe(true);

  expect(
    await auditAIChangelogA11y(
      page,
      harness,
      "admin-settings-after-mutations",
      '[data-testid="ai-regression-settings"]',
    ),
  ).toEqual([]);
  await scrollTargetIntoFrame(page, section);
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-regression-settings-admin-mutations-dark",
    harness,
  );
  await expectHarnessSafe(
    page,
    harness,
    '[data-testid="ai-regression-settings"]',
  );
});

test("viewer Settings keeps readable references while making zero settings or mutation requests", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openAIRegressionSettings(page, bootApp, setTheme, {
    role: "viewer",
    theme: "light",
    width: 400,
    height: 800,
  });
  const section = aiRegressionSettingsSection(page);
  const regression = section.getByTestId("ai-regression-settings");
  await expect(regression).toHaveAttribute("data-capability", "read-only");
  await expect(regression).toContainText("Read-only regression evidence");
  await expect(regression).toContainText("Golden references remain visible");
  await expect(regression.getByTestId("golden-example-row")).toHaveCount(2);
  await expect(
    regression.getByRole("button", { name: "Request replay" }),
  ).toHaveCount(0);
  await expect(
    regression.getByRole("button", { name: "Save golden reference" }),
  ).toHaveCount(0);
  await expect(
    regression.getByRole("button", { name: /Archive golden reference/u }),
  ).toHaveCount(0);

  expect(harness.unauthorizedAdminRequests).toEqual([]);
  expect(harness.requests.length).toBeGreaterThanOrEqual(1);
  expect(
    harness.requests.every(
      (request) =>
        request.body === null &&
        request.method === "GET" &&
        request.pathname === "/api/v1/ai-regression/golden-examples" &&
        request.search === "?limit=200",
    ),
  ).toBe(true);
  expect(
    await auditAIChangelogA11y(
      page,
      harness,
      "viewer-settings-narrow",
      '[data-testid="ai-regression-settings"]',
    ),
  ).toEqual([]);
  await scrollTargetIntoFrame(page, section);
  await captureAIChangelogEvidence(
    page,
    testInfo,
    "ai-regression-settings-viewer-narrow-light",
    harness,
  );
  await expectHarnessSafe(
    page,
    harness,
    '[data-testid="ai-regression-settings"]',
    { includeShellOverflow: false },
  );
  expect(new Date(AI_CHANGELOG_FIXED_TIME).toISOString()).toBe(
    AI_CHANGELOG_FIXED_TIME,
  );
});
