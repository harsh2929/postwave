#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect as inspectMigrationNumbering } from "./check-migration-numbering.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

const checks = [
  checkNoNotImplemented(),
  checkMigrationVersions(),
  checkEnvExamples(),
  checkDevBypassesDocumented(),
  checkDocsPlaceholders(),
  checkNoSyntheticCustomerMetrics(),
  checkNoStaticMockImports(),
  checkMigrationFixtureLibrary(),
  checkObservabilityArtifacts(),
  checkPinnedWorkflowActions(),
  checkFrontendToolchainAlignment(),
  checkAuditPortalCredentialBoundary(),
  checkDockerfileDigestPins(),
  checkProprietaryStubs(),
  checkSDKParityFloor(),
  checkDesktopReleaseConfig(),
  checkMobileReleaseConfig(),
  checkMobileAppLinks(),
  checkRunbookReferences(),
];

let blocked = false;
for (const check of checks) {
  const icon =
    check.status === "pass"
      ? "PASS"
      : check.status === "warn"
        ? "WARN"
        : "FAIL";
  console.log(`${icon} ${check.id}: ${check.message}`);
  if (check.details?.length) {
    for (const detail of check.details) console.log(`  - ${detail}`);
  }
  if (check.status === "fail") blocked = true;
}

if (blocked) process.exit(1);

function checkFrontendToolchainAlignment() {
  const rootPackage = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  const expectedVite = "8.0.16";
  const expectedReactPlugin = "6.0.3";
  const details = [];

  for (const workspace of ["apps/audit-portal", "apps/desktop"]) {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, workspace, "package.json"), "utf8"),
    );
    if (manifest.devDependencies?.vite !== expectedVite) {
      details.push(`${workspace}: vite must be pinned to ${expectedVite}`);
    }
    if (
      manifest.devDependencies?.["@vitejs/plugin-react"] !== expectedReactPlugin
    ) {
      details.push(
        `${workspace}: @vitejs/plugin-react must be pinned to ${expectedReactPlugin}`,
      );
    }
  }

  if (rootPackage.pnpm?.overrides?.["vite@<8.0.16"] !== expectedVite) {
    details.push(
      "root Vite security override does not match the supported toolchain",
    );
  }

  return {
    id: "frontend_toolchain_alignment",
    status: details.length ? "fail" : "pass",
    message: details.length
      ? "Frontend Vite manifests, plugins, and security override have drifted."
      : "Frontend Vite manifests, plugins, and security override are aligned.",
    details,
  };
}

