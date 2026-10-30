// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "config/document-governance.json");
const failures = [];

function fail(message) {
  failures.push(message);
}

function repositoryPath(value, context) {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    fail(`${context}: path must be a non-empty trimmed string`);
    return null;
  }
  const absolute = resolve(ROOT, value);
  const back = relative(ROOT, absolute);
  if (back === ".." || back.startsWith(`..${sep}`) || back === "") {
    fail(`${context}: path escapes or resolves to repository root: ${value}`);
    return null;
  }
  return absolute;
}

function parseDate(value, context) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`${context}: lastReviewed must be YYYY-MM-DD`);
    return null;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    fail(`${context}: invalid lastReviewed date ${value}`);
    return null;
  }
  return parsed;
}

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (error) {
  console.error(
    `documentation contracts: cannot parse ${CONFIG_PATH}: ${error.message}`,
  );
  process.exit(1);
}

const allowedTopKeys = new Set([
  "schemaVersion",
  "currentAudit",
  "archiveRoot",
  "documents",
  "executableContracts",
]);
for (const key of Object.keys(config)) {
  if (!allowedTopKeys.has(key)) fail(`unknown configuration key: ${key}`);
}
if (config.schemaVersion !== 1) fail("schemaVersion must equal 1");
if (!Array.isArray(config.documents) || config.documents.length === 0) {
  fail("documents must be a non-empty array");
}
if (!Array.isArray(config.executableContracts)) {
  fail("executableContracts must be an array");
}

const nowOverride = process.env.POSTWAVE_DOCUMENT_CHECK_DATE;
const now = nowOverride
  ? parseDate(nowOverride, "POSTWAVE_DOCUMENT_CHECK_DATE")
  : new Date();
const documentByPath = new Map();
const documentKeys = new Set([
  "path",
  "owner",
  "status",
  "version",
  "lastReviewed",
  "reviewIntervalDays",
]);

for (const [index, document] of (config.documents ?? []).entries()) {
  const context = `documents[${index}]`;
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail(`${context}: entry must be an object`);
    continue;
  }
  for (const key of Object.keys(document)) {
    if (!documentKeys.has(key)) fail(`${context}: unknown key ${key}`);
  }
  const absolute = repositoryPath(document.path, context);
  if (documentByPath.has(document.path))
    fail(`${context}: duplicate path ${document.path}`);
  documentByPath.set(document.path, document);
  if (!absolute || !existsSync(absolute) || !statSync(absolute).isFile()) {
    fail(`${context}: document does not exist: ${document.path}`);
  }
  if (
    typeof document.owner !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(document.owner)
  ) {
    fail(`${context}: owner must be a stable lower-kebab identifier`);
  }
  if (!new Set(["active", "reference"]).has(document.status)) {
    fail(`${context}: status must be active or reference`);
  }
  if (!Number.isSafeInteger(document.version) || document.version < 1) {
    fail(`${context}: version must be a positive integer`);
  }
  if (
    !Number.isSafeInteger(document.reviewIntervalDays) ||
    document.reviewIntervalDays < 1 ||
    document.reviewIntervalDays > 365
  ) {
    fail(
      `${context}: reviewIntervalDays must be an integer from 1 through 365`,
    );
  }
  const reviewed = parseDate(document.lastReviewed, context);
  if (reviewed && now) {
    const ageDays = Math.floor(
      (now.valueOf() - reviewed.valueOf()) / 86_400_000,
    );
    if (ageDays < 0) fail(`${context}: lastReviewed is in the future`);
    if (ageDays > document.reviewIntervalDays) {
      fail(
        `${context}: review expired ${ageDays - document.reviewIntervalDays} day(s) ago`,
      );
    }
  }
}

const runbookDir = join(ROOT, "docs/runbooks");
for (const name of readdirSync(runbookDir).filter((name) =>
  name.endsWith(".md"),
)) {
  const path = `docs/runbooks/${name}`;
  if (!documentByPath.has(path))
    fail(`active runbook is unowned/unversioned: ${path}`);
}

const currentAudit = repositoryPath(config.currentAudit, "currentAudit");
const archiveRoot = repositoryPath(config.archiveRoot, "archiveRoot");
if (!currentAudit || !existsSync(currentAudit))
  fail(`current audit does not exist: ${config.currentAudit}`);
