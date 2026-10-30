import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { persistWorkspaceApiUrl } from "../../lib/workspace-api-url";

describe("workspace API URL transaction persistence", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes, verifies, and invalidates after a durable write", () => {
    const invalidate = vi.fn();

    persistWorkspaceApiUrl("https://api.example.test/", invalidate);

    expect(values.get("postwave_api_url")).toBe("https://api.example.test");
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("fails closed when storage denies the write", () => {
    const invalidate = vi.fn();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });

    expect(() =>
      persistWorkspaceApiUrl("https://api.example.test", invalidate),
    ).toThrow(/durably store/i);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("fails closed when read-back does not match the requested URL", () => {
    const invalidate = vi.fn();
    vi.spyOn(window.localStorage, "getItem").mockReturnValue(
      "https://other.example.test",
    );

    expect(() =>
      persistWorkspaceApiUrl("https://api.example.test", invalidate),
    ).toThrow(/durably store/i);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
