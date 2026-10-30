// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// analytics-91: the /warehouse page renders the tenant-wide WarehouseRunsPanel
// (search, status filter, Refresh, admin-only redacted error evidence) in
// place of the old unfiltered RunsSection. Rendered through the real page and
// its deferred loader, so this proves the panel is reachable, fed by the
// page's own GET /api/v1/warehouse/runs query, and given the page's verified
// authority (the evidence request only fires for an owner/admin).
import { act, createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";
// The manager arrives through next/dynamic, so its first import can outlast
// renderPage's settle loop on a cold module graph. Wait on the outcome.
import { importBeforeTests, waitFor } from "./_wait";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/warehouse",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

const TENANT = WHOAMI.tenant_id;
const CONN = "33333333-3333-4333-8333-333333333333";
const RUN_OK = "55555555-5555-4555-8555-555555555555";
const RUN_FAIL = "66666666-6666-4666-8666-666666666666";

function run(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT,
    connection_id: CONN,
    direction: "export",
    run_mode: "scheduled",
    status: "completed",
    object_selection: ["subscribers"],
    rows_scanned: 100,
    rows_exported: 100,
    rows_imported: 0,
    rows_failed: 0,
    schema_errors: 0,
    retry_count: 0,
    issue_present: false,
    started_at: "2026-09-12T08:00:00Z",
    completed_at: "2026-09-12T08:01:00Z",
    created_at: "2026-09-12T08:00:00Z",
    updated_at: "2026-09-12T08:01:00Z",
    ...overrides,
  };
}

const requested: string[] = [];

// The page module these tests import is cold work for vitest's transform
// pipeline; pay it before any test's 5 s clock starts.
importBeforeTests(() => import("@/app/(dashboard)/app/warehouse/page"));

beforeEach(() => {
  requested.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const path = new URL(url, "http://localhost").pathname;
      requested.push(path);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (path === "/api/v1/warehouse/runs") {
        return json({
          items: [
            run(RUN_OK),
            run(RUN_FAIL, {
              status: "failed",
              rows_failed: 3,
              issue_present: true,
            }),
          ],
        });
      }
      if (path === `/api/v1/warehouse/runs/${RUN_FAIL}/errors`) {
        return json({
          items: [
            {
              id: 9,
              run_id: RUN_FAIL,
              source_object: "subscribers",
              row_number: 42,
              error_code: "schema_invalid",
              message_present: true,
              created_at: "2026-09-12T08:00:30Z",
            },
          ],
        });
      }
      if (path === "/api/v1/warehouse/connections") return json({ items: [] });
      return json({ error: { code: "not_found", message: "" } }, 404);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function count(path: string): number {
  return requested.filter((p) => p === path).length;
}

async function flush(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("warehouse page mounts the runs panel (analytics-91)", () => {
  it("clears a failed operation after Strict Mode remount so the page remains usable", async () => {
    const { WarehouseManager } =
      await import("@/app/(dashboard)/app/warehouse/warehouse-manager");
    const StrictPage = () =>
      createElement(StrictMode, null, createElement(WarehouseManager));
    const { container, root } = await renderPage(StrictPage);
    try {
      const runDue = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Run due",
      );
      expect(runDue).toBeDefined();
      await act(async () => runDue!.click());
      await waitFor(() => {
        expect(container.textContent).toContain(
          "Run due connections could not be completed",
        );
        expect(runDue!.disabled).toBe(false);
      });
      expect(count("/api/v1/warehouse/runs/due")).toBe(1);
    } finally {
      unmount(root);
    }
  });

  it("renders the searchable, refreshable run history from the page's runs query", async () => {
    const Page = (await import("@/app/(dashboard)/app/warehouse/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      await waitFor(() => {
        expect(
          container.querySelectorAll('[data-testid="warehouse-run-row"]'),
        ).toHaveLength(2);
      });
      expect(count("/api/v1/warehouse/runs")).toBeGreaterThanOrEqual(1);
      const section = container.querySelector<HTMLElement>(
        '[role="region"][aria-labelledby="warehouse-runs"]',
      );
      expect(section).not.toBeNull();
      // Panel-only controls: the old RunsSection had neither.
      const labels = [...section!.querySelectorAll("label")].map(
        (label) => label.textContent,
      );
      expect(labels).toEqual(expect.arrayContaining(["Find a run", "Status"]));
      expect(
        section!.querySelectorAll('[data-testid="warehouse-run-row"]'),
      ).toHaveLength(2);
      expect(section!.textContent).toContain("2 of 2 loaded");
      expect(section!.textContent).toContain("1 need attention");

      // Refresh re-runs the PAGE's runs query.
      const before = count("/api/v1/warehouse/runs");
      const refresh = [...section!.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Refresh",
      );
      expect(refresh).toBeDefined();
      await act(async () => {
        refresh?.click();
      });
      await flush();
      expect(count("/api/v1/warehouse/runs")).toBe(before + 1);
    } finally {
      unmount(root);
    }
  });

  it("passes the page's verified owner authority, so error evidence is requested", async () => {
    const Page = (await import("@/app/(dashboard)/app/warehouse/page")).default;
    const { container, root } = await renderPage(Page);
    try {
      await waitFor(() => {
        expect(
          container.querySelector(
            `button[aria-label="Inspect error evidence for run ${RUN_FAIL}"]`,
          ),
        ).not.toBeNull();
      });
      const inspect = container.querySelector<HTMLButtonElement>(
        `button[aria-label="Inspect error evidence for run ${RUN_FAIL}"]`,
      );
      expect(inspect).not.toBeNull();
      await act(async () => {
        inspect?.click();
      });
      await flush();
      expect(count(`/api/v1/warehouse/runs/${RUN_FAIL}/errors`)).toBe(1);
      expect(document.body.textContent).toContain("schema_invalid");
    } finally {
      unmount(root);
    }
  });
});
