// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InstallPrompt } from "@/components/install-prompt";

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
}));

vi.mock("@/lib/telemetry", () => ({
  track: mocks.track,
}));

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function findButton(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (el): el is HTMLButtonElement =>
      el instanceof HTMLButtonElement && el.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}

function beforeInstallPromptEvent(): Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
} {
  const event = new Event("beforeinstallprompt", {
    bubbles: true,
    cancelable: true,
  }) as Event & {
    platforms: string[];
    prompt: () => Promise<void>;
    userChoice: Promise<{
      outcome: "accepted" | "dismissed";
      platform: string;
    }>;
  };
  event.platforms = ["web"];
  event.prompt = vi.fn(async () => undefined);
  event.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
  return event;
}

function sendKey(key: string, init?: KeyboardEventInit): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

describe("InstallPrompt accessibility", () => {
  it("focuses the install dialog, traps Tab, closes on Escape, and restores focus", async () => {
    const { root } = render(
      createElement(
        "div",
        null,
        createElement("button", { type: "button" }, "Composer"),
        createElement(InstallPrompt),
      ),
    );

    try {
      const opener = findButton("Composer");
      opener.focus();
      expect(document.activeElement).toBe(opener);

      const installEvent = beforeInstallPromptEvent();
      await act(async () => {
        window.dispatchEvent(installEvent);
        window.dispatchEvent(new Event("postwave:campaign-sent"));
        await flush();
      });

      expect(installEvent.defaultPrevented).toBe(true);
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
      const install = findButton("Install");
      const notNow = findButton("Not now");

      expect(dialog?.getAttribute("aria-labelledby")).toBe(
        "postwave-install-title",
      );
      expect(document.activeElement).toBe(install);

      install.focus();
      sendKey("Tab");
      expect(document.activeElement).toBe(notNow);

      notNow.focus();
      sendKey("Tab", { shiftKey: true });
      expect(document.activeElement).toBe(install);

      await act(async () => {
        sendKey("Escape");
        await flush();
      });

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(mocks.track).toHaveBeenCalledWith("pwa.install.dismissed", {
        source: "manual",
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("honors the iOS cool-off immediately after dismissal", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    );
    const { root } = render(createElement(InstallPrompt));

    try {
      await act(async () => {
        window.dispatchEvent(new Event("postwave:campaign-sent"));
        await flush();
      });
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      await act(async () => {
        findButton("Got it").click();
        await flush();
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      await act(async () => {
        window.dispatchEvent(new Event("postwave:template-saved"));
        await flush();
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});
