import { describe, expect, it } from "vitest";

import {
  redactMcpRequestDetails,
  safeMcpDiagnostic,
  safeMcpMethod,
  safeMcpPath,
  safeMcpToolName,
  safeMcpUserAgent,
} from "../../components/mcp/mcp-execution-security";
import type { MCPExecution } from "../../lib/api-client";

function execution(overrides: Partial<MCPExecution> = {}): MCPExecution {
  return {
    id: 42,
    tenantId: "tenant-1",
    apiKeyId: "key-1",
    apiKeyPrefix: "pw_live_12",
    method: "POST",
    path: "/api/v1/campaigns",
    queryString: "email=owner%40example.test&token=top-secret",
    toolName: "campaigns_create",
    statusCode: 201,
    latencyMs: 42,
    userAgent: "postwave-mcp-server/1.2.3",
    remoteIp: "203.0.113.10",
    costMicros: 10,
    calledAt: "2026-07-17T08:00:00.000Z",
    requestBody: {
      name: "Confidential launch",
      authorization: "Bearer raw-secret",
      audience: { count: 920, enabled: true },
    },
    ...overrides,
  };
}

describe("MCP execution security boundary", () => {
  it("retains only constant counts while removing values and key names", () => {
    const redacted = redactMcpRequestDetails(execution());

    expect(redacted.bodyJson).toContain('"type": "object"');
    expect(redacted.bodyJson).toContain('"key_count": 3');
    expect(redacted.query).toBe("key_count=2");
    expect(redacted.bodyJson).not.toContain('"name"');
    expect(redacted.bodyJson).not.toContain('"authorization"');
    expect(redacted.bodyJson).not.toContain('"audience"');
    expect(JSON.stringify(redacted)).not.toContain("Confidential launch");
    expect(JSON.stringify(redacted)).not.toContain("owner@example.test");
    expect(JSON.stringify(redacted)).not.toContain("top-secret");
    expect(JSON.stringify(redacted)).not.toContain("Bearer raw-secret");
    expect(redacted.redactionCount).toBe(5);
  });

  it("bounds untrusted metadata before it reaches details", () => {
    expect(safeMcpMethod("POST; open /Applications/Calculator.app")).toBe(
      "GET",
    );
    expect(safeMcpPath("https://evil.test/path")).toBe("/");
    expect(safeMcpPath("/safe\nInjected")).toBe("/safeInjected");
    expect(safeMcpPath("/api/pw_live_embedded_secret")).toBe(
      "/[SENSITIVE_PATH_SUPPRESSED]",
    );
    expect(safeMcpPath(42)).toBe("/");
    expect(safeMcpUserAgent("postwave-mcp-server/1.2.3")).toBe(
      "postwave-mcp-server/1.2.3",
    );
    expect(safeMcpUserAgent("browser secret/pw_live_x")).toBe("Suppressed");
    expect(safeMcpToolName("campaigns_send")).toBe("campaigns_send");
    expect(safeMcpToolName("pw_live_embedded_secret")).toBe("Suppressed");
    expect(safeMcpDiagnostic("quota_exceeded")).toBe("quota_exceeded");
    expect(safeMcpDiagnostic("raw\ncredential")).toBe("Suppressed");
    expect(safeMcpDiagnostic("Bearer raw-token")).toBe("Suppressed");
    expect(safeMcpUserAgent(42)).toBe("Suppressed");
  });

  it("redacts secret-bearing keys and contains hostile object access", () => {
    const hostile: Record<string, unknown> = {
      pw_live_secret_as_a_key: "value",
      __proto__: "prototype payload",
    };
    Object.defineProperty(hostile, "explosive", {
      enumerable: true,
      get: () => {
        throw new Error("raw getter secret");
      },
    });

    const redacted = redactMcpRequestDetails({ requestBody: hostile });
    expect(redacted.bodyJson).toContain('"type": "object"');
    expect(redacted.bodyJson).toContain('"key_count": 2');
    expect(redacted.bodyJson).not.toContain("pw_live_secret_as_a_key");
    expect(redacted.bodyJson).not.toContain("raw getter secret");

    const query = redactMcpRequestDetails({
      queryString: "pw_live_secret_as_a_key=value",
    });
    expect(query.query).toBe("key_count=1");
    expect(query.query).not.toContain("pw_live_secret_as_a_key");
  });

  it("reduces oversized nested content to constant top-level metadata", () => {
    const redacted = redactMcpRequestDetails({
      requestBody: {
        records: Array.from(
          { length: 10_000 },
          (_, index) => "raw-private-value-" + String(index),
        ),
      },
    });
    const parsed = JSON.parse(redacted.bodyJson) as {
      key_count: number;
      type: string;
    };

    expect(parsed).toMatchObject({ type: "object", key_count: 1 });
    expect(redacted.redactionCount).toBe(1);
    expect(redacted.bodyJson).not.toContain("raw-private-value");
  });

  it("preserves a bounded server query count across repeated projection", () => {
    const first = redactMcpRequestDetails({ queryString: "key_count=17" });
    const second = redactMcpRequestDetails({ queryString: first.query });

    expect(first.query).toBe("key_count=17");
    expect(first.redactionCount).toBe(17);
    expect(second.query).toBe("key_count=17");
    expect(second.redactionCount).toBe(17);
  });
});
