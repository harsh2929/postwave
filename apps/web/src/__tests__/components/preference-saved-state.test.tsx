// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FrequencyForm } from "@/app/[locale]/preferences/[token]/frequency-form";
import { PreferencesForm } from "@/app/[locale]/preferences/[token]/preferences-form";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  publicUpdate: vi.fn(),
  publicUnsubscribeAll: vi.fn(),
  publicSmartUnsubscribe: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/en/preferences/pref-token",
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("@/lib/preferences-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/preferences-api")>();
  return {
    ...actual,
    publicUpdate: mocks.publicUpdate,
    publicUnsubscribeAll: mocks.publicUnsubscribeAll,
    publicSmartUnsubscribe: mocks.publicSmartUnsubscribe,
  };
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(element: React.ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("preference saved-state freshness", () => {
  it("requires an explicit confirmation before unsubscribing from every topic", async () => {
    mocks.publicUnsubscribeAll.mockResolvedValue(undefined);
    const root = render(
      createElement(PreferencesForm, {
        token: "pref-token",
        initial: {
          email: "reader@example.com",
          expiresAt: "2026-08-01T00:00:00Z",
          frequencyPreference: "default",
          topics: [],
          gpc: false,
          customization: {
            logo_url: "",
            primary_color: "#5B6CFF",
            footer_text: "",
            show_postwave_badge: true,
          },
        },
      }),
    );

    try {
      const unsubscribeButton = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "unsubscribe_all",
      );
      expect(unsubscribeButton).toBeTruthy();

      await act(async () => {
        unsubscribeButton?.click();
        await flush();
      });

      expect(mocks.publicUnsubscribeAll).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

      const confirmButton = [...document.querySelectorAll("button")].find(
        (button) => button.textContent === "unsubscribe_confirm",
      );
      await act(async () => {
        confirmButton?.click();
        await flush();
      });

      expect(mocks.publicUnsubscribeAll).toHaveBeenCalledWith("pref-token");
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("clears the topic saved confirmation after a new edit", async () => {
    mocks.publicUpdate.mockResolvedValue(undefined);
    const root = render(
      createElement(PreferencesForm, {
        token: "pref-token",
        initial: {
          email: "reader@example.com",
          expiresAt: "2026-08-01T00:00:00Z",
          frequencyPreference: "default",
          gpc: false,
          customization: {
            logo_url: "",
            primary_color: "#5B6CFF",
            footer_text: "",
            show_postwave_badge: true,
          },
          topics: [
            {
              optedIn: true,
              topic: {
                id: "topic-1",
                slug: "news",
                name: "News",
                defaultOptIn: true,
                displayOrder: 1,
              },
            },
          ],
        },
      }),
    );

    try {
      await act(async () => {
        document
          .querySelector("form")
          ?.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
        await flush();
      });
      expect(document.body.textContent).toContain("saved");

      await act(async () => {
        (
          document.querySelector('input[type="checkbox"]') as HTMLInputElement
        ).click();
        await flush();
      });
      expect(document.body.textContent).not.toContain("saved");
    } finally {
      act(() => root.unmount());
    }
  });

  it("clears the frequency saved confirmation after a new choice", async () => {
    mocks.publicSmartUnsubscribe.mockResolvedValue({ choice: "default" });
    const root = render(
      createElement(FrequencyForm, {
        token: "pref-token",
        email: "reader@example.com",
        initialChoice: "default",
      }),
    );

    try {
      await act(async () => {
        document
          .querySelector("form")
          ?.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
        await flush();
      });
      expect(document.body.textContent).toContain("saved_generic");

      await act(async () => {
        (
          document.querySelector('input[value="weekly"]') as HTMLInputElement
        ).click();
        await flush();
      });
      expect(document.body.textContent).not.toContain("saved_generic");
    } finally {
      act(() => root.unmount());
    }
  });

  it("normalizes invalid, past, and far-future pause timestamps", () => {
    const now = new Date("2026-08-27T00:00:00Z").getTime();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      for (const [pausedUntil, expected] of [
        ["not-a-date", "30"],
        ["2026-08-01T00:00:00Z", "1"],
        ["2030-08-27T00:00:00Z", "365"],
      ] as const) {
        const root = render(
          createElement(FrequencyForm, {
            token: "pref-token",
            email: "reader@example.com",
            initialChoice: "paused",
            pausedUntil,
          }),
        );
        expect(
          (document.querySelector('input[type="number"]') as HTMLInputElement)
            .value,
        ).toBe(expected);
        act(() => root.unmount());
        document.body.innerHTML = "";
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("allows clear-and-retype without ever submitting NaN or null", async () => {
    mocks.publicSmartUnsubscribe.mockResolvedValue({
      choice: "paused",
      pausedUntil: "2026-09-10T00:00:00Z",
    });
    const root = render(
      createElement(FrequencyForm, {
        token: "pref-token",
        email: "reader@example.com",
        initialChoice: "paused",
      }),
    );

    try {
      const input = document.querySelector(
        'input[type="number"]',
      ) as HTMLInputElement;
      const form = document.querySelector("form") as HTMLFormElement;

      act(() => {
        changeInput(input, "");
      });
      expect(input.value).toBe("");

      await act(async () => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        await flush();
      });
      expect(mocks.publicSmartUnsubscribe).not.toHaveBeenCalled();
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(document.body.textContent).toContain("pause_days_error");

      act(() => {
        changeInput(input, "14");
      });
      await act(async () => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        await flush();
      });

      expect(mocks.publicSmartUnsubscribe).toHaveBeenCalledWith("pref-token", {
        choice: "paused",
        pauseDays: 14,
      });
      const request = mocks.publicSmartUnsubscribe.mock.calls[0]?.[1];
      expect(request?.pauseDays).not.toBeNull();
      expect(Number.isFinite(request?.pauseDays)).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });
});
