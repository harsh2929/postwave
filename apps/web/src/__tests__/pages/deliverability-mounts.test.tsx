// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Mount reachability for /app/deliverability:
//   deliverability-38 — "Refresh evidence" re-reads all six hub surfaces
//   deliverability-40 — each breach row carries its server-supplied fix CTA
//   deliverability-58 — the hygiene playbooks expand on the page
import { routeFor } from "@postwave/nav";
import { afterEach, describe, expect, it, vi } from "vitest";

import HUB_FIXTURE from "../fixtures/api/deliverability_hub.json";
import { renderPage, unmount, WHOAMI } from "./_harness";
import {
  buttonByText,
  clickEl,
  recordingTransport,
  settle,
} from "./_mount-transport";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/deliverability",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

const HUB_WITH_FIX = {
  ...HUB_FIXTURE,
  breaches: [
    {
      code: "complaint_rate_high",
      severity: "critical",
      title: "Complaint rate is above the provider threshold",
      fix_cta: { label: "Review suppressions", section: "suppressions" },
    },
  ],
};

const SIX = [
  "/api/v1/deliverability/hub",
  "/api/v1/deliverability/hub/history",
  "/api/v1/deliverability/hub/dns-health",
  "/api/v1/deliverability/hub/blocklist-hits",
  "/api/v1/deliverability/hub/webhook-errors",
  "/api/v1/deliverability/hub/bounce-class-breakdown",
];

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mount() {
  const transport = recordingTransport((req) =>
    req.method === "GET" && req.path === "/api/v1/deliverability/hub"
      ? { body: HUB_WITH_FIX }
      : undefined,
  );
  const Page = (await import("@/app/(dashboard)/app/deliverability/page")).default;
  const rendered = await renderPage(Page);
  return { ...transport, ...rendered };
}

describe("deliverability hub mounts", () => {
  it("refreshes all six evidence surfaces from the header control (deliverability-38)", async () => {
    const { calls, container, root } = await mount();
    try {
      const header = container.querySelector("header")!;
      const refresh = buttonByText(header, "Refresh evidence");
      expect(refresh).toBeDefined();
      const before = calls.length;
      await clickEl(refresh);
      await settle();
      const reads = calls
        .slice(before)
        .filter((c) => c.method === "GET")
        .map((c) => c.path);
      for (const path of SIX) expect(reads).toContain(path);
      expect(header.querySelector('[role="status"]')?.textContent).toMatch(
        /surfaces verified/,
      );
    } finally {
      unmount(root);
    }
  });

  it("renders the breach's fix CTA as a link to the owning web section (deliverability-40)", async () => {
    const { container, root } = await mount();
    try {
      const row = [...container.querySelectorAll("li")].find((li) =>
        li.textContent?.includes("Complaint rate is above the provider threshold"),
      );
      expect(row).toBeDefined();
      const cta = [...row!.querySelectorAll("a")].find(
        (a) => a.textContent?.trim() === "Review suppressions",
      );
      expect(cta).toBeDefined();
      expect(cta!.getAttribute("href")).toBe(routeFor("suppressions", "web"));
    } finally {
      unmount(root);
    }
  });

  it("renders the hygiene playbooks and expands one (deliverability-58)", async () => {
    const { container, root } = await mount();
    try {
      const heading = [...container.querySelectorAll("h2")].find(
        (h) => h.textContent?.trim() === "Hygiene playbooks",
      );
      expect(heading).toBeDefined();
      const toggle = buttonByText(container, "Sunset flow");
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      await clickEl(toggle);
      expect(toggle?.getAttribute("aria-expanded")).toBe("true");
      expect(
        container.querySelector(`#${CSS.escape(toggle!.getAttribute("aria-controls")!)}`)
          ?.textContent,
      ).toContain("Win-back");
    } finally {
      unmount(root);
    }
  });
});
