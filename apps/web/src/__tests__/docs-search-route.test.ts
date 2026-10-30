// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/docs/search/route";

describe("docs search route", () => {
  it("returns compact results without serializing document bodies or postings", async () => {
    const response = GET(
      new Request("https://postwave.test/api/docs/search?q=campaign"),
    );
    const body = (await response.json()) as {
      results: Array<{ doc: Record<string, unknown> }>;
    };

    expect(response.status).toBe(200);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0]?.doc).toHaveProperty("title");
    expect(body.results[0]?.doc).not.toHaveProperty("body");
    expect(JSON.stringify(body)).not.toContain('"postings"');
  });

  it("rejects abusive query lengths before building a response", async () => {
    const response = GET(
      new Request(`https://postwave.test/api/docs/search?q=${"a".repeat(101)}`),
    );
    expect(response.status).toBe(400);
  });
});