function checkAuditPortalCredentialBoundary() {
  const details = [];
  const files = {
    auth: readFileSync(join(ROOT, "apps/api/internal/audit/portal.go"), "utf8"),
    handler: readFileSync(
      join(ROOT, "apps/api/internal/handlers/audit_portal.go"),
      "utf8",
    ),
    client: readFileSync(
      join(ROOT, "apps/audit-portal/src/lib/portal-api-client.ts"),
      "utf8",
    ),
    bootstrap: readFileSync(
      join(ROOT, "apps/audit-portal/src/lib/bootstrap.ts"),
      "utf8",
    ),
    nginx: readFileSync(join(ROOT, "apps/audit-portal/nginx.conf"), "utf8"),
    vite: readFileSync(join(ROOT, "apps/audit-portal/vite.config.ts"), "utf8"),
    wrapper: readFileSync(
      join(ROOT, "packages/audit-portal-react/src/PostwaveAuditPortal.tsx"),
      "utf8",
    ),
    migration: readFileSync(
      join(ROOT, "infra/migrations/1713_audit_portal_one_time_exchange.sql"),
      "utf8",
    ),
  };

  if (!files.auth.includes("/portal/audit#bootstrap=")) {
    details.push("portal links are not fragment-only");
  }
  if (
    !files.auth.includes("session_token_hash") ||
    !files.auth.includes("exchanged_at IS NULL")
  ) {
    details.push("durable one-time exchange checks are missing");
  }
  if (files.client.includes("Authorization")) {
    details.push("portal renderer client mentions an Authorization credential");
  }
  if (!files.client.includes('credentials: "include"')) {
    details.push("portal renderer does not use the dedicated cookie");
  }
  if (
    !files.bootstrap.includes("history.replaceState") ||
    !files.bootstrap.includes('params.get("bootstrap")')
  ) {
    details.push(
      "portal does not synchronously capture and scrub its fragment",
    );
  }
  if (
    !files.handler.includes('Header.Get("Authorization")') ||
    !files.handler.includes("conflicting_credentials")
  ) {
    details.push("portal middleware does not reject credential smuggling");
  }
  if (
    !files.nginx.includes("location = /portal/audit") ||
    !files.nginx.includes("location /portal/audit/")
  ) {
    details.push(
      "standalone portal does not fail closed on legacy token paths",
    );
  }
  if (
    !files.nginx.includes("access_log off") ||
    !files.nginx.includes("POSTWAVE_PORTAL_FRAME_ANCESTORS")
  ) {
    details.push("standalone portal logging/CSP boundary is incomplete");
  }
  if (!/sourcemap:\s*false/u.test(files.vite)) {
    details.push("portal production source maps are enabled");
  }
  if (
    !files.wrapper.includes("ev.source !== iframeRef.current?.contentWindow")
  ) {
    details.push("iframe messages are not pinned to the portal window");
  }
  if (
    !files.migration.includes("FORCE ROW LEVEL SECURITY") ||
    !files.migration.includes("session_token_hash")
  ) {
    details.push(
      "one-time exchange migration lacks forced RLS or cookie digest state",
    );
  }

  return {
    id: "audit_portal_credential_boundary",
    status: details.length ? "fail" : "pass",
    message: details.length
      ? "Audit-portal one-time credential and tenant boundary has regressed."
      : "Audit portal uses a one-time fragment exchange, dedicated HttpOnly cookie, and forced-RLS read boundary.",
    details,
  };
}

function checkNoNotImplemented() {
  const hits = scanFiles(
    ["apps/api", "services", "apps/web/src"],
    /\.(go|ts|tsx|js|mjs)$/u,
    [
      /\bhttp\.StatusNotImplemented\b/u,
      /\bStatusNotImplemented\b/u,
      /\bWriteHeader\(\s*501\s*\)/u,
      /\bhttp\.Error\([^,\n]+,\s*501\s*\)/u,
      /not implemented/iu,
      /NotImplemented/u,
    ],
  );
  return {
    id: "no_not_implemented_runtime_paths",
    status: hits.length ? "fail" : "pass",
    message: hits.length
      ? "Runtime code still contains 501/not-implemented markers."
      : "Runtime code has no 501/not-implemented markers.",
    details: hits.slice(0, 20),
  };
}

function checkMigrationVersions() {
  const dir = join(ROOT, "infra/migrations");
  const report = inspectMigrationNumbering(
    readdirSync(dir).filter((file) => file.endsWith(".sql")),
  );
  const grownNumbers = new Set(
    report.grownExceptions.map((entry) => entry.number),
  );
  const details = [
    ...report.malformed.map(
      (file) => `${file}: filename is not <4 digits>_<snake_case>.sql`,
    ),
    ...report.duplicates
      .filter(
        (entry) => !entry.known && !grownNumbers.has(entry.number),
      )
      .map(
        (entry) => `${entry.number}: unreviewed collision (${entry.files.join(", ")})`,
      ),
    ...report.grownExceptions.map(
      (entry) =>
        `${entry.number}: recorded collision gained ${entry.unexpected.join(", ")}`,
    ),
    ...report.staleExceptions.map(
      (entry) =>
        `${entry.number}: recorded collision no longer matches (${entry.found.join(", ")})`,
    ),
  ];
  const knownCount = report.duplicates.filter((entry) => entry.known).length;
  return {
    id: "unique_migration_versions",
    status: details.length ? "fail" : "pass",
    message: details.length
      ? "Unreviewed migration filename or version-prefix collisions found."
      : knownCount > 0
        ? `No unreviewed migration-number collisions; ${knownCount} exact shipped exception recorded.`
        : "Migration version prefixes are unique.",
    details,
  };
}

