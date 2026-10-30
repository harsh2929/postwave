#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

// Static release evidence for the managed email hard cap. Runtime/DB tests
// prove behavior; this guard makes deleting one provider-boundary integration
// or reintroducing queue-time overage admission fail the release audit.
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

const migration = requireText("infra/migrations/2065_managed_send_allowance.sql", [
  "CREATE TABLE managed_send_allowance_buckets",
  "CHECK (reserved_units + committed_units <= allowance_units)",
  "CREATE TABLE managed_send_allowance_reservations",
  "UNIQUE (tenant_id, period_start, reservation_key)",
  "CREATE TABLE managed_send_allowance_recipients",
  "CREATE TABLE managed_send_allowance_events",
  "FOREIGN KEY (reservation_id, tenant_id)",
  "state = 'committed' AND committed_at IS NOT NULL",
  "managed_send_allowance_recipients_immutable",
  "managed_send_allowance_events_immutable",
  "FORCE ROW LEVEL SECURITY",
]);
if (/overage/i.test(migration.replace("There is deliberately no\n-- overage state", ""))) {
  issues.push("allowance migration must not create an overage mechanism");
}

requireText("apps/api/internal/sendallowance/allowance.go", [
  "const ManagedSendAllowanceReleased = true",
  "FOR UPDATE",
  "ManagedMonthlySendAllowance",
  "current+units > allowance",
  "reservation recipient identity changed",
  'next == "released" && state == "released"',
  'State: "bypassed"',
  '"reserved"',
  '"committed"',
  '"released"',
]);
requireText("apps/api/internal/sending/sendloop.go", [
  'fmt.Sprintf("campaign-recipient:%d", pr.id)',
  "g.Allowance.Reserve",
  "g.Allowance.Commit",
  "g.Allowance.Release",
]);
requireText("apps/api/internal/campaigns/handlers.go", [
  'allowanceKey := "campaign-test:" + uuid.NewString()',
  "IdempotencyKey:  allowanceKey",
  "d.Allowance.Reserve",
  "d.Allowance.Commit",
]);
requireText("apps/api/internal/campaigns/automation_email.go", [
  '"automation-outbox:"+ev.ID',
  "req.IdempotencyKey = allowanceKey",
  "h.Allowance.Reserve",
  "h.Allowance.Commit",
]);
const transactional = requireText("apps/api/internal/transactional/send.go", [
  '"transactional-email:"+id',
  '"transactional-smtp:" + dedupKey',
  "d.Allowance.Reserve",
  "d.Allowance.Commit",
  "!isPerm && !ambiguous",
]);
if (!transactional.includes("SendStored") || !transactional.includes("SendRawSMTP")) {
  issues.push("transactional scheduled-worker and SMTP paths are not both present");
}
requireText("apps/api/internal/transactional/handlers.go", [
  "managed_send_allowance_exhausted",
  "entitlement.ReasonPlan",
  "managed_send_allowance_unavailable",
]);
const campaignQuota = read("apps/api/internal/campaigns/quota.go");
if (campaignQuota.includes("overage.Decide") || campaignQuota.includes("RecordOverage")) {
  issues.push("campaign queue may still admit automatic paid overage");
}
const queue = read("apps/api/internal/campaigns/handlers_queue.go");
if (/Limits\.Increment\([^\n]*ResourceMonthlySends/.test(queue)) {
  issues.push("campaign queue still pseudo-consumes monthly usage before provider dispatch");
}
const production = requireText("apps/api/main.go", [
  "managedSendAllowance := sendallowance.New(pool)",
  "Allowance:        managedSendAllowance",
  "RequireAllowance: true",
]);
const failClosedWiring = production.match(
  /Allowance:\s+managedSendAllowance,\s*\n\s*RequireAllowance:\s+true/g,
);
if ((failClosedWiring?.length ?? 0) < 3) {
  issues.push("campaign, campaign-drain, and transactional production wiring must all fail closed");
}
requireText("apps/api/workers_send_pipeline.go", [
  "Allowance:        allowance",
  "RequireAllowance: true",
]);
requireText("apps/api/internal/sending/sendloop.go", [
  "allowanceRetryAt",
  "managed_send_allowance_exhausted",
]);

if (issues.length) {
  console.error(`managed-send allowance coverage failed (${issues.length})`);
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(1);
}
console.log("managed-send allowance coverage OK: 6 provider paths, locked bucket, immutable recipient/events ledger, no overage admission");
