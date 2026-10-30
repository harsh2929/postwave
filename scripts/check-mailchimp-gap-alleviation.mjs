#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const registerPath = resolve(
  repoRoot,
  "docs/mailchimp-gap-alleviation-register.json",
);

const register = JSON.parse(readFileSync(registerPath, "utf8"));
const sourcePath = resolve(repoRoot, register.source_gap_analysis ?? "");
const source = readFileSync(sourcePath, "utf8");

const gapIDPattern =
  "(?:AUD|CAM|AUT|CNT|ONS|COM|REP|SMS|ADV|DEV|DEL|MIG-MC)-\\d+";
const gapIDRe = new RegExp(`^\\|\\s*(${gapIDPattern})\\s*\\|`, "gm");
const sourceIDs = [...source.matchAll(gapIDRe)].map((match) => match[1]);
const sourceSet = new Set(sourceIDs);
const validStatuses = new Set(register.valid_statuses ?? []);
const seen = new Map();
const failures = [];

if (!register.version) failures.push("register.version is required");
if (!register.owner) failures.push("register.owner is required");
if (!register.source_gap_analysis)
  failures.push("register.source_gap_analysis is required");
if (!Array.isArray(register.initiatives) || register.initiatives.length === 0) {
  failures.push("register.initiatives must be a non-empty array");
}
if (validStatuses.size === 0)
  failures.push("register.valid_statuses must be non-empty");
if (sourceIDs.length === 0)
  failures.push("no gap IDs found in source gap analysis");

const requiredStrings = [
  "id",
  "stream",
  "phase",
  "status",
  "owner",
  "alleviation",
];
const requiredArrays = ["gap_ids", "acceptance", "implementation_anchors"];

for (const [index, initiative] of (register.initiatives ?? []).entries()) {
  const label = initiative.id || `initiative[${index}]`;
  for (const key of requiredStrings) {
    if (typeof initiative[key] !== "string" || initiative[key].trim() === "") {
      failures.push(`${label}: missing ${key}`);
    }
  }
  for (const key of requiredArrays) {
    if (!Array.isArray(initiative[key]) || initiative[key].length === 0) {
      failures.push(`${label}: ${key} must be a non-empty array`);
    }
  }
  if (initiative.status && !validStatuses.has(initiative.status)) {
    failures.push(`${label}: invalid status ${initiative.status}`);
  }
  if (
    typeof initiative.phase === "string" &&
    !/^P[0-4]\b/u.test(initiative.phase)
  ) {
    failures.push(`${label}: phase must start with P0, P1, P2, P3, or P4`);
  }
  if (hasPlaceholder(initiative)) {
    failures.push(`${label}: contains placeholder text`);
  }
  for (const gapID of initiative.gap_ids ?? []) {
    if (!new RegExp(`^${gapIDPattern}$`).test(gapID)) {
      failures.push(`${label}: invalid gap id ${gapID}`);
      continue;
    }
    if (!sourceSet.has(gapID)) {
      failures.push(`${label}: unknown gap id ${gapID}`);
    }
    const existing = seen.get(gapID);
    if (existing) {
      failures.push(`${gapID}: assigned to both ${existing} and ${label}`);
    } else {
      seen.set(gapID, label);
    }
  }
}

for (const gapID of sourceIDs) {
  if (!seen.has(gapID))
    failures.push(`${gapID}: missing alleviation initiative`);
}

const duplicateSourceIDs = sourceIDs.filter(
  (id, idx) => sourceIDs.indexOf(id) !== idx,
);
for (const gapID of duplicateSourceIDs) {
  failures.push(`${gapID}: duplicate ID in source gap analysis`);
}

if (failures.length > 0) {
  console.error("Mailchimp gap alleviation FAILED.\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const byStatus = countBy(
  register.initiatives,
  (initiative) => initiative.status,
);
const byStream = countBy(
  register.initiatives,
  (initiative) => initiative.stream,
);
console.log(
  `Mailchimp gap alleviation OK: ${sourceIDs.length} gap IDs covered exactly once across ${register.initiatives.length} initiatives.`,
);
console.log(`By status: ${formatCounts(byStatus)}`);
console.log(`By stream: ${formatCounts(byStream)}`);

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item) || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function formatCounts(counts) {
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key}: ${count}`)
    .join(", ");
}

function hasPlaceholder(value) {
  if (typeof value === "string") return /\bTBD\b|\?\?\?/iu.test(value);
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (value && typeof value === "object")
    return Object.values(value).some(hasPlaceholder);
  return false;
}
