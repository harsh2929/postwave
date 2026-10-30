// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CookieBanner,
  COOKIE_PREFERENCES_EVENT,
} from "@/components/marketing/cookie-banner";
import { PUBLIC_CONSENT_GPC_ENFORCED_EVENT } from "@/lib/public-consent-sync";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = "moosewave.cookie.consent.v1";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.body.innerHTML = "";
  Object.defineProperty(navigator, "globalPrivacyControl", {
    configurable: true,
    value: undefined,
  });
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function findButton(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}

function storedConsent(): {
  choice: string;
  prefs: { essential: true; analytics: boolean; marketing: boolean };
} {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) throw new Error("Cookie consent was not stored");
  return JSON.parse(raw) as {
    choice: string;
    prefs: { essential: true; analytics: boolean; marketing: boolean };
  };
}

describe("CookieBanner accessibility", () => {
  it("renders as a non-modal consent region and saves custom preferences", async () => {
    const root = render(createElement(CookieBanner));

    try {
      await act(async () => {
        await flush();
      });

      const region = document.querySelector(
        '[role="region"][aria-labelledby="moosewave-cookie-title"]',
      );
      expect(region).toBeTruthy();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(document.body);

      await act(async () => {
        findButton("Customize").click();
        await flush();
      });

      const checkboxes = Array.from(
        document.querySelectorAll('input[type="checkbox"]'),
      ) as HTMLInputElement[];
      expect(checkboxes).toHaveLength(3);
      expect(checkboxes[0].disabled).toBe(true);

      await act(async () => {
        checkboxes[1].click();
        checkboxes[2].click();
        await flush();
      });

      await act(async () => {
        findButton("Save preferences").click();
        await flush();
      });

      expect(document.querySelector('[role="region"]')).toBeNull();
      expect(storedConsent()).toMatchObject({
        choice: "custom",
        prefs: { essential: true, analytics: true, marketing: true },
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("focuses save on explicit preferences reopen and restores the trigger", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        choice: "reject",
        prefs: { essential: true, analytics: false, marketing: false },
        ts: "2026-06-27T00:00:00.000Z",
      }),
    );
    const root = render(
      createElement(
        "div",
        null,
        createElement("button", { type: "button" }, "Cookie preferences"),
        createElement(CookieBanner),
      ),
    );

    try {
      await act(async () => {
        await flush();
      });
      expect(document.querySelector('[role="region"]')).toBeNull();

      const trigger = findButton("Cookie preferences");
      trigger.focus();

      await act(async () => {
        window.dispatchEvent(new Event(COOKIE_PREFERENCES_EVENT));
        await flush();
      });

      const save = findButton("Save preferences");
      expect(document.querySelector('[role="region"]')).toBeTruthy();
      expect(document.activeElement).toBe(save);

      await act(async () => {
        save.click();
        await flush();
      });

      expect(document.querySelector('[role="region"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("honors Global Privacy Control without showing the banner", async () => {
    Object.defineProperty(navigator, "globalPrivacyControl", {
      configurable: true,
      value: true,
    });
    const root = render(createElement(CookieBanner));

    try {
      await act(async () => {
        await flush();
      });

      expect(document.querySelector('[role="region"]')).toBeNull();
      expect(storedConsent()).toMatchObject({
        choice: "gpc",
        prefs: { essential: true, analytics: false, marketing: false },
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("overrides a previously accepted choice when GPC becomes authoritative", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        choice: "accept",
        prefs: { essential: true, analytics: true, marketing: true },
        ts: "2026-08-19T00:00:00.000Z",
      }),
    );
    Object.defineProperty(navigator, "globalPrivacyControl", {
      configurable: true,
      value: true,
    });
    const optOut = vi.fn();
    Object.assign(window, {
      posthog: { opt_in_capturing: vi.fn(), opt_out_capturing: optOut },
    });
    const root = render(createElement(CookieBanner));

    try {
      await act(async () => {
        await flush();
      });

      expect(storedConsent()).toMatchObject({
        choice: "gpc",
        prefs: { essential: true, analytics: false, marketing: false },
      });
      expect(optOut).toHaveBeenCalled();
      expect(document.querySelector('[role="region"]')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      delete (window as Window & { posthog?: unknown }).posthog;
    }
  });

  it("applies a server-side GPC override to local telemetry truth", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        choice: "accept",
        prefs: { essential: true, analytics: true, marketing: true },
        ts: "2026-08-19T00:00:00.000Z",
      }),
    );
    const optOut = vi.fn();
    Object.assign(window, {
      posthog: { opt_in_capturing: vi.fn(), opt_out_capturing: optOut },
    });
    const root = render(createElement(CookieBanner));

    try {
      await act(async () => {
        await flush();
        window.dispatchEvent(new Event(PUBLIC_CONSENT_GPC_ENFORCED_EVENT));
        await flush();
      });

      expect(storedConsent()).toMatchObject({
        choice: "gpc",
        prefs: { essential: true, analytics: false, marketing: false },
      });
      expect(optOut).toHaveBeenCalled();
      expect(document.querySelector('[role="region"]')).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      delete (window as Window & { posthog?: unknown }).posthog;
    }
  });

  it("opts telemetry out and keeps recovery visible when a GPC mirror cannot persist", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        choice: "accept",
        prefs: { essential: true, analytics: true, marketing: true },
        ts: "2026-08-19T00:00:00.000Z",
      }),
    );
    const optOut = vi.fn();
    Object.assign(window, {
      posthog: { opt_in_capturing: vi.fn(), opt_out_capturing: optOut },
    });
    const root = render(createElement(CookieBanner));

    try {
      await act(async () => {
        await flush();
      });
      vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });

      await act(async () => {
        window.dispatchEvent(new Event(PUBLIC_CONSENT_GPC_ENFORCED_EVENT));
        await flush();
      });

      expect(optOut).toHaveBeenCalled();
      expect(storedConsent()).toMatchObject({
        choice: "accept",
        prefs: { essential: true, analytics: true, marketing: true },
      });
      expect(document.querySelector('[role="region"]')).toBeTruthy();
      expect(document.querySelector('[role="status"]')).toBeTruthy();
    } finally {
      act(() => {
        root.unmount();
      });
      delete (window as Window & { posthog?: unknown }).posthog;
    }
  });
});
