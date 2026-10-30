// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// platform-77 — the catalog's workspace-state and customer-stack filters and
// the readiness / coverage / stacks / recipes panels are reachable from
// /app/integrations/catalog, narrow the grid, and are never requested for a
// viewer (connections / stacks are admin reads).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { catalogItem, connectionRow } from "../helpers/integrations-lifecycle-harness";
import { renderPage, unmount, WHOAMI } from "./_harness";
import { recordingTransport, settle } from "./_mount-transport";

const auth = vi.hoisted(() => ({ me: null as unknown }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/integrations/catalog",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn(async () => auth.me),
  whoamiFresh: vi.fn(async () => auth.me),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const CATALOG = {
  schema_version: "1",
  target_public_entries: 3,
  target_native_managed: 2,
  honest_badges: ["native"],
  categories: [
    { key: "crm", label: "CRM" },
    { key: "lead_capture", label: "Lead capture" },
  ],
  capabilities: ["contacts"],
  counts: { available: 3, native: 3 },
  items: [
    catalogItem(),
    catalogItem({ slug: "salesforce", name: "Salesforce", summary: "CRM records." }),
    catalogItem({
      slug: "typeform",
      name: "Typeform",
      category: "lead_capture",
      sources: ["lead_capture"],
      summary: "Form responses.",
    }),
  ],
};

const POSTURE_PATHS = [
  "/api/v1/integrations/connections",
  "/api/v1/integrations/stacks",
];

async function mount() {
  const transport = recordingTransport((req) => {
    if (req.method !== "GET") return undefined;
    if (req.path === "/api/v1/integrations/catalog") return { body: CATALOG };
    if (req.path === "/api/v1/integrations/connections") {
      return {
        body: {
          items: [connectionRow()],
          summary: { total: 1, connected: 1 },
          returned: 1,
        },
      };
    }
    if (req.path === "/api/v1/integrations/stacks") {
      return {
        body: {
          covered_pct: 50,
          target_coverage_pct: 80,
          covered_stacks: 1,
          total_stacks: 1,
          stacks: [
            {
              key: "lead-gen",
              name: "Lead gen",
              status: "partial",
              required_covered: 1,
              required_total: 2,
              components: [{ slug: "typeform", name: "Typeform" }],
            },
          ],
        },
      };
    }
    return undefined;
  });
  const Page = (await import("@/app/(dashboard)/app/integrations/catalog/page"))
    .default;
  const rendered = await renderPage(Page);
  await settle(6);
  return { ...transport, ...rendered };
}

function gridNames(container: HTMLElement): string[] {
  const status = [...container.querySelectorAll('[role="status"]')].find((el) =>
    el.textContent?.startsWith("Showing "),
  );
  const grid = status?.nextElementSibling;
  return [
    ...(grid?.querySelectorAll('a[href^="/app/integrations/catalog/"]') ?? []),
  ]
    .map((a) => a.textContent?.trim() ?? "")
    // Card titles only, not the "Connect →" / "Details →" CTAs.
    .filter((name) => name !== "" && !name.endsWith("→"))
    .sort();
}

async function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function selectLabelled(container: HTMLElement, label: string): HTMLSelectElement {
  const el = [...container.querySelectorAll("label")].find(
    (l) => l.textContent?.trim() === label,
  );
  const found = el ? container.querySelector(`#${CSS.escape(el.htmlFor)}`) : null;
  if (!(found instanceof HTMLSelectElement)) throw new Error(`no select ${label}`);
  return found;
}

describe("integrations catalog — posture filters and panels (platform-77)", () => {
  it("reads posture, renders the filters and panels, and narrows the grid by state and stack", async () => {
    auth.me = WHOAMI;
    const { calls, container, root } = await mount();
    try {
      for (const path of POSTURE_PATHS) {
        expect(calls.some((c) => c.method === "GET" && c.path === path)).toBe(true);
      }
      // The panels issue their own reads.
      expect(calls.some((c) => c.path === "/api/v1/integrations/readiness")).toBe(true);
      const headings = [...container.querySelectorAll("h2")].map((h) =>
        h.textContent?.trim(),
      );
      expect(headings).toContain("Filter by workspace posture");
      // The page owns search and category; the posture filter must not add a
      // second search box or category select.
      expect(container.querySelectorAll('input[type="search"]')).toHaveLength(1);
      expect(
        [...container.querySelectorAll("label")].filter(
          (label) => label.textContent?.trim() === "Category",
        ),
      ).toHaveLength(0);
      expect(gridNames(container)).toEqual(["HubSpot", "Salesforce", "Typeform"]);

      await choose(selectLabelled(container, "Workspace state"), "connected");
      await settle(2);
      expect(gridNames(container)).toEqual(["HubSpot"]);

      await choose(selectLabelled(container, "Workspace state"), "all");
      await choose(selectLabelled(container, "Customer stack"), "lead-gen");
      await settle(2);
      expect(gridNames(container)).toEqual(["Typeform"]);
    } finally {
      unmount(root);
    }
  });

  it("sends no posture read for a viewer", async () => {
    auth.me = { ...WHOAMI, role: "viewer", effective_role: "viewer" };
    const { calls, root } = await mount();
    try {
      for (const path of POSTURE_PATHS) {
        expect(calls.some((c) => c.path === path)).toBe(false);
      }
    } finally {
      unmount(root);
    }
  });
});
