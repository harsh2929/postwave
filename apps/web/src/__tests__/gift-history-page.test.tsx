// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Gift history (desktop-parity rows commerce-33/34/35).
//
// Every assertion here is a CONSEQUENCE, because each of these verbs is only
// worth anything if a specific request goes out or specifically does not:
//   * commerce-33 — the page reads BOTH the record page and the aggregate, and
//     the refresh control re-reads both.
//   * commerce-34 — each control changes the query string the server actually
//     receives; an invalid record prefix sends NOTHING (the reporting scope is
//     bounded on purpose); and "Review this page" filters the page already in
//     hand rather than asking the server for a filter it does not implement.
//   * commerce-35 — Inspect issues a real GET for that record id.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: mocks };
});
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoami: mocks.whoami, whoamiFresh: mocks.whoami };
});

import GiftHistoryPage from "@/app/(dashboard)/app/source-quality/gifts/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PAID_ID = "1a2b3c4d-1111-4111-8111-111111111111";
const BROKEN_ID = "2b3c4d5e-2222-4222-9222-222222222222";

function paidRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: PAID_ID,
    label: "Gift record 1a2b3c4d",
    plan_label: "Pro monthly",
    duration_months: 3,
    status: "paid",
    created_at: "2026-08-01T10:00:00Z",
    redeemed_at: null,
    expires_at: "2026-09-01T10:00:00Z",
    canceled_at: null,
    message_recorded: true,
    provider_invoice_linked: true,
    gifter_member_linked: false,
    recipient_member_linked: true,
    ...overrides,
  };
}

/** Claims redemption and carries no redemption timestamp — a data issue. */
function brokenRecord(overrides: Record<string, unknown> = {}) {
  return paidRecord({
    id: BROKEN_ID,
    label: "Gift record 2b3c4d5e",
    status: "redeemed",
    redeemed_at: null,
    ...overrides,
  });
}

const STATS = {
  total: 40,
  pending: 3,
  paid: 5,
  granted: 20,
  canceled: 6,
  expired: 4,
  refunded: 2,
  conversionRate: 0.625,
  generated_at: "2026-09-01T09:00:00Z",
};

function pageEnvelope(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    items,
    total: 40,
    limit: 18,
    offset: 0,
    snapshot_at: "2026-09-01T09:30:00Z",
    ...overrides,
  };
}

const listPaths: string[] = [];
const detailPaths: string[] = [];

function primeTransport(items: unknown[] = [paidRecord(), brokenRecord()]) {
  mocks.whoami.mockResolvedValue({
    user_id: "usr_1",
    tenant_id: "tnt_1",
    email: "ada@example.com",
    role: "owner",
    effective_role: "owner",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  });
  mocks.get.mockImplementation((path: string) => {
    if (path === "/api/v1/gift-subscriptions/stats") {
      return Promise.resolve(STATS);
    }
    if (path.startsWith("/api/v1/gift-subscriptions?")) {
      listPaths.push(path);
      const offset = Number(
        new URLSearchParams(path.slice(path.indexOf("?"))).get("offset") ?? "0",
      );
      return Promise.resolve(pageEnvelope(items, { offset }));
    }
    if (path.startsWith("/api/v1/gift-subscriptions/")) {
      detailPaths.push(path);
      const id = path.slice("/api/v1/gift-subscriptions/".length);
      return Promise.resolve(id === BROKEN_ID ? brokenRecord() : paidRecord());
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

function render(ui: ReactNode): Root {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, ui));
  });
  return root;
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
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
}

function buttonByText(text: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (button): button is HTMLButtonElement =>
      button instanceof HTMLButtonElement &&
      button.textContent?.includes(text) === true,
  );
  if (!match) throw new Error(`Button not found: ${text}`);
  return match;
}

async function click(control: HTMLElement): Promise<void> {
  await act(async () => {
    control.click();
    await flush();
  });
}

