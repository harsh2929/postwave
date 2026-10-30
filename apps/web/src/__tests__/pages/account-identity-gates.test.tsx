// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubFixtureTransport, WHOAMI } from "./_harness";

const { identity } = vi.hoisted(() => ({ identity: vi.fn() }));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: identity,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/live-streams-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/live-streams-api")>()),
  subscribeMcpExecutions: vi.fn(() => () => {}),
}));
import Tools from "@/app/(dashboard)/app/agent-tools/page";
import Keys from "@/app/(dashboard)/app/key-hygiene/page";
import Requests from "@/app/(dashboard)/app/compliance-requests/page";
import Analytics from "@/app/(dashboard)/app/analytics-destinations/page";

let root: Root;
let client: QueryClient;
let container: HTMLDivElement;
async function mount(Page: ComponentType) {
  container = document.createElement("div");
  document.body.appendChild(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Page)),
    );
  });
}
async function settle() {
  for (let n = 0; n < 5; n++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
}
beforeEach(() => {
  identity.mockReset();
  stubFixtureTransport();
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear();
  container?.remove();
  vi.unstubAllGlobals();
});

describe.each([
  ["agent tools", Tools],
  ["credential hygiene", Keys],
  ["requests and reports", Requests],
  ["analytics destinations", Analytics],
] as const)("%s workspace identity", (_name, Page) => {
  it("holds every private request while identity is pending", async () => {
    identity.mockReturnValue(new Promise(() => {}));
    await mount(Page);
    await settle();
    expect(container.textContent).toContain("Loading workspace identity");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps private requests stopped after identity fails and can recover by retrying identity", async () => {
    identity.mockRejectedValueOnce(new Error("Session unavailable"));
    await mount(Page);
    await settle();
    expect(container.textContent).toContain(
      "Workspace identity could not be loaded",
    );
    expect(fetch).not.toHaveBeenCalled();
    identity.mockResolvedValue(WHOAMI);
    const retry = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Retry"),
    );
    expect(retry).toBeTruthy();
    await act(async () => retry!.click());
    await settle();
    expect(fetch).toHaveBeenCalled();
    expect(container.textContent).not.toContain(
      "Workspace identity could not be loaded",
    );
  });
});
