import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openApiSpecApi } from "../lib/api-client";
import { resetApiIdentityTransitionForTests } from "../lib/api-identity-transition";
import { OPENAPI_SPEC_MAX_RESPONSE_TEXT_BYTES } from "../lib/api/platform-operations";

const stubLocalStorage: Storage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

beforeEach(() => {
  // @ts-expect-error — installing the minimal browser surface used by api-client.
  globalThis.window = {
    localStorage: stubLocalStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
});

afterEach(() => {
  resetApiIdentityTransitionForTests();
  // @ts-expect-error — clean up the test-only browser surface.
  delete globalThis.window;
  vi.restoreAllMocks();
});

describe("OpenAPI spec loader response boundary", () => {
  it("loads the real generated artifact through its endpoint-specific override", async () => {
    const specBody = readFileSync(
      new URL("../../../../packages/openapi/openapi.json", import.meta.url),
      "utf8",
    );
    const specBytes = new TextEncoder().encode(specBody).byteLength;
    expect(specBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(specBytes).toBeLessThanOrEqual(OPENAPI_SPEC_MAX_RESPONSE_TEXT_BYTES);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).pathname).toBe("/api/v1/openapi.json");
      return new Response(specBody, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(specBytes),
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await openApiSpecApi.get();

    expect(result.error).toBeUndefined();
    expect(result.data?.openapi).toBe("3.1.0");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a response larger than the endpoint-specific ceiling", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(
                OPENAPI_SPEC_MAX_RESPONSE_TEXT_BYTES + 1,
              ),
            },
          }),
      ),
    );

    const result = await openApiSpecApi.get();

    expect(result.error).toMatchObject({
      kind: "parse",
      code: "response_too_large",
    });
  });
});
