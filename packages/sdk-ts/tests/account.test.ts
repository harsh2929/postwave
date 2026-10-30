import { describe, expect, it, vi } from "vitest";

import { ACCOUNT_DELETION_CONFIRMATION, PostwaveClient } from "../src/index.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("AccountResource", () => {
  it("me() reads GET /api/v1/me", async () => {
    const fetch = vi.fn(async () =>
      json({ tenant: "acme", user: "u@acme.com" }),
    );
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    const res = await pw.account.me();

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/me",
      expect.objectContaining({ method: "GET" }),
    );
    expect(res.tenant).toBe("acme");
  });

  // Regression: update() previously PATCHed /api/v1/me — a route the
  // backend does NOT expose (GET-only). The real tenant sending-identity
  // surface is PATCH /api/v1/settings/workspace.
  it("update() PATCHes /api/v1/settings/workspace (NOT /api/v1/me)", async () => {
    const fetch = vi.fn(async () =>
      json({
        tenant_id: "t",
        display_name: "Acme Team",
        default_reply_to: "hi@acme.com",
        timezone: "UTC",
        date_format: "MMM D, YYYY",
        updated_at: "2026-06-21T00:00:00Z",
      }),
    );
    const pw = new PostwaveClient({
      apiKey: "k",
      tenantId: "t",
      fetch,
      retries: 0,
    });

    const res = await pw.account.update({
      display_name: "Acme Team",
      default_reply_to: "hi@acme.com",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/settings/workspace",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          display_name: "Acme Team",
          default_reply_to: "hi@acme.com",
        }),
      }),
    );
    // The old (broken) target must never be hit.
    expect(fetch).not.toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/me",
      expect.anything(),
    );
    expect(res.display_name).toBe("Acme Team");
  });

  it("deleteSelf() uses the session-only self endpoint with destructive reauthentication", async () => {
    const fetch = vi.fn(async () =>
      json({
        request: { request_id: "prv-1", status: "queued" },
        replayed: false,
        scope: {},
      }),
    );
    const pw = new PostwaveClient({
      authMode: "session",
      credentials: "include",
      fetch,
      retries: 0,
    });

    await pw.account.deleteSelf(
      {
        confirmation: ACCOUNT_DELETION_CONFIRMATION,
        password: "current password",
        mfa_code: "123456",
        region: "GDPR",
      },
      "stable-account-delete",
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/account",
      expect.objectContaining({
        method: "DELETE",
        credentials: "include",
        body: JSON.stringify({
          confirmation: "DELETE MY ACCOUNT",
          password: "current password",
          mfa_code: "123456",
          region: "GDPR",
        }),
        headers: expect.objectContaining({
          "Idempotency-Key": "stable-account-delete",
        }),
      }),
    );
  });

  it("deletionStatus() cannot query an arbitrary user id", async () => {
    const fetch = vi.fn(async () => json({ request: null }));
    const pw = new PostwaveClient({
      authMode: "session",
      credentials: "include",
      fetch,
      retries: 0,
    });

    await pw.account.deletionStatus();

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/account/deletion",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });
});
