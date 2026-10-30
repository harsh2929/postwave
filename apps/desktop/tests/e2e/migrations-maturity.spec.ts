import { Buffer } from "node:buffer";

import type { Locator, Page } from "@playwright/test";

import {
  MIGRATION_CANCELLED_HEALTHY_JOB,
  MIGRATION_FIXTURE_IDS,
  MIGRATION_JOBS,
  MIGRATION_SOURCE_CAPABILITIES,
  MIGRATION_WIZARD_IMPORTING_JOB,
  MIGRATIONS_CREDENTIAL_SECRET,
  MIGRATIONS_RECOVERY_SECRET,
  auditMigrationsA11y,
  captureMigrationsEvidence,
  clickMigration,
  expectMigrationsReducedMotion,
  expectMigrationsSafety,
  expectNoMigrationsOverflow,
  fillMigration,
  migrationDoneEvent,
  migrationProgressEvent,
  openMigrations,
  pressMigration,
  resetMigrationsEvidenceDirectory,
  selectMigration,
  setMigrationFile,
  type MigrationsHarness,
} from "./migrations-evidence-harness";
import { expect, test } from "../visual/fixture";

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async () => {
  await resetMigrationsEvidenceDirectory();
});

const JOBS_PATH = "/api/v1/migrations";
const SOURCES_PATH = "/api/v1/migrations/sources";

function migrationRow(page: Page, jobId: string): Locator {
  return page.getByRole("row").filter({ hasText: jobId });
}

async function expectFocusedStepHeading(
  dialog: Locator,
  expected: string,
): Promise<void> {
  const heading = dialog.locator("[data-migration-step-heading]");
  await expect(heading).toHaveText(expected);
  await expect(heading).toBeFocused();
}

function lastRequestOrder(harness: MigrationsHarness): number {
  return harness.requests.at(-1)?.order ?? 0;
}

function requestBody(
  harness: MigrationsHarness,
  pathname: string,
  method: string,
): Record<string, unknown> {
  const request = harness.requests.find(
    (candidate) =>
      candidate.pathname === pathname && candidate.method === method,
  );
  expect(request, `${method} ${pathname} was not recorded`).toBeDefined();
  expect(request?.body).not.toBeNull();
  return JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
}

async function expectHarnessSafe(
  page: Page,
  harness: MigrationsHarness,
  label: string,
  options: { includeShell?: boolean; selector?: string } = {},
): Promise<void> {
  await expectNoMigrationsOverflow(
    page,
    harness,
    label,
    options.selector ?? ".migration-surface",
    { includeShell: options.includeShell },
  );
  await expectMigrationsSafety(page, harness);
}

test("initial verification states distinguish loading, verified empty, unavailable, and recovered", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openMigrations(page, bootApp, setTheme, {
    initialModes: {
      [JOBS_PATH]: "deferred",
      [SOURCES_PATH]: "deferred",
    },
  });
  await expect(page.getByLabel("Verifying migration history")).toBeVisible();
  await expect(
    page.getByLabel("Verifying migration source availability"),
  ).toBeVisible();
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-initial-loading-dark",
    harness,
  );

  harness.setEndpointPayload(JOBS_PATH, []);
  harness.releaseEndpoint(JOBS_PATH);
  harness.releaseEndpoint(SOURCES_PATH);
  await expect(
    page.getByText("Verified empty history", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start Klaviyo migration" }),
  ).toBeVisible();
  expect(await auditMigrationsA11y(page, harness, "verified-empty")).toEqual(
    [],
  );
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-verified-empty-dark",
    harness,
  );

  harness.setEndpointMode(JOBS_PATH, "error");
  harness.setEndpointMode(SOURCES_PATH, "error");
  await page.reload();
  await expect(
    page.getByText("No verified migration history is available.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("No verified source catalog is available.", {
      exact: true,
    }),
  ).toBeVisible();
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-initial-unavailable-dark",
    harness,
  );

  harness.setEndpointMode(JOBS_PATH, "success");
  harness.setEndpointMode(SOURCES_PATH, "success");
  await clickMigration(
    harness,
    "header refresh after independent failures",
    page.getByRole("button", { name: "Refresh", exact: true }),
  );
  await expect(
    page.getByText("Verified empty history", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start Klaviyo migration" }),
  ).toBeVisible();
  expect(await auditMigrationsA11y(page, harness, "recovered-empty")).toEqual(
    [],
  );
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-recovered-empty-dark",
    harness,
  );
  await expectHarnessSafe(page, harness, "initial-state-matrix");
});

