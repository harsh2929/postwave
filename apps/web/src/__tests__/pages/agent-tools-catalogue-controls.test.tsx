// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The catalogue's two new verbs: filter by category, and copy an identifier.
// The category counts used to be a read-only legend that looked like filters.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

const CATALOG = [
  {
    name: "segments.create_from_rules",
    category: "audience-management",
    description: "Create a segment from explicit subscriber rules.",
  },
  {
    name: "campaigns.schedule",
    category: "campaign-delivery",
    description: "Schedule a reviewed campaign for delivery.",
  },
  {
    name: "campaigns.preview",
    category: "campaign-delivery",
    description: "Render a campaign preview without sending.",
  },
];

const BODIES: Record<string, unknown> = {
  "/api/v1/mcp/catalog": CATALOG,
  "/api/v1/mcp/quotas": {
    quotas: [],
    enforcementMode: "advisory_unverified",
    authoritative: false,
    releaseHold: "mcp_quota_enforcement_release_held",
  },
  "/api/v1/mcp/stats": {
    windowHours: 24,
    totalCalls: 0,
    successfulCalls: 0,
    averageLatencyMs: 0,
    p95LatencyMs: 0,
    totalCostMicros: 0,
    topTools: [],
    statusBreakdown: [],
  },
  "/api/v1/mcp/trend": { points: [] },
  "/api/v1/mcp/executions": { rows: [], detailPolicy: "minimized_v1" },
};

function stubTransport() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return new Response(JSON.stringify(BODIES[url.split("?")[0]] ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function control(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim().startsWith(label),
  );
}

beforeEach(() => {
  stubTransport();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("agent tool catalogue controls", () => {
  it("filters the list to one category and clears back to the counts", async () => {
    const Page = (await import("@/app/(dashboard)/app/agent-tools/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      // Before any filter, the catalogue shows counts and no tool rows.
      expect(container.textContent).toContain("campaign delivery");
      expect(container.textContent).not.toContain("campaigns.schedule");

      const chip = control("campaign delivery");
      expect(chip?.getAttribute("aria-pressed")).toBe("false");
      await act(async () => {
        chip?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(container.textContent).toContain(
        "2 matching tools in campaign delivery",
      );
      expect(container.textContent).toContain("campaigns.schedule");
      expect(container.textContent).not.toContain(
        "segments.create_from_rules",
      );
      expect(control("campaign delivery")?.getAttribute("aria-pressed")).toBe(
        "true",
      );

      await act(async () => {
        control("Clear filters")?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(container.textContent).not.toContain("campaigns.schedule");
      expect(control("Clear filters")).toBeUndefined();
    } finally {
      unmount(root);
    }
  });

  it("copies a tool identifier and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const Page = (await import("@/app/(dashboard)/app/agent-tools/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await act(async () => {
        control("audience management")?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const copy = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find(
        (candidate) =>
          candidate.getAttribute("aria-label") ===
          "Copy tool identifier segments.create_from_rules",
      );
      expect(copy).toBeDefined();

      await act(async () => {
        copy?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(writeText).toHaveBeenCalledWith("segments.create_from_rules");
      expect(container.textContent).toContain(
        "Copied the identifier segments.create_from_rules",
      );
    } finally {
      unmount(root);
    }
  });
});