async function setValue(
  control: HTMLInputElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  const prototype =
    control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
}

function field<T extends HTMLElement>(id: string): T {
  const match = document.querySelector<T>(`#${id}`);
  if (!match) throw new Error(`Control not found: #${id}`);
  return match;
}

/** Records currently rendered in the archive list. */
function renderedLabels(): string[] {
  return Array.from(
    document.querySelectorAll('ul[aria-label="Gift lifecycle records"] > li'),
  ).map((li) => li.querySelector("p:nth-of-type(2)")?.textContent ?? "");
}

afterEach(() => {
  vi.clearAllMocks();
  listPaths.length = 0;
  detailPaths.length = 0;
  document.body.innerHTML = "";
});

describe("gift history archive (commerce-33/34/35)", () => {
  it("reads the record page and the aggregate, and re-reads both on refresh", async () => {
    primeTransport();
    const root = render(createElement(GiftHistoryPage));
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Gift record 1a2b3c4d");
      });

      // commerce-33: the exact contract, including the bounded page size.
      expect(listPaths).toEqual(["/api/v1/gift-subscriptions?limit=18&offset=0"]);
      expect(mocks.get).toHaveBeenCalledWith("/api/v1/gift-subscriptions/stats");
      // The aggregate quick-filters render the server's own counts.
      expect(document.body.textContent).toContain("Total archive");
      expect(document.body.textContent).toContain("3 pending · 5 paid");
      // Sanitized projection reaches the row.
      expect(document.body.textContent).toContain("Pro monthly");
      expect(document.body.textContent).toContain("Paid · awaiting access");
      // A redeemed row with no redemption timestamp is NOT reported as
      // redeemed — it is promoted out of its claimed state.
      expect(document.body.textContent).toContain("Data issue");
      expect(document.body.textContent).not.toContain("2 records have field");

      await click(buttonByText("Refresh evidence"));
      await waitFor(() => {
        expect(listPaths).toHaveLength(2);
      });
      expect(
        mocks.get.mock.calls.filter(
          (call) => call[0] === "/api/v1/gift-subscriptions/stats",
        ),
      ).toHaveLength(2);
    } finally {
      act(() => root.unmount());
    }
  });

  it("reports a properly redeemed gift as redeemed, not as a data issue", async () => {
    // The contradictory fixture above only proves the unhappy branch. A gift
    // with a real redemption timestamp must survive parsing: if the wire field
    // were dropped, every legitimate redemption would be demoted to a data issue.
    primeTransport([
      paidRecord({
        id: "3c4d5e6f-3333-4333-a333-333333333333",
        label: "Gift record 3c4d5e6f",
        status: "redeemed",
        redeemed_at: "2026-08-10T10:00:00Z",
      }),
    ]);
    const root = render(createElement(GiftHistoryPage));
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Gift record 3c4d5e6f");
      });
      const row = Array.from(
        document.querySelectorAll('ul[aria-label="Gift lifecycle records"] > li'),
      ).find((li) => li.textContent?.includes("Gift record 3c4d5e6f"));
      expect(row?.textContent).toContain("Redeemed");
      expect(row?.textContent).not.toContain("Data issue");
    } finally {
      act(() => root.unmount());
    }
  });

  it("sends each control as a query parameter and pages by offset", async () => {
    primeTransport();
    const root = render(createElement(GiftHistoryPage));
    try {
      await waitFor(() => expect(listPaths).toHaveLength(1));

      await setValue(field<HTMLSelectElement>("gift-filter"), "redeemed");
      await waitFor(() =>
        expect(listPaths.at(-1)).toBe(
          "/api/v1/gift-subscriptions?limit=18&offset=0&filter=redeemed",
        ),
      );

      await setValue(field<HTMLSelectElement>("gift-sort"), "oldest");
      await waitFor(() =>
        expect(listPaths.at(-1)).toBe(
          "/api/v1/gift-subscriptions?limit=18&offset=0&filter=redeemed&sort=oldest",
        ),
      );

      // Search is the opaque record prefix and nothing else: an address-shaped
      // query must not reach the server at all.
      const before = listPaths.length;
      await setValue(field<HTMLInputElement>("gift-search"), "ada@example.com");
      await act(async () => {
        await flush();
      });
      expect(listPaths).toHaveLength(before);
      expect(document.body.textContent).toContain(
        "Enter 8–32 hexadecimal characters",
      );

      await setValue(field<HTMLInputElement>("gift-search"), "1a2b3c4d");
      await waitFor(() =>
        expect(listPaths.at(-1)).toBe(
          "/api/v1/gift-subscriptions?limit=18&offset=0&q=1a2b3c4d&filter=redeemed&sort=oldest",
        ),
      );

      // Paging advances the offset, and only the offset.
      await click(buttonByText("Next"));
      await waitFor(() =>
        expect(listPaths.at(-1)).toBe(
          "/api/v1/gift-subscriptions?limit=18&offset=18&q=1a2b3c4d&filter=redeemed&sort=oldest",
        ),
      );
      await click(buttonByText("Previous"));
      await waitFor(() =>
        expect(listPaths.at(-1)).toBe(
          "/api/v1/gift-subscriptions?limit=18&offset=0&q=1a2b3c4d&filter=redeemed&sort=oldest",
        ),
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("quick-filters from a summary cell and reviews this page without a request", async () => {
    primeTransport();
    const root = render(createElement(GiftHistoryPage));
    try {
      await waitFor(() => expect(renderedLabels()).toHaveLength(2));

      // "Review this page" is page-local: the server has no notion of a row
      // contradicting itself, so from the unfiltered archive it must narrow
      // what is already in hand and ask for nothing.
      const before = listPaths.length;
      await click(buttonByText("Review this page"));
      await act(async () => {
        await flush();
      });
      expect(listPaths).toHaveLength(before);
      expect(renderedLabels()).toEqual(["Gift record 2b3c4d5e"]);
      expect(field<HTMLSelectElement>("gift-filter").value).toBe("data_issue");

      // Summary cell → the server-side lifecycle filter.
      await click(buttonByText("Open"));
      await waitFor(() =>
        expect(listPaths.at(-1)).toBe(
          "/api/v1/gift-subscriptions?limit=18&offset=0&filter=open",
        ),
      );
      expect(buttonByText("Open").getAttribute("aria-pressed")).toBe("true");
    } finally {
      act(() => root.unmount());
    }
  });

  it("inspects one record by re-reading it from the server", async () => {
    primeTransport();
    const root = render(createElement(GiftHistoryPage));
    try {
      await waitFor(() => expect(renderedLabels()).toHaveLength(2));

      await click(buttonByText("Inspect evidence"));
      await waitFor(() =>
        expect(detailPaths).toEqual([`/api/v1/gift-subscriptions/${PAID_ID}`]),
      );
      await waitFor(() => {
        const dialog = document.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog?.textContent).toContain("Gift record 1a2b3c4d");
        // Presence-only linkage flags, rendered as presence.
        expect(dialog?.textContent).toContain("Recipient member linkage");
        expect(dialog?.textContent).toContain("Gifter member linkage");
        expect(dialog?.textContent).toContain("not recorded");
        expect(dialog?.textContent).toContain("Paid · awaiting access");
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows the server's own denial instead of an empty archive", async () => {
    primeTransport();
    const { ApiError } = await import("@/lib/api");
    mocks.get.mockImplementation((path: string) => {
      if (path === "/api/v1/gift-subscriptions/stats") {
        return Promise.resolve(STATS);
      }
      return Promise.reject(
        new ApiError("your role does not have permission for this route", 403),
      );
    });
    const root = render(createElement(GiftHistoryPage));
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "your role does not have permission for this route",
        );
      });
      expect(document.body.textContent).not.toContain(
        "No gift lifecycle records are on file",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
