// SPDX-License-Identifier: AGPL-3.0-only
//
// The passkey list is the screen a user opens to revoke the passkey on a device
// they lost. "No passkeys registered" there is a security statement, so a body
// the client cannot read must surface as a failure and never as an empty
// account. The wrong-key drift this pins already shipped once: the client read
// `credentials` while webauthn_handlers.go writes `items`, and every account
// looked empty.
import { afterEach, describe, expect, it, vi } from "vitest";

import { listPasskeys } from "./passkeys";

const BASE = "https://api.moosewave.com";

function respondWith(body: unknown) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const ROW = { id: "pk1", created_at: "2026-09-01T00:00:00Z" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("listPasskeys fails closed on a drifted body", () => {
  it("reads the server's `items` envelope from the credentials route", async () => {
    const fetch = respondWith({ items: [ROW] });
    await expect(listPasskeys(BASE)).resolves.toEqual({ data: [ROW] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/auth/webauthn/credentials",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("reports a wrong envelope key as unreadable, never as an empty account", async () => {
    respondWith({ credentials: [ROW] });
    const res = await listPasskeys(BASE);
    expect(res).toMatchObject({
      error: {
        kind: "parse",
        code: "invalid_passkeys_response",
        message: "The server returned an unreadable passkey list.",
      },
    });
    expect(res.data).toBeUndefined();
  });

  it("reports a bare array, which is not the envelope, as unreadable", async () => {
    respondWith([ROW]);
    await expect(listPasskeys(BASE)).resolves.toMatchObject({
      error: { kind: "parse", code: "invalid_passkeys_response" },
    });
  });

  it("reports a non-array `items` as unreadable", async () => {
    respondWith({ items: { pk1: ROW } });
    await expect(listPasskeys(BASE)).resolves.toMatchObject({
      error: { kind: "parse", code: "invalid_passkeys_response" },
    });
  });

  it("still reads a genuinely empty account as empty", async () => {
    // The server writes a non-nil `items` for an account with no passkeys, so
    // this is the only body that may say "none".
    respondWith({ items: [] });
    await expect(listPasskeys(BASE)).resolves.toEqual({ data: [] });
  });

  it("still skips a malformed row and keeps the readable one", async () => {
    respondWith({ items: [ROW, { id: "" }, { id: "pk2" }] });
    await expect(listPasskeys(BASE)).resolves.toEqual({ data: [ROW] });
  });
});
