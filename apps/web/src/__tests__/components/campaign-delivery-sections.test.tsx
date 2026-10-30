// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CampaignTestSendSection } from "@/app/(dashboard)/app/campaigns/[id]/campaign-test-send-section";
import { CampaignTrackingSection } from "@/app/(dashboard)/app/campaigns/[id]/campaign-tracking-section";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
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

function inputById(id: string): HTMLInputElement {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Input not found: ${id}`);
  return input;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.includes(text) === true,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function checkboxByLabel(label: string): HTMLInputElement {
  const wrapper = Array.from(document.querySelectorAll("label")).find(
    (element) => element.textContent?.includes(label) === true,
  );
  const input = wrapper?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Checkbox not found: ${label}`);
  return input;
}

function changeInput(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("campaign delivery sections", () => {
  it("routes tracking toggles and UTM fields through the caller callback", () => {
    const onChange = vi.fn<(key: string, value: unknown) => void>();
    const root = render(
      createElement(CampaignTrackingSection, {
        onChange,
        tracking: {
          click_tracking: "true",
          google_analytics: false,
          utm_source: "newsletter",
        },
      }),
    );

    try {
      expect(checkboxByLabel("Click tracking").checked).toBe(true);
      expect(checkboxByLabel("Google Analytics").checked).toBe(false);
      expect(inputById("utm-source").value).toBe("newsletter");

      act(() => {
        checkboxByLabel("Google Analytics").click();
      });
      expect(onChange).toHaveBeenLastCalledWith("google_analytics", true);

      act(() => {
        changeInput(inputById("utm-campaign"), "spring-launch");
      });
      expect(onChange).toHaveBeenLastCalledWith("utm_campaign", "spring-launch");
    } finally {
      act(() => root.unmount());
    }
  });

  it("routes test recipient edits and send action through the caller", () => {
    const onChangeEmail = vi.fn<(value: string) => void>();
    const onSend = vi.fn<() => void>();
    const root = render(
      createElement(CampaignTestSendSection, {
        onChangeEmail,
        onSend,
        testEmail: "qa@example.com",
      }),
    );

    try {
      expect(inputById("test-email").value).toBe("qa@example.com");

      act(() => {
        changeInput(inputById("test-email"), "next@example.com");
      });
      expect(onChangeEmail).toHaveBeenCalledWith("next@example.com");

      act(() => {
        buttonByText("Send test").click();
      });
      expect(onSend).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });
});
