// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SequencePerformancePanel } from "@/app/(dashboard)/app/sequences/[id]/sequence-performance-panel";
import { getSequencePerformance } from "@/lib/voice-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/voice-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/voice-api")>();
  return {
    ...actual,
    getSequencePerformance: vi.fn(),
  };
});

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("sequence performance request states", () => {
  it("offers an accessible retry instead of presenting a request failure as no data", async () => {
    vi.mocked(getSequencePerformance)
      .mockRejectedValueOnce(new Error("performance unavailable"))
      .mockResolvedValueOnce({
        reached: 0,
        opened: 0,
        clicked: 0,
        positions: [],
      });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        createElement(SequencePerformancePanel, { sequenceId: "seq_1" }),
      );
    });

    try {
      await waitFor(() => {
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "Couldn’t load send performance",
        );
      });
      expect(document.body.textContent).not.toContain("No send data yet");

      const retry = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry",
      );
      await act(async () => {
        retry?.click();
      });
      await waitFor(() => {
        expect(document.body.textContent).toContain("No send data yet");
      });
      expect(getSequencePerformance).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain(
        "Live sequence delivery is unavailable",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
