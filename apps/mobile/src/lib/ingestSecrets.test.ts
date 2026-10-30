import { describe, expect, it } from "vitest";

import {

/**
 * KEY IDS ARE 32 HEX CHARACTERS, NOT ANY STRING.
 *
 * `Issue()` mints them as `randomToken(ingestKeyIDBytes=16, hex.EncodeToString)`
 * (apps/api/internal/conversions/ingest_secrets.go:46,165), so the parser's
 * `/^[0-9a-f]{32}$/` is the server's own shape. These fixtures used to say "k1",
 * which predates that check and made the whole file red — the parser was right
 * and the fixtures were stale, so the fixtures moved.
 */
  CONVERSION_INGEST_V2_CONTRACT,
  ingestSecretIsActive,
  ingestSecretRevokeCopy,
  parseIngestSecrets,
} from "./ingestSecrets";

describe("parseIngestSecrets", () => {
  it("reads the handler's { items } envelope", () => {
    const page = parseIngestSecrets({
      items: [
        {
          key_id: "3f9c1a7e5b0d42a8be61c07d29f4ab53",
          label: "Shopify",
          created_at: "2026-08-30T10:00:00Z",
          identity_projection_status: "ready",
          identity_projection_updated_at: "2026-08-30T10:01:00Z",
        },
      ],
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.label).toBe("Shopify");
  });

  it("falls back to the id so no key renders unlabelled", () => {
    // Nobody can decide about "8f2c…" under pressure.
    expect(
      parseIngestSecrets({
        items: [
          {
            key_id: "3f9c1a7e5b0d42a8be61c07d29f4ab53",
            label: "",
            created_at: "2026-08-30T10:00:00Z",
            identity_projection_status: "pending",
            identity_projection_updated_at: "2026-08-30T10:00:00Z",
          },
        ],
      }).items[0]?.label,
    ).toBe("3f9c1a7e5b0d42a8be61c07d29f4ab53");
  });

  it("accepts only a bounded optional opaque page cursor", () => {
    expect(
      parseIngestSecrets({ items: [], next_cursor: "next/opaque+cursor==" }),
    ).toEqual({ items: [], nextCursor: "next/opaque+cursor==" });
    expect(() => parseIngestSecrets({ items: [], next_cursor: "" })).toThrow(
      "malformed",
    );
    expect(() =>
      parseIngestSecrets({ items: [], next_cursor: "x".repeat(513) }),
    ).toThrow("malformed");
    expect(() => parseIngestSecrets({ items: [], total: 0 })).toThrow(
      "malformed",
    );
  });

  it("fails closed on a missing id, secret-bearing row, or malformed envelope", () => {
    expect(() =>
      parseIngestSecrets({
        items: [
          {
            label: "ghost",
            created_at: "2026-08-30T10:00:00Z",
            identity_projection_status: "ready",
            identity_projection_updated_at: "2026-08-30T10:00:00Z",
          },
        ],
      }),
    ).toThrow("invalid row");
    expect(() =>
      parseIngestSecrets({
        items: [
          {
            key_id: "3f9c1a7e5b0d42a8be61c07d29f4ab53",
            label: "live",
            created_at: "2026-08-30T10:00:00Z",
            identity_projection_status: "ready",
            identity_projection_updated_at: "2026-08-30T10:00:00Z",
            secret: "must-never-be-listable",
          },
        ],
      }),
    ).toThrow("invalid row");
    expect(() => parseIngestSecrets(null)).toThrow("malformed");
    expect(() => parseIngestSecrets({ items: "nope" })).toThrow("malformed");
  });

  it("fails closed on incomplete or contradictory email projection state", () => {
    const base = {
      key_id: "3f9c1a7e5b0d42a8be61c07d29f4ab53",
      label: "live",
      created_at: "2026-08-30T10:00:00Z",
      identity_projection_updated_at: "2026-08-30T10:01:00Z",
    };
    expect(() => parseIngestSecrets({ items: [{ ...base }] })).toThrow(
      "invalid row",
    );
    expect(() =>
      parseIngestSecrets({
        items: [
          {
            ...base,
            identity_projection_status: "failed",
          },
        ],
      }),
    ).toThrow("invalid row");
    expect(() =>
      parseIngestSecrets({
        items: [
          {
            ...base,
            identity_projection_status: "ready",
            identity_projection_error_code: "projection_failed",
          },
        ],
      }),
    ).toThrow("invalid row");
  });
});

describe("ingestSecretIsActive", () => {
  it("treats a key with no revocation timestamp as live", () => {
    const {
      items: [live],
    } = parseIngestSecrets({
      items: [
        {
          key_id: "3f9c1a7e5b0d42a8be61c07d29f4ab53",
          label: "",
          created_at: "2026-08-30T10:00:00Z",
          identity_projection_status: "ready",
          identity_projection_updated_at: "2026-08-30T10:00:00Z",
        },
      ],
    });
    expect(ingestSecretIsActive(live!)).toBe(true);
  });

  it("treats a revoked key as inactive", () => {
    const {
      items: [dead],
    } = parseIngestSecrets({
      items: [
        {
          key_id: "3f9c1a7e5b0d42a8be61c07d29f4ab53",
          label: "",
          created_at: "2026-08-29T10:00:00Z",
          revoked_at: "2026-08-30T10:00:00Z",
          identity_projection_status: "failed",
          identity_projection_error_code: "secret_unavailable",
          identity_projection_updated_at: "2026-08-30T09:00:00Z",
        },
      ],
    });
    expect(ingestSecretIsActive(dead!)).toBe(false);
  });
});

describe("ingestSecretRevokeCopy", () => {
  it("names the cost as well as the benefit", () => {
    // Saying only "stops forged events" would make revoking look free; it also
    // breaks anything legitimate still signing with the key.
    const copy = ingestSecretRevokeCopy({
      keyId: "3f9c1a7e5b0d42a8be61c07d29f4ab53",
      label: "Shopify",
      createdAt: "",
      revokedAt: null,
      identityProjectionStatus: "ready",
      identityProjectionErrorCode: null,
      identityProjectionUpdatedAt: "2026-08-30T10:00:00Z",
    });
    expect(copy.title).toContain("Shopify");
    expect(copy.body).toContain("legitimate");
    expect(copy.body).toContain("cannot be undone");
  });
});

describe("signed-ingest v2 operator contract", () => {
  it("locks the exact header, key-bound preimage, and email pseudonym rule", () => {
    expect(CONVERSION_INGEST_V2_CONTRACT).toEqual([
      "X-Postwave-Signature: keyid=<id>,v2=<hex>",
      "X-Postwave-Timestamp: <Unix seconds>",
      "Idempotency-Key: <stable retry key>",
      "MAC = HMAC-SHA256(signing secret, UTF8('postwave-conversion-v2\\n' + byteLength(key_id) + '\\n' + key_id + byteLength(timestamp) + '\\n' + timestamp) || exact raw JSON bytes)",
      "email_hmac_sha256 = HMAC-SHA256(signing secret, lower(trim(email)))",
    ]);
  });
});