test("populated control center exposes every lifecycle, verified source truth, search, filters, and pagination", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openMigrations(page, bootApp, setTheme);
  await expect(
    page.getByRole("region", { name: "Migration job history" }),
  ).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(MIGRATION_JOBS.length + 1);
  await expect(
    page
      .getByRole("list", { name: "Verified migration sources" })
      .getByRole("listitem"),
  ).toHaveCount(MIGRATION_SOURCE_CAPABILITIES.length);

  for (const [jobId, status] of [
    [MIGRATION_FIXTURE_IDS.importing, "Importing"],
    [MIGRATION_FIXTURE_IDS.awaiting, "Awaiting confirmation"],
    [MIGRATION_FIXTURE_IDS.rollingBack, "Rolling back"],
    [MIGRATION_FIXTURE_IDS.completed, "Completed"],
    [MIGRATION_FIXTURE_IDS.cancelled, "Failed"],
    [MIGRATION_FIXTURE_IDS.failed, "Failed"],
    [MIGRATION_FIXTURE_IDS.rolledBack, "Rolled back"],
  ] as const) {
    await expect(migrationRow(page, jobId)).toContainText(status);
  }
  await expect(
    migrationRow(page, MIGRATION_FIXTURE_IDS.rollingBack),
  ).toContainText("Original import scope");
  await expect(
    page.getByText(/7 verified jobs · 1 completed · 3 in flight/u),
  ).toBeVisible();

  const search = page.getByLabel("Search verified jobs");
  await fillMigration(
    harness,
    "verified job search",
    search,
    MIGRATION_FIXTURE_IDS.completed,
  );
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(
    migrationRow(page, MIGRATION_FIXTURE_IDS.completed),
  ).toBeVisible();
  await clickMigration(
    harness,
    "clear verified job search",
    page.getByRole("button", { name: "Clear search" }),
  );

  const completedFilter = page.getByRole("radio", { name: /Completed/u });
  await completedFilter.focus();
  await pressMigration(
    harness,
    "completed status filter",
    completedFilter,
    "Space",
  );
  await expect(completedFilter).toBeChecked();
  await expect(page.getByRole("row")).toHaveCount(2);
  const allFilter = page.getByRole("radio", { name: /^All/u });
  await allFilter.focus();
  await pressMigration(harness, "all status filter", allFilter, "Space");
  await selectMigration(
    harness,
    "jobs per page",
    page.getByLabel("Jobs per page"),
    "50",
  );
  await expect(page.getByText(/Showing 1–7 of 7 matching jobs/u)).toBeVisible();

  expect(
    await auditMigrationsA11y(page, harness, "populated-control-center"),
  ).toEqual([]);
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-populated-control-center-dark",
    harness,
  );
  await expectHarnessSafe(page, harness, "populated-control-center");
});

test("history and capability failures remain independent, retain verified snapshots, block stale starts, and recover", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openMigrations(page, bootApp, setTheme);
  await expect(
    migrationRow(page, MIGRATION_FIXTURE_IDS.importing),
  ).toBeVisible();

  harness.setEndpointMode(JOBS_PATH, "error");
  await clickMigration(
    harness,
    "refresh with history unavailable",
    page.getByRole("button", { name: "Refresh", exact: true }),
  );
  await expect(
    page.getByText("The last verified snapshot remains visible.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    migrationRow(page, MIGRATION_FIXTURE_IDS.importing),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start Klaviyo migration" }),
  ).not.toHaveAttribute("aria-disabled", "true");

  harness.setEndpointMode(JOBS_PATH, "success");
  harness.setEndpointMode(SOURCES_PATH, "error");
  await clickMigration(
    harness,
    "refresh with capability catalog unavailable",
    page.getByRole("button", { name: "Refresh", exact: true }),
  );
  await expect(
    page.getByText(/Starting from a source card is unavailable/u),
  ).toBeVisible();
  const staleKlaviyo = page.getByRole("button", {
    name: /Start Klaviyo migration unavailable: Capability verification is stale/u,
  });
  await expect(staleKlaviyo).toHaveAttribute("aria-disabled", "true");
  await staleKlaviyo.focus();
  await expect(staleKlaviyo).toBeFocused();
  await pressMigration(
    harness,
    "blocked stale Klaviyo start",
    staleKlaviyo,
    "Enter",
  );
  await expect(
    page.getByRole("dialog", { name: /Migration · Step/u }),
  ).toHaveCount(0);
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-retained-stale-independent-errors-dark",
    harness,
  );

  harness.setEndpointMode(SOURCES_PATH, "success");
  await clickMigration(
    harness,
    "recover history and capability verification",
    page.getByRole("button", { name: "Refresh", exact: true }),
  );
  await expect(
    page.getByRole("button", { name: "Start Klaviyo migration" }),
  ).not.toHaveAttribute("aria-disabled", "true");
  expect(
    await auditMigrationsA11y(page, harness, "independent-error-recovery"),
  ).toEqual([]);
  await expectHarnessSafe(page, harness, "independent-error-recovery");
});