function checkEnvExamples() {
  const files = [
    "apps/api/.env.example",
    "apps/web/.env.example",
    "services/migration/.env.example",
    "services/deliverability/.env.example",
  ];
  const required = [
    "POSTWAVE_INTERNAL_API_TOKEN",
    "POSTWAVE_SENDING_KEK",
    "POSTWAVE_AUTH_HMAC_PEPPER",
    "POSTWAVE_MAILER",
    "POSTWAVE_AUTH_FROM_ADDRESS",
    "LISTMONK_WEBHOOK_SECRET",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_SECRET_KEY",
    "SHOPIFY_CLIENT_ID",
    "SHOPIFY_CLIENT_SECRET",
    "SHOPIFY_WEBHOOK_SECRET",
    "POSTWAVE_MIGRATION_SESSION_KEK",
    "MAILCHIMP_CLIENT_ID",
    "MAILCHIMP_CLIENT_SECRET",
    "CONVERTKIT_CLIENT_ID",
    "CONVERTKIT_CLIENT_SECRET",
    "DELIVERABILITY_SERVICE_URL",
    "GEMINI_API_KEY",
    "HCTI_USER_ID",
    "HCTI_API_KEY",
    "DMARC_IMAP_HOST",
    "DMARC_IMAP_USER",
    "DMARC_IMAP_PASSWORD",
    "SEEDLIST_CONFIG_PATH",
    "POSTWAVE_PUBLIC_BASE_URL",
    "EXPO_PUSH_ACCESS_TOKEN",
    "SMS_DEFAULT_PROVIDER",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_MESSAGING_SERVICE_SID",
    "TWILIO_FROM_NUMBER",
    "TWILIO_WEBHOOK_AUTH_TOKEN",
    "TWILIO_STATUS_CALLBACK_URL",
    "TELNYX_API_KEY",
    "TELNYX_FROM_NUMBER",
    "TELNYX_MESSAGING_PROFILE_ID",
    "TELNYX_WEBHOOK_URL",
    "TELNYX_PUBLIC_KEY",
    "BANDWIDTH_ACCOUNT_ID",
    "BANDWIDTH_API_USERNAME",
    "BANDWIDTH_API_PASSWORD",
    "BANDWIDTH_WEBHOOK_TOKEN",
    "BANDWIDTH_WEBHOOK_USERNAME",
    "BANDWIDTH_WEBHOOK_PASSWORD",
    "BANDWIDTH_APPLICATION_ID",
    "BANDWIDTH_FROM_NUMBER",
  ];
  const text = files.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
  const missing = required.filter((key) => !text.includes(key));
  return {
    id: "env_examples_cover_production_secrets",
    status: missing.length ? "warn" : "pass",
    message: missing.length
      ? "Env examples are missing some production secret names."
      : "Env examples include the production secret names audited here.",
    details: missing,
  };
}

function checkNoSyntheticCustomerMetrics() {
  const hits = scanFiles(["apps/web/src"], /\.(ts|tsx|js|mjs)$/u, [
    /Mock dataset doesn't carry/iu,
    /stylized list/iu,
    /synthetic (production|customer|metric)/iu,
    /fake (analytics|metric|conversion|payout)/iu,
  ]);
  return {
    id: "web_no_synthetic_customer_metrics",
    status: hits.length ? "fail" : "pass",
    message: hits.length
      ? "Web runtime still contains customer-facing synthetic metric fallbacks."
      : "Web runtime has no audited synthetic customer metric fallbacks.",
    details: hits.slice(0, 20),
  };
}

function checkNoStaticMockImports() {
  const hits = scanWholeFiles(["apps/web/src"], /\.(ts|tsx)$/u, [
    /import\s+(?!type\b)[\s\S]{0,800}?from\s+["'](?:@\/lib\/|\.{1,2}\/)[^"']+-mocks["']/u,
  ]);
  return {
    id: "web_no_static_mock_imports",
    status: hits.length ? "fail" : "pass",
    message: hits.length
      ? "Web runtime statically imports mock fixture modules."
      : "Web runtime loads mock fixtures only through explicit dynamic mock mode.",
    details: hits.slice(0, 20),
  };
}

