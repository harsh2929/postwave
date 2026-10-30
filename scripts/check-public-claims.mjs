#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registerPath = path.join(
  root,
  "docs/security/public-claims-register.json",
);
const register = JSON.parse(readFileSync(registerPath, "utf8"));
const allowedStatuses = new Set([
  "approved",
  "approved_bounded",
  "contract_only",
  "external_review_required",
  "prohibited",
  "release_catalog_only",
]);
const requiredFields = [
  "id",
  "statement",
  "status",
  "owner_role",
  "scope",
  "artifacts",
  "evidence",
  "last_verified",
  "expires_on",
];
const errors = [];
const warnings = [];
const today = new Date().toISOString().slice(0, 10);

// How long before expiry the gate starts asking for re-verification.
//
// The 2026-09-05 compliance audit (F-01) found all 15 claims expired, CI red,
// and 13 of them sharing a single expiry date. Two mechanism defects made that
// outcome likely rather than unlucky:
//
//   1. The gate went from silent to fully red in one day. There was no point
//      at which it said "this lapses soon" while a build still passed, so the
//      first signal was also a blockage.
//   2. A single shared date means the register lapses all at once, producing a
//      wall of identical failures — the most tempting possible input to a bulk
//      date-bump that re-verifies nothing. Re-dating without re-checking is
//      worse than an expired claim, because it launders a stale statement as a
//      fresh one.
//
// The warning window addresses (1); STAGGER_LIMIT below addresses (2).
const WARN_WINDOW_DAYS = 30;
const STAGGER_LIMIT = 5;

