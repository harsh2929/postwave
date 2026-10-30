#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "infra", "migrations");
const baselinePath = join(
  root,
  "scripts",
  "check-worker-db-safety-baseline.json",
);

const unsafeCastPattern = String.raw`current_setting\s*\(\s*'app\.tenant_id'\s*,\s*true\s*\)\s*::\s*uuid\b`;
const expectedDisposition = "forward-repaired";
const expectedObligation = "zero-unsafe-public-policy-casts";

const workerMigration =
  "infra/migrations/0096_worker_rls_and_global_ops_grants.sql";
const requiredWorkerSnippets = [
  "GRANT SELECT, INSERT, UPDATE, DELETE ON web_vitals_events TO postwave_app",
  "GRANT SELECT, INSERT, UPDATE, DELETE ON stripe_webhook_attempts TO postwave_app",
  "CREATE POLICY campaign_recipients_worker_select ON campaign_recipients",
  "CREATE POLICY tenant_visible ON outbound_webhooks",
  "CREATE POLICY tenant_visible ON outbound_webhook_deliveries",
  "NULLIF(current_setting('app.tenant_id', true), '')::uuid",
];

const repairSnippets = [
  "FROM pg_policy AS policy",
  "JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace",
  "namespace.nspname = 'public'",
  "pg_get_expr(policy.polqual, policy.polrelid)",
  "pg_get_expr(policy.polwithcheck, policy.polrelid)",
  "replace(policy_row.qual, unsafe_cast, safe_cast)",
  "replace(policy_row.with_check, unsafe_cast, safe_cast)",
  "ALTER POLICY %I ON %I.%I USING (%s) WITH CHECK (%s)",
  "IF EXISTS (",
  "legacy tenant policy repair left a direct app.tenant_id uuid cast",
];