function checkSDKParityFloor() {
  const files = [
    "packages/sdk-py/postwave/resources/events.py",
    "packages/sdk-py/postwave/resources/segments.py",
  ];
  const missing = [];
  for (const file of files) {
    try {
      readFileSync(join(ROOT, file), "utf8");
    } catch {
      missing.push(file);
    }
  }
  const client = readFileSync(
    join(ROOT, "packages/sdk-py/postwave/client.py"),
    "utf8",
  );
  for (const attr of ["self.events", "self.segments"]) {
    if (!client.includes(attr)) missing.push(`client.py missing ${attr}`);
  }
  return {
    id: "python_sdk_parity_floor",
    status: missing.length ? "fail" : "pass",
    message: missing.length
      ? "Python SDK is missing required parity resources."
      : "Python SDK exposes the required parity floor resources.",
    details: missing,
  };
}

function checkDesktopReleaseConfig() {
  const details = [];
  let cfg;
  try {
    cfg = JSON.parse(
      readFileSync(
        join(ROOT, "apps/desktop/src-tauri/tauri.conf.json"),
        "utf8",
      ),
    );
  } catch (err) {
    return {
      id: "desktop_release_config",
      status: "fail",
      message: "Desktop Tauri config could not be parsed.",
      details: [err.message],
    };
  }

  if (!cfg.productName) details.push("missing productName");
  if (!/^com\.moosewave\./u.test(cfg.identifier ?? "")) {
    details.push("identifier must be a stable com.moosewave.* bundle id");
  }
  if (cfg.bundle?.macOS?.hardenedRuntime !== true) {
    details.push("macOS hardenedRuntime must stay enabled");
  }
  if (!cfg.app?.security?.csp) details.push("missing Tauri CSP");

  const updater = cfg.plugins?.updater;
  if (updater?.active === true) {
    if (!String(updater.pubkey ?? "").trim()) {
      details.push("updater is active but pubkey is empty");
    }
    if (!Array.isArray(updater.endpoints) || updater.endpoints.length === 0) {
      details.push("updater is active but no endpoints are configured");
    }
  }

  const releaseWorkflow = readFileSync(
    join(ROOT, ".github/workflows/desktop-release.yml"),
    "utf8",
  );
  const versionPreflight = readFileSync(
    join(ROOT, "apps/desktop/scripts/validate-release-version.mjs"),
    "utf8",
  );
  const environmentPreflight = readFileSync(
    join(ROOT, "apps/desktop/scripts/validate-release-env.mjs"),
    "utf8",
  );
  if (
    !versionPreflight.includes('argument !== "--dry-run"') ||
    !environmentPreflight.includes('argument !== "--dry-run"') ||
    !releaseWorkflow.includes("release:version-check -- --dry-run") ||
    !releaseWorkflow.includes("release:env-check -- --dry-run")
  ) {
    details.push(
      "manual desktop releases must execute explicit dry-run preflights",
    );
  }
  if (
    versionPreflight.includes("skipping version check") ||
    environmentPreflight.includes("preflight skipped")
  ) {
    details.push(
      "desktop preflights must not report an implicit skip as success",
    );
  }
  if (/^[ \t]+dry_run:/mu.test(releaseWorkflow)) {
    details.push("desktop workflow must not expose an unused dry_run input");
  }

  return {
    id: "desktop_release_config",
    status: details.length ? "fail" : "pass",
    message: details.length
      ? "Desktop release config is not store/distribution safe."
      : "Desktop release config keeps updater/signing-sensitive defaults safe.",
    details,
  };
}

