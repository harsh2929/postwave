// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../../lib/api-client";

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("desktop migration source-session API", () => {
  it("posts same-job credentials and follows with a no-cache exact GET", async () => {
    const response = {
      id: "job/session 1",
      source: "beehiiv",
      status: "awaiting_confirmation",
      source_session_expires_at: "2026-11-01T00:00:00.000Z",
    };
    const fetchMock = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> =>
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const refreshed = await api.refreshMigrationSourceSession("job/session 1", {
      apiKey: "secret-key",
      accountId: "pub_1",
      extra: { publication_id: "pub_1" },
    });
    const exact = await api.getMigration("job/session 1");

    expect(refreshed.error).toBeUndefined();
    expect(exact.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [refreshURL, refreshInit] = fetchMock.mock.calls[0]!;
    expect(new URL(String(refreshURL)).pathname).toBe(
      "/api/v1/migrations/job%2Fsession%201/source-session",
    );
    expect(refreshInit?.method).toBe("POST");
    expect(JSON.parse(String(refreshInit?.body))).toEqual({
      api_key: "secret-key",
      account_id: "pub_1",
      extra: { publication_id: "pub_1" },
    });

    const [getURL, getInit] = fetchMock.mock.calls[1]!;
    expect(new URL(String(getURL)).pathname).toBe(
      "/api/v1/migrations/job%2Fsession%201",
    );
    expect(getInit?.cache).toBe("no-store");
  });
});
