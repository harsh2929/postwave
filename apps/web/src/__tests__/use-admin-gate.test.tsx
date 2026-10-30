// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ whoami: vi.fn() }));
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...original, whoami: mocks.whoami };
});

import { useAdminGate } from "@/lib/use-admin-gate";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const gate = useAdminGate();
  return createElement(
    "div",
    null,
    createElement("span", null, `${gate.state}:${gate.role ?? "none"}`),
    createElement("button", { disabled: !gate.canWrite }, "write"),
    createElement("button", { onClick: gate.retry }, "retry"),
  );
}

function renderHarnesses(count = 1): Root {
  const root = createRoot(
    document.body.appendChild(document.createElement("div")),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        ...Array.from({ length: count }, (_, index) =>
          createElement(Harness, { key: index }),
        ),
      ),
    ),
  );
  return root;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("useAdminGate", () => {
  it("deduplicates concurrent viewers and distinguishes verified read-only", async () => {
    mocks.whoami.mockResolvedValue({ role: "viewer" });
    const root = renderHarnesses(2);
    try {
      expect(document.body.textContent).toBe(
        "loading:nonewriteretryloading:nonewriteretry",
      );
      await settle();
      await settle();
      expect(document.body.textContent).toBe(
        "read-only:viewerwriteretryread-only:viewerwriteretry",
      );
      expect(mocks.whoami).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("reports identity failure as error and retries fail-closed", async () => {
    mocks.whoami.mockRejectedValueOnce(new Error("private outage"));
    const root = renderHarnesses();
    try {
      await settle();
      await settle();
      expect(document.body.textContent).toBe("error:nonewriteretry");
      expect(document.querySelector("button")?.disabled).toBe(true);

      mocks.whoami.mockResolvedValueOnce({ role: "admin" });
      act(() =>
        Array.from(document.querySelectorAll("button"))
          .find((candidate) => candidate.textContent === "retry")
          ?.click(),
      );
      await settle();
      await settle();
      expect(document.body.textContent).toBe("writer:adminwriteretry");
      expect(document.querySelector("button")?.disabled).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("never treats viewer mode as writable even for an owner", async () => {
    mocks.whoami.mockResolvedValue({
      role: "owner",
      effective_role: "owner",
      viewer_mode: true,
    });
    const root = renderHarnesses();
    try {
      await settle();
      await settle();
      expect(document.body.textContent).toBe("read-only:ownerwriteretry");
      expect(document.querySelector("button")?.disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });
});
