import { describe, expect, it } from "vitest";

import {
  MCP_DETAIL_MALFORMED,
  MCP_DETAIL_WRONG_WORKSPACE,
  MCP_SENSITIVE_PATH,
  MCP_SUPPRESSED,
  mcpExecutionTitle,
  mcpRedactionSentence,
  normalizeMcpExecutionDetail,
  projectMcpExecutionDetail,
  redactMcpRequestDetails,
  safeMcpDiagnostic,
  safeMcpMethod,
  safeMcpPath,
  safeMcpToolName,
  safeMcpUserAgent,
} from "@/lib/mcpExecutionDetail";

/**
 * These pin the masking the detail sheet relies on. Every identifier the
 * sheet shows is rendered as an exact token and one of them is offered to the
 * clipboard, so each rule is asserted from the leaking side: the secret must
 * NOT be in the output, not merely "something was returned".
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";

describe("safeMcpPath", () => {
  it("suppresses a path that carries secret material or invisible characters", () => {
    for (const leak of [
      "/api/v1/subscribers/person@example.test",
      `/api/v1/x?token=${JWT}`,
      "/api/v1/keys/pw_live_abcdef123456",
      "/api/v1/x/Bearer abc",
      "/api/v1/sub\u200bscribers",
      "/api/v1/\u202eelbat",
    ]) {
      const out = safeMcpPath(leak);
      expect(out).toBe(MCP_SENSITIVE_PATH);
      expect(out).not.toContain("example.test");
      expect(out).not.toContain("pw_live");
    }
  });

  it("keeps a reviewed path, strips control characters, and bounds length", () => {
    expect(safeMcpPath("/api/v1/subscribers/*")).toBe("/api/v1/subscribers/*");
    expect(safeMcpPath("/api/v1/sub\u0000scribers")).toBe("/api/v1/subscribers");
    expect(safeMcpPath(`/${"a".repeat(5_000)}`)).toHaveLength(2_048);
    expect(safeMcpPath("no-leading-slash")).toBe("/");
    expect(safeMcpPath(undefined)).toBe("/");
  });
});

describe("token grammars", () => {
  it("whitelists HTTP methods and falls back to GET", () => {
    expect(safeMcpMethod(" post ")).toBe("POST");
    expect(safeMcpMethod("PROPFIND")).toBe("GET");
    expect(safeMcpMethod(7)).toBe("GET");
  });

  it("suppresses a diagnostic code that carries secret material", () => {
    expect(safeMcpDiagnostic("internal_error")).toBe("internal_error");
    expect(safeMcpDiagnostic("rate limited: retry")).toBe("rate limited: retry");
    expect(safeMcpDiagnostic("bad person@example.test")).toBe(MCP_SUPPRESSED);
    expect(safeMcpDiagnostic("x".repeat(129))).toBe(MCP_SUPPRESSED);
    expect(safeMcpDiagnostic("")).toBe(MCP_SUPPRESSED);
  });

  it("suppresses a tool name that is not a bounded identifier", () => {
    expect(safeMcpToolName("subscribers_create")).toBe("subscribers_create");
    expect(safeMcpToolName("_leading")).toBe(MCP_SUPPRESSED);
    expect(safeMcpToolName("pw_live_abcdef123456")).toBe(MCP_SUPPRESSED);
    expect(safeMcpToolName("tool name")).toBe(MCP_SUPPRESSED);
  });

  it("keeps only the exact MCP product token of a User-Agent", () => {
    expect(safeMcpUserAgent("postwave-mcp-server/1.4.0")).toBe(
      "postwave-mcp-server/1.4.0",
    );
    expect(safeMcpUserAgent("postwave-mcp-server/1.4.0 (person@example.test)")).toBe(
      MCP_SUPPRESSED,
    );
    expect(safeMcpUserAgent("curl/8.0")).toBe(MCP_SUPPRESSED);
  });
});

describe("redactMcpRequestDetails", () => {
  it("passes a minimised key_count through and counts it as redacted", () => {
    expect(redactMcpRequestDetails({ queryString: "key_count=3" })).toEqual({
      bodyJson: "",
      query: "key_count=3",
      redactionCount: 3,
    });
    expect(redactMcpRequestDetails({ queryString: "parameter_count=0" }).query).toBe(
      "key_count=0",
    );
  });

  it("reduces a RAW query string to its key count — never a key or a value", () => {
    const out = redactMcpRequestDetails({
      queryString: "email=person@example.test&token=secret",
    });
    expect(out.query).toBe("key_count=2");
    expect(out.redactionCount).toBe(2);
    expect(JSON.stringify(out)).not.toContain("example.test");
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("keeps only the constant summary fields of a body, never keys or values", () => {
    const out = redactMcpRequestDetails({
      requestBody: { email: "person@example.test", tags: ["vip"] },
    });
    expect(JSON.parse(out.bodyJson)).toEqual({
      _summary: true,
      type: "object",
      key_count: 2,
      _truncated: false,
    });
    expect(out.bodyJson).not.toContain("email");
    expect(out.bodyJson).not.toContain("vip");
    expect(out.redactionCount).toBe(2);
  });

  it("accepts the server's own summary and drops a legacy keys array", () => {
    const out = redactMcpRequestDetails({
      requestBody: {
        _summary: true,
        type: "object",
        keys: ["email", "name"],
        _truncated: true,
      },
    });
    expect(JSON.parse(out.bodyJson)).toEqual({
      _summary: true,
      type: "object",
      key_count: 2,
      _truncated: true,
    });
    expect(out.bodyJson).not.toContain("email");
  });

  it("refuses an unknown recorded type and falls back to the observed one", () => {
    const out = redactMcpRequestDetails({
      requestBody: { _summary: true, type: "<script>", key_count: 1 },
    });
    expect(JSON.parse(out.bodyJson).type).toBe("object");
  });

  it("yields no body block when nothing was retained", () => {
    expect(redactMcpRequestDetails({}).bodyJson).toBe("");
    expect(redactMcpRequestDetails({ requestBody: null }).bodyJson).toBe("");
  });

  it("words the redaction sentence with the right number", () => {
    expect(mcpRedactionSentence(1)).toContain("At least 1 request metadata item was omitted");
    expect(mcpRedactionSentence(4)).toContain("At least 4 request metadata items were omitted");
  });
});

function rowWire(over: Record<string, unknown> = {}) {
  return {
    id: 9,
    apiKeyId: "key-1",
    apiKeyPrefix: "pw_live_ab12",
    method: "POST",
    path: "/api/v1/subscribers/*",
    queryString: "key_count=1",
    toolName: "subscribers_create",
    statusCode: 500,
    latencyMs: 3100,
    userAgent: "postwave-mcp-server/1.4.0",
    errorCode: "internal_error",
    requestBody: { _summary: true, type: "object", key_count: 3 },
    dryRun: false,
    dryRunAsserted: false,
    costMicros: 0,
    calledAt: "2026-07-25T03:00:00Z",
    ...over,
  };
}

function envelope(rows: unknown[], over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    rows,
    detailPolicy: "minimized_v1",
    evidenceClass: "best_effort_observability",
    ...over,
  };
}

describe("normalizeMcpExecutionDetail", () => {
  it("accepts the tapped row and carries the server's policy words verbatim", () => {
    const parsed = normalizeMcpExecutionDetail(envelope([rowWire()]), 9, TENANT);
    expect(parsed.error).toBeNull();
    expect(parsed.detail?.detailPolicy).toBe("minimized_v1");
    expect(parsed.detail?.evidenceClass).toBe("best_effort_observability");
    expect(parsed.detail?.row?.id).toBe(9);
    expect(parsed.detail?.row?.query).toBe("key_count=1");
    expect(JSON.parse(parsed.detail!.row!.bodyJson).key_count).toBe(3);
    expect(parsed.detail?.row?.redactionCount).toBe(4);
  });

  it("refuses to show a DIFFERENT row under the tapped row's header", () => {
    // before_id is a cursor: a purged row makes the server answer the next
    // older one, and that must read as "not retained", not as the detail.
    const parsed = normalizeMcpExecutionDetail(envelope([rowWire({ id: 8 })]), 9, TENANT);
    expect(parsed.error).toBeNull();
    expect(parsed.detail?.row).toBeNull();
    expect(normalizeMcpExecutionDetail(envelope([]), 9, TENANT).detail?.row).toBeNull();
  });

  it("refuses the wrong workspace and a malformed envelope", () => {
    expect(
      normalizeMcpExecutionDetail(envelope([rowWire()]), 9, "22222222-2222-4222-8222-222222222222"),
    ).toEqual({ detail: null, error: MCP_DETAIL_WRONG_WORKSPACE });
    for (const bad of [null, [], { rows: [] }, { tenantId: TENANT }]) {
      expect(normalizeMcpExecutionDetail(bad, 9, TENANT)).toEqual({
        detail: null,
        error: MCP_DETAIL_MALFORMED,
      });
    }
  });

  it("masks every field of the projected row and never keeps the remote IP", () => {
    const row = projectMcpExecutionDetail(
      rowWire({
        path: "/api/v1/subscribers/person@example.test",
        toolName: "pw_live_abcdef123456",
        userAgent: "curl/8.0",
        errorCode: "leak person@example.test",
        remoteIp: "203.0.113.9",
        method: "propfind",
        dryRun: true,
        dryRunAsserted: undefined,
      }),
    );
    expect(row).not.toBeNull();
    expect(row?.path).toBe(MCP_SENSITIVE_PATH);
    expect(row?.toolName).toBe(MCP_SUPPRESSED);
    expect(row?.userAgent).toBe(MCP_SUPPRESSED);
    expect(row?.errorCode).toBe(MCP_SUPPRESSED);
    expect(row?.method).toBe("GET");
    expect(row?.dryRunAsserted).toBe(true);
    expect(JSON.stringify(row)).not.toContain("203.0.113.9");
    expect(JSON.stringify(row)).not.toContain("example.test");
  });

  it("keeps an absent tool / agent / error as absent rather than as Suppressed", () => {
    const row = projectMcpExecutionDetail(
      rowWire({ toolName: "", userAgent: undefined, errorCode: undefined, apiKeyId: undefined }),
    );
    expect(row?.toolName).toBe("");
    expect(row?.userAgent).toBe("");
    expect(row?.errorCode).toBe("");
    expect(row?.apiKeyId).toBe("");
  });

  it("refuses a row without a positive id", () => {
    expect(projectMcpExecutionDetail(rowWire({ id: 0 }))).toBeNull();
    expect(projectMcpExecutionDetail("row")).toBeNull();
  });
});

describe("mcpExecutionTitle", () => {
  it("names the absence and the suppression differently from a real identifier", () => {
    expect(mcpExecutionTitle("subscribers_create")).toBe("subscribers_create");
    expect(mcpExecutionTitle("")).toBe("No tool identifier recorded");
    expect(mcpExecutionTitle("has space")).toBe("Tool identifier suppressed");
  });
});
