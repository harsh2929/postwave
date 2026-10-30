import { webcrypto } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, type FormDetail } from "../../lib/api-client";

const FORM: FormDetail = {
  id: "form-1",
  name: "Launch list",
  slug: "launch",
  optInMode: "double",
  status: "draft",
  settings: {},
  structure: { fields: [] },
};

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

beforeEach(() => {
  const localStorage = memoryStorage();
  vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("window", {
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    crypto: webcrypto as unknown as Crypto,
    localStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("forms optimistic-concurrency API contract", () => {
  it("echoes the strong form ETag through If-Match and retains the next ETag", async () => {
    const observed: Array<{
      body: unknown;
      ifMatch: string | null;
      method: string | undefined;
      url: string;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        observed.push({
          body: JSON.parse(String(init.body)),
          ifMatch: new Headers(init.headers).get("If-Match"),
          method: init.method,
          url,
        });
        return new Response(JSON.stringify({ ...FORM, name: "Renamed" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: '"form:form-1:v2"',
          },
        });
      }),
    );

    const result = await api.updateForm(
      FORM.id,
      { name: "Renamed" },
      {
        expectedVersion: '"form:form-1:v1"',
        requireOnline: true,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.serverVersion).toBe('"form:form-1:v2"');
    expect(observed).toEqual([
      {
        body: { name: "Renamed" },
        ifMatch: '"form:form-1:v1"',
        method: "PATCH",
        url: "http://localhost:8080/api/v1/forms/form-1",
      },
    ]);
  });

  it("rejects an unsafe or weak version before dispatch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const weak = await api.updateForm(
      FORM.id,
      { name: "Unsafe" },
      { expectedVersion: 'W/"form:form-1:v1"', requireOnline: true },
    );
    const injected = await api.updateForm(
      FORM.id,
      { name: "Unsafe" },
      { expectedVersion: '"ok"\r\nX-Test: bad', requireOnline: true },
    );

    expect(weak.error?.code).toBe("invalid_form_version");
    expect(injected.error?.code).toBe("invalid_form_version");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("protects deletion with the loaded strong ETag", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("DELETE");
      expect(new Headers(init.headers).get("If-Match")).toBe(
        '"form:form-1:v1"',
      );
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.deleteForm(FORM.id, {
      expectedVersion: '"form:form-1:v1"',
    });
    const rejected = await api.deleteForm(FORM.id, {
      expectedVersion: 'W/"form:form-1:v1"',
    });

    expect(result.data).toEqual({ ok: true });
    expect(rejected.error?.code).toBe("invalid_form_version");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed instead of queueing a reconciliation-sensitive offline edit", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.updateForm(
      FORM.id,
      { name: "Offline rename" },
      {
        expectedVersion: '"form:form-1:v1"',
        requireOnline: true,
      },
    );

    expect(result.queued).not.toBe(true);
    expect(result.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