if (
  !archiveRoot ||
  !existsSync(archiveRoot) ||
  !statSync(archiveRoot).isDirectory()
) {
  fail(`audit archive directory does not exist: ${config.archiveRoot}`);
}
const auditRoot = join(ROOT, "docs/audits");
for (const entry of readdirSync(auditRoot, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".md")) {
    const path = `docs/audits/${entry.name}`;
    const governedReference = documentByPath.get(path)?.status === "reference";
    if (
      path !== config.currentAudit &&
      entry.name !== "README.md" &&
      !governedReference
    ) {
      fail(`superseded audit must be under ${config.archiveRoot}: ${path}`);
    }
  }
}

function stripCodeFences(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

function linkTarget(raw) {
  const unwrapped = raw.trim().replace(/^<|>$/g, "");
  const titleOffset = unwrapped.search(/\s+["']/);
  return titleOffset === -1 ? unwrapped : unwrapped.slice(0, titleOffset);
}

function filesBelow(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

for (const document of config.documents ?? []) {
  if (document.status !== "active") continue;
  const absolute = repositoryPath(document.path, document.path);
  if (!absolute || !existsSync(absolute)) continue;
  const source = stripCodeFences(readFileSync(absolute, "utf8"));
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = linkTarget(match[1]);
    if (
      !target ||
      target.startsWith("#") ||
      /^(?:https?:|mailto:|tel:|app:)/i.test(target)
    )
      continue;
    const withoutFragment = target.split("#", 1)[0].split("?", 1)[0];
    if (!withoutFragment) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(withoutFragment);
    } catch {
      fail(`${document.path}: malformed percent-encoding in link ${target}`);
      continue;
    }
    const resolved = resolve(dirname(absolute), normalize(decoded));
    const back = relative(ROOT, resolved);
    if (back === ".." || back.startsWith(`..${sep}`)) {
      fail(`${document.path}: relative link escapes repository: ${target}`);
    } else if (!existsSync(resolved)) {
      fail(`${document.path}: broken local link: ${target}`);
    }
  }
}

function docsRouteForFile(file, root) {
  const source = relative(root, file)
    .replaceAll(sep, "/")
    .replace(/\.mdx$/u, "");
  const withoutIndex =
    source === "index" ? "" : source.replace(/\/index$/u, "");
  return `/${withoutIndex}`;
}

function findForbiddenClaims(source, claims) {
  const normalizedSource = source.toLocaleLowerCase("en-US");
  return claims.filter((claim) =>
    normalizedSource.includes(claim.toLocaleLowerCase("en-US")),
  );
}

function validateDocsSitePolicy() {
  const policyPath = join(ROOT, "docs-site/content-policy.json");
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (error) {
    fail(`docs-site content policy is missing or invalid: ${error.message}`);
    return;
  }
  const allowedKeys = new Set([
    "schemaVersion",
    "canonicalRoot",
    "archivedRoot",
    "retiredRoot",
    "owner",
    "status",
    "version",
    "lastReviewed",
    "reviewIntervalDays",
    "forbiddenPublishedMarkers",
    "forbiddenPublicClaims",
  ]);
  for (const key of Object.keys(policy)) {
    if (!allowedKeys.has(key))
      fail(`docs-site content policy has unknown key ${key}`);
  }
  if (policy.schemaVersion !== 2)
    fail("docs-site content policy schemaVersion must equal 2");
  if (policy.canonicalRoot !== "apps/web/src/app/(docs)/docs") {
    fail(
      "canonical public docs must remain in the signed @postwave/web route tree",
    );
  }
  if (policy.archivedRoot !== "docs-site/pages") {
    fail(
      "docs-site/pages must remain the explicitly archived Nextra content root",
    );
  }
  if (policy.retiredRoot !== "docs-site/content") {
    fail("docs-site retiredRoot must identify docs-site/content");
  }
  if (existsSync(join(ROOT, policy.retiredRoot))) {
    fail("retired duplicate docs-site/content tree has returned");
  }
  if (
    policy.owner !== "product-documentation" ||
    policy.status !== "archived-non-production"
  ) {
    fail(
      "docs-site policy must remain owned and explicitly archived-non-production",
    );
  }
  if (!Number.isSafeInteger(policy.version) || policy.version < 1) {
    fail("docs-site content policy version must be a positive integer");
  }
  if (
    !Number.isSafeInteger(policy.reviewIntervalDays) ||
    policy.reviewIntervalDays < 1 ||
    policy.reviewIntervalDays > 365
  ) {
    fail("docs-site reviewIntervalDays must be an integer from 1 through 365");
  }
  const reviewed = parseDate(policy.lastReviewed, "docs-site content policy");
  if (reviewed && now) {
    const ageDays = Math.floor(
      (now.valueOf() - reviewed.valueOf()) / 86_400_000,
    );
    if (ageDays < 0) fail("docs-site content review date is in the future");
    if (ageDays > policy.reviewIntervalDays) {
      fail(
        `docs-site collection review expired ${ageDays - policy.reviewIntervalDays} day(s) ago`,
      );
    }
  }
  for (const key of ["forbiddenPublishedMarkers", "forbiddenPublicClaims"]) {
    if (
      !Array.isArray(policy[key]) ||
      policy[key].length === 0 ||
      policy[key].some((marker) => typeof marker !== "string" || !marker.trim())
    ) {
      fail(`docs-site ${key} must be a non-empty string array`);
    }
  }

  const canonicalRoot = join(ROOT, policy.canonicalRoot);
  if (!existsSync(canonicalRoot) || !statSync(canonicalRoot).isDirectory()) {
    fail("canonical @postwave/web docs root does not exist");
    return;
  }
  const canonicalPages = filesBelow(canonicalRoot).filter((file) =>
    file.endsWith(`${sep}page.tsx`),
  );
  if (canonicalPages.length === 0) {
    fail("canonical @postwave/web docs root contains no route pages");
  }

  const archivedRoot = join(ROOT, policy.archivedRoot);
  if (!existsSync(archivedRoot) || !statSync(archivedRoot).isDirectory()) {
    fail("archived Nextra content root does not exist");
    return;
  }
  const archivedPages = filesBelow(archivedRoot).filter((file) =>
    file.endsWith(".mdx"),
  );
  if (archivedPages.length === 0)
    fail("archived Nextra root contains no MDX pages");
  const routes = new Set(
    archivedPages.map((file) => docsRouteForFile(file, archivedRoot)),
  );

  const claimSources = [
    ...filesBelow(canonicalRoot).filter((file) =>
      /\.(?:mdx?|tsx?)$/u.test(file),
    ),
    ...archivedPages,
  ];
  for (const file of claimSources) {
    const path = relative(ROOT, file).replaceAll(sep, "/");
    const source = readFileSync(file, "utf8");
    for (const claim of findForbiddenClaims(
      source,
      policy.forbiddenPublicClaims ?? [],
    )) {
      fail(`${path}: contains forbidden unsupported public claim ${claim}`);
    }
  }

  for (const file of archivedPages) {
    const path = relative(ROOT, file).replaceAll(sep, "/");
    const source = readFileSync(file, "utf8");
    if (!/^---\n[\s\S]*?^title:\s*\S[^\n]*\n[\s\S]*?^---\n/mu.test(source)) {
      fail(`${path}: archived MDX page lacks title front matter`);
    }
    for (const marker of policy.forbiddenPublishedMarkers) {
      if (source.includes(marker))
        fail(`${path}: contains forbidden editorial marker ${marker}`);
    }

    const prose = stripCodeFences(source);
    const targets = [
      ...[...prose.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)].map((match) =>
        linkTarget(match[1]),
      ),
      ...[...prose.matchAll(/\bhref=["']([^"']+)["']/gu)].map(
        (match) => match[1],
      ),
    ];
    for (const target of targets) {
      if (
        !target ||
        target.startsWith("#") ||
        /^(?:https?:|mailto:|tel:)/iu.test(target)
      ) {
        continue;
      }
      const rawPath = target.split("#", 1)[0].split("?", 1)[0];
      if (!rawPath) continue;
      if (rawPath.startsWith("/images/")) {
        if (!existsSync(join(ROOT, "docs-site/public", rawPath))) {
          fail(`${path}: referenced public image does not exist: ${rawPath}`);
        }
        continue;
      }
      if (rawPath.startsWith("/")) {
        const route =
          rawPath.length > 1 ? rawPath.replace(/\/$/u, "") : rawPath;
        if (!routes.has(route)) fail(`${path}: broken docs route ${target}`);
        continue;
      }
      let decoded;
      try {
        decoded = decodeURIComponent(rawPath);
      } catch {
        fail(`${path}: malformed percent-encoding in link ${target}`);
        continue;
      }
      const candidate = resolve(dirname(file), decoded);
      const options = [
        candidate,
        `${candidate}.mdx`,
        join(candidate, "index.mdx"),
      ];
      if (!options.some((option) => existsSync(option))) {
        fail(`${path}: broken relative docs link ${target}`);
      }
    }
  }

  const archiveReadme = readFileSync(join(ROOT, "docs-site/README.md"), "utf8");
  const canonicalReadme = readFileSync(
    join(ROOT, "apps/web/src/app/(docs)/README.md"),
    "utf8",
  );
  const theme = readFileSync(join(ROOT, "docs-site/theme.config.tsx"), "utf8");
  const nextConfig = readFileSync(
    join(ROOT, "docs-site/next.config.mjs"),
    "utf8",
  );
  const packageJson = JSON.parse(
    readFileSync(join(ROOT, "docs-site/package.json"), "utf8"),
  );
  if (
    !archiveReadme.includes("ARCHIVED — NON-PRODUCTION") ||
    !archiveReadme.includes(policy.canonicalRoot) ||
    !canonicalReadme.includes("sole canonical") ||
    !canonicalReadme.includes("docs-site/")
  ) {
    fail(
      "canonical/archive docs READMEs must declare one source of public truth",
    );
  }
  if (
    packageJson.scripts?.build !==
      "node ../scripts/refuse-archived-docs-build.mjs build" ||
    packageJson.scripts?.start !==
      "node ../scripts/refuse-archived-docs-build.mjs start" ||
    packageJson.scripts?.["build:archive-preview"] !==
      "POSTWAVE_ARCHIVED_DOCS_PREVIEW=1 next build" ||
    packageJson.scripts?.["start:archive-preview"] !==
      "POSTWAVE_ARCHIVED_DOCS_PREVIEW=1 next start -p 3001"
  ) {
    fail(
      "archived docs package must refuse normal builds and expose preview-only build/start scripts",
    );
  }
  if (
    !nextConfig.includes(
      'process.env.POSTWAVE_ARCHIVED_DOCS_PREVIEW !== "1"',
    ) ||
    !nextConfig.includes('key: "X-Robots-Tag"') ||
    !nextConfig.includes('value: "noindex, nofollow, noarchive"') ||
    !theme.includes("Moosewave Docs Archive") ||
    !theme.includes('content="noindex,nofollow,noarchive"')
  ) {
    fail(
      "archived docs preview must enforce build opt-in, noindex headers, and visible labeling",
    );
  }

  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const rootPackage = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  const prelaunch = readFileSync(
    join(ROOT, "scripts/prelaunch-local-gate.mjs"),
    "utf8",
  );
  if (
    !ci.includes("pnpm --filter @postwave/docs build:archive-preview") ||
    !prelaunch.includes('"build:archive-preview"') ||
    !rootPackage.scripts?.build?.includes("!@postwave/docs")
  ) {
    fail(
      "production builds must exclude archived docs; CI/prelaunch may use the preview build only",
    );
  }
}

validateDocsSitePolicy();

const mailchimpMigrationTruthPaths = [
  "apps/web/src/app/(docs)/docs/migrations/[source]/page.tsx",
  "apps/web/src/app/(dashboard)/app/migrations/[jobId]/pilot-acceptance-card.tsx",
  "apps/web/src/app/(dashboard)/app/migrations/[jobId]/selected-audience-scope-card.tsx",
  "apps/web/src/app/(dashboard)/app/migrations/new/[source]/review-step.tsx",
  "apps/web/src/app/(marketing)/migrate-anywhere/page.tsx",
  "docs/USER-GUIDE.md",
  "docs/integrations/mailchimp-migration.md",
  "docs/integrations/mailchimp.md",
  "docs/mailchimp-gap-alleviation-register.json",
  "docs/support/macros.json",
  "docs-site/pages/api-reference/migrations.mdx",
  "docs-site/pages/automation/migrating-from-mailchimp-journeys.mdx",
  "docs-site/pages/migration/index.mdx",
  "docs-site/pages/migration/mailchimp.mdx",
  "docs-site/pages/migration/rollback.mdx",
  "docs-site/pages/migration/verification-report.mdx",
  "packages/migrate/MIGRATION_PLAYBOOK.md",
  "packages/migrate/README.md",
];

const forbiddenMailchimpMigrationClaims = [
  {
    label: "invented granular Mailchimp OAuth scopes",
    pattern: /\b(?:lists|campaigns|automations|account):read\b/iu,
  },
  {
    label: "invented Mailchimp OAuth scope list",
    pattern: /Moosewave requests these scopes/iu,
  },
  {
    label: "Mailchimp API-key customer authentication",
    pattern: /Mailchimp API key/iu,
  },
  {
    label: "executable Customer Journey translation",
    pattern:
      /(?:most journeys translate cleanly|journey block into a Moosewave node|Customer Journeys as paused|automations\/customer journeys|Customer Journeys\s*\|\s*Moosewave automations)/iu,
  },
  {
    label: "snapshot or archive-vault rollback",
    pattern:
      /(?:Every committed migration creates a snapshot|archive vault|status flipped to `?purged|true reset)/iu,
  },
  {
    label: "unimplemented exponential-jitter retry promise",
    pattern: /exponential jitter/iu,
  },
  {
    label: "obsolete verification-report schema",
    pattern:
      /(?:"migration_id"\s*:|"entities"\s*:|"unsupported_features"\s*:|"integrity_hash"\s*:)/iu,
  },
  {
    label: "obsolete verification-report phase field",
    pattern: /"phase"\s*:/iu,
    exceptPaths: ["docs/mailchimp-gap-alleviation-register.json"],
  },
  {
    label: "obsolete migration jobs route",
    pattern: /\/api\/v1\/migrations\/jobs\//iu,
  },
  {
    label: "obsolete verification route",
    pattern: /\/migrations\/jobs\/\{id\}\/verify/iu,
  },
  {
    label: "incorrect Mailchimp per-second limit",
    pattern: /10\s+(?:calls|req(?:uests)?)\s*\/\s*sec(?:ond)?/iu,
  },
  {
    label: "unsupported subscriber-completeness guarantee",
    pattern: /(?:preserved at 100% in every case|fully reverse the import)/iu,
  },
  {
    label: "false fixed-lifetime Mailchimp token claim",
    pattern: /token'?s documented lifetime[^.]*elapsed/iu,
  },
  {
    label: "obsolete account-global campaign-history claim",
    pattern:
      /templates and campaign history (?:can )?remain account-(?:wide|global)/iu,
  },
];

function mailchimpMigrationClaimIssues(path, source) {
  const issues = [];
  for (const claim of forbiddenMailchimpMigrationClaims) {
    if (claim.exceptPaths?.includes(path)) continue;
    if (claim.pattern.test(source)) issues.push(`${path}: ${claim.label}`);
  }
  return issues;
}

for (const path of mailchimpMigrationTruthPaths) {
  const absolute = join(ROOT, path);
  if (!existsSync(absolute)) {
    fail(`Mailchimp migration truth document is missing: ${path}`);
    continue;
  }
  for (const issue of mailchimpMigrationClaimIssues(
    path,
    readFileSync(absolute, "utf8"),
  )) {
    fail(issue);
  }
}

for (const [path, requiredFragments] of Object.entries({
  "apps/web/src/app/(dashboard)/app/migrations/[jobId]/selected-audience-scope-card.tsx":
    [
      "campaigns, and reports",
      "Account-global: templates, landing pages, ecommerce evidence",
    ],
  "apps/web/src/app/(dashboard)/app/migrations/new/[source]/review-step.tsx": [
    "Review account-global Mailchimp surfaces",
  ],
  "docs/integrations/mailchimp-migration.md": [
    "LISTMONK_TENANT_MODE=dedicated",
    "LISTMONK_DEDICATED_TENANT_ID",
  ],
  "docs-site/pages/api-reference/migrations.mdx": [
    "LISTMONK_TENANT_MODE=dedicated",
    "LISTMONK_DEDICATED_TENANT_ID",
  ],
  "docs-site/pages/migration/mailchimp.mdx": [
    "account-global",
    "LISTMONK_DEDICATED_TENANT_ID",
  ],
  "packages/migrate/MIGRATION_PLAYBOOK.md": [
    "LISTMONK_TENANT_MODE=dedicated",
    "LISTMONK_DEDICATED_TENANT_ID",
  ],
  "services/migration/README.md": [
    "MAILCHIMP_AUDIENCE_IDS",
    "never inferred from discovery order",
    "LISTMONK_TENANT_MODE",
    "LISTMONK_DEDICATED_TENANT_ID",
  ],
})) {
  const source = readFileSync(join(ROOT, path), "utf8");
  for (const fragment of requiredFragments) {
    if (!source.includes(fragment)) {
      fail(`${path}: required Mailchimp contract text missing: ${fragment}`);
    }
  }
}

for (const historicalPath of [
  "docs/qa-report-2026-06.md",
  "docs/mailchimp-migration-readiness-audit-2026-07-02.md",
]) {
  const source = readFileSync(join(ROOT, historicalPath), "utf8");
  if (!source.includes("Historical") && !source.includes("historical")) {
    fail(
      `${historicalPath}: superseded Mailchimp evidence lacks a historical warning`,
    );
  }
}

if (process.argv.includes("--self-test")) {
  const claims = ["unsupported refund promise", "unsupported uptime promise"];
  const detected = findForbiddenClaims(
    "prefix unsupported uptime promise suffix",
    claims,
  );
  if (
    detected.length !== 1 ||
    detected[0] !== "unsupported uptime promise" ||
    findForbiddenClaims("evidence-backed neutral copy", claims).length !== 0
  ) {
    fail("forbidden public-claim scanner self-test failed");
  }
  const mailchimpMutations = [
    "Moosewave requests these scopes: lists:read",
    "Customer Journeys as paused Moosewave automations",
    "Every committed migration creates a snapshot in the archive vault",
    "Moosewave retries with exponential jitter",
    '{"migration_id":"id","unsupported_features":[]}',
    "Mailchimp API key",
    "Mailchimp caps us at 10 calls/sec",
    "Your subscriber list is preserved at 100% in every case",
    "The token's documented lifetime elapsed mid-job",
    "Templates and campaign history remain account-wide",
  ];
  for (const mutation of mailchimpMutations) {
    if (mailchimpMigrationClaimIssues("self-test", mutation).length === 0) {
      fail(`Mailchimp migration claim scanner missed mutation: ${mutation}`);
    }
  }
  if (
    mailchimpMigrationClaimIssues(
      "self-test",
      "Mailchimp OAuth follows the user's role; Customer Journey graphs remain manual-review evidence.",
    ).length !== 0
  ) {
    fail("Mailchimp migration claim scanner rejected truthful guidance");
  }
}

const contractKeys = new Set(["documents", "command"]);
for (const [index, contract] of (config.executableContracts ?? []).entries()) {
  const context = `executableContracts[${index}]`;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    fail(`${context}: entry must be an object`);
    continue;
  }
  for (const key of Object.keys(contract)) {
    if (!contractKeys.has(key)) fail(`${context}: unknown key ${key}`);
  }
  if (!Array.isArray(contract.documents) || contract.documents.length === 0) {
    fail(`${context}: documents must be a non-empty array`);
  } else {
    for (const path of contract.documents) {
      if (!documentByPath.has(path))
        fail(`${context}: ungoverned document ${path}`);
    }
  }
  if (typeof contract.command !== "string" || !contract.command.trim()) {
    fail(`${context}: command must be a non-empty string`);
    continue;
  }
  const [executable, ...args] = contract.command.trim().split(/\s+/);
  if (!new Set(["node", "bash"]).has(executable)) {
    fail(`${context}: executable must be node or bash`);
    continue;
  }
  const script = args[0];
  if (!script || script.startsWith("-") || !existsSync(join(ROOT, script))) {
    fail(`${context}: command script does not exist: ${script ?? "<missing>"}`);
    continue;
  }
  if (process.env.POSTWAVE_EXECUTE_DOCUMENT_CONTRACTS === "1") {
    try {
      execFileSync(executable, args, {
        cwd: ROOT,
        stdio: "inherit",
        env: process.env,
      });
    } catch (error) {
      fail(
        `${context}: command failed with exit ${error.status ?? "unknown"}: ${contract.command}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`documentation contracts: FAIL (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `documentation contracts: PASS (${documentByPath.size} governed documents, ${config.executableContracts.length} executable contracts)`,
);
