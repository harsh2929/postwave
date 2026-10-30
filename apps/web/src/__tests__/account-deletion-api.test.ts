import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_DELETION_CONFIRMATION,
  deleteOwnAccount,
} from "@/lib/account-deletion-api";

afterEach(() => vi.unstubAllGlobals());

describe("self account deletion client", () => {
  it("uses the dedicated DELETE endpoint, sends reauthentication, and never queues offline", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          request: {
            request_id: "prv-1",
            status: "queued",
            requested_at: "2026-07-15T00:00:00Z",
            execute_after: "2026-07-15T01:00:00Z",
            due_at: "2026-08-14T00:00:00Z",
            legal_hold: false,
            retention_expires_at: "2032-07-13T00:00:00Z",
          },
          replayed: false,
          scope: {},
        },
        { status: 202 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await deleteOwnAccount(
      {
        confirmation: ACCOUNT_DELETION_CONFIRMATION,
        password: "current password",
        mfa_code: "123456",
        region: "GDPR",
      },
      "stable-key",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://localhost:8080/api/v1/account");
    expect(options.method).toBe("DELETE");
    expect(options.headers).toEqual(
      expect.objectContaining({ "Idempotency-Key": "stable-key" }),
    );
    expect(JSON.parse(String(options.body))).toEqual({
      confirmation: "DELETE MY ACCOUNT",
      password: "current password",
      mfa_code: "123456",
      region: "GDPR",
    });
  });
});
