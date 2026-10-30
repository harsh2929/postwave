// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

import { API_KEY_SCOPES, PostwaveClient } from "../src/index.js";

describe("API key lifecycle contract", () => {
  it("exports the complete backend scope catalogue", () => {
    expect(API_KEY_SCOPES).toEqual([
      "read:subscribers",
      "write:subscribers",
      "read:campaigns",
      "write:campaigns",
      "send:transactional",
      "read:reports",
      "admin",
      "audit:read",
      "audit:read_pii",
      "audit:read_all_tenants",
      "audit:configure_sinks",
      "audit:configure_retention",
      "audit:execute_actions",
      "mcp",
    ]);
  });

  it("sends only fields the strict create handler accepts", async () => {
    let body: unknown;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          key: {
            id: "key-id",
            tenantId: "tenant-id",
            label: "read preview",
            prefix: "pw_live_abcd",
            scopes: ["mcp", "read:reports"],
            createdAt: "2026-08-20T00:00:00Z",
            actorType: "agent",
            sandboxOnly: true,
          },
          plaintext: "pw_live_abcd_once",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = new PostwaveClient({
      apiKey: "test",
      tenantId: "tenant",
      fetch,
      retries: 0,
    });

    await client.apiKeys.create({
      label: "read preview",
      scopes: ["mcp", "read:reports"],
      expires_at: "2026-08-21T00:00:00Z",
      allowed_ips: ["127.0.0.1/32"],
      sandbox_only: true,
    });

    expect(body).toEqual({
      label: "read preview",
      scopes: ["mcp", "read:reports"],
      expires_at: "2026-08-21T00:00:00Z",
      allowed_ips: ["127.0.0.1/32"],
      sandbox_only: true,
    });
  });
});
