// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks }));

import { parseSessionsEnvelope, sessionsApi } from "@/lib/sessions-api";
import {
  parseTrustedDevicesEnvelope,
  trustedDevicesApi,
} from "@/lib/trusted-devices-api";

beforeEach(() => vi.clearAllMocks());

describe("authentication device API paths", () => {
  it("rejects contradictory session inventories and preserves canonical labels", () => {
    const row = {
      id: "session_1",
      issued_at: "2026-09-01T00:00:00Z",
      last_seen_at: "2026-09-02T00:00:00Z",
      expires_at: "2026-10-01T00:00:00Z",
      auth_method: "password",
      current: true,
      device_label: "Chrome on macOS",
    };
    expect(
      parseSessionsEnvelope({ sessions: [row] }).sessions[0],
    ).toMatchObject({ id: "session_1", device_label: "Chrome on macOS" });
    expect(() =>
      parseSessionsEnvelope({
        sessions: [row, { ...row, id: "session_2" }],
      }),
    ).toThrow(/multiple current sessions/i);
  });

  it("validates the complete trusted-device policy and rejects unsafe durations", () => {
    const envelope = {
      trusted_devices: [
        {
          id: "trusted_1",
          trust_days: 90,
          issued_at: "2026-09-01T00:00:00Z",
          expires_at: "2026-11-30T00:00:00Z",
          current: false,
          device_label: "Safari on iPhone",
        },
      ],
      allowed: true,
      allowed_durations: [30, 90, 180],
      max_days: 180,
      default_days: 30,
    };
    expect(parseTrustedDevicesEnvelope(envelope)).toMatchObject({
      trusted_devices: [{ id: "trusted_1", trust_days: 90 }],
      max_days: 180,
    });
    expect(() =>
      parseTrustedDevicesEnvelope({
        ...envelope,
        allowed_durations: [30, 365],
      }),
    ).toThrow(/malformed/i);
  });

  it("keeps private inventories online-only and abortable", async () => {
    const signal = new AbortController().signal;
    mocks.get.mockResolvedValueOnce({ sessions: [] }).mockResolvedValueOnce({
      trusted_devices: [],
      allowed: false,
      allowed_durations: [30, 90, 180],
      max_days: 180,
      default_days: 30,
    });
    await sessionsApi.list({ signal });
    await trustedDevicesApi.list({ signal });
    for (const call of mocks.get.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({
          cache: "no-store",
          requireOnline: true,
          maxAttempts: 1,
          signal,
        }),
      );
    }
  });

  it("walks every bounded session page without truncating a large inventory", async () => {
    const session = (id: string, current = false) => ({
      id,
      issued_at: "2026-09-01T00:00:00Z",
      last_seen_at: "2026-09-02T00:00:00Z",
      expires_at: "2026-10-01T00:00:00Z",
      auth_method: "password",
      current,
    });
    mocks.get
      .mockResolvedValueOnce({
        sessions: Array.from({ length: 600 }, (_, index) =>
          session(`page-1-${index}`, index === 0),
        ),
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        sessions: Array.from({ length: 500 }, (_, index) =>
          session(`page-2-${index}`),
        ),
      });

    await expect(sessionsApi.listAll()).resolves.toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: "page-1-0", current: true }),
        expect.objectContaining({ id: "page-2-499" }),
      ]),
    });
    expect(mocks.get).toHaveBeenNthCalledWith(
      2,
      "/api/v1/auth/sessions?cursor=page-2&limit=200",
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
  });

  it("encodes a session id as exactly one pathname segment", async () => {
    mocks.delete.mockResolvedValue({ revoked: true });

    await sessionsApi.revoke("session/root?next=#devices");

    expect(mocks.delete).toHaveBeenCalledWith(
      "/api/v1/auth/sessions/session%2Froot%3Fnext%3D%23devices",
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
  });

  it("encodes a trusted-device id as exactly one pathname segment", async () => {
    mocks.delete.mockResolvedValue({ revoked: true });

    await trustedDevicesApi.revoke("trusted/root?next=#devices");

    expect(mocks.delete).toHaveBeenCalledWith(
      "/api/v1/auth/trusted-devices/trusted%2Froot%3Fnext%3D%23devices",
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
  });

  it("keeps finite bulk-action route literals unchanged", async () => {
    mocks.post.mockResolvedValue({ revoked_count: 2 });

    await sessionsApi.logoutAllOthers();
    await trustedDevicesApi.revokeAll();

    expect(mocks.post).toHaveBeenNthCalledWith(
      1,
      "/api/v1/auth/sessions/logout-all",
      undefined,
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
    expect(mocks.post).toHaveBeenNthCalledWith(
      2,
      "/api/v1/auth/trusted-devices/revoke-all",
      undefined,
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );
  });
});