test("viewer mode keeps reasons focusable and blocks every tenant mutation before the network", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openMigrations(page, bootApp, setTheme, {
    role: "viewer",
  });
  const newMigration = page.getByRole("button", { name: "New migration" });
  await expect(newMigration).toHaveAttribute("aria-disabled", "true");
  await newMigration.focus();
  await expect(newMigration).toBeFocused();
  await pressMigration(
    harness,
    "blocked viewer new migration",
    newMigration,
    "Enter",
  );
  await expect(
    page.getByText(/Viewer mode: an admin role is required/u),
  ).toBeVisible();

  const source = page.getByRole("button", {
    name: /Start Klaviyo migration unavailable: Admin role required/u,
  });
  await expect(source).toHaveAttribute("aria-disabled", "true");
  await source.focus();
  await expect(source).toBeFocused();
  await pressMigration(harness, "blocked viewer source start", source, "Enter");

  const importing = migrationRow(page, MIGRATION_FIXTURE_IDS.importing);
  const cancel = importing.getByRole("button", { name: "Cancel job" });
  await expect(cancel).toHaveAttribute("aria-disabled", "true");
  await cancel.focus();
  await expect(cancel).toBeFocused();
  await pressMigration(harness, "blocked viewer cancellation", cancel, "Enter");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  const completed = migrationRow(page, MIGRATION_FIXTURE_IDS.completed);
  await expect(
    completed.getByRole("button", { name: "Roll back" }),
  ).toHaveAttribute("aria-disabled", "true");
  await clickMigration(
    harness,
    "open viewer-safe completed detail",
    completed.getByRole("button", { name: "View details" }),
  );
  const detail = page.getByRole("dialog", { name: /Klaviyo migration/u });
  await expect(
    detail.getByRole("heading", { name: "Job provenance" }),
  ).toBeVisible();
  await expect(
    detail.getByRole("button", { name: "Roll back imported records" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(
    await auditMigrationsA11y(
      page,
      harness,
      "viewer-detail",
      "[role='dialog']",
    ),
  ).toEqual([]);
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-viewer-permission-boundaries-dark",
    harness,
  );
  expect(
    harness.requests.filter(
      ({ method, pathname }) =>
        method !== "GET" && pathname !== "/api/v1/streams/token",
    ),
    "viewer interactions must not reach a tenant mutation endpoint",
  ).toEqual([]);
  await expectMigrationsSafety(page, harness);
});

test("source catalog is keyboard navigable and opens a truthful credential step without making a request", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openMigrations(page, bootApp, setTheme, {
    initialModes: { [SOURCES_PATH]: "deferred" },
  });
  await expect.poll(() => harness.activeRequestCount(SOURCES_PATH)).toBe(1);
  const newMigration = page.getByRole("button", { name: "New migration" });
  await expect(newMigration).toHaveAttribute("aria-disabled", "true");
  const sourceRequestsBeforeBlockedSetup = harness.requests.filter(
    ({ method, pathname }) => method === "GET" && pathname === SOURCES_PATH,
  ).length;
  await newMigration.focus();
  await pressMigration(
    harness,
    "blocked pending-catalog migration setup",
    newMigration,
    "Enter",
  );
  await newMigration.click({ force: true });
  harness.interactions.push({
    action: "click",
    order: harness.interactions.length + 1,
    target: "blocked pending-catalog migration setup",
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(harness.maximumConcurrentRequests[`GET ${SOURCES_PATH}`]).toBe(1);
  expect(
    harness.requests.filter(
      ({ method, pathname }) => method === "GET" && pathname === SOURCES_PATH,
    ),
  ).toHaveLength(sourceRequestsBeforeBlockedSetup);

  harness.releaseEndpoint(SOURCES_PATH);
  await expect(newMigration).not.toHaveAttribute("aria-disabled", "true");
  const sourceRequestsBeforeWizard = harness.requests.filter(
    ({ method, pathname }) => method === "GET" && pathname === SOURCES_PATH,
  ).length;
  await clickMigration(harness, "open source catalog", newMigration);
  const catalog = page.getByRole("dialog", {
    name: /Migration · Step 1 of 5: Pick source/u,
  });
  await expect(catalog).toBeVisible();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() => resolve()),
        );
      }),
  );
  expect(
    harness.requests.filter(
      ({ method, pathname }) => method === "GET" && pathname === SOURCES_PATH,
    ),
    "opening the wizard must reuse the page's freshly verified source snapshot",
  ).toHaveLength(sourceRequestsBeforeWizard);
  expect(harness.maximumConcurrentRequests[`GET ${SOURCES_PATH}`]).toBe(1);
  await expectFocusedStepHeading(catalog, "Step 1 of 5: Pick source");
  await expect(
    catalog.getByLabel(/Migration wizard, step 1 of 5/u),
  ).toBeVisible();
  await expect(
    catalog.getByRole("button", { name: /^Klaviyo/u }),
  ).toBeVisible();
  await expect(
    catalog.getByRole("button", {
      name: /^Kit \(ConvertKit\) · OAuth · Write-ready$/u,
    }),
  ).toBeVisible();
  await expect(
    catalog.getByRole("button", {
      name: /^Substack · File upload · Write-ready$/u,
    }),
  ).toBeVisible();
  expect(
    await auditMigrationsA11y(
      page,
      harness,
      "wizard-source-catalog",
      "[role='dialog']",
    ),
  ).toEqual([]);
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-wizard-source-catalog-dark",
    harness,
  );

  const requestCountBeforePick = harness.requests.length;
  const csv = catalog.getByRole("button", { name: /^CSV upload/u });
  await csv.focus();
  await pressMigration(harness, "CSV upload source card", csv, "Enter");
  const csvConnect = page.getByRole("dialog", {
    name: /Migration · Step 2 of 5: Connect/u,
  });
  await expectFocusedStepHeading(csvConnect, "Step 2 of 5: Connect");
  await setMigrationFile(
    harness,
    "empty CSV rejection fixture",
    csvConnect.getByRole("button", { name: "Choose CSV file" }),
    {
      name: "empty.csv",
      mimeType: "text/csv",
      buffer: Buffer.alloc(0),
    },
  );
  await expect(csvConnect.getByRole("alert")).toContainText(
    "The selected file is empty.",
  );
  await clickMigration(
    harness,
    "return to source catalog after file validation",
    csvConnect.getByRole("button", { name: "Back", exact: true }),
  );

  const restoredCatalog = page.getByRole("dialog", {
    name: /Migration · Step 1 of 5: Pick source/u,
  });
  await expectFocusedStepHeading(restoredCatalog, "Step 1 of 5: Pick source");
  const klaviyo = restoredCatalog.getByRole("button", { name: /^Klaviyo/u });
  await klaviyo.focus();
  await expect(klaviyo).toBeFocused();
  await pressMigration(harness, "Klaviyo source card", klaviyo, "Enter");
  const connect = page.getByRole("dialog", {
    name: /Migration · Step 2 of 5: Connect/u,
  });
  await expectFocusedStepHeading(connect, "Step 2 of 5: Connect");
  await expect(connect.getByLabel("Private API key *")).toBeVisible();
  await expect(connect).toContainText("Credentials stay tenant-scoped");
  expect(
    harness.requests
      .slice(requestCountBeforePick)
      .filter(({ method }) => method !== "GET"),
  ).toEqual([]);
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-wizard-credential-step-dark",
    harness,
  );
  await expectMigrationsSafety(page, harness);
});

