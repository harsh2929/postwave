import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
let failRead = false;
let failWrite = false;

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => {
      if (failRead) throw new Error("storage unavailable");
      return store.get(key) ?? null;
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      if (failWrite) throw new Error("storage unavailable");
      store.set(key, value);
    }),
  },
}));

// eslint-disable-next-line import/first
import {
  isStorableBaseUrl,
  LAST_BASE_URL_KEY,
  readLastBaseUrl,
  rememberLastBaseUrl,
} from "./authPrefs";

beforeEach(() => {
  store.clear();
  failRead = false;
  failWrite = false;
});

describe("isStorableBaseUrl", () => {
  it("accepts the shapes a real deployment uses", () => {
    expect(isStorableBaseUrl("https://api.moosewave.com")).toBe(true);
    expect(isStorableBaseUrl("https://postwave.internal.acme.com:8443")).toBe(
      true,
    );
    expect(isStorableBaseUrl("http://localhost:9000")).toBe(true);
  });

  it("rejects anything that could redirect a password post", () => {
    expect(isStorableBaseUrl("")).toBe(false);
    expect(isStorableBaseUrl(null)).toBe(false);
    expect(isStorableBaseUrl(undefined)).toBe(false);
    expect(isStorableBaseUrl("  https://api.moosewave.com  ")).toBe(false);
    expect(isStorableBaseUrl("javascript:alert(1)")).toBe(false);
    expect(isStorableBaseUrl("moosewave://auth/magic")).toBe(false);
    expect(isStorableBaseUrl("https://user:pass@api.moosewave.com")).toBe(false);
    expect(isStorableBaseUrl("not a url")).toBe(false);
    expect(isStorableBaseUrl(`https://${"x".repeat(600)}.com`)).toBe(false);
  });
});

describe("readLastBaseUrl / rememberLastBaseUrl", () => {
  it("round-trips a valid server address", async () => {
    await rememberLastBaseUrl("https://postwave.internal.acme.com");
    expect(store.get(LAST_BASE_URL_KEY)).toBe(
      "https://postwave.internal.acme.com",
    );
    await expect(readLastBaseUrl()).resolves.toBe(
      "https://postwave.internal.acme.com",
    );
  });

  it("refuses to persist an invalid value", async () => {
    await rememberLastBaseUrl("javascript:alert(1)");
    expect(store.has(LAST_BASE_URL_KEY)).toBe(false);
  });

  it("refuses to return a corrupted stored value", async () => {
    store.set(LAST_BASE_URL_KEY, "javascript:alert(1)");
    await expect(readLastBaseUrl()).resolves.toBeNull();
  });

  it("degrades to null rather than throwing when storage is unavailable", async () => {
    failRead = true;
    await expect(readLastBaseUrl()).resolves.toBeNull();
    failWrite = true;
    await expect(
      rememberLastBaseUrl("https://api.moosewave.com"),
    ).resolves.toBeUndefined();
  });
});
