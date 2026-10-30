// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckYourEmail } from "@/components/auth/check-your-email";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CheckYourEmail focus handoff", () => {
  it("focuses the confirmation that replaces the submitted form", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(CheckYourEmail, {
          email: "reader@example.com",
          sentDescription: "a reset link is on the way.",
          onResend: vi.fn().mockResolvedValue(undefined),
        }),
      );
      await Promise.resolve();
    });

    const status = container.querySelector('[role="status"]');
    expect(status).toBeInstanceOf(HTMLDivElement);
    expect(status?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(status);

    await act(async () => root.unmount());
  });
});