test("credential flow redacts secrets, binds one dry-run job, commits once, streams progress, and verifies terminal evidence", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openMigrations(page, bootApp, setTheme);
  await clickMigration(
    harness,
    "start Klaviyo migration",
    page.getByRole("button", { name: "Start Klaviyo migration" }),
  );
  const connect = page.getByRole("dialog", {
    name: /Migration · Step 2 of 5: Connect/u,
  });
  await expectFocusedStepHeading(connect, "Step 2 of 5: Connect");
  const credential = connect.getByLabel("Private API key *");
  await fillMigration(
    harness,
    "Klaviyo private API key",
    credential,
    MIGRATIONS_CREDENTIAL_SECRET,
    { sensitive: true },
  );
  await clickMigration(
    harness,
    "show credential locally",
    connect.getByRole("button", { name: "Show" }),
  );
  await expect(credential).toHaveAttribute("type", "text");
  await clickMigration(
    harness,
    "hide credential locally",
    connect.getByRole("button", { name: "Hide" }),
  );
  await expect(credential).toHaveAttribute("type", "password");
  await clickMigration(
    harness,
    "connect and prepare dry-run",
    connect.getByRole("button", { name: "Connect & preview" }),
  );

  const preview = page.getByRole("dialog", {
    name: /Migration · Step 3 of 5: Preview/u,
  });
  await expectFocusedStepHeading(preview, "Step 3 of 5: Preview");
  await expect(preview).toContainText(
    `Dry-run for Klaviyo · exact job ${MIGRATION_FIXTURE_IDS.wizard}`,
  );
  await expect(preview).toContainText(
    "No destination resources have been imported. A durable setup job or upload may already exist.",
  );
  await expect(preview).toContainText(
    "Klaviyo runtime parity is not part of this import",
  );
  await expect(preview).toContainText("Estimated data-loss vs source: 2.4%");

  const credentialsPath = "/api/v1/migrations/klaviyo/credentials";
  const dryRunPath = "/api/v1/migrations/klaviyo/dry-run";
  const exactWizardPath = `/api/v1/migrations/${MIGRATION_FIXTURE_IDS.wizard}`;
  const credentialsBody = requestBody(harness, credentialsPath, "POST");
  expect(credentialsBody).toEqual({
    api_key: "[REDACTED]",
    account_id: "",
    extra: {},
  });
  expect(requestBody(harness, dryRunPath, "POST")).toEqual({
    job_id: MIGRATION_FIXTURE_IDS.wizard,
  });
  expect(
    harness.requests.filter(
      ({ method, pathname }) =>
        method === "POST" && pathname === credentialsPath,
    ),
  ).toHaveLength(1);
  expect(
    harness.requests.filter(
      ({ method, pathname }) => method === "POST" && pathname === dryRunPath,
    ),
  ).toHaveLength(1);
  const dryRunRequest = harness.requests.find(
    ({ method, pathname }) => method === "POST" && pathname === dryRunPath,
  );
  const previewSnapshot = harness.requests.find(
    ({ method, order, pathname }) =>
      method === "GET" &&
      pathname === exactWizardPath &&
      order > (dryRunRequest?.order ?? Number.POSITIVE_INFINITY),
  );
  expect(dryRunRequest).toBeDefined();
  expect(
    previewSnapshot,
    "the dry-run must be followed by an exact no-query job snapshot",
  ).toBeDefined();
  expect(
    await auditMigrationsA11y(
      page,
      harness,
      "verified-dry-run",
      "[role='dialog']",
    ),
  ).toEqual([]);
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-verified-dry-run-dark",
    harness,
  );

  const requestsBeforeCommit = lastRequestOrder(harness);
  await clickMigration(
    harness,
    "commit verified dry-run",
    preview.getByRole("button", {
      name: "Looks good — start the real import",
    }),
  );
  const run = page.getByRole("dialog", {
    name: /Migration · Step 4 of 5: Run/u,
  });
  await expectFocusedStepHeading(run, "Step 4 of 5: Run");
  await expect(run).toContainText(`exact job ${MIGRATION_FIXTURE_IDS.wizard}`);
  const commitPath = "/api/v1/migrations/klaviyo/commit";
  await expect
    .poll(
      () =>
        harness.requests.filter(
          ({ method, pathname }) =>
            method === "POST" && pathname === commitPath,
        ).length,
    )
    .toBe(1);
  const commitRequest = harness.requests.find(
    ({ method, pathname }) => method === "POST" && pathname === commitPath,
  );
  const commitPreflight = harness.requests.find(
    ({ method, order, pathname }) =>
      method === "GET" &&
      pathname === exactWizardPath &&
      order > requestsBeforeCommit &&
      order < (commitRequest?.order ?? 0),
  );
  expect(
    commitPreflight,
    "commit must be authorized by a fresh exact-job GET immediately before the write",
  ).toBeDefined();
  await expect.poll(() => harness.streamInstanceCount()).toBeGreaterThan(0);
  await harness.emitStream("snapshot", MIGRATION_WIZARD_IMPORTING_JOB);
  await harness.emitStream("progress", migrationProgressEvent());
  await expect(run).toContainText("Importing subscribers (642 of 1,284)");
  await expect(
    run.getByRole("progressbar", { name: "Overall migration progress" }),
  ).toHaveAttribute("aria-valuenow", /\d+/u);
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-live-import-progress-dark",
    harness,
  );

  await harness.emitStream("done", migrationDoneEvent());
  const verify = page.getByRole("dialog", {
    name: /Migration · Step 5 of 5: Verify/u,
  });
  await expectFocusedStepHeading(verify, "Step 5 of 5: Verify");
  await expect(verify).toContainText(
    "Initial import finished; Klaviyo cutover is not certified.",
  );
  await expect(verify).toContainText(MIGRATION_FIXTURE_IDS.wizard);
  await expect(verify).toContainText("Verification evidence");
  expect(
    harness.requests.filter(
      ({ method, pathname }) =>
        method === "POST" && pathname === "/api/v1/migrations/klaviyo/commit",
    ),
  ).toHaveLength(1);
  expect(
    await auditMigrationsA11y(
      page,
      harness,
      "terminal-verification",
      "[role='dialog']",
    ),
  ).toEqual([]);
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-terminal-verification-dark",
    harness,
  );
  await expectMigrationsSafety(page, harness);
});

