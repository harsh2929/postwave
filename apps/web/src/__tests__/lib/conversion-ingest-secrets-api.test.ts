// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONVERSION_INGEST_V2_CONTRACT,
  conversionIngestSecretsApi,
  issuedConversionIngestSecretSummary,
  parseConversionIngestSecretRegister,
  parseIssuedConversionIngestSecret,
} from "@/lib/conversion-ingest-secrets-api";

const REVEALED_SECRET = "A".repeat(43);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("conversion signed-ingest secret API", () => {
  it("parses list metadata while failing closed if a list ever carries a secret", () => {
    expect(
      parseConversionIngestSecretRegister({
        items: [
          {
            key_id: "0123456789abcdef0123456789abcdef",
            label: "Production checkout",
            created_at: "2026-08-30T10:00:00Z",
            identity_projection_status: "ready",
            identity_projection_updated_at: "2026-08-30T10:01:00Z",
          },
        ],
      }),
    ).toEqual({
      items: [
        {
          keyId: "0123456789abcdef0123456789abcdef",
          label: "Production checkout",
          createdAt: "2026-08-30T10:00:00Z",
          revokedAt: null,
          identityProjectionStatus: "ready",
          identityProjectionErrorCode: null,
          identityProjectionUpdatedAt: "2026-08-30T10:01:00Z",
        },
      ],
    });

    expect(() =>
      parseConversionIngestSecretRegister({
        items: [
          {
            key_id: "0123456789abcdef0123456789abcdef",
            label: "Production checkout",
            created_at: "2026-08-30T10:00:00Z",
            identity_projection_status: "ready",
            identity_projection_updated_at: "2026-08-30T10:01:00Z",
            secret: "must-not-be-listable",
          },
        ],
      }),
    ).toThrow("invalid row");
  });

  it("accepts the handler's nested one-time issue response only", () => {
    const issued = parseIssuedConversionIngestSecret({
      secret: {
        key_id: "0123456789abcdef0123456789abcdef",
        secret: REVEALED_SECRET,
        label: "Production checkout",
        created_at: "2026-08-30T10:00:00Z",
        identity_projection_status: "pending",
        identity_projection_updated_at: "2026-08-30T10:00:00Z",
      },
      notice: "This is the only time the secret is shown.",
    });
    expect(issued.secret).toBe(REVEALED_SECRET);
    expect(issued.keyId).toBe("0123456789abcdef0123456789abcdef");
    const registerRow = issuedConversionIngestSecretSummary(issued);
    expect(registerRow).toEqual({
      keyId: "0123456789abcdef0123456789abcdef",
      label: "Production checkout",
      createdAt: "2026-08-30T10:00:00Z",
      revokedAt: null,
      identityProjectionStatus: "pending",
      identityProjectionErrorCode: null,
      identityProjectionUpdatedAt: "2026-08-30T10:00:00Z",
    });
    expect(registerRow).not.toHaveProperty("secret");
    expect(() =>
      parseIssuedConversionIngestSecret({
        key_id: "wrong-flat-shape",
        secret: REVEALED_SECRET,
      }),
    ).toThrow("may have been issued");
  });

  it("uses all three admin routes with no-store and the mounted revoke verb", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const path = url.replace(/^https?:\/\/[^/]+/u, "");
        if (init.method === "GET") {
          return Response.json({ items: [] });
        }
        if (path.endsWith("/revoke")) {
          return Response.json({ revoked: true });
        }
        return Response.json(
          {
            secret: {
              key_id: "0123456789abcdef0123456789abcdef",
              secret: REVEALED_SECRET,
              label: "Production checkout",
              created_at: "2026-08-30T10:00:00Z",
              identity_projection_status: "pending",
              identity_projection_updated_at: "2026-08-30T10:00:00Z",
            },
            notice: "This is the only time the secret is shown.",
          },
          { status: 201 },
        );
      }),
    );

    await conversionIngestSecretsApi.list({ cursor: "next-page" });
    await conversionIngestSecretsApi.issue(" Production checkout ");
    await conversionIngestSecretsApi.revoke("0123456789abcdef0123456789abcdef");

    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:8080/api/v1/conversions/ingest-secrets?limit=100&cursor=next-page",
      "http://localhost:8080/api/v1/conversions/ingest-secrets",
      "http://localhost:8080/api/v1/conversions/ingest-secrets/0123456789abcdef0123456789abcdef/revoke",
    ]);
    expect(calls.map((call) => call.init.method)).toEqual([
      "GET",
      "POST",
      "POST",
    ]);
    expect(calls.every((call) => call.init.cache === "no-store")).toBe(true);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      label: "Production checkout",
    });
    expect(new Headers(calls[1]?.init.headers).get("Idempotency-Key")).toBeNull();
  });

  it("uses schema-exact key IDs, code-point labels, and reveal credentials", () => {
    const multibyteLabel = "😀".repeat(128);
    expect(
      parseConversionIngestSecretRegister({
        items: [
          {
            key_id: "0123456789abcdef0123456789abcdef",
            label: multibyteLabel,
            created_at: "2026-08-30T10:00:00Z",
            identity_projection_status: "ready",
            identity_projection_updated_at: "2026-08-30T10:01:00Z",
          },
        ],
      }).items[0]?.label,
    ).toBe(multibyteLabel);
    expect(() =>
      parseConversionIngestSecretRegister({
        items: [
          {
            key_id: "KEY-1",
            label: "invalid ID",
            created_at: "2026-08-30T10:00:00Z",
            identity_projection_status: "ready",
            identity_projection_updated_at: "2026-08-30T10:01:00Z",
          },
        ],
      }),
    ).toThrow("invalid row");
    expect(() =>
      parseConversionIngestSecretRegister({
        items: [
          {
            key_id: "0123456789abcdef0123456789abcdef",
            label: "😀".repeat(129),
            created_at: "2026-08-30T10:00:00Z",
            identity_projection_status: "ready",
            identity_projection_updated_at: "2026-08-30T10:01:00Z",
          },
        ],
      }),
    ).toThrow("invalid row");

    const issuedBase = {
      secret: {
        key_id: "0123456789abcdef0123456789abcdef",
        label: multibyteLabel,
        created_at: "2026-08-30T10:00:00Z",
        identity_projection_status: "pending",
        identity_projection_updated_at: "2026-08-30T10:00:00Z",
      },
      notice: "Only shown once.",
    };
    expect(
      parseIssuedConversionIngestSecret({
        ...issuedBase,
        secret: { ...issuedBase.secret, secret: REVEALED_SECRET },
      }).secret,
    ).toBe(REVEALED_SECRET);
    for (const malformed of ["A".repeat(42), "A".repeat(44), `${"A".repeat(42)}+`]) {
      expect(() =>
        parseIssuedConversionIngestSecret({
          ...issuedBase,
          secret: { ...issuedBase.secret, secret: malformed },
        }),
      ).toThrow("could not be verified");
    }
    expect(() =>
      parseIssuedConversionIngestSecret({
        ...issuedBase,
        secret: { ...issuedBase.secret, secret: REVEALED_SECRET },
        replayable: true,
      }),
    ).toThrow("could not be verified");
  });

  it("fails closed on incomplete or contradictory projection state", () => {
    const base = {
      // The API contract uses an exact 32-character lowercase hex key ID.
      // Keep this fixture valid so the assertions below isolate projection
      // state rather than failing earlier on an unrelated identifier error.
      key_id: "0123456789abcdef0123456789abcdef",
      label: "Production checkout",
      created_at: "2026-08-30T10:00:00Z",
      identity_projection_updated_at: "2026-08-30T10:01:00Z",
    };
    expect(() =>
      parseConversionIngestSecretRegister({
        items: [{ ...base, identity_projection_status: "failed" }],
      }),
    ).toThrow("invalid row");
    expect(() =>
      parseConversionIngestSecretRegister({
        items: [
          {
            ...base,
            identity_projection_status: "ready",
            identity_projection_error_code: "projection_failed",
          },
        ],
      }),
    ).toThrow("invalid row");
    expect(
      parseConversionIngestSecretRegister({
        items: [
          {
            ...base,
            identity_projection_status: "failed",
            identity_projection_error_code: "secret_unavailable",
          },
        ],
      }).items[0],
    ).toMatchObject({
      identityProjectionStatus: "failed",
      identityProjectionErrorCode: "secret_unavailable",
    });
  });

  it("accepts only a bounded optional pagination cursor", () => {
    expect(
      parseConversionIngestSecretRegister({
        items: [],
        next_cursor: "opaque-next-page",
      }),
    ).toEqual({ items: [], nextCursor: "opaque-next-page" });
    expect(() =>
      parseConversionIngestSecretRegister({ items: [], next_cursor: "" }),
    ).toThrow("malformed");
    expect(() =>
      parseConversionIngestSecretRegister({ items: [], total: 0 }),
    ).toThrow("malformed");
  });

  it("locks the key-bound v2 signature and HMAC email identity contract", () => {
    expect(CONVERSION_INGEST_V2_CONTRACT).toEqual([
      "X-Postwave-Signature: keyid=<id>,v2=<hex>",
      "X-Postwave-Timestamp: <Unix seconds>",
      "Idempotency-Key: <stable retry key>",
      "MAC = HMAC-SHA256(signing secret, UTF8('postwave-conversion-v2\\n' + byteLength(key_id) + '\\n' + key_id + byteLength(timestamp) + '\\n' + timestamp) || exact raw JSON bytes)",
      "email_hmac_sha256 = HMAC-SHA256(signing secret, lower(trim(email)))",
    ]);
  });
});
