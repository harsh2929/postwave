import { beforeEach, describe, expect, it, vi } from "vitest";

import { WireShapeError } from "@/lib/wireShapeError";

import { listTrackingKeys, revokeTrackingKey } from "./trackingKeys";

const mocks = vi.hoisted(() => ({ rawRequest: vi.fn() }));

vi.mock("./request", () => ({ rawRequest: mocks.rawRequest }));

beforeEach(() => mocks.rawRequest.mockReset());

const wireRow = {
  id: "3f7c1a2e-9b4d-4c8e-a1f0-5d6e7f8a9b0c",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  label: "Production storefront",
  prefix: "pk_live_ab12",
  created_at: "2026-08-30T10:00:00Z",
};

describe("listTrackingKeys", () => {
  it("reads the handler's bare array from the exact admin route", async () => {
    mocks.rawRequest.mockResolvedValueOnce({ data: [wireRow], error: null });

    await expect(listTrackingKeys()).resolves.toEqual([
      {
        id: "3f7c1a2e-9b4d-4c8e-a1f0-5d6e7f8a9b0c",
        label: "Production storefront",
        prefix: "pk_live_ab12",
        createdAt: "2026-08-30T10:00:00Z",
        revokedAt: "",
      },
    ]);
    expect(mocks.rawRequest).toHaveBeenCalledTimes(1);
    expect(mocks.rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/conversions/keys",
    );
  });

  it("reads the handler's empty register as empty", async () => {
    // conversions.go ListTrackingKeys: `out := []TrackingKey{}` — never null.
    mocks.rawRequest.mockResolvedValueOnce({ data: [], error: null });
    await expect(listTrackingKeys()).resolves.toEqual([]);
  });

  it("treats a non-array body as drift, never as an empty register", async () => {
    // "No site keys" is a security statement. A paged envelope where the
    // bare array should be must surface as a failure, not as reassurance.
    mocks.rawRequest.mockResolvedValueOnce({
      data: { items: [wireRow] },
      error: null,
    });
    await expect(listTrackingKeys()).rejects.toThrow("malformed");

    mocks.rawRequest.mockResolvedValueOnce({ data: null, error: null });
    await expect(listTrackingKeys()).rejects.toThrow("malformed");
  });

  it("tags the drift as a wire-shape failure, keeping its sentence", async () => {
    // errorCopy reads `code: "wire_shape"` to tell drift from a network blip,
    // so a bare Error here reads as "something went wrong loading this".
    mocks.rawRequest.mockResolvedValueOnce({
      data: { items: [wireRow] },
      error: null,
    });
    const err = await listTrackingKeys().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WireShapeError);
    expect(err).toMatchObject({
      code: "wire_shape",
      message: "The site-key register response was malformed.",
    });
  });

  it("surfaces the server's error envelope with its status", async () => {
    mocks.rawRequest.mockResolvedValueOnce({
      data: null,
      error: { status: 403, message: "admin role required" },
    });
    await expect(listTrackingKeys()).rejects.toMatchObject({
      message: "admin role required",
      status: 403,
    });
  });
});

describe("revokeTrackingKey", () => {
  it("DELETEs the encoded id and requires positive confirmation", async () => {
    mocks.rawRequest.mockResolvedValueOnce({ data: { ok: true }, error: null });
    await expect(revokeTrackingKey(" key/1 ")).resolves.toBeUndefined();
    expect(mocks.rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/conversions/keys/key%2F1",
    );

    mocks.rawRequest.mockResolvedValueOnce({ data: { ok: false }, error: null });
    await expect(revokeTrackingKey("key-2")).rejects.toThrow("did not confirm");

    mocks.rawRequest.mockResolvedValueOnce({ data: "", error: null });
    await expect(revokeTrackingKey("key-3")).rejects.toThrow("did not confirm");
  });

  it("refuses a blank id before touching the network", async () => {
    await expect(revokeTrackingKey("   ")).rejects.toThrow("required");
    expect(mocks.rawRequest).not.toHaveBeenCalled();
  });

  it("surfaces the handler's 404 as its own sentence", async () => {
    // AdminRevokeKey answers a static "tracking key not found" when the
    // (tenant, id, not-yet-revoked) predicate matches nothing.
    mocks.rawRequest.mockResolvedValueOnce({
      data: null,
      error: { status: 404, message: "tracking key not found" },
    });
    await expect(revokeTrackingKey("gone")).rejects.toMatchObject({
      message: "tracking key not found",
      status: 404,
    });
  });
});