test("completed detail keeps full provenance and requires exact typed rollback confirmation", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openMigrations(page, bootApp, setTheme);
  const row = migrationRow(page, MIGRATION_FIXTURE_IDS.completed);
  await clickMigration(
    harness,
    "open completed migration detail",
    row.getByRole("button", { name: "View details" }),
  );
  const detail = page.getByRole("dialog", { name: /Klaviyo migration/u });
  await expect(
    detail.getByRole("heading", { name: "Job provenance" }),
  ).toBeVisible();
  await expect(detail).toContainText(MIGRATION_FIXTURE_IDS.completed);
  await expect(detail).toContainText("Verification evidence");
  await expect(detail).toContainText("Cutover review is required");
  await expect(detail).not.toContainText("redacted-by-production-surface");
  await clickMigration(
    harness,
    "refresh exact completed job snapshot",
    detail.getByRole("button", { name: "Refresh snapshot" }),
  );
  await expect
    .poll(
      () =>
        harness.requests.filter(
          ({ method, pathname }) =>
            method === "GET" &&
            pathname ===
              `/api/v1/migrations/${MIGRATION_FIXTURE_IDS.completed}`,
        ).length,
    )
    .toBe(1);
  expect(
    await auditMigrationsA11y(
      page,
      harness,
      "completed-detail",
      "[role='dialog']",
    ),
  ).toEqual([]);
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-completed-detail-dark",
    harness,
  );

  await clickMigration(
    harness,
    "open rollback confirmation",
    detail.getByRole("button", { name: "Roll back imported records" }),
  );
  const rollback = page.getByRole("alertdialog", {
    name: "Roll back imported records?",
  });
  const confirmation = rollback.getByLabel(/Type the exact job identifier/u);
  const confirm = rollback.getByRole("button", { name: "Roll back this job" });
  await expect(confirm).toHaveAttribute("aria-disabled", "true");
  await fillMigration(
    harness,
    "partial rollback confirmation",
    confirmation,
    MIGRATION_FIXTURE_IDS.completed.slice(0, -3),
  );
  await expect(confirm).toHaveAttribute("aria-disabled", "true");
  await fillMigration(
    harness,
    "exact rollback confirmation",
    confirmation,
    MIGRATION_FIXTURE_IDS.completed,
  );
  await expect(confirm).not.toHaveAttribute("aria-disabled", "true");
  expect(
    await auditMigrationsA11y(
      page,
      harness,
      "rollback-confirmation",
      "[role='alertdialog']",
    ),
  ).toEqual([]);
  const requestsBeforeRollback = lastRequestOrder(harness);
  await clickMigration(harness, "confirm exact rollback", confirm);
  await expect(rollback).toHaveCount(0);
  const completedPath = `/api/v1/migrations/${MIGRATION_FIXTURE_IDS.completed}`;
  const rollbackPath = `${completedPath}/rollback`;
  await expect
    .poll(
      () =>
        harness.requests.filter(
          ({ method, pathname }) =>
            method === "POST" && pathname === rollbackPath,
        ).length,
    )
    .toBe(1);
  const rollbackRequest = harness.requests.find(
    ({ method, pathname }) => method === "POST" && pathname === rollbackPath,
  );
  expect(
    harness.requests.find(
      ({ method, order, pathname }) =>
        method === "GET" &&
        pathname === completedPath &&
        order > requestsBeforeRollback &&
        order < (rollbackRequest?.order ?? 0),
    ),
    "rollback must be authorized by a fresh exact-job GET immediately before the write",
  ).toBeDefined();
  await expectMigrationsSafety(page, harness);
});

