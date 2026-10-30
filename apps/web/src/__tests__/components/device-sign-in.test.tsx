// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  poll: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  decide: vi.fn(),
}));

vi.mock("@/lib/device-login", () => ({
  startDeviceLogin: mocks.start,
  pollDeviceLogin: mocks.poll,
  confirmDeviceLogin: mocks.confirm,
  cancelDeviceLogin: mocks.cancel,
  devicePollDecision: mocks.decide,
}));

vi.mock("@/components/qr-code", () => ({
  QrCode: ({ value, ariaLabel }: { value: string; ariaLabel: string }) =>
    createElement("div", {
      role: "img",
      "aria-label": ariaLabel,
      "data-value": value,
    }),
}));

import { DeviceSignIn } from "@/components/auth/device-sign-in";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.start.mockResolvedValue({
    deviceCode: "memory-only-secret",
    userCode: "BCDF-GHJK",
    verificationUri: "http://localhost:3000/cli/auth",
    verificationUriComplete:
      "http://localhost:3000/cli/auth?user_code=BCDF-GHJK",
    expiresIn: 600,
    interval: 5,
    remember: false,
  });
  mocks.poll.mockResolvedValue({
    grant_kind: "session",
    session: true,
    confirmation_required: true,
    confirmation_expires_in: 120,
  });
  mocks.confirm.mockResolvedValue({
    grant_kind: "session",
    session: true,
    confirmed: true,
    confirmation_required: false,
  });
  mocks.cancel.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("DeviceSignIn", () => {
  it("renders a QR/manual code, waits the server interval, then completes", async () => {
    const complete = vi.fn();
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");

    await act(async () => {
      root.render(
        createElement(DeviceSignIn, { onBack: vi.fn(), onComplete: complete }),
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("BCDF-GHJK");
    expect(container.textContent).toContain("Waiting for approval");
    expect(
      container.querySelector('[role="img"]')?.getAttribute("data-value"),
    ).toBe("http://localhost:3000/cli/auth?user_code=BCDF-GHJK");
    expect(mocks.poll).not.toHaveBeenCalled();
    expect(storageSpy).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(mocks.poll).toHaveBeenCalledWith("memory-only-secret", {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.confirm).toHaveBeenCalledWith("memory-only-secret", {
      signal: expect.any(AbortSignal),
    });
    expect(complete).toHaveBeenCalledTimes(1);
    storageSpy.mockRestore();
  });

  it("best-effort cancels and clears a pending grant when the stage unmounts", async () => {
    await act(async () => {
      root.render(
        createElement(DeviceSignIn, { onBack: vi.fn(), onComplete: vi.fn() }),
      );
      await Promise.resolve();
    });

    await act(async () => root.unmount());
    expect(mocks.cancel).toHaveBeenCalledWith("memory-only-secret");

    // afterEach may safely unmount the already-unmounted root.
    root = createRoot(container);
  });

  it("retains and safely replays after a malformed exchange response", async () => {
    const complete = vi.fn();
    mocks.poll
      .mockRejectedValueOnce(new Error("truncated JSON response"))
      .mockResolvedValueOnce({
        grant_kind: "session",
        session: true,
        confirmation_required: true,
        confirmation_expires_in: 120,
      });
    mocks.decide.mockReturnValueOnce({
      kind: "error",
      message: "The response was incomplete.",
    });

    await act(async () => {
      root.render(
        createElement(DeviceSignIn, { onBack: vi.fn(), onComplete: complete }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(mocks.poll).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(container.textContent).toContain("response was incomplete");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mocks.poll).toHaveBeenCalledTimes(2);
    expect(mocks.confirm).toHaveBeenCalledWith("memory-only-secret", {
      signal: expect.any(AbortSignal),
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
