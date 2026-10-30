import { describe, expect, it } from "vitest";

import {
  buildRootErrorReport,
  redactErrorMessage,
  rootErrorShareText,
} from "./rootErrorReport";

describe("redactErrorMessage", () => {
  it("removes email addresses", () => {
    expect(redactErrorMessage("failed for reader@example.com")).toBe(
      "failed for [email]",
    );
  });

  it("removes API keys and bearer tokens", () => {
    expect(redactErrorMessage("bad key pw_abc123def456")).toBe(
      "bad key [redacted]",
    );
    expect(
      redactErrorMessage("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9xxxx"),
    ).toBe("Authorization: [redacted]");
  });

  it("removes long opaque blobs", () => {
    expect(redactErrorMessage(`payload ${"a".repeat(60)} end`)).toBe(
      "payload [redacted] end",
    );
  });

  it("collapses whitespace and truncates", () => {
    const long = redactErrorMessage("word ".repeat(200));
    expect(long).not.toBeNull();
    expect((long as string).length).toBeLessThanOrEqual(200);
    expect(long as string).toMatch(/…$/);
  });

  it("returns null for a non-string or empty message", () => {
    expect(redactErrorMessage(undefined)).toBeNull();
    expect(redactErrorMessage("   ")).toBeNull();
  });
});

describe("buildRootErrorReport", () => {
  it("carries the SDK request id into a spoken reference", () => {
    const error = Object.assign(new TypeError("boom for a@b.co"), {
      requestId: "req_01HZY",
    });
    const report = buildRootErrorReport(error, "1.4.2");
    expect(report).toMatchObject({
      name: "TypeError",
      message: "boom for [email]",
      requestId: "req_01HZY",
      release: "1.4.2",
    });
    expect(report.reference).toBe("TypeError · ref req_01HZY · 1.4.2");
  });

  it("degrades safely when there is nothing to report", () => {
    const report = buildRootErrorReport(null, undefined);
    expect(report).toEqual({
      name: "Error",
      message: null,
      requestId: null,
      release: null,
      reference: "Error",
    });
  });

  it("rejects a malformed request id or release rather than rendering it", () => {
    const error = Object.assign(new Error("x"), {
      requestId: "<script>alert(1)</script>",
    });
    const report = buildRootErrorReport(error, "not a release!!");
    expect(report.requestId).toBeNull();
    expect(report.release).toBeNull();
  });
});

describe("rootErrorShareText", () => {
  it("omits absent fields instead of printing null", () => {
    const text = rootErrorShareText(
      buildRootErrorReport(new Error("plain failure"), undefined),
    );
    expect(text).toBe("Moosewave app error\nType: Error\nDetail: plain failure");
    expect(text).not.toContain("null");
  });
});
