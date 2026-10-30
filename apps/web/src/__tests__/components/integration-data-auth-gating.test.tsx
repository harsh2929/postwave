// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ whoami: vi.fn() }));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SURFACES: Array<{
  name: string;
  heading: string;
  load: () => Promise<{ default: ComponentType }>;
}> = [
  {
    name: "integration catalogue",
    heading: "Integration catalogue",
    load: () => import("@/app/(dashboard)/app/integration-catalogue/page"),
  },
  {
    name: "developer reference",
    heading: "Developer reference",
    load: () => import("@/app/(dashboard)/app/developer-reference/page"),
  },
  {
    name: "API usage",
    heading: "API usage",
    load: () => import("@/app/(dashboard)/app/api-usage/page"),
  },
  {
    name: "audience destinations",
    heading: "Audience destinations",
    load: () => import("@/app/(dashboard)/app/audience-destinations/page"),
  },
  {
    name: "audience syncs",
    heading: "Audience syncs",
    load: () => import("@/app/(dashboard)/app/audience-syncs/page"),
  },
  {
    name: "omnichannel",
    heading: "Omnichannel",
    load: () => import("@/app/(dashboard)/app/omnichannel/page"),
  },
  {
    name: "warehouse",
    heading: "Data warehouse",
    load: async () => {
      // The route keeps this large control plane behind an ssr:false boundary.
      // Mount the real client here because this suite owns the protected-read
      // gate and happy-dom does not reliably hydrate a cold Next loader.
      const { WarehouseManager } = await import(
        "@/app/(dashboard)/app/warehouse/warehouse-manager"
      );
      return { default: WarehouseManager };
    },
  },
];

function render(Page: ComponentType): { root: Root } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Page),
      ),
    );
  });
  return { root };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
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
      await act(async () => flush());
    }
  }
  throw lastError;
}

beforeEach(() => {
  mocks.whoami.mockRejectedValue(new Error("identity unavailable"));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("data request must stay gated"))),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("integration and data surfaces gate reads on workspace identity", () => {
  for (const surface of SURFACES) {
    it(`${surface.name} keeps data requests disabled when identity fails`, async () => {
      const Page = (await surface.load()).default;
      const { root } = render(Page);
      try {
        await waitFor(() => {
          expect(document.querySelector("h1")?.textContent).toBe(
            surface.heading,
          );
          expect(document.body.textContent).toContain(
            "Workspace identity could not be loaded",
          );
        });

        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(document.body.textContent).not.toMatch(
          /No (?:audience syncs|warehouse connected)/u,
        );
      } finally {
        act(() => root.unmount());
      }
    });
  }
});