function daysBetween(fromISO, toISO) {
  const ms = Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

// A prohibition ("do not say this publicly") does not decay.
//
// Letting it expire generates noise that has to be cleared to get a green
// build, and the only way to clear it is to touch the entry — which is exactly
// the habit that produces unreviewed bulk extensions. Leaving a prohibition in
// force without review keeps the SAFE state: the worst case is that Moosewave
// keeps declining to make a claim it could now support. Relaxing one requires
// an affirmative status change, which the review below still governs.
const NON_EXPIRING_STATUSES = new Set(["prohibited"]);

if (register.schema_version !== 1 || !Array.isArray(register.claims)) {
  errors.push("claim register must use schema_version 1 and contain claims[]");
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(register.reviewed_on ?? "")) {
  errors.push("claim register reviewed_on must be YYYY-MM-DD");
} else if (register.reviewed_on > today) {
  errors.push("claim register reviewed_on cannot be in the future");
}

const seen = new Set();
for (const claim of register.claims ?? []) {
  for (const field of requiredFields) {
    if (
      claim[field] === undefined ||
      claim[field] === "" ||
      (Array.isArray(claim[field]) && claim[field].length === 0)
    ) {
      errors.push(`${claim.id ?? "<unknown>"}: missing ${field}`);
    }
  }
  if (seen.has(claim.id)) errors.push(`${claim.id}: duplicate id`);
  seen.add(claim.id);
  if (!allowedStatuses.has(claim.status)) {
    errors.push(`${claim.id}: unsupported status ${claim.status}`);
  }
  for (const field of ["artifacts", "evidence"]) {
    for (const relativePath of claim[field] ?? []) {
      if (!existsSync(path.join(root, relativePath))) {
        errors.push(
          `${claim.id}: ${field} path does not exist: ${relativePath}`,
        );
      }
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(claim.last_verified ?? "")) {
    errors.push(`${claim.id}: last_verified must be YYYY-MM-DD`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(claim.expires_on ?? "")) {
    errors.push(`${claim.id}: expires_on must be YYYY-MM-DD`);
  } else if (NON_EXPIRING_STATUSES.has(claim.status)) {
    // Recorded for review cadence, never enforced. See NON_EXPIRING_STATUSES.
    if (claim.expires_on < today) {
      warnings.push(
        `${claim.id}: ${claim.status} entry passed its review date ${claim.expires_on} (not enforced — a prohibition stays safe unreviewed)`,
      );
    }
  } else if (claim.expires_on < today) {
    errors.push(`${claim.id}: evidence expired on ${claim.expires_on}`);
  } else {
    const remaining = daysBetween(today, claim.expires_on);
    if (remaining <= WARN_WINDOW_DAYS) {
      warnings.push(
        `${claim.id}: evidence expires in ${remaining} day(s) on ${claim.expires_on} — re-verify against ${(claim.evidence ?? []).join(", ") || "its evidence"}`,
      );
    }
  }
}

// Stagger check. Warn rather than fail: a clustered register is a process
// smell, not a false public claim, and turning it into a build failure would
// just create a second thing to bulk-edit.
const expiryClusters = new Map();
for (const claim of register.claims ?? []) {
  if (NON_EXPIRING_STATUSES.has(claim.status)) continue;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(claim.expires_on ?? "")) continue;
  expiryClusters.set(
    claim.expires_on,
    (expiryClusters.get(claim.expires_on) ?? 0) + 1,
  );
}
for (const [date, count] of expiryClusters) {
  if (count > STAGGER_LIMIT) {
    warnings.push(
      `${count} claims all expire on ${date} — spread them out so the register lapses gradually instead of all at once`,
    );
  }
}

for (const requiredId of [
  "release-status",
  "certifications",
  "legal-documents",
  "public-publication-gate",
  "paid-checkout-gate",
  "affiliate-program-availability",
  "canonical-domain-contract",
]) {
  if (!seen.has(requiredId))
    errors.push(`missing governed claim ${requiredId}`);
}

const clientSourceRoots = [
  "apps/web/src",
  "apps/web/public",
  "apps/desktop/src",
  "apps/mobile/src",
  "docs-site/pages",
];
const sourceFiles = clientSourceRoots
  .flatMap((relativePath) => walk(path.join(root, relativePath)))
  .filter(
    (file) =>
      /\.(?:[cm]?[jt]sx?|json|mdx?|txt)$/.test(file) &&
      !file.includes(`${path.sep}__tests__${path.sep}`) &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
  );

for (const file of sourceFiles) {
  const text = readFileSync(file, "utf8");
  for (const phrase of register.forbidden_public_phrases ?? []) {
    if (
      text
        .toLocaleLowerCase("en-US")
        .includes(phrase.toLocaleLowerCase("en-US"))
    ) {
      errors.push(
        `${path.relative(root, file)}: forbidden unsubstantiated claim '${phrase}'`,
      );
    }
  }
}

// These are executable publication/commercial invariants, not prose-only
// entries. Keep them here so deleting a gate while leaving the register intact
// cannot produce a false-green claims audit.
requireAll("apps/web/src/lib/public-release.ts", [
  "POSTWAVE_PUBLIC_RELEASE_APPROVAL",
  'const APPROVAL_PREFIX = "approved:"',
  "return reference.length >= MIN_REFERENCE_LENGTH ? reference : null",
]);
requireAll("apps/web/src/middleware.ts", [
  "if (!publicReleaseApproved())",
  'response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive")',
]);
requireAll("apps/web/src/app/robots.ts", [
  'export const dynamic = "force-dynamic"',
  "if (!publicReleaseApproved())",
  'disallow: "/"',
]);
requireAll("apps/web/src/app/sitemap.ts", [
  'export const dynamic = "force-dynamic"',
  "if (!publicReleaseApproved()) return []",
]);
for (const relativePath of [
  "apps/web/src/app/(marketing)/legal/layout.tsx",
  "apps/web/src/app/(marketing)/vs/layout.tsx",
]) {
  requireAll(relativePath, [
    'import { notFound } from "next/navigation"',
    "notFound();",
  ]);
}

requireAll("apps/api/internal/billing/handlers.go", [
  'os.Getenv("MOOSEWAVE_BILLING_LAUNCH_APPROVAL")',
  'os.Getenv("POSTWAVE_BILLING_LAUNCH_APPROVAL")',
  "configuredProvider() == ProviderDodo",
  'errEnv("checkout_launch_blocked"',
  "http.StatusServiceUnavailable",
]);
requireAll("apps/api/internal/readiness/readiness.go", [
  '"billing_launch_approval"',
  '"MOOSEWAVE_BILLING_LAUNCH_APPROVAL"',
  '"POSTWAVE_BILLING_LAUNCH_APPROVAL"',
  '"DODO_PAYMENTS_API_KEY"',
  '"DODO_PAYMENTS_WEBHOOK_KEY"',
  '"DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY"',
]);
for (const relativePath of [
  "apps/web/src/app/(marketing)/pricing/_components/checkout-cta.tsx",
  "apps/web/src/app/(dashboard)/app/billing/upgrade/page.tsx",
]) {
  requireAll(relativePath, [
    "mailto:sales@moosewave.com",
    "closed during production qualification",
  ]);
  rejectAll(relativePath, ["createCheckoutSession"]);
}

requireAll("apps/web/src/app/(marketing)/affiliates/page.tsx", [
  "Affiliate enrollment is closed.",
  "not accepting affiliate applications",
  "issuing public",
  "tracking links",
  "No commission rate, attribution window, payment schedule",
]);
rejectAll("apps/web/src/app/(marketing)/affiliates/page.tsx", [
  "mailto:",
  "/affiliates/apply",
  "/api/public/affiliates",
  "<form",
]);
requireAll("apps/web/src/app/(marketing)/legal/affiliate-terms/page.tsx", [
  "No affiliate program terms are in force",
  "There is no public affiliate offer to accept.",
  "will not apply retroactively",
]);
for (const relativePath of [
  "apps/web/src/app/(dashboard)/app/affiliates/page.tsx",
  "apps/web/src/app/(dashboard)/app/affiliates/[id]/page.tsx",
]) {
  requireAll(relativePath, ["AffiliateProgramUnavailable"]);
  rejectAll(relativePath, [
    "@/lib/affiliates-api",
    "/api/v1/admin/affiliates",
    "AffiliatesTable",
    "PayoutDialog",
  ]);
}
for (const relativePath of [
  "apps/web/src/app/(marketing)/affiliates/apply/page.tsx",
  "apps/web/src/app/(marketing)/affiliates/apply/layout.tsx",
  "apps/web/src/app/(marketing)/affiliates/apply/success/page.tsx",
]) {
  requireAbsent(relativePath);
}
rejectAll("apps/api/main.go", ["affiliatesDeps.MountPublicRoutes"]);
rejectAll("apps/web/src/middleware.ts", ["pw_ref"]);
rejectAll("apps/web/src/app/api/[...path]/route.ts", ["pw_ref"]);

// Warnings print on both paths. On the failing path they would otherwise be
// buried under the errors that caused the exit, and "expires in 3 days" is
// precisely the notice that stops the NEXT outage.
if (warnings.length > 0) {
  console.warn("Public claims gate warnings:");
  for (const warning of warnings) console.warn(`- ${warning}`);
  console.warn("");
}

if (errors.length > 0) {
  console.error("Public claims gate failed:");
  for (const error of errors) console.error(`- ${error}`);
  console.error(
    "\nRe-verify each claim against its evidence before changing expires_on. " +
      "Bumping the date without re-checking the evidence converts a stale " +
      "claim into one that looks fresh, which is the failure this gate exists " +
      "to prevent.",
  );
  process.exit(1);
}

console.log(
  `Public claims gate passed: ${register.claims.length} registered claims, ${sourceFiles.length} client-facing source files scanned.`,
);

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".next" ||
      entry.name === ".turbo" ||
      entry.name === "dist" ||
      entry.name === "coverage" ||
      entry.name === "out" ||
      entry.name === "storybook-static"
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && statSync(full).size <= 2 * 1024 * 1024)
      files.push(full);
  }
  return files;
}

function requireAll(relativePath, snippets) {
  const fullPath = path.join(root, relativePath);
  if (!existsSync(fullPath)) {
    errors.push(`${relativePath}: required governed source is missing`);
    return;
  }
  const source = readFileSync(fullPath, "utf8");
  for (const snippet of snippets) {
    if (!source.includes(snippet)) {
      errors.push(
        `${relativePath}: missing governed invariant ${JSON.stringify(snippet)}`,
      );
    }
  }
}

function rejectAll(relativePath, snippets) {
  const fullPath = path.join(root, relativePath);
  if (!existsSync(fullPath)) {
    errors.push(`${relativePath}: required governed source is missing`);
    return;
  }
  const source = readFileSync(fullPath, "utf8");
  for (const snippet of snippets) {
    if (source.includes(snippet)) {
      errors.push(
        `${relativePath}: forbidden governed surface ${JSON.stringify(snippet)}`,
      );
    }
  }
}

function requireAbsent(relativePath) {
  if (existsSync(path.join(root, relativePath))) {
    errors.push(
      `${relativePath}: closed affiliate enrollment surface must remain absent`,
    );
  }
}
