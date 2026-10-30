// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";

import {
  AmbiguousConversionIngestSecretIssueError,
  CONVERSION_INGEST_SECRET_AMBIGUOUS_ISSUE_RECOVERY,
  CONVERSION_INGEST_SECRET_NOTICE,
  PostwaveClient,
} from "../src/index.js";

const KEY_A = "0123456789abcdef0123456789abcdef";
const KEY_B = "abcdef0123456789abcdef0123456789";
const SECRET = "A".repeat(43);
const CREATED = "2026-08-30T12:00:00.123Z";
const UPDATED = "2026-08-30T12:00:01Z";

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    key_id: KEY_A,
    label: "Orders 🔐",
    created_at: CREATED,
    identity_projection_status: "ready",
    identity_projection_updated_at: UPDATED,
    ...overrides,
  };
}

function issued(overrides: Record<string, unknown> = {}) {
  return {
    secret: {
      ...metadata({ identity_projection_status: "pending" }),
      secret: SECRET,
      ...overrides,
    },
    notice: CONVERSION_INGEST_SECRET_NOTICE,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ConversionIngestSecretsResource", () => {
  it("lists exactly one bounded metadata page and preserves conditional state", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      expect(url).toBe(
        "https://api.moosewave.com/api/v1/conversions/ingest-secrets?limit=17&cursor=page-token",
      );
      expect(init.method).toBe("GET");
      expect(init.body).toBeNull();
      return json({
        items: [
          metadata(),
          metadata({
            key_id: KEY_B,
            label: "retired",
            revoked_at: "2026-08-30T13:00:00+00:00",
            identity_projection_status: "failed",
            identity_projection_error_code: "secret_unavailable",
          }),
        ],
        next_cursor: "next-page",
      });
    });
    const client = new PostwaveClient({
      apiKey: "pw_admin",
      fetch,
      retries: 4,
    });

    const page = await client.conversionIngestSecrets.list({
      limit: 17,
      cursor: "page-token",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(page).toEqual({
      items: [
        {
          keyId: KEY_A,
          label: "Orders 🔐",
          createdAt: CREATED,
          identityProjectionStatus: "ready",
          identityProjectionUpdatedAt: UPDATED,
        },
        {
          keyId: KEY_B,
          label: "retired",
          createdAt: CREATED,
          revokedAt: "2026-08-30T13:00:00+00:00",
          identityProjectionStatus: "failed",
          identityProjectionErrorCode: "secret_unavailable",
          identityProjectionUpdatedAt: UPDATED,
        },
      ],
      nextCursor: "next-page",
    });
  });

  it("issues once with no Idempotency-Key, even with retries and a default header", async () => {
    const requests: RequestInit[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit = {}) => {
      requests.push(init);
      return json(issued(), 201);
    });
    const client = new PostwaveClient({
      apiKey: "pw_admin",
      fetch,
      retries: 8,
      defaultHeaders: { "idempotency-key": "must-be-stripped" },
    });

    const result = await client.conversionIngestSecrets.issue("Orders 🔐");

    expect(fetch).toHaveBeenCalledTimes(1);
    const headers = Object.fromEntries(
      Object.entries(requests[0]?.headers as Record<string, string>).map(
        ([key, value]) => [key.toLowerCase(), value],
      ),
    );
    expect(headers["idempotency-key"]).toBeUndefined();
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.body).toBe(JSON.stringify({ label: "Orders 🔐" }));
    expect(result).toEqual({
      keyId: KEY_A,
      label: "Orders 🔐",
      createdAt: CREATED,
      identityProjectionStatus: "pending",
      identityProjectionUpdatedAt: UPDATED,
      secret: SECRET,
      notice: CONVERSION_INGEST_SECRET_NOTICE,
    });
  });

  it("never retries an ambiguous status and carries the only safe recovery", async () => {
    const fetch = vi.fn(async () => json({ error: { code: "internal" } }, 503));
    const client = new PostwaveClient({
      apiKey: "pw_admin",
      fetch,
      retries: 9,
    });

    await expect(
      client.conversionIngestSecrets.issue("orders"),
    ).rejects.toMatchObject({
      name: "AmbiguousConversionIngestSecretIssueError",
      recovery: CONVERSION_INGEST_SECRET_AMBIGUOUS_ISSUE_RECOVERY,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats a wrong 2xx status or malformed reveal as ambiguous", async () => {
    for (const response of [
      json(issued(), 200),
      json(issued({ secret: "not-base64url" }), 201),
      json(issued({ revoked_at: UPDATED }), 201),
      json(issued({ identity_projection_status: "ready" }), 201),
      json(issued({ label: "mismatched" }), 201),
      json({ ...issued(), extra: true }, 201),
    ]) {
      const client = new PostwaveClient({
        apiKey: "pw_admin",
        retries: 5,
        fetch: vi.fn(async () => response.clone()),
      });
      await expect(
        client.conversionIngestSecrets.issue("Orders 🔐"),
      ).rejects.toBeInstanceOf(AmbiguousConversionIngestSecretIssueError);
    }

    const secretBearingMalformed = new PostwaveClient({
      apiKey: "pw_admin",
      retries: 0,
      fetch: vi.fn(async () => json({ ...issued(), extra: true }, 201)),
    });
    try {
      await secretBearingMalformed.conversionIngestSecrets.issue("Orders 🔐");
      expect.fail("expected ambiguous malformed reveal");
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousConversionIngestSecretIssueError);
      expect(String(error)).not.toContain(SECRET);
      expect(
        (error as AmbiguousConversionIngestSecretIssueError).payload,
      ).toBeUndefined();
    }
  });

  it("rejects hostile closed pages, labels, cursors, and duplicate IDs locally", async () => {
    const fetch = vi.fn(async () => json({ items: [] }));
    const client = new PostwaveClient({
      apiKey: "pw_admin",
      fetch,
      retries: 0,
    });

    await expect(
      client.conversionIngestSecrets.list({ limit: 0 }),
    ).rejects.toThrow(/1 to 100/);
    await expect(
      client.conversionIngestSecrets.list({ cursor: "x".repeat(513) }),
    ).rejects.toThrow(/cursor/);
    await expect(
      client.conversionIngestSecrets.issue(" padded "),
    ).rejects.toThrow(/label/);
    await expect(
      client.conversionIngestSecrets.issue("😀".repeat(129)),
    ).rejects.toThrow(/128 Unicode/);
    await expect(
      client.conversionIngestSecrets.issue("bad\ud800label"),
    ).rejects.toThrow(/label/);
    expect(fetch).not.toHaveBeenCalled();

    for (const page of [
      { items: [metadata({ secret: SECRET })] },
      { items: [metadata({ identity_projection_error_code: null })] },
      { items: [metadata(), metadata()] },
      { items: [metadata()], next_cursor: "same" },
      { items: [], unknown: true },
    ]) {
      const closed = new PostwaveClient({
        apiKey: "pw_admin",
        retries: 0,
        fetch: vi.fn(async () => json(page)),
      });
      await expect(
        closed.conversionIngestSecrets.list({
          cursor: page.next_cursor === "same" ? "same" : undefined,
        }),
      ).rejects.toThrow();
    }
  });

  it("revokes the exact ID with a bodyless normal write and strict receipt", async () => {
    const requests: RequestInit[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit = {}) => {
      requests.push(init);
      return json({ revoked: true });
    });
    const client = new PostwaveClient({
      apiKey: "pw_admin",
      fetch,
      retries: 0,
    });

    await expect(client.conversionIngestSecrets.revoke(KEY_A)).resolves.toEqual(
      {
        revoked: true,
      },
    );
    expect(requests[0]?.body).toBeNull();
    expect(
      (requests[0]?.headers as Record<string, string>)["Idempotency-Key"],
    ).toMatch(/.+/u);
    await expect(
      client.conversionIngestSecrets.revoke(KEY_A.toUpperCase()),
    ).rejects.toThrow(/lowercase hexadecimal/);
  });
});
