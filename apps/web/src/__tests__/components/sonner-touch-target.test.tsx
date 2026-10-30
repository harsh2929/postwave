// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { toast } from "sonner";

import { Toaster } from "@/components/ui/sonner";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  toast.dismiss();
  document.body.innerHTML = "";
});

describe("global toast touch target", () => {
  it("forwards a 44px mobile hit area to Sonner's close control", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<Toaster />);
        await Promise.resolve();
      });
      await act(async () => {
        toast.success("Template created", {
          duration: Number.POSITIVE_INFINITY,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const close = document.querySelector<HTMLButtonElement>(
        "button[data-close-button]",
      );
      expect(close?.getAttribute("aria-label")).toBe("Close toast");
      expect(close?.classList).toContain("!h-11");
      expect(close?.classList).toContain("!w-11");
      expect(close?.classList).toContain("sm:!h-8");
      expect(close?.classList).toContain("sm:!w-8");
      // The compact visible disc is a positioned ::before layer. Pin the
      // library-owned X above it instead of relying on browser paint order.
      expect(close?.classList).toContain("before:z-0");
      expect(close?.classList).toContain("[&>svg]:relative");
      expect(close?.classList).toContain("[&>svg]:z-10");
    } finally {
      toast.dismiss();
      act(() => root.unmount());
    }
  });
});
