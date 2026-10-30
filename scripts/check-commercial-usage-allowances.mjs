#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

// Static release evidence for Moosewave's finite commercial allowances.
// Database and handler tests prove behavior; this guard prevents a production
// entry point from silently dropping its fail-closed meter wiring.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const issues = [];
const requireText = (file, snippets) => {
  const source = read(file);
  for (const snippet of snippets) {
    if (!source.includes(snippet)) issues.push(`${file} missing ${JSON.stringify(snippet)}`);
  }
  return source;
};

requireText("infra/migrations/2067_commercial_usage_allowances.sql", [
  "CREATE TABLE commercial_usage_buckets",
  "used_units <= limit_units",
  "CREATE TABLE commercial_usage_reservations",
  "CREATE FUNCTION commercial_usage_reserve",
  "FOR UPDATE",
  "SECURITY INVOKER",
  "FORCE ROW LEVEL SECURITY",
  "AS PERMISSIVE FOR ALL TO postwave_app",
  "REVOKE ALL ON FUNCTION public.commercial_usage_reserve",
]);
requireText("packages/runtime/commercialusage/meter.go", [
  'ResourceAICreditMillis Resource = "ai_credit_millis"',
  'ResourceAutomationRuns Resource = "automation_runs"',
  'ResourceTrackedEvents  Resource = "tracked_events"',
  'ResourceAPIOperations  Resource = "api_operations"',
  "commercial_usage_reserve(",
  'case "exceeded":',
  "ErrIdempotencyConflict",
]);

const apiMain = requireText("apps/api/main.go", [
  "commercialUsageMeter := &sharedusage.Meter{Pool: pool}",
  "meterCommercialUsage: usagegate.APIOperationMiddleware(commercialUsageMeter)",
  "UsageMeter:           commercialUsageMeter",
  "RequireUsageMeter:    true",
  "UsageMeter: commercialUsageMeter, RequireUsageMeter: true",
]);
if ((apiMain.match(/RequireUsageMeter:\s+true/g) ?? []).length < 3) {
  issues.push("apps/api/main.go must fail closed for authenticated, identified-public, and anonymous tracking");
}
requireText("apps/api/internal/usagegate/http.go", [
  "IsAPIKeyAuth",
  "ResourceAPIOperations",
  "usage_meter_unavailable",
]);
for (const file of [
  "apps/api/internal/track/handlers.go",
  "apps/api/internal/publictrack/publictrack.go",
  "apps/api/internal/publictrack/anonymous.go",
]) {
  requireText(file, ["RequireUsageMeter", "ResourceTrackedEvents", "UsageMeter.Reserve"]);
}

requireText("services/automation/main.go", [
  "engine.UsageMeter = &sharedusage.Meter{Pool: pool}",
  "engine.RequireUsageMeter = true",
]);
requireText("services/automation/internal/runtime/engine.go", [
  "RequireUsageMeter",
  "ResourceAutomationRuns",
  '"automation:v1:',
]);
requireText("services/automation/internal/worker/worker.go", [
  "ErrAutomationAllowanceExceeded",
  "Permanent",
]);

const voiceMain = requireText("services/voice/main.go", [
  "&quota.CommercialQuota{",
  "sharedusage.Meter{Pool: pool}",
  "quota.BillingStateTierResolver(pool)",
]);
if (voiceMain.includes("&quota.PostgresQuota{")) {
  issues.push("services/voice/main.go must not wire the retired daily-call quota in production");
}
for (const file of [
  "services/voice/internal/handlers/chat.go",
  "services/voice/internal/handlers/template_generate.go",
  "services/voice/internal/handlers/sequence_draft.go",
  "services/voice/internal/handlers/sequences.go",
  "services/voice/internal/handlers/regression.go",
  "services/voice/internal/handlers/voice.go",
]) {
  requireText(file, ["CheckAndConsume", "CostMilliCredits"]);
}

requireText("apps/api/internal/assets/repo.go", [
  "pg_advisory_xact_lock",
  "AssetStorageAllowanceBytes",
  "StorageLimitError",
  "COALESCE(sum(bytes), 0)",
]);
requireText("apps/api/internal/assets/handlers.go", [
  "StorageLimitError",
  'Code: "asset_storage_limit_exceeded"',
]);

if (issues.length) {
  console.error(`commercial-usage allowance coverage failed (${issues.length})`);
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(1);
}
console.log("commercial-usage allowance coverage OK: AI, automation, tracked events, API operations, and asset storage fail closed");
