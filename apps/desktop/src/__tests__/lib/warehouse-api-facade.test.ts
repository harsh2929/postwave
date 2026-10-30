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

import { writebackApi } from "../../lib/api-client";

describe("Warehouse/writeback facade composition", () => {
  it("routes the extracted run-now operation through the shared transport", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            run_id: "run_1",
            status: "completed",
            members_seen: 10,
            matched: 9,
            tags_written: 9,
            fields_written: 18,
            rows_failed: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await writebackApi.runTarget("target/one");

    expect(result.data?.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "http://localhost:8080/api/v1/integration-writeback/targets/target%2Fone/run",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(new Headers(init.headers).get("X-Postwave-Client")).toBe("desktop");
  });
});
