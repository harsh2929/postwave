import { describe, expect, it } from "vitest";

import { projectSafeMcpExecution } from "../../components/mcp/mcp-execution-security";
import {
  validExecution,
  validExecutionPage,
  validExecutionPageForScope,
  validQuotaEnvelopeForScope,
  validTrendEnvelopeForScope,
} from "../../components/mcp/mcp-telemetry-validation";
import type {
  MCPExecution,
  MCPExecutionsResponse,
  MCPTrendPoint,
} from "../../lib/api-client";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const SINCE = "2026-08-19T12:00:00.000Z";

function execution(overrides: Partial<MCPExecution> = {}): MCPExecution {
  return {
    id: 42,
    tenantId: "tenant-1",
    method: "POST",
    path: "/api/v1/campaigns/{id}",
    toolName: "campaigns_update",
    statusCode: 200,
    latencyMs: 21,
    userAgent: "postwave-mcp-server/0.1.0",
    requestBody: {
      _summary: true,
      type: "object",
      key_count: 2,
    },
    dryRun: true,
    dryRunAsserted: true,
    costMicros: 0,
    calledAt: "2026-08-20T11:00:00.000Z",
    ...overrides,
  };
}

function page(
  rows: MCPExecution[] = [execution()],
  overrides: Partial<MCPExecutionsResponse> = {},
): MCPExecutionsResponse {
  return {
    tenantId: "tenant-1",
    rows,
    detailPolicy: "minimized_v1",
    evidenceClass: "best_effort_observability",
    ...overrides,
  };
}

function trend(): MCPTrendPoint[] {
  const start = Date.parse(SINCE);
  return Array.from({ length: 25 }, (_, index) => ({
    bucket: new Date(start + index * 60 * 60 * 1_000).toISOString(),
    calls: index === 24 ? 1 : 0,
  }));
}

