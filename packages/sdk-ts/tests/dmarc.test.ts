import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

describe("DmarcResource", () => {
  it("uses the canonical bounded list transport and UUID report shape", async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://api.moosewave.com/api/v1/deliverability/dmarc-reports?domain=mail.example.com&from=2026-07-04T08%3A30%3A00Z&to=2026-08-03T08%3A30%3A00Z&limit=500",
      );
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "123e4567-e89b-42d3-a456-426614174000",
              orgName: "Example Receiver",
              reportId: "receiver-1",
              domain: "mail.example.com",
              policyP: "none",
              policyPct: null,
              dateBegin: "2026-08-02T00:00:00Z",
              dateEnd: "2026-08-03T00:00:00Z",
              passCount: 90,
              failCount: 10,
              receivedAt: "2026-08-03T01:00:00Z",
            },
          ],
          meta: {
            generatedAt: "2026-08-03T08:30:00Z",
            limit: 500,
            returned: 1,
            totalReports: 1,
            hasMore: false,
            availableDomains: ["mail.example.com"],
            domainInventoryTruncated: false,
            scope: { domain: "mail.example.com" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new PostwaveClient({
      apiKey: "test-key",
      tenantId: "tenant",
      fetch,
      retries: 0,
    });

    const page = await client.dmarc.list({
      domain: "mail.example.com",
      from: "2026-07-04T08:30:00Z",
      to: "2026-08-03T08:30:00Z",
      limit: 500,
    });

    expect(page.items[0]?.id).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(page.meta).toMatchObject({
      returned: 1,
      totalReports: 1,
      hasMore: false,
    });
  });
});