const effectiveSchemaSnippets = [
  "def verify_null_safe_tenant_policies(",
  "tenant_policy_expression_count = verify_null_safe_tenant_policies(",
  "unsafe direct app.tenant_id UUID cast",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function mask(char) {
  return char === "\n" ? "\n" : " ";
}

// Remove top-level PostgreSQL comments while preserving byte offsets. Quoted
// SQL remains visible because a dynamic CREATE/ALTER POLICY is executable and
// must not become a scanner bypass merely because it is built as a string.
function stripSqlComments(sql) {
  let output = "";
  let index = 0;
  let state = "code";
  let blockDepth = 0;
  let dollarTag = "";

  while (index < sql.length) {
    if (state === "code") {
      if (sql.startsWith("--", index)) {
        output += "  ";
        index += 2;
        state = "line-comment";
        continue;
      }
      if (sql.startsWith("/*", index)) {
        output += "  ";
        index += 2;
        blockDepth = 1;
        state = "block-comment";
        continue;
      }
      if (sql[index] === "'") {
        output += sql[index++];
        state = "single-quote";
        continue;
      }
      if (sql[index] === '"') {
        output += sql[index++];
        state = "double-quote";
        continue;
      }
      if (sql[index] === "$") {
        const match = sql
          .slice(index)
          .match(/^(?:\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/);
        if (match) {
          dollarTag = match[0];
          output += dollarTag;
          index += dollarTag.length;
          state = "dollar-quote";
          continue;
        }
      }
      output += sql[index++];
      continue;
    }

    if (state === "line-comment") {
      output += mask(sql[index]);
      if (sql[index] === "\n") state = "code";
      index += 1;
      continue;
    }

    if (state === "block-comment") {
      if (sql.startsWith("/*", index)) {
        output += "  ";
        index += 2;
        blockDepth += 1;
        continue;
      }
      if (sql.startsWith("*/", index)) {
        output += "  ";
        index += 2;
        blockDepth -= 1;
        if (blockDepth === 0) state = "code";
        continue;
      }
      output += mask(sql[index++]);
      continue;
    }

    if (state === "single-quote") {
      output += sql[index];
      if (sql[index] === "'" && sql[index + 1] === "'") {
        output += sql[index + 1];
        index += 2;
        continue;
      }
      if (sql[index] === "'") state = "code";
      index += 1;
      continue;
    }

    if (state === "double-quote") {
      output += sql[index];
      if (sql[index] === '"' && sql[index + 1] === '"') {
        output += sql[index + 1];
        index += 2;
        continue;
      }
      if (sql[index] === '"') state = "code";
      index += 1;
      continue;
    }

    if (state === "dollar-quote") {
      if (sql.startsWith(dollarTag, index)) {
        output += dollarTag;
        index += dollarTag.length;
        state = "code";
      } else {
        output += sql[index++];
      }
    }
  }

  return output;
}

function unsafeCastLocations(sql) {
  const visibleSql = stripSqlComments(sql);
  const matches = [];
  for (const match of visibleSql.matchAll(new RegExp(unsafeCastPattern, "g"))) {
    matches.push({
      index: match.index,
      line: visibleSql.slice(0, match.index).split("\n").length,
    });
  }
  return matches;
}

function migrationVersion(path) {
  const match = basename(path).match(/^(\d{4})_/);
  return match ? Number(match[1]) : -1;
}

function loadMigrationSources() {
  const sources = new Map();
  for (const name of readdirSync(migrationsDir)
    .filter((entry) => /^\d{4}_.*\.sql$/.test(entry))
    .sort()) {
    const path = `infra/migrations/${name}`;
    sources.set(path, readFileSync(join(root, path), "utf8"));
  }
  return sources;
}

function validateReview(review, now, failures) {
  if (!review || typeof review !== "object") {
    failures.push("baseline review metadata is missing");
    return;
  }
  if (review.owner !== "database-platform-and-security") {
    failures.push(
      "baseline review owner must be database-platform-and-security",
    );
  }
  if (typeof review.expires_if !== "string" || review.expires_if.length < 20) {
    failures.push(
      "baseline review must declare its target/effective-schema expiry condition",
    );
  }
  if (
    typeof review.review_by !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(review.review_by)
  ) {
    failures.push("baseline review_by must be an ISO date");
    return;
  }
  const reviewDeadline = Date.parse(`${review.review_by}T23:59:59.999Z`);
  if (!Number.isFinite(reviewDeadline) || now.getTime() > reviewDeadline) {
    failures.push(`baseline review expired on ${review.review_by}`);
  }
}

function validateBaselineShape(baseline, failures) {
  if (baseline.version !== 1) failures.push("baseline version must be 1");
  if (baseline.scope !== "all-numbered-migration-sources") {
    failures.push("baseline scope must cover all numbered migration sources");
  }
  if (
    !Number.isSafeInteger(baseline.expected_findings) ||
    baseline.expected_findings < 1
  ) {
    failures.push("baseline expected_findings must be a positive integer");
  }
  if (
    !Number.isSafeInteger(baseline.expected_occurrences) ||
    baseline.expected_occurrences < 1
  ) {
    failures.push("baseline expected_occurrences must be a positive integer");
  }
  if (!Array.isArray(baseline.findings))
    failures.push("baseline findings must be an array");
  if (!baseline.repair || typeof baseline.repair !== "object") {
    failures.push("baseline repair contract is missing");
  }
  if (
    !baseline.effective_schema ||
    typeof baseline.effective_schema !== "object"
  ) {
    failures.push("baseline effective-schema contract is missing");
  }
}

function auditContract({
  baseline,
  migrationSources,
  effectiveSchemaSource,
  now = new Date(),
}) {
  const failures = [];
  validateBaselineShape(baseline, failures);
  validateReview(baseline.review, now, failures);
  if (failures.length > 0) return failures;

  const repairPath = baseline.repair.path;
  const repairSql = migrationSources.get(repairPath);
  if (
    typeof repairPath !== "string" ||
    !/^infra\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(repairPath)
  ) {
    failures.push("repair path must name one numbered migration");
  } else if (repairSql === undefined) {
    failures.push(`repair migration is missing: ${repairPath}`);
  } else {
    if (sha256(repairSql) !== baseline.repair.source_sha256) {
      failures.push(
        `${repairPath} checksum does not match its reviewed repair contract`,
      );
    }
    if (baseline.repair.obligation !== expectedObligation) {
      failures.push(`repair obligation must be ${expectedObligation}`);
    }
    for (const snippet of repairSnippets) {
      if (!repairSql.includes(snippet)) {
        failures.push(
          `${repairPath} is missing required repair semantic: ${snippet}`,
        );
      }
    }
  }

  if (
    baseline.effective_schema.verifier !== "scripts/lint-migrations-schema.py"
  ) {
    failures.push("effective-schema verifier path is not canonical");
  }
  if (baseline.effective_schema.obligation !== expectedObligation) {
    failures.push(`effective-schema obligation must be ${expectedObligation}`);
  }
  for (const snippet of effectiveSchemaSnippets) {
    if (!effectiveSchemaSource.includes(snippet)) {
      failures.push(
        `effective-schema verifier is missing required semantic: ${snippet}`,
      );
    }
  }

  const workerSql = migrationSources.get(workerMigration);
  if (workerSql === undefined) {
    failures.push(`required worker migration is missing: ${workerMigration}`);
  } else {
    for (const snippet of requiredWorkerSnippets) {
      if (!workerSql.includes(snippet)) {
        failures.push(
          `${workerMigration} is missing required worker-safety semantic: ${snippet}`,
        );
      }
    }
  }

  const actual = new Map();
  for (const [path, sql] of migrationSources) {
    const locations = unsafeCastLocations(sql);
    if (locations.length > 0) actual.set(path, locations);
  }

  const findings = baseline.findings;
  if (findings.length !== baseline.expected_findings) {
    failures.push(
      `baseline declares ${baseline.expected_findings} findings but contains ${findings.length}`,
    );
  }

  const reviewed = new Set();
  let reviewedOccurrences = 0;
  for (const finding of findings) {
    const path = finding?.path;
    if (
      typeof path !== "string" ||
      !/^infra\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(path)
    ) {
      failures.push(`invalid reviewed migration path: ${String(path)}`);
      continue;
    }
    if (reviewed.has(path)) {
      failures.push(`duplicate reviewed migration path: ${path}`);
      continue;
    }
    reviewed.add(path);
    const sql = migrationSources.get(path);
    if (sql === undefined) {
      failures.push(`reviewed historical migration is missing: ${path}`);
      continue;
    }
    if (finding.disposition !== expectedDisposition) {
      failures.push(
        `${path} has unsupported disposition ${String(finding.disposition)}`,
      );
    }
    if (finding.repair_migration !== repairPath) {
      failures.push(`${path} is not bound to the canonical repair migration`);
    }
    if (finding.effective_schema_obligation !== expectedObligation) {
      failures.push(`${path} is not bound to the effective-schema obligation`);
    }
    if (sha256(sql) !== finding.source_sha256) {
      failures.push(
        `${path} checksum drifted from its reviewed historical bytes`,
      );
    }
    const locations = actual.get(path) ?? [];
    if (locations.length !== finding.occurrences) {
      failures.push(
        `${path} expected ${finding.occurrences} executable unsafe cast(s), found ${locations.length}`,
      );
    }
    if (migrationVersion(path) >= migrationVersion(repairPath)) {
      failures.push(
        `${path} is not historical to its declared repair migration`,
      );
    }
    reviewedOccurrences += finding.occurrences;
  }

  if (reviewedOccurrences !== baseline.expected_occurrences) {
    failures.push(
      `baseline declares ${baseline.expected_occurrences} occurrences but reviews ${reviewedOccurrences}`,
    );
  }
  for (const [path, locations] of actual) {
    if (!reviewed.has(path)) {
      failures.push(
        `${path} contains ${locations.length} unreviewed executable direct app.tenant_id UUID cast(s) at line(s) ${locations.map(({ line }) => line).join(", ")}`,
      );
    }
  }
  for (const path of reviewed) {
    if (!actual.has(path)) {
      failures.push(
        `${path} has a stale disposition with no executable unsafe cast`,
      );
    }
  }

  return failures;
}

function loadCanonicalInputs() {
  return {
    baseline: JSON.parse(readFileSync(baselinePath, "utf8")),
    migrationSources: loadMigrationSources(),
    effectiveSchemaSource: readFileSync(
      join(root, "scripts", "lint-migrations-schema.py"),
      "utf8",
    ),
  };
}

function cloneInputs(inputs) {
  return {
    baseline: structuredClone(inputs.baseline),
    migrationSources: new Map(inputs.migrationSources),
    effectiveSchemaSource: inputs.effectiveSchemaSource,
  };
}

function runSelfTests() {
  const canonical = loadCanonicalInputs();
  const canonicalFailures = auditContract(canonical);
  if (canonicalFailures.length > 0) {
    throw new Error(
      `canonical contract is not valid:\n${canonicalFailures.join("\n")}`,
    );
  }

  let mutationCount = 0;
  const expectFailure = (name, mutate, expectedText) => {
    const input = cloneInputs(canonical);
    mutate(input);
    const failures = auditContract(input);
    if (!failures.some((failure) => failure.includes(expectedText))) {
      throw new Error(
        `${name} did not fail closed with ${JSON.stringify(expectedText)}: ${failures.join(" | ")}`,
      );
    }
    mutationCount += 1;
  };

  expectFailure(
    "expired review",
    ({ baseline }) => {
      baseline.review.review_by = "2020-01-01";
    },
    "baseline review expired",
  );
  expectFailure(
    "missing disposition",
    ({ baseline }) => {
      baseline.findings.pop();
    },
    "baseline declares",
  );
  expectFailure(
    "wrong occurrence count",
    ({ baseline }) => {
      baseline.findings[0].occurrences += 1;
      baseline.expected_occurrences += 1;
    },
    "executable unsafe cast(s)",
  );
  expectFailure(
    "historical checksum drift",
    ({ baseline, migrationSources }) => {
      const path = baseline.findings[0].path;
      migrationSources.set(path, `${migrationSources.get(path)}\n-- drift\n`);
    },
    "checksum drifted",
  );
  expectFailure(
    "unreviewed later unsafe cast",
    ({ migrationSources }) => {
      migrationSources.set(
        "infra/migrations/9999_unreviewed_worker_cast.sql",
        "CREATE POLICY unsafe ON sample USING (tenant_id = current_setting('app.tenant_id', true)::uuid);",
      );
    },
    "unreviewed executable direct",
  );
  expectFailure(
    "weakened repair migration",
    ({ baseline, migrationSources }) => {
      const path = baseline.repair.path;
      const mutated = migrationSources
        .get(path)
        .replace(
          "replace(policy_row.qual, unsafe_cast, safe_cast)",
          "policy_row.qual",
        );
      migrationSources.set(path, mutated);
      baseline.repair.source_sha256 = sha256(mutated);
    },
    "missing required repair semantic",
  );
  expectFailure(
    "removed effective-schema verifier",
    (input) => {
      input.effectiveSchemaSource = input.effectiveSchemaSource.replace(
        "def verify_null_safe_tenant_policies(",
        "def removed_null_safe_policy_verifier(",
      );
    },
    "effective-schema verifier is missing",
  );
  expectFailure(
    "unsupported disposition",
    ({ baseline }) => {
      baseline.findings[0].disposition = "waived";
    },
    "unsupported disposition",
  );

  const commentOnly = cloneInputs(canonical);
  commentOnly.migrationSources.set(
    "infra/migrations/9999_comment_only.sql",
    "-- current_setting('app.tenant_id', true)::uuid is documentation, not SQL\nSELECT 1;\n",
  );
  const commentFailures = auditContract(commentOnly);
  if (commentFailures.length > 0) {
    throw new Error(
      `comment-only control was misclassified: ${commentFailures.join(" | ")}`,
    );
  }

  console.log(
    `Worker DB safety self-tests passed (${mutationCount} fail-closed mutations plus comment-only control).`,
  );
}

if (process.argv.includes("--self-test")) {
  runSelfTests();
} else {
  const inputs = loadCanonicalInputs();
  const failures = auditContract(inputs);
  if (failures.length > 0) {
    console.error("Worker DB safety audit failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    `Worker DB safety audit passed: ${inputs.baseline.expected_findings} checksum-pinned historical migrations / ${inputs.baseline.expected_occurrences} direct casts are bound to ${basename(inputs.baseline.repair.path)} and a zero-unsafe-policy effective-schema assertion.`,
  );
}
