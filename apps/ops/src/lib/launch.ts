// SPDX-License-Identifier: AGPL-3.0-only
//
// launch.ts — the production readiness report.
//
// GET /api/internal/ops/readiness has been mounted behind the platform-operator
// gate since the console was built and nothing has ever rendered it. It is the
// most directly useful endpoint the API exposes for a go-live: the live Stripe
// keys, the billing launch approval, the auth providers, the sidecar contracts
// — every gate that is CONFIGURATION rather than code, which is exactly the
// category no test suite can speak to.
//
// Two rules, both inherited from the board. A report we cannot read is a loud
// failure, never an empty (and therefore reassuring) list. And a malformed
// report is refused whole rather than partially rendered: a dropped failing
// check reads as a passing one.

import { fetchOpsViewJSON, viewStatusMessage } from "./opsViewFetch";
import {
  hasDuplicateKey,
  hasOnlyKeys,
  isBoundedText,
  isRecord,
} from "./viewSchema";

// A single gate. `severity` decides whether failing it blocks the launch or
// merely warns; the API derives the report status from exactly this pair.
export interface ReadinessCheck {
  id: string;
  label: string;
  status: "pass" | "fail";
  severity: "required" | "optional";
  remediation?: string;
}

export interface ReadinessGroup {
  id: string;
  label: string;
  checks: ReadinessCheck[];
}

export interface ReadinessReport {
  status: "ok" | "warning" | "blocked";
  environment: string;
  groups: ReadinessGroup[];
}

export type LaunchResult =
  | { ok: true; report: ReadinessReport }
  | { ok: false; status?: number; message: string };

export async function fetchReadiness(): Promise<LaunchResult> {
  const result = await fetchOpsViewJSON("/api/internal/ops/readiness");
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      message:
        result.kind === "configuration"
          ? "the ops console is not configured safely"
          : result.kind === "invalid"
            ? "the readiness report was unreadable"
            : "the readiness report is unavailable",
    };
  }
  // 503 is a MEANINGFUL success here, not a transport failure: the handler
  // answers Service Unavailable precisely when the report says "blocked", and
  // that is the single most important thing a pre-launch operator can be
  // shown. Treating it as an outage would hide the launch blockers behind an
  // error page.
  if (result.status !== 200 && result.status !== 503) {
    return {
      ok: false,
      status: result.status,
      message: viewStatusMessage(result.status, "the readiness report"),
    };
  }
  if (!isReadinessReport(result.body)) {
    return { ok: false, status: result.status, message: "the readiness report was unreadable" };
  }
  return { ok: true, report: result.body };
}

export function isReadinessReport(value: unknown): value is ReadinessReport {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["status", "environment", "groups"]) ||
    (value.status !== "ok" && value.status !== "warning" && value.status !== "blocked") ||
    !isBoundedText(value.environment, 64, 256) ||
    !Array.isArray(value.groups) ||
    value.groups.length > 64 ||
    !value.groups.every(isReadinessGroup)
  ) return false;
  return !hasDuplicateKey(value.groups as ReadinessGroup[], (g) => g.id);
}

function isReadinessGroup(value: unknown): value is ReadinessGroup {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "label", "checks"]) ||
    !isBoundedText(value.id, 128, 512) ||
    !isBoundedText(value.label, 256, 1024) ||
    !Array.isArray(value.checks) ||
    value.checks.length > 256 ||
    !value.checks.every(isReadinessCheck)
  ) return false;
  return !hasDuplicateKey(value.checks as ReadinessCheck[], (c) => c.id);
}

function isReadinessCheck(value: unknown): value is ReadinessCheck {
  return isRecord(value) &&
    hasOnlyKeys(value, ["id", "label", "status", "severity"], ["remediation"]) &&
    isBoundedText(value.id, 128, 512) &&
    isBoundedText(value.label, 512, 2048) &&
    (value.status === "pass" || value.status === "fail") &&
    (value.severity === "required" || value.severity === "optional") &&
    (value.remediation === undefined || isBoundedText(value.remediation, 4096, 16384));
}

// summarise counts what an operator actually asks: how many gates are left,
// and how many of those actually stop a launch.
export function summarise(report: ReadinessReport): {
  total: number;
  failing: number;
  blocking: number;
} {
  let total = 0;
  let failing = 0;
  let blocking = 0;
  for (const group of report.groups) {
    for (const check of group.checks) {
      total += 1;
      if (check.status !== "fail") continue;
      failing += 1;
      if (check.severity === "required") blocking += 1;
    }
  }
  return { total, failing, blocking };
}
