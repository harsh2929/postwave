// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TelemetryProvider } from "@/components/telemetry-provider";

const mocks = vi.hoisted(() => ({
  pathname:
    "/en/preferences/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  init: vi.fn(async () => undefined),
  track: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams("campaign=present"),
}));

vi.mock("@/lib/telemetry", () => ({
  init: mocks.init,
  track: mocks.track,
}));

beforeEach(() => {
  mocks.pathname =
    "/en/preferences/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("TelemetryProvider path privacy", () => {
  it("suppresses PostHog capture on a hosted preference capability path", async () => {
    const token = mocks.pathname.split("/").at(-1) ?? "";
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<TelemetryProvider />);
    });

    expect(mocks.track).not.toHaveBeenCalled();
    expect(mocks.init).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.track.mock.calls)).not.toContain(token);

    act(() => root.unmount());
  });

  it("continues emitting a bounded page view for a normal route", async () => {
    mocks.pathname = "/pricing";
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<TelemetryProvider />);
    });

    expect(mocks.track).toHaveBeenCalledWith("page_viewed", {
      path: "/pricing",
      has_search: true,
    });
    expect(mocks.init).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });
});