describe("MCP telemetry admission boundary", () => {
  it("requires the exact minimized best-effort execution envelope", () => {
    expect(validExecutionPage(page())).toBe(true);
    expect(
      validExecutionPage({
        ...page(),
        detailPolicy: "legacy" as "minimized_v1",
      }),
    ).toBe(false);
    expect(
      validExecutionPage({
        ...page(),
        evidenceClass: "complete" as "best_effort_observability",
      }),
    ).toBe(false);
    const missing = { rows: [execution()] };
    expect(
      validExecutionPage(missing as unknown as MCPExecutionsResponse),
    ).toBe(false);
  });

  it("rejects contradictory dry-run assertions and arbitrary body values", () => {
    expect(validExecution(execution({ dryRunAsserted: false }))).toBe(false);
    expect(
      validExecution(
        execution({ requestBody: { email: "person@example.test" } }),
      ),
    ).toBe(false);
    expect(
      validExecution(
        execution({
          requestBody: {
            _summary: true,
            type: "object",
            key_count: 2,
            keys: ["legacy-name"],
          } as MCPExecution["requestBody"],
        }),
      ),
    ).toBe(false);
    expect(validExecution(execution({ queryString: "secret=value" }))).toBe(
      false,
    );
    expect(validExecution(execution({ queryString: "key_count=17" }))).toBe(
      true,
    );
  });

  it("removes body key names, query names, values, and IP before UI state", () => {
    const safe = projectSafeMcpExecution(
      execution({
        queryString: "person@example.test&token",
        remoteIp: "203.0.113.2",
      }),
    );
    const serialized = JSON.stringify(safe);
    expect(serialized).toContain('"key_count":2');
    expect(serialized).toContain("key_count=2");
    expect(serialized).not.toContain("subscriber-opaque-id");
    expect(serialized).not.toContain("person@example.test");
    expect(serialized).not.toContain("203.0.113.2");
  });

  it("keeps the minimized row canonical across validation and repeat projection", () => {
    const once = projectSafeMcpExecution(
      execution({ queryString: "key_count=17" }),
    );
    expect(validExecution(once)).toBe(true);
    const twice = projectSafeMcpExecution(once);
    expect(validExecution(twice)).toBe(true);
    expect(twice).toEqual(once);
  });

  it("accepts the exact minimized visual qualification envelope", () => {
    const rows = [
      execution({
        id: 104,
        tenantId: "mcp-qualification-tenant",
        apiKeyId: "qualification-key-a",
        apiKeyPrefix: "pw_live_a1",
        path: "/api/v1/subscribers/import",
        queryString: "key_count=2",
        toolName: "subscribers_import",
        statusCode: 202,
        latencyMs: 47,
        requestBody: {
          _summary: true,
          type: "object",
          key_count: 3,
          _truncated: false,
        },
        costMicros: 1_800,
        calledAt: "2026-08-20T11:59:00.000Z",
      }),
      execution({
        id: 103,
        tenantId: "mcp-qualification-tenant",
        apiKeyId: "qualification-key-b",
        apiKeyPrefix: "pw_live_b2",
        method: "GET",
        path: "/api/v1/campaigns/report",
        queryString: undefined,
        toolName: "campaigns_report",
        statusCode: 200,
        latencyMs: 29,
        requestBody: undefined,
        dryRun: false,
        dryRunAsserted: false,
        costMicros: 420,
        calledAt: "2026-08-20T11:58:00.000Z",
      }),
    ];
    const envelope = page(rows, {
      tenantId: "mcp-qualification-tenant",
    });
    expect(
      validExecutionPageForScope(
        envelope,
        "2026-08-13T12:00:00.000Z",
        "",
        undefined,
        "mcp-qualification-tenant",
        "mcp",
        NOW,
      ),
    ).toBe(true);
    const projected = { ...envelope, rows: rows.map(projectSafeMcpExecution) };
    expect(validExecutionPage(projected)).toBe(true);
  });

  it("binds rows to tenant, source, time, tool, order, and exact cursor", () => {
    expect(
      validExecutionPageForScope(
        page([execution({ id: 42 }), execution({ id: 40 })], {
          nextBeforeId: 40,
        }),
        SINCE,
        "campaigns_update",
        undefined,
        "tenant-1",
        "mcp",
        NOW,
      ),
    ).toBe(true);
    expect(
      validExecutionPageForScope(
        page([execution({ id: 42 })], { nextBeforeId: 41 }),
        SINCE,
        "",
        undefined,
        "tenant-1",
        "mcp",
        NOW,
      ),
    ).toBe(false);
    expect(
      validExecutionPageForScope(
        page([execution({ tenantId: "tenant-2" })]),
        SINCE,
        "",
        undefined,
        "tenant-1",
        "mcp",
        NOW,
      ),
    ).toBe(false);
    expect(
      validExecutionPageForScope(
        page([execution()], { tenantId: "tenant-2" }),
        SINCE,
        "",
        undefined,
        "tenant-1",
        "mcp",
        NOW,
      ),
    ).toBe(false);
    expect(
      validExecutionPageForScope(
        page([execution({ userAgent: "forged-browser/1" })]),
        SINCE,
        "",
        undefined,
        "tenant-1",
        "mcp",
        NOW,
      ),
    ).toBe(false);
  });

  it("requires a complete, contiguous, tenant-bound hourly trend", () => {
    expect(
      validTrendEnvelopeForScope(
        { tenantId: "tenant-1", windowHours: 24, points: trend() },
        "tenant-1",
        24,
        SINCE,
        NOW,
      ),
    ).toBe(true);
    expect(
      validTrendEnvelopeForScope(
        {
          tenantId: "tenant-1",
          windowHours: 24,
          points: trend().filter((_, index) => index !== 9),
        },
        "tenant-1",
        24,
        SINCE,
        NOW,
      ),
    ).toBe(false);
    expect(
      validTrendEnvelopeForScope(
        { tenantId: "tenant-2", windowHours: 24, points: trend() },
        "tenant-1",
        24,
        SINCE,
        NOW,
      ),
    ).toBe(false);
  });

  it("binds hourly buckets to the selected window throughout the hour", () => {
    const requestedAt = Date.parse("2026-08-20T12:37:42.000Z");
    const since = "2026-08-19T12:37:42.000Z";
    const points = Array.from({ length: 25 }, (_, index) => ({
      bucket: new Date(
        Date.parse("2026-08-19T12:00:00.000Z") + index * 3_600_000,
      ).toISOString(),
      calls: index === 24 ? 1 : 0,
    }));
    expect(
      validTrendEnvelopeForScope(
        { tenantId: "tenant-1", windowHours: 24, points },
        "tenant-1",
        24,
        since,
        requestedAt,
      ),
    ).toBe(true);
  });

  it("requires the exact tenant-bound provisional quota posture", () => {
    const envelope = {
      tenantId: "tenant-1",
      quotas: [],
      enforcementMode: "advisory_unverified" as const,
      authoritative: false as const,
      releaseHold: "mcp_quota_enforcement_release_held" as const,
    };
    expect(validQuotaEnvelopeForScope(envelope, "tenant-1")).toBe(true);
    expect(
      validQuotaEnvelopeForScope(
        { ...envelope, tenantId: "tenant-2" },
        "tenant-1",
      ),
    ).toBe(false);
  });
});
