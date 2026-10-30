import { beforeEach, describe, expect, it, vi } from "vitest";
import { listIngestSecrets, revokeIngestSecret } from "./ingestSecrets";

/**
 * KEY IDS ARE 32 HEX CHARACTERS, NOT ANY STRING.
 *
 * `Issue()` mints them as `randomToken(ingestKeyIDBytes=16, hex.EncodeToString)`
 * (apps/api/internal/conversions/ingest_secrets.go:46,165), so the parser's
 * `/^[0-9a-f]{32}$/` is the server's own shape. These fixtures used to say "k1",
 * which predates that check and made the whole file red — the parser was right
 * and the fixtures were stale, so the fixtures moved.
 */

const mocks = vi.hoisted(() => ({ rawRequest: vi.fn() }));

vi.mock("@/api/request", () => ({ rawRequest: mocks.rawRequest }));

beforeEach(() => mocks.rawRequest.mockReset());

describe("mobile signed-ingest secret API", () => {
  it("lists only metadata from the exact admin route", async () => {
    mocks.rawRequest.mockResolvedValueOnce({
      data: {
        items: [
          {
            key_id: "3f9c1a7e5b0d42a8be61c07d29f4ab53",
            label: "Production checkout",
            created_at: "2026-08-30T10:00:00Z",
            identity_projection_status: "pending",
            identity_projection_updated_at: "2026-08-30T10:00:00Z",
          },
        ],
      },
    });

    await expect(listIngestSecrets("next/opaque+cursor==")).resolves.toEqual({
      items: [
        {
          keyId: "3f9c1a7e5b0d42a8be61c07d29f4ab53",
          label: "Production checkout",
          createdAt: "2026-08-30T10:00:00Z",
          revokedAt: null,
          identityProjectionStatus: "pending",
          identityProjectionErrorCode: null,
          identityProjectionUpdatedAt: "2026-08-30T10:00:00Z",
        },
      ],
    });
    expect(mocks.rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/conversions/ingest-secrets?limit=100&cursor=next%2Fopaque%2Bcursor%3D%3D",
    );
  });

  it("refuses a key id that is not the server's shape, before any request", async () => {
    // This used to assert that "key/id" was URL-encoded into the path. The
    // client now refuses that id outright, which is the stronger guarantee:
    // a separator cannot reach a path segment at all, encoded or not. Revoking
    // is irreversible and admin-only, so a malformed id must not become a
    // request against SOME row — it must become an error.
    await expect(revokeIngestSecret(" key/id ")).rejects.toThrow(
      "key ID is invalid",
    );
    await expect(revokeIngestSecret("../../admin")).rejects.toThrow(
      "key ID is invalid",
    );
    expect(mocks.rawRequest).not.toHaveBeenCalled();
  });

  it("trims and forwards a real key id, and requires positive confirmation", async () => {
    mocks.rawRequest.mockResolvedValueOnce({ data: { revoked: true } });
    await expect(
      revokeIngestSecret("  3f9c1a7e5b0d42a8be61c07d29f4ab53  "),
    ).resolves.toBeUndefined();
    expect(mocks.rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/conversions/ingest-secrets/3f9c1a7e5b0d42a8be61c07d29f4ab53/revoke",
      {},
    );

    // A 200 that does not say `revoked: true` is not a revocation. Reporting
    // success there would tell an admin a leaked key was dead when it was not.
    mocks.rawRequest.mockResolvedValueOnce({ data: { revoked: false } });
    await expect(
      revokeIngestSecret("8d21e4c60fb74a19ac35d802e7b16f4c"),
    ).rejects.toThrow("did not confirm");
  });
});
