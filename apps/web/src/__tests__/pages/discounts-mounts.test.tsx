// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// commerce-30 — the discount archive's local-state filters (chips incl.
// Expired / Cap reached, clickable summary cells, Reset, data-issue banner)
// are reachable from /app/discounts and narrow the rows the page loaded.
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";
import {
  buttonByText,
  clickEl,
  recordingTransport,
  settle,
} from "./_mount-transport";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app/discounts",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function record(id: string, label: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    label,
    percent_off: 20,
    currency: "usd",
    times_redeemed: 3,
    applies_to: "both",
    created_at: "2026-07-10T00:00:00Z",
    ...extra,
  };
}

const RECORDS = [
  record("11111111-2222-4333-8444-555555555551", "Open record"),
  record("11111111-2222-4333-8444-555555555552", "Expired record", {
    expires_at: "2026-01-01T00:00:00Z",
  }),
  record("11111111-2222-4333-8444-555555555553", "Capped record", {
    max_redemptions: 3,
  }),
];

function rowLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll("tbody tr")]
    .map((tr) => tr.textContent ?? "")
    .flatMap((text) =>
      ["Open record", "Expired record", "Capped record"].filter((l) =>
        text.includes(l),
      ),
    );
}

describe("discounts — archive record filters (commerce-30)", () => {
  it("renders the filter chips on the page and narrows the loaded rows", async () => {
    const { calls } = recordingTransport((req) =>
      req.method === "GET" && req.path === "/api/v1/discounts"
        ? { body: { items: RECORDS, has_more: false } }
        : undefined,
    );
    const Page = (await import("@/app/(dashboard)/app/discounts/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      expect(calls.some((c) => c.path === "/api/v1/discounts")).toBe(true);
      expect(rowLabels(container).sort()).toEqual(
        ["Capped record", "Expired record", "Open record"],
      );
      const group = container.querySelector("fieldset")!;
      expect(group.querySelector("legend")?.textContent).toContain(
        "Filter discount history on this page",
      );

      await clickEl(buttonByText(group, /^Expired\s*1$/));
      await settle(2);
      expect(rowLabels(container)).toEqual(["Expired record"]);

      await clickEl(buttonByText(group, /^Cap reached\s*1$/));
      await settle(2);
      expect(rowLabels(container)).toEqual(["Capped record"]);

      await clickEl(buttonByText(group, "Reset"));
      await settle(2);
      expect(rowLabels(container)).toHaveLength(3);

      // The summary cells filter too.
      await clickEl(
        container.querySelector(
          'button[aria-label="Stored-rule closures: 2. Filter records."]',
        ),
      );
      await settle(2);
      expect(rowLabels(container).sort()).toEqual([
        "Capped record",
        "Expired record",
      ]);
    } finally {
      unmount(root);
    }
  });
});