test("near-expiry and expired sessions recover before resume while in-flight cancellation remains exact", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openMigrations(page, bootApp, setTheme);
  const importingRow = migrationRow(page, MIGRATION_FIXTURE_IDS.importing);
  await clickMigration(
    harness,
    "open near-expiry in-flight migration detail",
    importingRow.getByRole("button", { name: "View details" }),
  );
  const nearExpiryDetail = page.getByRole("dialog", {
    name: /Customer.io migration/u,
  });
  await expect(nearExpiryDetail).toContainText(
    "Source authorization is inside the cutover safety window.",
  );
  await expect(nearExpiryDetail).toContainText(
    "The server cannot replace a source session while this job is reading, importing, or rolling back.",
  );
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-near-expiry-source-session-dark",
    harness,
  );
  await clickMigration(
    harness,
    "close near-expiry migration detail",
    nearExpiryDetail
      .locator(".modal-footer")
      .getByRole("button", { name: "Close", exact: true }),
  );

  const cancelledRow = migrationRow(page, MIGRATION_FIXTURE_IDS.cancelled);
  await clickMigration(
    harness,
    "open cancelled migration detail",
    cancelledRow.getByRole("button", { name: "View details" }),
  );
  const detail = page.getByRole("dialog", { name: /Beehiiv migration/u });
  await expect(detail).toContainText("Import cancelled at a checkpoint");
  await expect(detail).not.toContainText("cancelled by operator");
  await expect(detail).toContainText("Source authorization has expired.");
  await expect(detail).toContainText(
    "The saved source authorization has expired.",
  );
  const resumeAction = detail.getByRole("button", {
    name: "Resume from checkpoint",
  });
  await expect(resumeAction).toHaveAttribute("aria-disabled", "true");
  expect(
    await auditMigrationsA11y(
      page,
      harness,
      "expired-source-session",
      "[role='dialog']",
    ),
  ).toEqual([]);
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-expired-source-session-recovery-dark",
    harness,
  );

  const cancelledPath = `/api/v1/migrations/${MIGRATION_FIXTURE_IDS.cancelled}`;
  const sourceSessionPath = `${cancelledPath}/source-session`;
  harness.setEndpointPayload(
    cancelledPath,
    MIGRATION_CANCELLED_HEALTHY_JOB,
    "GET",
  );
  await fillMigration(
    harness,
    "Beehiiv recovery API key",
    detail.getByLabel("API key *", { exact: true }),
    MIGRATIONS_RECOVERY_SECRET,
    { sensitive: true },
  );
  const requestsBeforeSourceRefresh = lastRequestOrder(harness);
  await clickMigration(
    harness,
    "refresh and verify exact source session",
    detail.getByRole("button", { name: "Refresh this job's session" }),
  );
  await expect(resumeAction).not.toHaveAttribute("aria-disabled", "true");
  await expect
    .poll(
      () =>
        harness.requests.filter(
          ({ method, pathname }) =>
            method === "POST" && pathname === sourceSessionPath,
        ).length,
    )
    .toBe(1);
  expect(requestBody(harness, sourceSessionPath, "POST")).toMatchObject({
    api_key: "[REDACTED]",
  });
  const sourceSessionRequest = harness.requests.find(
    ({ method, pathname }) =>
      method === "POST" && pathname === sourceSessionPath,
  );
  expect(sourceSessionRequest?.order).toBeGreaterThan(
    requestsBeforeSourceRefresh,
  );
  expect(
    harness.requests.find(
      ({ method, order, pathname }) =>
        method === "GET" &&
        pathname === cancelledPath &&
        order > (sourceSessionRequest?.order ?? Number.POSITIVE_INFINITY),
    ),
    "source-session replacement must be followed by a separate exact-job verification GET",
  ).toBeDefined();

  await clickMigration(harness, "open resume confirmation", resumeAction);
  const resume = page.getByRole("dialog", {
    name: "Resume from the recorded checkpoint?",
  });
  const requestsBeforeResume = lastRequestOrder(harness);
  await clickMigration(
    harness,
    "confirm checkpoint resume",
    resume.getByRole("button", { name: "Resume from checkpoint" }),
  );
  await expect(resume).toHaveCount(0);
  const resumePath = `${cancelledPath}/resume`;
  await expect
    .poll(
      () =>
        harness.requests.filter(
          ({ method, pathname }) =>
            method === "POST" && pathname === resumePath,
        ).length,
    )
    .toBe(1);
  const resumeRequest = harness.requests.find(
    ({ method, pathname }) => method === "POST" && pathname === resumePath,
  );
  expect(
    harness.requests.find(
      ({ method, order, pathname }) =>
        method === "GET" &&
        pathname === cancelledPath &&
        order > requestsBeforeResume &&
        order < (resumeRequest?.order ?? 0),
    ),
    "resume must be authorized by a fresh exact-job GET immediately before the write",
  ).toBeDefined();
  await clickMigration(
    harness,
    "close cancelled detail",
    detail
      .locator(".modal-footer")
      .getByRole("button", { name: "Close", exact: true }),
  );
  await clickMigration(
    harness,
    "open in-flight cancellation",
    importingRow.getByRole("button", { name: "Cancel job" }),
  );
  const cancel = page.getByRole("alertdialog", {
    name: "Cancel at the next checkpoint?",
  });
  const confirmation = cancel.getByLabel(/Type the exact job identifier/u);
  await fillMigration(
    harness,
    "exact cancellation confirmation",
    confirmation,
    MIGRATION_FIXTURE_IDS.importing,
  );
  expect(
    await auditMigrationsA11y(
      page,
      harness,
      "cancel-confirmation",
      "[role='alertdialog']",
    ),
  ).toEqual([]);
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-cancel-resume-confirmations-dark",
    harness,
  );
  await clickMigration(
    harness,
    "confirm exact cancellation",
    cancel.getByRole("button", { name: "Cancel this job" }),
  );
  await expect(cancel).toHaveCount(0);
  expect(
    harness.requests.filter(
      ({ method, pathname }) =>
        method === "DELETE" &&
        pathname === `/api/v1/migrations/${MIGRATION_FIXTURE_IDS.importing}`,
    ),
  ).toHaveLength(1);
  await expectMigrationsSafety(page, harness);
});

