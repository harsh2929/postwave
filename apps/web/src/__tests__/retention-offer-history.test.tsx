// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Retention offer history (desktop-parity rows commerce-57/58/59).
//
// The service mounts no query parameters for the offer list, so the controls
// here are client-side over the bounded (≤1,000-row) result. That makes the
// consequence to assert the RENDERED SET, not a request — except for the one
// row that IS a request: commerce-59's paid-tier catalogue, whose whole job is
// to turn a tier UUID into a name an operator can act on, and whose failure
// must degrade to a reference rather than blanking the offers.

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

import RetentionPage from "@/app/(dashboard)/app/retention/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

function offerId(index: number): string {
  return `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
}
function tierId(index: number): string {
  return `${(index + 0x1000).toString(16).padStart(8, "0")}-2222-4222-9222-222222222222`;
}
/** Distinct, descending-friendly instants so "newest" is deterministic. */
function createdAt(day: number): string {
  return `2026-08-${String(day).padStart(2, "0")}T10:00:00Z`;
}

function offer(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: offerId(index),
    tenant_id: TENANT_ID,
    paywall_tier_id: tierId(index),
    percent_off: 10 + index,
    duration_months: 3,
    headline: `Offer ${index}`,
    body: `Stored copy for offer ${index}.`,
    active: true,
    created_at: createdAt(18 - index),
    updated_at: createdAt(18 - index),
    ...overrides,
  };
}

const OFFERS = [
  offer(1, {
    headline: "Stay with us",
    body: "A stored offer row.",
    stripe_coupon_id: "coupon_reference",
    created_at: createdAt(20),
    updated_at: createdAt(21),
  }),
  (() => {
    const { percent_off: _percent, ...row } = offer(2, {
      headline: "Fixed saver",
      active: false,
      created_at: createdAt(19),
      updated_at: createdAt(19),
    });
    return { ...row, fixed_off_cents: 500 };
  })(),
  ...Array.from({ length: 10 }, (_, i) => offer(i + 3)),
];

const TILES = [
  {
    offer_id: offerId(1),
    tier_id: tierId(1),
    shown: 4,
    accepted: 1,
    declined: 2,
    expired: 1,
    acceptance_rate: 0.25,
  },
  {
    offer_id: offerId(2),
    tier_id: tierId(2),
    shown: 0,
    accepted: 0,
    declined: 0,
    expired: 0,
    acceptance_rate: 0,
  },
];

const TIERS = {
  tiers: [
    {
      id: tierId(1),
      name: "Premium tier",
      active: true,
      createdAt: createdAt(1),
      updatedAt: createdAt(1),
    },
    {
      id: tierId(2),
      name: "Saver tier",
      active: true,
      createdAt: createdAt(1),
      updatedAt: createdAt(1),
    },
  ],
};

function primeTransport(options: { tiersFail?: boolean } = {}) {
  mocks.whoami.mockResolvedValue({
    user_id: "usr_1",
    tenant_id: TENANT_ID,
    email: "ada@example.com",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  });
  mocks.get.mockImplementation(async (path: string) => {
    switch (path) {
      case "/api/v1/retention-offers/winback-settings":
        return {
          enabled: false,
          churn_threshold: 0.5,
          churn_profiles_scored: 0,
        };
      case "/api/v1/retention-offers":
        return { offers: OFFERS, count: OFFERS.length };
      case "/api/v1/retention-offers/funnel":
        return { tiles: TILES, count: TILES.length };
      case "/api/v1/paywall/tiers": {
        if (options.tiersFail) {
          const { ApiError } = await import("@/lib/api");
          throw new ApiError("tier catalogue unavailable", 503);
        }
        return TIERS;
      }
      default:
        throw new Error(`unexpected GET ${path}`);
    }
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

function offerHeadlines(): string[] {
  return Array.from(
    document.querySelectorAll('ul[aria-label="Retention offers"] > li'),
  ).map((li) => li.querySelector("p")?.textContent ?? "");
}

function offerSubtitles(): string[] {
  return Array.from(
    document.querySelectorAll('ul[aria-label="Retention offers"] > li'),
  ).map((li) => li.querySelectorAll("p")[1]?.textContent ?? "");
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("retention offer history (commerce-57/58/59)", () => {
  it("labels an offer with the paid-tier catalogue name it just read", async () => {
    primeTransport();
    const root = render(createElement(RetentionPage));
    try {
      await waitFor(() => expect(offerHeadlines()).toHaveLength(10));

      // commerce-59: the request the label depends on.
      expect(mocks.get).toHaveBeenCalledWith("/api/v1/paywall/tiers");
      expect(offerSubtitles()[0]).toContain("Premium tier");
      expect(offerSubtitles()[0]).toContain("11% off");
      expect(offerSubtitles()[0]).not.toContain(tierId(1));
      // The funnel surface stops rendering a raw tier id too.
      expect(document.body.textContent).toContain("Saver tier");
    } finally {
      act(() => root.unmount());
    }
  });

  it("degrades to a tier reference when the catalogue read fails", async () => {
    primeTransport({ tiersFail: true });
    const root = render(createElement(RetentionPage));
    try {
      await waitFor(() => expect(offerHeadlines()).toHaveLength(10));

      // The offers themselves are unaffected — a labelling read is not an
      // offer read, and its failure is stated rather than swallowed.
      expect(offerHeadlines()[0]).toBe("Stay with us");
      expect(offerSubtitles()[0]).toContain(`Tier ${tierId(1).slice(0, 8)}…`);
      expect(offerSubtitles()[0]).not.toContain("absent from catalogue");
      expect(document.body.textContent).toContain(
        "Tier names could not be read",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("narrows the stored rows by search, state, discount, and evidence", async () => {
    primeTransport();
    const root = render(createElement(RetentionPage));
    try {
      await waitFor(() => expect(offerHeadlines()).toHaveLength(10));
      expect(document.body.textContent).toContain("12 matching offers");

      // Search reaches the catalogue name, not only the stored copy.
      await setValue(field<HTMLInputElement>("wb-offer-search"), "Premium");
      await waitFor(() => expect(offerHeadlines()).toEqual(["Stay with us"]));

      await setValue(field<HTMLInputElement>("wb-offer-search"), "");
      await setValue(field<HTMLSelectElement>("wb-offer-state"), "inactive");
      await waitFor(() => expect(offerHeadlines()).toEqual(["Fixed saver"]));

      await setValue(field<HTMLSelectElement>("wb-offer-state"), "all");
      await setValue(field<HTMLSelectElement>("wb-offer-discount"), "fixed");
      await waitFor(() => expect(offerHeadlines()).toEqual(["Fixed saver"]));

      await setValue(field<HTMLSelectElement>("wb-offer-discount"), "all");
      await setValue(field<HTMLSelectElement>("wb-offer-evidence"), "measured");
      await waitFor(() => expect(offerHeadlines()).toEqual(["Stay with us"]));

      // A funnel that says nothing about an offer is "unknown", not "zero".
      await setValue(field<HTMLSelectElement>("wb-offer-evidence"), "zero");
      await waitFor(() => expect(offerHeadlines()).toEqual(["Fixed saver"]));

      await setValue(field<HTMLSelectElement>("wb-offer-evidence"), "unknown");
      await waitFor(() => expect(offerHeadlines()).toHaveLength(10));
      expect(offerHeadlines()).not.toContain("Stay with us");
      expect(document.body.textContent).toContain("10 matching offers");
    } finally {
      act(() => root.unmount());
    }
  });

  it("pages the matching rows and reorders them", async () => {
    primeTransport();
    const root = render(createElement(RetentionPage));
    try {
      await waitFor(() => expect(offerHeadlines()).toHaveLength(10));
      expect(offerHeadlines()[0]).toBe("Stay with us");
      expect(document.body.textContent).toContain("Page 1 of 2");

      await click(buttonByText("Next"));
      await waitFor(() => expect(offerHeadlines()).toEqual(["Offer 11", "Offer 12"]));
      expect(document.body.textContent).toContain("Page 2 of 2");

      await click(buttonByText("Previous"));
      await waitFor(() => expect(offerHeadlines()[0]).toBe("Stay with us"));

      // Oldest-first inverts the set; the pager resets to the first page.
      await setValue(field<HTMLSelectElement>("wb-offer-sort"), "oldest");
      await waitFor(() => expect(offerHeadlines()[0]).toBe("Offer 12"));
      expect(document.body.textContent).toContain("Page 1 of 2");

      // Counter sorts put unreconciled rows last rather than treating an
      // absent funnel row as a zero.
      await setValue(field<HTMLSelectElement>("wb-offer-sort"), "shown-desc");
      await waitFor(() => expect(offerHeadlines()[0]).toBe("Stay with us"));
      expect(offerHeadlines()[1]).toBe("Fixed saver");
    } finally {
      act(() => root.unmount());
    }
  });

  it("inspects one offer row without reading or writing anything new", async () => {
    primeTransport();
    const root = render(createElement(RetentionPage));
    try {
      await waitFor(() => expect(offerHeadlines()).toHaveLength(10));
      const before = mocks.get.mock.calls.length;

      await click(buttonByText("Inspect"));
      await waitFor(() => {
        const dialog = document.querySelector('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog?.textContent).toContain("Stay with us");
        expect(dialog?.textContent).toContain("Premium tier");
        expect(dialog?.textContent).toContain("Reconciled counters");
        expect(dialog?.textContent).toContain("11% off");
        // Coupon PRESENCE, never the provider reference itself.
        expect(dialog?.textContent).toContain("Present");
        expect(dialog?.textContent).not.toContain("coupon_reference");
        expect(dialog?.textContent).toContain("Derived acceptance25%");
      });
      expect(mocks.get.mock.calls).toHaveLength(before);
      expect(mocks.post).not.toHaveBeenCalled();
      expect(mocks.patch).not.toHaveBeenCalled();
      expect(mocks.delete).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
