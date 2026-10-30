#!/usr/bin/env node
// Credential-free first-customer pilot smoke harness.
//
// This does not create live provider traffic. It verifies the Moosewave control
// plane that can be checked without customer-owned credentials: migration
// acceptance, SMS readiness, exact-sender certification evidence, and optional
// campaign evidence availability.

import { smsEvidenceReleaseHoldCheck } from "./lib/sms-evidence-release-hold.mjs";

const args = parseArgs(process.argv.slice(2));
const baseURL = trimRightSlash(
  args["base-url"] || process.env.POSTWAVE_BASE_URL || "http://localhost:3000",
);
const migrationJobID = args["migration-job-id"] || process.env.POSTWAVE_MIGRATION_JOB_ID || "";
const smsSenderID = args["sms-sender-id"] || process.env.POSTWAVE_SMS_SENDER_ID || "";
const smsCampaignID = args["sms-campaign-id"] || process.env.POSTWAVE_SMS_CAMPAIGN_ID || "";
const strict = Boolean(args.strict || process.env.POSTWAVE_PILOT_SMOKE_STRICT === "1");

const checks = [];

await check("api health", "warning", async () => {
  const res = await request("/api/health", { allow404: true });
  return {
    status: res.ok ? "pass" : "warning",
    detail: res.ok ? "Health endpoint responded." : `Health endpoint unavailable (${res.status}); continuing with authenticated checks.`,
  };
});

if (migrationJobID) {
  await check("migration pilot acceptance", "blocker", async () => {
    const report = await requestJSON(`/api/v1/migrations/${encodeURIComponent(migrationJobID)}/pilot-acceptance`);
    return {
      status: normalizeStatus(report.status),
      detail: `${report.blockers ?? 0} blocker(s), ${report.warnings ?? 0} warning(s).`,
      evidence: report.items,
    };
  });
  await check("migration rollback rehearsal", "warning", async () => {
    const report = await requestJSON(`/api/v1/migrations/${encodeURIComponent(migrationJobID)}/rollback-rehearsal`);
    return {
      status: report.rollbackable === true || report.status === "pass" ? "pass" : "warning",
      detail: report.detail || report.message || "Rollback rehearsal endpoint responded.",
      evidence: report,
    };
  });
} else {
  checks.push({
    name: "migration pilot acceptance",
    status: "warning",
    detail: "Set POSTWAVE_MIGRATION_JOB_ID or --migration-job-id to check cutover gates.",
  });
}

await check("email sending readiness", "blocker", async () => {
  const readiness = await requestJSON("/api/v1/sending/readiness");
  const blockers = (readiness.items ?? []).filter((item) => item.severity === "blocker" && !item.complete);
  const warnings = (readiness.items ?? []).filter((item) => item.severity === "warning" && !item.complete);
  return {
    status: readiness.ready ? (warnings.length ? "warning" : "pass") : "blocker",
    detail: readiness.ready
      ? `${warnings.length} email readiness warning(s).`
      : `${blockers.length} email sending blocker(s).`,
    evidence: readiness,
  };
});

await check("sms setup", "blocker", async () => {
  const setup = await requestJSON("/api/v1/sms/setup");
  return {
    status: setup.can_send ? "pass" : "blocker",
    detail: setup.can_send
      ? `${setup.senders?.length ?? 0} sender(s) configured and at least one can send.`
      : `Blocked: ${(setup.blocking_reasons ?? ["unknown"]).join(", ")}`,
    evidence: setup,
  };
});

await check("sms pilot readiness", "blocker", async () => {
  const readiness = await requestJSON("/api/v1/sms/pilot-readiness");
  const blockers = (readiness.items ?? []).filter((item) => item.status === "blocker");
  return {
    status: readiness.can_pilot ? "pass" : "blocker",
    detail: readiness.can_pilot
      ? "Tenant-level SMS pilot gates are passing."
      : `${blockers.length} SMS pilot blocker(s).`,
    evidence: readiness,
  };
});

if (smsSenderID) {
  await check("exact sender certification", "blocker", async () => {
    const cert = await requestJSON(`/api/v1/sms/senders/${encodeURIComponent(smsSenderID)}/pilot-certification`);
    const blockers = (cert.items ?? []).filter((item) => item.status === "blocker");
    const warnings = (cert.items ?? []).filter((item) => item.status === "warning");
    return {
      status: cert.can_pilot ? (warnings.length ? "warning" : "pass") : "blocker",
      detail: cert.can_pilot
        ? `${warnings.length} sender warning(s).`
        : `${blockers.length} exact-sender blocker(s).`,
      evidence: cert,
    };
  });
} else {
  checks.push({
    name: "exact sender certification",
    status: "warning",
    detail: "Set POSTWAVE_SMS_SENDER_ID or --sms-sender-id to check live callback evidence.",
  });
}

if (smsCampaignID) {
  checks.push(smsEvidenceReleaseHoldCheck());
}

const blockers = checks.filter((check) => check.status === "blocker");
const warnings = checks.filter((check) => check.status === "warning");
const summary = {
  generated_at: new Date().toISOString(),
  base_url: baseURL,
  status: blockers.length ? "blocker" : warnings.length ? "warning" : "pass",
  blockers: blockers.length,
  warnings: warnings.length,
  checks,
};

console.log(JSON.stringify(summary, null, 2));

if (blockers.length || (strict && warnings.length)) {
  process.exitCode = 1;
}

async function check(name, failureStatus, fn) {
  try {
    const result = await fn();
    checks.push({ name, ...result });
  } catch (err) {
    checks.push({
      name,
      status: failureStatus,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function requestJSON(path) {
  const res = await request(path);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${path} returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function request(path, opts = {}) {
  const headers = {};
  if (process.env.POSTWAVE_API_KEY) {
    headers.Authorization = `Bearer ${process.env.POSTWAVE_API_KEY}`;
  }
  if (process.env.POSTWAVE_AUTH_HEADER) {
    const idx = process.env.POSTWAVE_AUTH_HEADER.indexOf(":");
    if (idx > 0) {
      headers[process.env.POSTWAVE_AUTH_HEADER.slice(0, idx).trim()] =
        process.env.POSTWAVE_AUTH_HEADER.slice(idx + 1).trim();
    }
  }
  if (process.env.POSTWAVE_TENANT_ID) {
    headers["X-Tenant-ID"] = process.env.POSTWAVE_TENANT_ID;
    headers["X-Postwave-Tenant-ID"] = process.env.POSTWAVE_TENANT_ID;
  }
  const res = await fetch(baseURL + path, { headers });
  if (opts.allow404 && res.status === 404) return res;
  return res;
}

function normalizeStatus(status) {
  if (status === "pass") return "pass";
  if (status === "blocker" || status === "fail" || status === "failed") return "blocker";
  return "warning";
}

function parseArgs(raw) {
  const out = {};
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = raw[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function trimRightSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}
