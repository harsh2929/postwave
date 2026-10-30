import { describe, expect, it } from "vitest";

import { parseQueueDepth, parseDeadLetters } from "./send";

const TENANT_ID = "018f4f4c-53de-7c12-ae4d-fbbac8f735b1";

describe("parseQueueDepth", () => {
  it("returns rows from a well-formed body", () => {
    const r = parseQueueDepth(200, { tenants: [{ tenant_id: TENANT_ID, slug: "acme", name: "Acme", pending: 5, failed: 1 }], truncated: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows[0].pending).toBe(5);
  });
  it("a non-200 is a loud failure", () => {
    expect(parseQueueDepth(500, {}).ok).toBe(false);
  });
  it("a malformed body is a failure, not empty", () => {
    expect(parseQueueDepth(200, { nope: 1 } as unknown).ok).toBe(false);
  });
  it("rejects duplicate rows and unsafe counts", () => {
    const row = { tenant_id: TENANT_ID, slug: "acme", name: "Acme", pending: 5, failed: 1 };
    expect(parseQueueDepth(200, { tenants: [row, row], truncated: false }).ok).toBe(false);
    expect(parseQueueDepth(200, { tenants: [{ ...row, pending: -1 }], truncated: false }).ok).toBe(false);
  });
});

describe("parseDeadLetters", () => {
  it("returns rows from a well-formed body", () => {
    const r = parseDeadLetters(200, { dead_letters: [{ tenant_id: TENANT_ID, slug: "acme", kind: "automation.email", dead_count: 3, oldest_dead_at: "2026-07-15T00:00:00Z" }], truncated: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows[0].kind).toBe("automation.email");
  });
  it("a non-200 is a loud failure", () => {
    expect(parseDeadLetters(503, {}).ok).toBe(false);
  });
});
