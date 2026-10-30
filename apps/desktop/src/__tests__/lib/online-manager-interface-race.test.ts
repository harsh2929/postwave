// @vitest-environment happy-dom

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setConn: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  getApiUrl: () => "https://api.postwave.test",
}));
vi.mock("../../lib/http-fetch", () => ({
  httpFetch: vi.fn(),
}));
vi.mock("../../lib/store", () => ({
  setConn: mocks.setConn,
}));
vi.mock("../../lib/tauri", () => ({
  isTauri: () => false,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import {
  getConnectivitySnapshot,
  noteRequestSuccess,
} from "../../lib/online-manager";

let online = true;
let originalOnlineDescriptor: PropertyDescriptor | undefined;

beforeAll(() => {
  originalOnlineDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "onLine",
  );
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
});

afterAll(() => {
  if (originalOnlineDescriptor) {
    Object.defineProperty(navigator, "onLine", originalOnlineDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "onLine");
  }
});

describe("online manager interface races", () => {
  it("does not let a late successful response override an offline interface", () => {
    online = true;
    noteRequestSuccess();
    expect(getConnectivitySnapshot()).toMatchObject({
      status: "online",
      reason: "online",
    });

    online = false;
    noteRequestSuccess();

    expect(getConnectivitySnapshot()).toMatchObject({
      status: "offline",
      reason: "no-interface",
    });
    expect(mocks.setConn).toHaveBeenLastCalledWith("offline");
  });
});
