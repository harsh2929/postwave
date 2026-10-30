import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stubLocalStorage: Storage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

beforeEach(() => {
  // @ts-expect-error - minimal browser shell for the shared facade transport.
  globalThis.window = {
    localStorage: stubLocalStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
});

afterEach(() => {
  // @ts-expect-error - clean up the test browser shell.
  delete globalThis.window;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import { integrationsApi } from "../../lib/api-client";

describe("Integrations catalog facade composition", () => {
  it("routes the extracted sync action through the shared transport", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            slug: "hub/spot",
            action: "sync",
            status: "accepted",
            message: "Sync queued",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await integrationsApi.sync("hub/spot");

    expect(result.data?.action).toBe("sync");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "http://localhost:8080/api/v1/integrations/hub%2Fspot/sync",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    const headers = new Headers(init.headers);
    expect(headers.get("X-Postwave-Client")).toBe("desktop");
    expect(headers.get("Idempotency-Key")).toBeTruthy();
  });
});
