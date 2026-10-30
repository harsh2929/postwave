// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

const nextHeaders = vi.hoisted(() => ({ headers: vi.fn() }));
vi.mock("next/headers", () => ({ headers: nextHeaders.headers }));

import { fetchReadiness, isReadinessReport, summarise, type ReadinessReport } from "./launch";

const SESSION = `${"a".repeat(22)}.${"b".repeat(43)}`;

const report: ReadinessReport = {
  status: "blocked",
  environment: "production",
  groups: [
    {
      id: "billing",
      label: "Billing",
      checks: [
        { id: "stripe_secret_key", label: "Live Stripe API key configured", status: "fail", severity: "required", remediation: "Set STRIPE_SECRET_KEY." },
        { id: "stripe_price_pro", label: "Pro Stripe Price configured", status: "pass", severity: "required" },
      ],
    },
    {
      id: "auth_providers",
      label: "Authentication Providers",
      checks: [
        { id: "google_oauth", label: "Google OAuth configured", status: "fail", severity: "optional", remediation: "Set the client id." },
      ],
    },
  ],
};

function stubProductionEnv() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("OPS_API_ORIGIN", "https://internal-api.postwave.example");
  vi.stubEnv("OPS_API_ALLOWED_HOSTS", "internal-api.postwave.example");
  vi.stubEnv("OPS_PUBLIC_ORIGIN", "https://ops.postwave.example");
  vi.stubEnv("OPS_RUNBOOK_BASE_URL", "https://runbooks.postwave.example/production/");
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nextHeaders.headers.mockReset();
});

describe("readiness report contract", () => {
  it("accepts the API's report shape", () => {
    expect(isReadinessReport(report)).toBe(true);
  });

  it("refuses an unknown report status rather than rendering it as neutral", () => {
    expect(isReadinessReport({ ...report, status: "probably-fine" })).toBe(false);
  });

  it("refuses an unknown check status, which would otherwise render as not-failing", () => {
    const mutated = {
      ...report,
      groups: [{ ...report.groups[0], checks: [{ ...report.groups[0].checks[0], status: "unknown" }] }],
    };
    expect(isReadinessReport(mutated)).toBe(false);
  });

  it("refuses duplicate check ids, which would double-count a gate", () => {
    const dup = report.groups[0].checks[0];
    const mutated = { ...report, groups: [{ ...report.groups[0], checks: [dup, dup] }] };
    expect(isReadinessReport(mutated)).toBe(false);
  });

  it("counts blocking gates separately from merely failing ones", () => {
    expect(summarise(report)).toEqual({ total: 3, failing: 2, blocking: 1 });
  });
});

describe("fetchReadiness", () => {
  it("treats 503 as a real report, because that is what 'blocked' answers with", async () => {
    // The handler answers Service Unavailable exactly when the report says
    // blocked. Reading that as an outage would hide every launch blocker
    // behind an error page — the one moment the page has to work.
    stubProductionEnv();
    nextHeaders.headers.mockResolvedValue(new Headers({ cookie: `pw_session=${SESSION}` }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(report, 503)));

    const result = await fetchReadiness();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.report.status).toBe("blocked");
  });

  it("fails loud on an unreadable report rather than returning an empty one", async () => {
    stubProductionEnv();
    nextHeaders.headers.mockResolvedValue(new Headers({ cookie: `pw_session=${SESSION}` }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "ok" }, 200)));

    const result = await fetchReadiness();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("unreadable");
  });

  it("fails loud when the operator is not authorised", async () => {
    stubProductionEnv();
    nextHeaders.headers.mockResolvedValue(new Headers({ cookie: `pw_session=${SESSION}` }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: {} }, 403)));

    const result = await fetchReadiness();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("denied");
  });
});
