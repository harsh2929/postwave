#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectWorkflowIssues as collectDesktopRustWorkflowIssues } from "../apps/desktop/scripts/check-rust-dependencies.mjs";
import { collectPerformanceContractIssues } from "../apps/web/scripts/check-performance-contracts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function loadSources() {
  return {
    ci: read(".github/workflows/ci.yml"),
    testWorkflow: read(".github/workflows/test.yml"),
    e2eWorkflow: read(".github/workflows/e2e.yml"),
    e2eRunner: read("tests/e2e/run.sh"),
    desktopCi: read(".github/workflows/desktop-ci.yml"),
    desktopRelease: read(".github/workflows/desktop-release.yml"),
    desktopPackage: read("apps/desktop/package.json"),
    desktopVitest: read("apps/desktop/vitest.config.ts"),
    desktopEslint: read("apps/desktop/eslint.config.js"),
    desktopFunctionQuality: read(
      "apps/desktop/scripts/check-function-quality.mjs",
    ),
    desktopSourceSize: read("apps/desktop/scripts/check-source-size.mjs"),
    liveMigrations: read(".github/workflows/live-migrations-nightly.yml"),
    lighthouseWorkflow: read(".github/workflows/lighthouse.yml"),
    lighthouseDesktop: read("apps/web/lighthouserc.json"),
    lighthouseMobile: read("apps/web/lighthouserc.mobile.json"),
    performanceBudgets: read("apps/web/performance-budgets.json"),
    performanceContracts: read(
      "apps/web/scripts/check-performance-contracts.mjs",
    ),
    performanceRunner: read(
      "tests/playwright/performance/web-performance.spec.ts",
    ),
    bundleBudget: read("apps/web/scripts/check-bundle-budgets.mjs"),
    loadWorkflow: read(".github/workflows/load-baseline.yml"),
    loadAuth: read("infra/load/auth.js"),
    mobileWorkflow: read(".github/workflows/mobile-release.yml"),
    eas: read("apps/mobile/eas.json"),
    migrationSchema: read("scripts/lint-migrations-schema.py"),
  };
}

