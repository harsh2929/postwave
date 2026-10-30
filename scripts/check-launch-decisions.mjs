#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const strict = process.argv.includes("--strict");
const register = JSON.parse(
  readFileSync(join(ROOT, "docs/launch-decision-register.json"), "utf8"),
);

const validStatuses = new Set(["proposed", "decided", "deferred", "rejected"]);
let failed = false;
for (const decision of register.decisions ?? []) {
  const missing = [];
  for (const key of ["id", "owner", "status", "required_before", "proposal"]) {
    if (!decision[key]) missing.push(key);
  }
  if (!validStatuses.has(decision.status)) missing.push("valid_status");
  if (decision.status === "decided") {
    for (const key of [
      "decided_value",
      "approved_by_role",
      "approval_evidence_ref",
      "approved_on",
    ]) {
      if (!decision[key]) missing.push(key);
    }
    if (
      decision.approval_evidence_ref &&
      !/^private-release-record:\d{4}-\d{2}-\d{2}\/[a-z0-9-]+$/u.test(
        decision.approval_evidence_ref,
      )
    ) {
      missing.push("valid_approval_evidence_ref");
    }
    if (
      decision.approved_on &&
      !/^\d{4}-\d{2}-\d{2}$/u.test(decision.approved_on)
    ) {
      missing.push("valid_approved_on");
    }
  }
  if (decision.approved_by_email || decision.approved_by) {
    missing.push("no_personal_approver_fields");
  }
  const strictOpen = strict && decision.status !== "decided";
  const status =
    missing.length || strictOpen
      ? "FAIL"
      : decision.status === "decided"
        ? "PASS"
        : "WARN";
  console.log(
    `${status} ${decision.id ?? "(missing-id)"}: ${decision.status ?? "(missing-status)"}`,
  );
  if (missing.length)
    console.log(`  - missing/invalid fields: ${missing.join(", ")}`);
  if (strictOpen) console.log("  - strict launch mode requires status=decided");
  if (status === "FAIL") failed = true;
}

if (!Array.isArray(register.decisions) || register.decisions.length === 0) {
  console.error("FAIL: launch decision register has no decisions");
  failed = true;
}

if (failed) process.exit(1);
console.log(
  strict
    ? "\nLaunch decision strict gate passed."
    : "\nLaunch decision register reviewed. Warnings mean founder/business sign-off is still pending.",
);
