import { beforeEach, describe, expect, it, vi } from "vitest";
import { takePendingRoute, validatePendingRoute } from "./pendingRoute";

const storageMock = vi.hoisted(() => ({
  value: null as string | null,
  removedKeys: [] as string[],
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("@bacons/apple-targets", () => ({
  ExtensionStorage: class {
    get() {
      return storageMock.value;
    }
    remove(key: string) {
      storageMock.removedKeys.push(key);
      storageMock.value = null;
    }
    static reloadWidget() {}
  },
}));

beforeEach(() => {
  storageMock.value = null;
  storageMock.removedKeys = [];
});

describe("validatePendingRoute", () => {
  it("accepts allow-listed tab routes", () => {
    expect(validatePendingRoute("/(tabs)/dashboard")).toBe("/(tabs)/dashboard");
    expect(validatePendingRoute("/(tabs)/approvals")).toBe("/(tabs)/approvals");
  });

  it("accepts the argument-free launcher destinations", () => {
    expect(validatePendingRoute("/(tabs)/search")).toBe("/(tabs)/search");
    expect(validatePendingRoute("/(tabs)/notifications")).toBe(
      "/(tabs)/notifications",
    );
    expect(validatePendingRoute("/(tabs)/scan")).toBe("/(tabs)/scan");
  });

  it("rejects anything not on the allow-list", () => {
    expect(validatePendingRoute("/(tabs)/settings")).toBeNull();
    expect(validatePendingRoute("https://evil.com")).toBeNull();
    expect(validatePendingRoute("../../etc/passwd")).toBeNull();
  });

  it("rejects null / empty / non-strings", () => {
    expect(validatePendingRoute(null)).toBeNull();
    expect(validatePendingRoute("")).toBeNull();
  });
});

describe("takePendingRoute", () => {
  it("returns and clears an allow-listed route", () => {
    storageMock.value = "/(tabs)/dashboard";

    expect(takePendingRoute()).toBe("/(tabs)/dashboard");
    expect(storageMock.removedKeys).toEqual(["pw_pending_route"]);
  });

  it("clears an invalid stored route so it cannot replay every foreground", () => {
    storageMock.value = "/(tabs)/settings";

    expect(takePendingRoute()).toBeNull();
    expect(storageMock.removedKeys).toEqual(["pw_pending_route"]);
  });
});