export function checkContracts(sources) {
  const issues = [];
  const requireContract = (condition, id, message) => {
    if (!condition) issues.push({ id, message });
  };

  let lighthouseDesktop;
  let lighthouseMobile;
  let performanceBudgets;
  let eas;
  try {
    lighthouseDesktop = JSON.parse(sources.lighthouseDesktop);
    lighthouseMobile = JSON.parse(sources.lighthouseMobile);
    performanceBudgets = JSON.parse(sources.performanceBudgets);
    eas = JSON.parse(sources.eas);
  } catch (error) {
    issues.push({
      id: "H16-JSON",
      message: `release JSON could not be parsed: ${error.message}`,
    });
    return issues;
  }

  requireContract(
    sources.ci.includes("github.com/rhysd/actionlint/cmd/actionlint@v1.7.12") &&
      sources.ci.includes(
        "node scripts/check-ci-release-contracts.mjs --self-test",
      ),
    "H16-WORKFLOW-LINT",
    "blocking CI must run exact actionlint v1.7.12 and the release-gate fail-closed tests",
  );

  const databaseGateCommands = [
    "scripts/lint-migrations.sh",
    "scripts/check-rls-policies.sh",
    "scripts/check-no-bare-set-config.sh",
    "pnpm test:worker-db-safety",
    "pnpm audit:worker-db",
    "pnpm audit:request-bodies",
  ];
  requireContract(
    databaseGateCommands.every((command) => sources.ci.includes(command)) &&
      sources.ci.includes("POSTWAVE_MIGRATION_LINT_BASE") &&
      sources.testWorkflow.includes("scripts/lint-migrations.test.sh") &&
      sources.testWorkflow.includes("scripts/lint-migrations-schema.py") &&
      sources.testWorkflow.includes(
        "node scripts/check-worker-db-safety.mjs --self-test",
      ) &&
      sources.testWorkflow.includes(
        "node scripts/check-worker-db-safety.mjs",
      ) &&
      sources.testWorkflow.includes("POSTWAVE_MIGRATION_LINT_BASE") &&
      sources.migrationSchema.includes("verify_complete_tenant_tables") &&
      sources.migrationSchema.includes("verify_partition_tenant_semantics") &&
      sources.migrationSchema.includes("verify_null_safe_tenant_policies") &&
      sources.migrationSchema.includes("NULLABLE_TENANT_EXCEPTIONS"),
    "H16-DATABASE-GATES",
    "required CI must fail closed on migration lock/RLS shape, null-safe effective tenant policies, the complete effective tenant schema, transaction-local worker scope, and unbounded request bodies",
  );

  requireContract(
    sources.e2eWorkflow.includes("pull_request:") &&
      !sources.e2eWorkflow.includes("continue-on-error") &&
      sources.e2eWorkflow.includes('POSTWAVE_E2E_STRICT_ASSERTIONS: "1"') &&
      sources.e2eWorkflow.includes("/api/ready") &&
      sources.e2eRunner.includes("wait_for_ready") &&
      sources.e2eRunner.includes("export POSTWAVE_E2E_STRICT_ASSERTIONS=1"),
    "H16-E2E",
    "full-stack E2E must block pull requests, wait for dependency readiness, and turn every skipped/soft journey into a failure",
  );

  requireContract(
    collectDesktopRustWorkflowIssues({
      ci: sources.desktopCi,
      release: sources.desktopRelease,
    }).length === 0,
    "H16-DESKTOP-RUST",
    "desktop CI and release must install the same pinned cargo-audit and invoke the exact supported-target-aware Rust dependency gate",
  );

  requireContract(
    sources.desktopCi.includes(
      "pnpm --filter postwave-desktop-shell run test:coverage",
    ) &&
      sources.desktopRelease.includes(
        "pnpm --filter postwave-desktop-shell run test:coverage",
      ) &&
      sources.desktopPackage.includes(
        '"test:coverage": "vitest run --coverage"',
      ) &&
      sources.desktopPackage.includes('"@vitest/coverage-v8": "4.1.11"') &&
      sources.desktopVitest.includes('provider: "v8"') &&
      sources.desktopVitest.includes('include: ["src/**/*.{ts,tsx}"]') &&
      sources.desktopVitest.includes("thresholds:") &&
      sources.desktopVitest.includes("statements: 13") &&
      sources.desktopVitest.includes("branches: 13") &&
      sources.desktopVitest.includes("functions: 11") &&
      sources.desktopVitest.includes("lines: 13"),
    "H16-DESKTOP-COVERAGE",
    "desktop CI and release must run the pinned V8 full-source coverage gate with the reviewed regression floors",
  );

  const requiredTypedLintRules = [
    "@typescript-eslint/await-thenable",
    "@typescript-eslint/no-array-delete",
    "@typescript-eslint/no-floating-promises",
    "@typescript-eslint/no-for-in-array",
    "@typescript-eslint/no-implied-eval",
    "@typescript-eslint/no-misused-promises",
    "@typescript-eslint/no-misused-spread",
    "@typescript-eslint/prefer-promise-reject-errors",
    "@typescript-eslint/unbound-method",
  ];
  requireContract(
    sources.desktopCi.includes(
      "pnpm --filter postwave-desktop-shell run check:source-size",
    ) &&
      sources.desktopRelease.includes(
        "pnpm --filter postwave-desktop-shell run check:source-size",
      ) &&
      sources.desktopPackage.includes("pnpm check:function-quality") &&
      sources.desktopPackage.includes(
        '"check:function-quality": "pnpm test:function-quality && node scripts/check-function-quality.mjs"',
      ) &&
      requiredTypedLintRules.every((rule) =>
        sources.desktopEslint.includes(`"${rule}"`),
      ) &&
      sources.desktopFunctionQuality.includes("DEFAULT_MAX_FUNCTION_LINES") &&
      sources.desktopFunctionQuality.includes("DEFAULT_MAX_COMPLEXITY") &&
      sources.desktopFunctionQuality.includes("fatalErrorCount") &&
      sources.desktopSourceSize.includes("collectSourceSizeFindings") &&
      sources.desktopSourceSize.includes("2_000") &&
      sources.desktopSourceSize.includes("Object\\.assign"),
    "H16-DESKTOP-MAINTAINABILITY",
    "desktop CI and release must retain type-aware lint plus exact source/function size and complexity ratchets",
  );

  const mailchimpSecrets = [
    "MAILCHIMP_ACCESS_TOKEN",
    "MAILCHIMP_DC",
    "MAILCHIMP_AUDIENCE_IDS",
    "MAILCHIMP_LIVE_DRY_RUN",
    "MAILCHIMP_LIVE_COMMIT",
    "MAILCHIMP_LIVE_ROLLBACK",
  ];
  requireContract(
    !sources.liveMigrations.includes("${{ runner.temp }}") &&
      mailchimpSecrets.every((name) =>
        sources.liveMigrations.includes(`${name}: \${{ secrets.${name} }}`),
      ) &&
      sources.liveMigrations.includes("activecampaign_source_event_phase:") &&
      sources.liveMigrations.includes("- prepare") &&
      sources.liveMigrations.includes("- finish") &&
      sources.liveMigrations.includes("- cleanup") &&
      sources.liveMigrations.includes(
        "ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE: ${{ secrets.ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE }}",
      ) &&
      sources.liveMigrations.includes(
        "ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID: ${{ secrets.ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_JOB_ID }}",
      ) &&
      !sources.liveMigrations.includes("activecampaign_source_event_job_id:") &&
      sources.liveMigrations.includes(
        "ACTIVECAMPAIGN_LIVE_SOURCE_EVENT_PHASE=cleanup",
      ),
    "H16-LIVE-MIGRATIONS",
    "nightly strict migration certification must use a valid artifact context, supply every Mailchimp live input, and expose secret-backed resumable ActiveCampaign prepare/finish/cleanup phases without a dispatch job-ID input",
  );

  const desktopCollect = lighthouseDesktop?.ci?.collect;
  const mobileCollect = lighthouseMobile?.ci?.collect;
  const performanceContractIssues = collectPerformanceContractIssues({
    budgets: performanceBudgets,
    desktop: lighthouseDesktop,
    mobile: lighthouseMobile,
  });
  requireContract(
    desktopCollect?.settings?.preset === "desktop" &&
      Number(desktopCollect?.numberOfRuns) >= 3 &&
      mobileCollect?.settings?.preset === undefined &&
      mobileCollect?.settings?.throttlingMethod === "devtools" &&
      Number(mobileCollect?.numberOfRuns) >= 3 &&
      !sources.lighthouseMobile.includes('"preset": "mobile"') &&
      lighthouseDesktop?.ci?.upload?.target === "filesystem" &&
      lighthouseMobile?.ci?.upload?.target === "filesystem" &&
      sources.lighthouseWorkflow.includes("Build web workspace dependencies") &&
      sources.lighthouseWorkflow.includes("timeout-minutes: 30") &&
      sources.lighthouseWorkflow.includes('POSTWAVE_LOCAL_AUTH_BYPASS: "0"') &&
      (
        sources.lighthouseWorkflow.match(
          /POSTWAVE_PUBLIC_RELEASE_APPROVAL: "approved:CI-LIGHTHOUSE-SIMULATION"/g,
        ) ?? []
      ).length === 2 &&
      sources.lighthouseWorkflow.includes(
        "no deploy/publish step consumes this build",
      ) &&
      sources.lighthouseWorkflow.includes(
        "Retain private Lighthouse reports",
      ) &&
      sources.lighthouseWorkflow.includes(
        "pnpm --filter @postwave/web performance:contracts",
      ) &&
      sources.lighthouseWorkflow.includes(
        "pnpm --filter @postwave/web bundle:check",
      ) &&
      sources.lighthouseWorkflow.includes(
        "pnpm --dir tests/playwright test:performance",
      ) &&
      sources.lighthouseWorkflow.includes(
        "playwright install --with-deps chromium",
      ) &&
      performanceContractIssues.length === 0 &&
      sources.bundleBudget.includes("graphEntriesForRoute") &&
      sources.bundleBudget.includes("gzipSync") &&
      sources.bundleBudget.includes("forbiddenInitialModuleSignatures") &&
      sources.bundleBudget.includes("allEmittedClientJs") &&
      sources.bundleBudget.includes("const missingSignatures") &&
      sources.bundleBudget.includes(
        "update the contract explicitly if the library was intentionally removed",
      ) &&
      sources.performanceRunner.includes("Performance.getMetrics") &&
      sources.performanceRunner.includes("HeapProfiler.collectGarbage") &&
      sources.performanceRunner.includes("PerformanceEventTiming") &&
      sources.performanceRunner.includes("durationThreshold: 0") &&
      sources.performanceRunner.includes("EVENT_TIMING_REPORTING_FLOOR_MS") &&
      sources.performanceRunner.includes("reported: false") &&
      sources.performanceRunner.includes("upperBoundMs") &&
      sources.performanceRunner.includes(
        "trusted navigation-click Event Timing",
      ) &&
      sources.performanceRunner.includes("maxHeapGrowthMiB") &&
      sources.performanceRunner.includes("navigateInApp") &&
      !sources.performanceRunner.includes("page.goBack") &&
      sources.performanceRunner.includes(
        "window.__postwaveDocumentNonce = crypto.randomUUID()",
      ) &&
      sources.performanceRunner.includes("__postwaveClickObservation") &&
      sources.performanceRunner.includes("observationToken") &&
      sources.performanceRunner.includes(
        "init-script document nonce changed across trusted click",
      ) &&
      sources.performanceRunner.includes(
        "same-context trusted Next link clicks with PerformanceEventTiming",
      ) &&
      sources.performanceRunner.includes("this is not visit-wide INP") &&
      (sources.lighthouseWorkflow.match(/pnpm dlx @lhci\/cli@0\.15\.1/g) ?? [])
        .length === 2,
    "H16-LIGHTHOUSE",
    "desktop/mobile Lighthouse plus route-graph, interaction, long-task, DOM, and browser-memory gates must be blocking, private, sampled, and fail-closed",
  );

  requireContract(
    !sources.loadWorkflow.includes(".postwave.test") &&
      sources.loadWorkflow.includes("POSTWAVE_LOAD_ALLOWED_HOST") &&
      sources.loadWorkflow.includes("secrets.POSTWAVE_LOAD_API_KEY") &&
      sources.loadWorkflow.includes(
        "c7f03434854f837b6790ee81572e4b0f955241974c79a43cbb9f8d0fef069589",
      ) &&
      sources.loadWorkflow.includes("sha256sum --check --strict") &&
      sources.loadWorkflow.includes("SSE — 500 real concurrent streams") &&
      sources.loadWorkflow.includes("-clients 500") &&
      !sources.loadWorkflow.includes("events-sse.k6.js") &&
      sources.loadAuth.includes(
        "POSTWAVE_LOAD_API_KEY is required for a remote load target",
      ),
    "H16-LOAD",
    "load CI must use an exact authenticated staging host, checksum k6, and hold 500 real SSE streams",
  );

  requireContract(
    !sources.mobileWorkflow.includes("--latest") &&
      sources.mobileWorkflow.includes("eas-version: 20.5.1") &&
      sources.mobileWorkflow.includes("--wait") &&
      sources.mobileWorkflow.includes("--json") &&
      sources.mobileWorkflow.includes(
        'echo "build_id=$build_id" >> "$GITHUB_OUTPUT"',
      ) &&
      sources.mobileWorkflow.includes('--id "$EAS_BUILD_ID"') &&
      sources.mobileWorkflow.includes('SUBMIT_AFTER_BUILD" = "true"') &&
      sources.mobileWorkflow.includes('BUILD_MODE" != "eas"') &&
      sources.mobileWorkflow.includes("Retain immutable EAS build identity") &&
      sources.mobileWorkflow.includes(
        "node ./scripts/prepare-eas-submit-profile.mjs",
      ) &&
      sources.mobileWorkflow.includes("ASC_API_KEY_P8_BASE64") &&
      sources.mobileWorkflow.includes("GOOGLE_SERVICE_ACCOUNT_JSON") &&
      sources.mobileWorkflow.includes(
        "Remove runner-temporary store credentials",
      ) &&
      sources.mobileWorkflow.includes("native-smoke:") &&
      sources.mobileWorkflow.includes(":app:assembleRelease") &&
      sources.mobileWorkflow.includes("xcodebuild") &&
      sources.mobileWorkflow.includes("test:coverage") &&
      sources.mobileWorkflow.includes("- native-smoke") &&
      (
        sources.mobileWorkflow.match(
          /EXPO_PUBLIC_APP_URL: https:\/\/app\.postwave\.com/g,
        ) ?? []
      ).length === 3 &&
      !sources.mobileWorkflow.includes(["postwave", "app"].join(".")) &&
      eas?.cli?.version === "20.5.1",
    "H16-MOBILE-RELEASE",
    "mobile release must gate the exact EAS 20.5.1 build on coverage plus clean Android/iOS Release compiles, submit only that build ID, and retain evidence",
  );

  return issues;
}