function checkMobileReleaseConfig() {
  const details = [];
  let cfg;
  try {
    cfg = JSON.parse(
      readFileSync(join(ROOT, "apps/mobile/app.json"), "utf8"),
    ).expo;
  } catch (err) {
    return {
      id: "mobile_release_config",
      status: "fail",
      message: "Mobile Expo config could not be parsed.",
      details: [err.message],
    };
  }

  if (!cfg?.scheme) details.push("missing deep-link scheme");
  if (!/^com\.moosewave\./u.test(cfg?.ios?.bundleIdentifier ?? "")) {
    details.push("iOS bundleIdentifier must be a stable com.moosewave.* id");
  }
  if (!/^com\.moosewave\./u.test(cfg?.android?.package ?? "")) {
    details.push("Android package must be a stable com.moosewave.* id");
  }
  if (!cfg?.ios?.infoPlist?.NSCameraUsageDescription) {
    details.push("iOS camera permission reason is missing");
  }
  const privacy = cfg?.ios?.privacyManifests;
  if (privacy?.NSPrivacyTracking !== false) {
    details.push(
      "iOS privacy manifest must explicitly disable tracking unless policy changes",
    );
  }
  const collected = new Set(
    (privacy?.NSPrivacyCollectedDataTypes ?? []).map(
      (entry) => entry.NSPrivacyCollectedDataType,
    ),
  );
  for (const required of [
    "NSPrivacyCollectedDataTypeEmailAddress",
    "NSPrivacyCollectedDataTypeUserID",
    "NSPrivacyCollectedDataTypeDeviceID",
    "NSPrivacyCollectedDataTypeCrashData",
    "NSPrivacyCollectedDataTypePerformanceData",
  ]) {
    if (!collected.has(required))
      details.push(`iOS privacy manifest missing ${required}`);
  }
  const permissions = new Set(cfg?.android?.permissions ?? []);
  if (!permissions.has("android.permission.POST_NOTIFICATIONS")) {
    details.push(
      "Android POST_NOTIFICATIONS permission should be declared for notification flows",
    );
  }
  if (
    !Array.isArray(cfg?.android?.intentFilters) ||
    cfg.android.intentFilters.length === 0
  ) {
    details.push("Android app links/deep links are not configured");
  }

  return {
    id: "mobile_release_config",
    status: details.length ? "fail" : "pass",
    message: details.length
      ? "Mobile release metadata/privacy config is incomplete."
      : "Mobile release metadata and privacy manifest are present.",
    details,
  };
}

function checkMobileAppLinks() {
  const required = [
    "apps/web/src/app/.well-known/apple-app-site-association/route.ts",
    "apps/web/src/app/.well-known/assetlinks.json/route.ts",
  ];
  const missing = [];
  for (const file of required) {
    try {
      readFileSync(join(ROOT, file), "utf8");
    } catch {
      missing.push(file);
    }
  }
  return {
    id: "mobile_app_links_served",
    status: missing.length ? "fail" : "pass",
    message: missing.length
      ? "Mobile universal/app-link verification routes are missing from the web app."
      : "Mobile universal/app-link verification routes are served by the web app.",
    details: missing,
  };
}

function checkRunbookReferences() {
  const details = [];
  const accountBan = readFileSync(
    join(ROOT, "docs/runbooks/account-ban.md"),
    "utf8",
  );
  if (accountBan.includes("TODO: file does not exist yet")) {
    details.push(
      "docs/runbooks/account-ban.md still references a missing seedlist provisioning runbook",
    );
  }
  try {
    readFileSync(join(ROOT, "docs/runbooks/seedlist-provisioning.md"), "utf8");
  } catch {
    details.push("docs/runbooks/seedlist-provisioning.md is missing");
  }
  return {
    id: "runbook_references_resolve",
    status: details.length ? "fail" : "pass",
    message: details.length
      ? "Runbooks still contain unresolved operational references."
      : "Runbook cross-references needed for launch resolve.",
    details,
  };
}

