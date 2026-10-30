#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Audit the exact candidate workspace: tracked files plus new, non-ignored
// files. This prevents a newly added source file from bypassing the brand gate
// merely because it has not been staged yet.
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  },
)
  .split("\0")
  .filter(Boolean);

const legacyPattern = /\bPostwave\b|postwave\.com|com\.postwave|postwave:\/\//g;
const pathAllowlist = new Set([
  "docs/launch/moosewave-compatibility-boundary.md",
  // These migrations are checksum-pinned because they have already shipped.
  // Their comments are historical bytes, not current customer-facing copy.
  "infra/migrations/0063_assets.sql",
  "infra/migrations/0075_founding_member.sql",
  "infra/migrations/0086_dmarc_reports.sql",
  "infra/migrations/0088_outbound_webhooks.sql",
  "infra/migrations/0122_scim_provisioning.sql",
  "infra/migrations/0124_hipaa_compliance.sql",
  "scripts/release/check-moosewave-brand.mjs",
]);

function allowed(path, line) {
  if (pathAllowlist.has(path)) return true;
  // Applied migrations are checksum-pinned release history. Their comments
  // and seeded compatibility values describe the former product identity;
  // current data is canonicalized by the Moosewave cutover migrations.
  if (path.startsWith("infra/migrations/")) return true;
  if (path.startsWith("apps/api/internal/assurancecorpus/corpus/")) return true;
  return (
    line.includes("X-Postwave") ||
    line.includes("Postwave/Backup") ||
    line.includes("harsh2929/postwave") ||
    /Postwave-(?:Event|Idempotency-Key|Signature)/.test(line)
  );
}

const violations = [];
for (const path of files) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    legacyPattern.lastIndex = 0;
    if (legacyPattern.test(line) && !allowed(path, line)) {
      violations.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Legacy customer-facing brand references found:\n");
  console.error(violations.slice(0, 100).join("\n"));
  if (violations.length > 100) {
    console.error(`\n...and ${violations.length - 100} more`);
  }
  process.exit(1);
}

console.log("Moosewave brand boundary passed.");
