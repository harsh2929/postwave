// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// automation-4 — "Refresh the forms inventory" is reachable from the forms
// list's filter bar, re-issues GET /api/v1/forms, and the LIST re-renders from
// the answer (the button observes the list's own query key).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FormListItem } from "@/lib/forms-types";
import { WHOAMI } from "./_harness";
import {
  buttonByText,
  clickEl,
  recordingTransport,
  settle,
} from "./_mount-transport";

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/forms",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

vi.mock("@/lib/use-forms-origin", () => ({
  useFormsOrigin: () => "https://forms.example",
}));

import { FormsListClient } from "@/app/(dashboard)/app/forms/forms-list-client";

function form(id: string, name: string): FormListItem {
  return {
    id,
    tenantId: WHOAMI.tenant_id,
    slug: name.toLowerCase(),
    name,
    optInMode: "double",
    structure: { fields: [] },
    settings: { successMessage: "Thanks" },
    status: "draft",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    submissions30d: 0,
    visits30d: 0,
    conversionRate: 0,
  };
}

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("forms list — refresh inventory (automation-4)", () => {
  it("re-reads the inventory from the filter bar and re-renders the list", async () => {
    const { calls } = recordingTransport((req) =>
      req.method === "GET" && req.path === "/api/v1/forms"
        ? { body: [form("form-1", "Newsletter"), form("form-2", "Webinar")] }
        : undefined,
    );
    const host = document.createElement("div");
    document.body.append(host);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    await act(async () => {
      root = createRoot(host);
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(FormsListClient, {
            initialForms: [form("form-1", "Newsletter")],
          }),
        ),
      );
    });
    await settle(8);
    const before = calls.filter((c) => c.path === "/api/v1/forms").length;
    expect(host.textContent).not.toContain("Webinar");

    const filterBar = host
      .querySelector('input[aria-label="Search forms"]')!
      .closest("form")!.parentElement!;
    await clickEl(buttonByText(filterBar, "Refresh"));
    await settle(8);

    expect(calls.filter((c) => c.path === "/api/v1/forms").length).toBe(
      before + 1,
    );
    expect(host.textContent).toContain("Webinar");
    expect(filterBar.querySelector('[role="status"]')?.textContent).toBe(
      "Refreshed · 2 forms",
    );
  });
});