function checkMigrationFixtureLibrary() {
  const missing = [];
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(
        join(ROOT, "packages/migrate/fixtures/manifest.json"),
        "utf8",
      ),
    );
  } catch (err) {
    missing.push(`packages/migrate/fixtures/manifest.json: ${err.message}`);
  }
  const required = [
    "mailchimp",
    "convertkit",
    "beehiiv",
    "mailerlite",
    "substack",
    "csv",
  ];
  const sources = new Map((manifest?.sources ?? []).map((s) => [s.source, s]));
  for (const source of required) {
    const entry = sources.get(source);
    if (!entry) {
      missing.push(`missing source ${source}`);
      continue;
    }
    if (!entry.files?.length) missing.push(`${source}: no files listed`);
    for (const file of entry.files ?? []) {
      try {
        readFileSync(join(ROOT, "packages/migrate/fixtures", file), "utf8");
      } catch {
        missing.push(`${source}: missing fixture file ${file}`);
      }
    }
  }
  return {
    id: "migration_fixture_library",
    status: missing.length ? "fail" : "pass",
    message: missing.length
      ? "Migration fixture library is incomplete."
      : "Migration fixture library covers launch and assisted-beta sources.",
    details: missing,
  };
}

function checkObservabilityArtifacts() {
  const required = [
    "infra/grafana/dashboards/sendloop.json",
    "infra/grafana/dashboards/recurrence_scanner.json",
    "infra/grafana/dashboards/postwave-release-overview.json",
    "infra/grafana/dashboards/campaign-assurance.json",
    "infra/grafana/alerts/sendloop_silent.yml",
    "infra/grafana/alerts/campaign_assurance.yml",
    "infra/grafana/alerts/release_core.yml",
    "infra/grafana/alerts/automation_ops.yml",
    "infra/grafana/alerts/sms_ops.yml",
    "docs/runbooks/dashboards.md",
    "docs/runbooks/provider-rehearsal.md",
  ];
  const missing = [];
  for (const file of required) {
    try {
      readFileSync(join(ROOT, file), "utf8");
    } catch {
      missing.push(file);
    }
  }
  return {
    id: "observability_artifacts",
    status: missing.length ? "fail" : "pass",
    message: missing.length
      ? "Required dashboards, alerts, or runbooks are missing."
      : "Required dashboards, alerts, and runbooks are present.",
    details: missing,
  };
}

