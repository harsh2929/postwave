// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentPermission: vi.fn(),
  fetchConfig: vi.fn(),
  isSubscribed: vi.fn(),
  sendTest: vi.fn(),
  subscribe: vi.fn(),
  support: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("@/lib/web-push", () => ({
  currentPermission: mocks.currentPermission,
  fetchWebPushConfig: mocks.fetchConfig,
  isSubscribed: mocks.isSubscribed,
  sendTestPush: mocks.sendTest,
  subscribeToWebPush: mocks.subscribe,
  unsubscribeFromWebPush: mocks.unsubscribe,
  webPushSupport: mocks.support,
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { WebPushCard } from "@/components/notifications/web-push-card";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function renderCard(): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(WebPushCard)));
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(flush);
    }
  }
  throw lastError;
}

function button(text: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.includes(text) === true,
  );
  if (!match) throw new Error(`button not found: ${text}`);
  return match;
}

beforeEach(() => {
  mocks.support.mockReturnValue("supported");
  mocks.currentPermission.mockReturnValue("granted");
  mocks.fetchConfig.mockResolvedValue({ enabled: true, publicKey: "key" });
  mocks.isSubscribed.mockResolvedValue(true);
  mocks.sendTest.mockResolvedValue(1);
  mocks.subscribe.mockResolvedValue({ status: "subscribed" });
  mocks.unsubscribe.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("WebPushCard", () => {
  it("renders an SSR-stable loading state, then the subscribed controls", async () => {
    const config = deferred<{ enabled: boolean; publicKey: string }>();
    mocks.fetchConfig.mockReturnValue(config.promise);
    const root = renderCard();
    try {
      expect(document.body.textContent).toContain(
        "Checking this browser's notification status",
      );

      await act(async () => {
        config.resolve({ enabled: true, publicKey: "key" });
        await flush();
      });
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Browser notifications are on for this device",
        ),
      );
      expect(button("Send test").disabled).toBe(false);
      expect(button("Turn off").disabled).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("single-flights same-tick tests and focuses a persistent failure", async () => {
    const request = deferred<number>();
    mocks.sendTest.mockReturnValue(request.promise);
    const root = renderCard();
    try {
      await waitFor(() => expect(button("Send test").disabled).toBe(false));
      const testButton = button("Send test");
      act(() => {
        testButton.click();
        testButton.click();
      });
      expect(mocks.sendTest).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("Sending…");

      await act(async () => {
        request.reject(new Error("push gateway unavailable"));
        await flush();
      });
      await waitFor(() =>
        expect(document.body.textContent).toContain("push gateway unavailable"),
      );
      expect(document.activeElement?.getAttribute("role")).toBe("alert");
      expect(button("Send test").disabled).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows configuration guidance instead of a dead enable button", async () => {
    mocks.fetchConfig.mockResolvedValue({ enabled: false, publicKey: "" });
    mocks.isSubscribed.mockResolvedValue(false);
    const root = renderCard();
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Web Push isn't configured for this deployment",
        ),
      );
      expect(document.body.textContent).toContain("WEB_PUSH_VAPID_PRIVATE_KEY");
      expect(
        document.body.textContent?.includes("Enable browser notifications"),
      ).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps a configuration probe outage distinct and retries only that probe", async () => {
    mocks.isSubscribed.mockResolvedValue(false);
    mocks.fetchConfig.mockRejectedValueOnce(new Error("gateway details"));
    const root = renderCard();
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Deployment configuration could not be verified",
        ),
      );
      expect(document.body.textContent).toContain(
        "not evidence that Web Push is unconfigured",
      );
      expect(document.body.textContent).not.toContain(
        "Web Push isn't configured for this deployment",
      );

      mocks.fetchConfig.mockResolvedValue({ enabled: true, publicKey: "key" });
      await act(async () => {
        button("Retry configuration check").click();
        await flush();
      });
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Enable browser notifications",
        ),
      );
      expect(mocks.fetchConfig).toHaveBeenCalledTimes(2);
      expect(mocks.isSubscribed).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps a subscription probe outage distinct while retaining verified configuration", async () => {
    mocks.isSubscribed.mockRejectedValueOnce(new Error("worker details"));
    const root = renderCard();
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "subscription status could not be verified",
        ),
      );
      expect(document.body.textContent).toContain(
        "No subscribed or unsubscribed state has been assumed",
      );
      expect(document.body.textContent).not.toContain(
        "Enable browser notifications",
      );

      mocks.isSubscribed.mockResolvedValue(false);
      await act(async () => {
        button("Retry browser check").click();
        await flush();
      });
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Enable browser notifications",
        ),
      );
      expect(mocks.isSubscribed).toHaveBeenCalledTimes(2);
      expect(mocks.fetchConfig).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("single-flights enable and preserves an actionable registration error", async () => {
    mocks.isSubscribed.mockResolvedValue(false);
    const registration = deferred<{
      status: "error";
      message: string;
    }>();
    mocks.subscribe.mockReturnValue(registration.promise);
    const root = renderCard();
    try {
      await waitFor(() =>
        expect(button("Enable browser notifications").disabled).toBe(false),
      );
      const enable = button("Enable browser notifications");
      act(() => {
        enable.click();
        enable.click();
      });
      expect(mocks.subscribe).toHaveBeenCalledTimes(1);

      await act(async () => {
        registration.resolve({
          status: "error",
          message: "registration rejected",
        });
        await flush();
      });
      await waitFor(() =>
        expect(document.body.textContent).toContain("registration rejected"),
      );
      expect(mocks.toastError).toHaveBeenCalledWith("registration rejected");
    } finally {
      act(() => root.unmount());
    }
  });
});
