// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  auditExportPath,
  redactAuditMetadata,
} from "@/lib/audit-api";

describe("audit metadata rendering boundary", () => {
  it("redacts credential keys and authorization-shaped values recursively", () => {
    const safe = redactAuditMetadata({
      before: {
        api_token: "secret-api-token",
        nested: { authorization: "Bearer abc.def.ghi", subject: "Campaign" },
      },
      after: {
        routing_key: "pagerduty-routing-key",
        status: "enabled",
      },
    });
    const rendered = JSON.stringify(safe);
    expect(rendered).toContain("Campaign");
    expect(rendered).toContain("enabled");
    expect(rendered).toContain("[redacted]");
    expect(rendered).not.toContain("secret-api-token");
    expect(rendered).not.toContain("abc.def.ghi");
    expect(rendered).not.toContain("pagerduty-routing-key");
  });

  it("bounds deeply nested, wide, and long metadata", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 250 }, (_, index) => [`field_${index}`, index]),
    );
    const safe = redactAuditMetadata({
      long: "x".repeat(10_000),
      deep: { a: { b: { c: { d: { e: { f: { g: "too deep" } } } } } } },
      wide,
      list: Array.from({ length: 120 }, (_, index) => index),
    });
    const rendered = JSON.stringify(safe);
    expect(rendered.length).toBeLessThan(20_000);
    expect(rendered).toContain("[truncated]");
    expect(rendered).toContain("[depth limit]");
  });

  it("caps browser CSV exports at 10,000 rows and preserves exact filters", () => {
    const path = auditExportPath({
      action: "subscriber.delete",
      resourceId: "sub-1",
      limit: 999_999,
    });
    const url = new URL(path, "https://app.example.test");
    expect(url.searchParams.get("action")).toBe("subscriber.delete");
    expect(url.searchParams.get("resource_id")).toBe("sub-1");
    expect(url.searchParams.get("limit")).toBe("10000");
    expect(url.searchParams.get("include_manifest")).toBe("true");
  });
});
