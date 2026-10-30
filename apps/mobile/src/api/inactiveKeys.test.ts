/**
 * The inactive-keys transport seam, driven with the real `{data, error}`
 * envelope shape — a broken read must throw, never resolve as "no dormant
 * keys". The parser's own decisions are pinned in lib/inactiveKeyAlerts.test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  INACTIVE_KEYS_PATH,
  InactiveKeysError,
  fetchInactiveKeys,
  isInactiveKeysDenied,
} from "./inactiveKeys";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("fetchInactiveKeys", () => {
  it("GETs the route with the server's default threshold and unwraps the object", async () => {
    rawRequest.mockResolvedValue({
      data: {
        threshold_days: 90,
        keys: [
          {
            id: "k1",
            label: "CI deploy key",
            prefix: "pw_live_9f2c",
            actor_type: "human",
            created_at: "2026-03-14T10:00:00Z",
            days_since_last_use: 124,
            never_used: false,
            severity: "high",
          },
        ],
        count: 1,
      },
      error: null,
    });
    const payload = await fetchInactiveKeys();
    expect(payload.thresholdDays).toBe(90);
    expect(payload.keys).toHaveLength(1);
    expect(payload.keys[0]?.severity).toBe("high");
    expect(rawRequest).toHaveBeenCalledWith("GET", INACTIVE_KEYS_PATH);
    expect(INACTIVE_KEYS_PATH).toBe("/api/v1/inactive-keys");
  });

  it("resolves an empty report as an empty list — a null keys included", async () => {
    rawRequest.mockResolvedValue({
      data: { threshold_days: 90, keys: null, count: 0 },
      error: null,
    });
    await expect(fetchInactiveKeys()).resolves.toEqual({
      thresholdDays: 90,
      keys: [],
    });
  });

  it("surfaces a failure as a throw carrying the status", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 500, message: "boom" },
    });
    const err = await fetchInactiveKeys().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InactiveKeysError);
    expect((err as InactiveKeysError).status).toBe(500);
    expect((err as InactiveKeysError).message).toBe("boom");
  });

  it("classifies exactly a 403 as a permission refusal", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "forbidden" },
    });
    expect(isInactiveKeysDenied(await fetchInactiveKeys().catch((e: unknown) => e))).toBe(true);

    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 500, message: "" },
    });
    expect(isInactiveKeysDenied(await fetchInactiveKeys().catch((e: unknown) => e))).toBe(false);
  });

  it("throws on a 200 whose body is not the handler's object, instead of resolving empty", async () => {
    // An HTML SPA fallback or a paged envelope is the server answering
    // something we cannot read; resolving `[]` here would hide the fault as
    // "nothing dormant" for as long as the fault lasted.
    for (const body of ["<!doctype html><html></html>", [], { items: [] }]) {
      rawRequest.mockResolvedValue({ data: body, error: null });
      const err = await fetchInactiveKeys().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InactiveKeysError);
      expect((err as InactiveKeysError).status).toBe(0);
      expect(isInactiveKeysDenied(err)).toBe(false);
    }
  });
});