function assertClean(sources) {
  const issues = checkContracts(sources);
  if (issues.length) {
    for (const issue of issues) console.error(`${issue.id}: ${issue.message}`);
    throw new Error(`${issues.length} release-gate contract(s) failed`);
  }
}

function assertMutationFails(base, name, expectedID, mutate) {
  const mutated = { ...base };
  mutate(mutated);
  const ids = new Set(checkContracts(mutated).map((issue) => issue.id));
  if (!ids.has(expectedID)) {
    throw new Error(`${name}: mutation did not trigger ${expectedID}`);
  }
}

function runSelfTests(base) {
  assertMutationFails(
    base,
    "missing migration secret",
    "H16-LIVE-MIGRATIONS",
    (value) => {
      value.liveMigrations = value.liveMigrations.replace(
        "MAILCHIMP_ACCESS_TOKEN",
        "REMOVED_ACCESS_TOKEN",
      );
    },
  );
  assertMutationFails(
    base,
    "unmeasured browser memory growth",
    "H16-LIGHTHOUSE",
    (value) => {
      const parsed = JSON.parse(value.performanceBudgets);
      parsed.browser.mobile.maxHeapGrowthMiB = 100;
      value.performanceBudgets = JSON.stringify(parsed);
    },
  );
  assertMutationFails(
    base,
    "unmeasured mobile throttling",
    "H16-LIGHTHOUSE",
    (value) => {
      const parsed = JSON.parse(value.lighthouseMobile);
      delete parsed.ci.collect.settings.throttlingMethod;
      value.lighthouseMobile = JSON.stringify(parsed);
    },
  );
  assertMutationFails(
    base,
    "optimistic Lighthouse aggregation",
    "H16-LIGHTHOUSE",
    (value) => {
      const parsed = JSON.parse(value.lighthouseDesktop);
      delete parsed.ci.assert.assertions["largest-contentful-paint"][1]
        .aggregationMethod;
      value.lighthouseDesktop = JSON.stringify(parsed);
    },
  );
  assertMutationFails(
    base,
    "full-reload browser memory journey",
    "H16-LIGHTHOUSE",
    (value) => {
      value.performanceRunner = value.performanceRunner.replace(
        "same-context trusted Next link clicks with PerformanceEventTiming",
        "full-reload journey",
      );
    },
  );
  assertMutationFails(
    base,
    "uncorrelated hard-navigation click timing",
    "H16-LIGHTHOUSE",
    (value) => {
      value.performanceRunner = value.performanceRunner.replace(
        "window.__postwaveDocumentNonce = crypto.randomUUID()",
        "window.__postwaveDocumentNonce = undefined",
      );
    },
  );
  assertMutationFails(
    base,
    "stale forbidden bundle markers",
    "H16-LIGHTHOUSE",
    (value) => {
      value.bundleBudget = value.bundleBudget.replace(
        "const missingSignatures",
        "const ignoredSignatures",
      );
    },
  );
  assertMutationFails(base, "unchecked load tool", "H16-LOAD", (value) => {
    value.loadWorkflow = value.loadWorkflow.replace(
      "sha256sum --check --strict",
      "sha256sum skipped",
    );
  });
  assertMutationFails(
    base,
    "mutable mobile submit",
    "H16-MOBILE-RELEASE",
    (value) => {
      value.mobileWorkflow = value.mobileWorkflow.replace(
        '--id "$EAS_BUILD_ID"',
        "--latest",
      );
    },
  );
  assertMutationFails(
    base,
    "missing mobile native prerequisite",
    "H16-MOBILE-RELEASE",
    (value) => {
      value.mobileWorkflow = value.mobileWorkflow.replace(
        ":app:assembleRelease",
        ":app:compileSkipped",
      );
    },
  );
  assertMutationFails(
    base,
    "mutable actionlint",
    "H16-WORKFLOW-LINT",
    (value) => {
      value.ci = value.ci.replace("actionlint@v1.7.12", "actionlint@latest");
    },
  );
  assertMutationFails(
    base,
    "removed desktop Rust gate",
    "H16-DESKTOP-RUST",
    (value) => {
      value.desktopRelease = value.desktopRelease.replace(
        "pnpm --dir apps/desktop check:rust-dependencies",
        "cargo audit --deny warnings --ignore RUSTSEC-2024-0429",
      );
    },
  );
  assertMutationFails(
    base,
    "removed desktop coverage gate",
    "H16-DESKTOP-COVERAGE",
    (value) => {
      value.desktopRelease = value.desktopRelease.replace(
        "pnpm --filter postwave-desktop-shell run test:coverage",
        "pnpm --filter postwave-desktop-shell run test",
      );
    },
  );
  assertMutationFails(
    base,
    "removed desktop function-quality ratchet",
    "H16-DESKTOP-MAINTAINABILITY",
    (value) => {
      value.desktopPackage = value.desktopPackage.replace(
        "pnpm check:function-quality",
        "function quality skipped",
      );
    },
  );
  assertMutationFails(
    base,
    "removed worker database gate",
    "H16-DATABASE-GATES",
    (value) => {
      value.ci = value.ci.replace(
        "pnpm audit:worker-db",
        "worker database audit skipped",
      );
    },
  );
  assertMutationFails(
    base,
    "removed worker database fail-closed tests",
    "H16-DATABASE-GATES",
    (value) => {
      value.ci = value.ci.replace(
        "pnpm test:worker-db-safety",
        "worker database self-tests skipped",
      );
    },
  );
  assertMutationFails(
    base,
    "removed effective migration schema gate",
    "H16-DATABASE-GATES",
    (value) => {
      value.testWorkflow = value.testWorkflow.replaceAll(
        "scripts/lint-migrations-schema.py",
        "effective migration schema verification skipped",
      );
    },
  );
  assertMutationFails(
    base,
    "removed complete tenant schema scan",
    "H16-DATABASE-GATES",
    (value) => {
      value.migrationSchema = value.migrationSchema.replaceAll(
        "verify_complete_tenant_tables",
        "complete tenant schema verification skipped",
      );
    },
  );
  assertMutationFails(
    base,
    "removed null-safe effective policy scan",
    "H16-DATABASE-GATES",
    (value) => {
      value.migrationSchema = value.migrationSchema.replaceAll(
        "verify_null_safe_tenant_policies",
        "null-safe effective policy verification skipped",
      );
    },
  );
  assertMutationFails(base, "non-blocking E2E", "H16-E2E", (value) => {
    value.e2eWorkflow = value.e2eWorkflow.replace(
      'POSTWAVE_E2E_STRICT_ASSERTIONS: "1"',
      'POSTWAVE_E2E_STRICT_ASSERTIONS: "0"',
    );
    value.e2eRunner = value.e2eRunner.replace(
      "export POSTWAVE_E2E_STRICT_ASSERTIONS=1",
      "export POSTWAVE_E2E_STRICT_ASSERTIONS=0",
    );
  });
  console.log(
    "Release-gate contract self-tests passed (fail-closed mutations).",
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const sources = loadSources();
    assertClean(sources);
    if (process.argv.includes("--self-test")) runSelfTests(sources);
    else console.log("Release-gate contracts passed.");
  } catch (error) {
    console.error(`Release-gate validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
