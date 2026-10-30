// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { SubscribersNewBanner } from "../../components/subscribers/SubscribersNewBanner";

describe("SubscribersNewBanner accessibility", () => {
  it("announces the exact visible buffered count", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onClick = vi.fn();
    act(() => {
      root.render(
        <SubscribersNewBanner count={1_234} atLeast onClick={onClick} />,
      );
    });

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe(
      "Show 1,234 or more new subscribers who joined since this view was opened",
    );
    act(() => button?.click());
    expect(onClick).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    container.remove();
  });
});