function checkPinnedWorkflowActions() {
  const hits = [];
  const dir = join(ROOT, ".github/workflows");
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/u.test(f))) {
    const rel = `.github/workflows/${file}`;
    const lines = readFileSync(join(dir, file), "utf8").split(/\r?\n/u);
    lines.forEach((line, idx) => {
      const match = line.match(/\buses:\s*([^\s#]+)@([^\s#]+)/u);
      if (!match) return;
      const ref = match[2];
      if (!/^[a-f0-9]{40}$/iu.test(ref)) {
        hits.push(`${rel}:${idx + 1}: ${match[1]}@${ref}`);
      }
    });
  }
  return {
    id: "github_actions_pinned",
    status: hits.length ? "fail" : "pass",
    message: hits.length
      ? "Some GitHub Actions still use mutable refs."
      : "GitHub Actions are pinned to immutable commit SHAs.",
    details: hits,
  };
}

function checkDockerfileDigestPins() {
  const hits = [];
  const dockerfiles = [
    "Dockerfile.go",
    "apps/audit-portal/Dockerfile",
    "apps/ops/Dockerfile",
    "apps/web/Dockerfile",
    "infra/migrations/Dockerfile",
  ];
  for (const file of dockerfiles) {
    const lines = readFileSync(join(ROOT, file), "utf8").split(/\r?\n/u);
    lines.forEach((line, idx) => {
      const match = line.trim().match(/^FROM\s+([^\s]+)(?:\s+AS\s+\w+)?$/iu);
      if (!match) return;
      const image = match[1];
      if (image !== "scratch" && !/@sha256:[a-f0-9]{64}$/iu.test(image)) {
        hits.push(`${file}:${idx + 1}: ${image}`);
      }
    });
  }
  return {
    id: "docker_base_images_pinned",
    status: hits.length ? "fail" : "pass",
    message: hits.length
      ? "Docker base images are missing immutable digest pins."
      : "Docker base images are pinned by digest.",
    details: hits,
  };
}

function checkProprietaryStubs() {
  const required = [
    "proprietary-stubs/README.md",
    "proprietary-stubs/prompts/diagnostician/system.md",
    "proprietary-stubs/prompts/diagnostician/few_shot.md",
    "proprietary-stubs/prompts/voice/sequence_system.md",
    "proprietary-stubs/prompts/voice/regenerate_system.md",
    "proprietary-stubs/eval/diagnostician-cases/sample.json",
    "proprietary-stubs/templates/voice-templates/basic-newsletter.json",
  ];
  const missing = [];
  for (const file of required) {
    try {
      readFileSync(join(ROOT, file), "utf8");
    } catch {
      missing.push(file);
    }
  }
  return {
    id: "proprietary_stub_assets",
    status: missing.length ? "fail" : "pass",
    message: missing.length
      ? "Redistributable proprietary asset stubs are incomplete."
      : "Redistributable proprietary asset stubs are present.",
    details: missing,
  };
}

function checkDevBypassesDocumented() {
  const text = readFileSync(join(ROOT, "apps/api/.env.example"), "utf8");
  const bypasses = [
    "POSTWAVE_DEV_TENANT_SLUG_HEADER",
    "POSTWAVE_DEV_ADMIN_ROLE_HEADER",
    "POSTWAVE_DEV_SHOPIFY_WEBHOOK_BYPASS",
    "POSTWAVE_DEV_LISTMONK_WEBHOOK_BYPASS",
  ];
  const missing = bypasses.filter((key) => !text.includes(key));
  return {
    id: "dev_bypasses_visible",
    status: missing.length ? "warn" : "pass",
    message: missing.length
      ? "Some dev bypass flags are not visible in the API env example."
      : "Dev bypass flags are visible in the API env example.",
    details: missing,
  };
}

function checkDocsPlaceholders() {
  // The in-web route group is canonical; docs-site/pages is an archived,
  // non-production migration source. Scan both so archived content cannot
  // quietly reintroduce placeholders before it is ported or retired. The old
  // docs-site/content tree must remain absent.
  const hits = scanFiles(
    ["apps/web/src/app/(docs)", "docs-site/pages"],
    /\.(md|mdx|ts|tsx)$/u,
    [/placeholder\.svg/u, /\]\(placeholder\)/u],
  );
  return {
    id: "docs_no_placeholder_assets",
    status: hits.length ? "fail" : "pass",
    message: hits.length
      ? "Canonical or archived docs still reference placeholder screenshot assets."
      : "Canonical and archived docs do not reference placeholder screenshot assets.",
    details: hits.slice(0, 20),
  };
}

function scanFiles(dirs, ext, patterns) {
  const hits = [];
  for (const dir of dirs) walk(join(ROOT, dir), hits, ext, patterns);
  return hits;
}

function scanWholeFiles(dirs, ext, patterns) {
  const hits = [];
  for (const dir of dirs) walkWhole(join(ROOT, dir), hits, ext, patterns);
  return hits;
}

function walk(dir, hits, ext, patterns) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", "dist", "out"].includes(entry.name))
        continue;
      walk(path, hits, ext, patterns);
      continue;
    }
    if (!ext.test(entry.name)) continue;
    if (entry.name.endsWith("_test.go")) continue;
    if (/\.(test|spec)\.(ts|tsx|js|mjs)$/u.test(entry.name)) continue;
    const rel = path.slice(ROOT.length);
    const lines = readFileSync(path, "utf8").split(/\r?\n/u);
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("#")
      ) {
        return;
      }
      if (patterns.some((pattern) => pattern.test(line)))
        hits.push(`${rel}:${idx + 1}: ${trimmed}`);
    });
  }
}

function walkWhole(dir, hits, ext, patterns) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", "dist", "out"].includes(entry.name))
        continue;
      walkWhole(path, hits, ext, patterns);
      continue;
    }
    if (!ext.test(entry.name)) continue;
    if (/\.(test|spec)\.(ts|tsx|js|mjs)$/u.test(entry.name)) continue;
    const text = readFileSync(path, "utf8");
    if (patterns.some((pattern) => pattern.test(text))) {
      hits.push(path.slice(ROOT.length));
    }
  }
}
