import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("InboundEmailsResource endpoint secret contract", () => {
  it("uses metadata-only GET and one-shot create/rotate POST", async () => {
    const metadata = {
      id: "endpoint-1",
      tenantId: "tenant-1",
      slug: "opaque-slug",
      secretConfigured: true,
      rotationRequired: false,
      secretRotatedAt: "2026-07-15T12:00:00Z",
      createdAt: "2026-07-15T12:00:00Z",
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(metadata))
      .mockResolvedValueOnce(
        json({ ...metadata, secret: "iem_revealed_once" }),
      );
    const client = new PostwaveClient({ apiKey: "pw_test", fetch, retries: 0 });

    const read = await client.inboundEmails.getEndpoint();
    const rotated = await client.inboundEmails.rotateEndpoint();

    expect(read).not.toHaveProperty("secret");
    expect(rotated.secret).toBe("iem_revealed_once");
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.moosewave.com/api/v1/inbound-emails/endpoint",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.moosewave.com/api/v1/inbound-emails/endpoint/rotate",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