test("responsive light-theme matrix keeps route content usable from desktop through narrow mobile widths", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openMigrations(page, bootApp, setTheme, {
    theme: "light",
  });
  const viewports = [
    { name: "desktop", width: 1_440, height: 1_000 },
    { name: "laptop", width: 1_024, height: 900 },
    { name: "tablet", width: 768, height: 1_024 },
    { name: "narrow", width: 400, height: 900 },
  ] as const;

  for (const viewport of viewports) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await expect(
      page.getByRole("heading", { name: "Migrations", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Server-supported source platforms" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Migration history" }),
    ).toBeVisible();
    await expectNoMigrationsOverflow(
      page,
      harness,
      `responsive-${viewport.name}`,
      ".migration-surface",
      { includeShell: viewport.width >= 768 },
    );
    await captureMigrationsEvidence(
      page,
      testInfo,
      `migrations-responsive-${viewport.name}-light`,
      harness,
    );
  }
  expect(await auditMigrationsA11y(page, harness, "responsive-narrow")).toEqual(
    [],
  );
  await expectMigrationsSafety(page, harness);
});

test("forced colors, reduced motion, and keyboard-only filter/source navigation remain operable", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({
    colorScheme: "dark",
    forcedColors: "active",
    reducedMotion: "reduce",
  });
  const harness = await openMigrations(page, bootApp, setTheme, {
    width: 1_024,
    height: 900,
  });
  const all = page.getByRole("radio", { name: /^All/u });
  await all.focus();
  await expect(all).toBeFocused();
  await pressMigration(
    harness,
    "status filter keyboard navigation",
    all,
    "End",
  );
  const rolledBack = page.getByRole("radio", { name: /Rolled back/u });
  await expect(rolledBack).toBeChecked();
  await expect(
    migrationRow(page, MIGRATION_FIXTURE_IDS.rolledBack),
  ).toBeVisible();

  await all.focus();
  await pressMigration(harness, "restore all status rows", all, "Space");
  const source = page.getByRole("button", { name: "Start Klaviyo migration" });
  await source.focus();
  await expect(source).toBeFocused();
  await pressMigration(
    harness,
    "keyboard open Klaviyo source",
    source,
    "Enter",
  );
  const connect = page.getByRole("dialog", {
    name: /Migration · Step 2 of 5: Connect/u,
  });
  await expect(connect).toBeVisible();
  await expectMigrationsReducedMotion(page);
  expect(
    await auditMigrationsA11y(
      page,
      harness,
      "forced-colors-connect",
      "[role='dialog']",
      { includeColorContrast: false },
    ),
  ).toEqual([]);
  await captureMigrationsEvidence(
    page,
    testInfo,
    "migrations-forced-colors-reduced-motion-keyboard",
    harness,
  );
  await expectMigrationsSafety(page, harness);
});
