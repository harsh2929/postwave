// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// The saved detail link is keyed by the sanitized archive UUID. It must never
// fall back to a redeemable-code lookup or scan archive pages to find a row.
import { Suspense, act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import DiscountDetailPage from "@/app/(dashboard)/app/discounts/[id]/page";
import type { DiscountHistoryRecord } from "@/lib/discounts-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  listDiscountHistory: vi.fn(),
  listDiscountRedemptionEvents: vi.fn(),
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  search: "",
}));

vi.mock("@/lib/auth-api", () => ({ whoami: mocks.whoami }));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: { children: ReactNode; href: string } & Record<string, unknown>) =>
    createElement("a", { href, ...props }, children),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/app/discounts/11111111-1111-4111-8111-111111111111",
  useRouter: () => ({ push: mocks.routerPush, replace: mocks.routerReplace }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("@/lib/discounts-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discounts-api")>();
  return {
    ...actual,
    listDiscountHistory: mocks.listDiscountHistory,
    listDiscountRedemptionEvents: mocks.listDiscountRedemptionEvents,
  };
});

const RECORD_ID = "11111111-1111-4111-8111-111111111111";

function record(id = RECORD_ID): DiscountHistoryRecord {
  return {
    id,
    label: "Discount record 11111111",
    percent_off: 25,
    amount_off_cents: null,
    currency: "USD",
    max_redemptions: 10,
    times_redeemed: 3,
    expires_at: null,
    applies_to: "both",
    created_at: "2026-07-01T00:00:00Z",
    issues: [],
  };
}

function prime(): void {
  mocks.whoami.mockResolvedValue({
    user_id: "usr_1",
    tenant_id: "tnt_1",
    email: "operator@example.com",
    role: "admin",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  });
  mocks.listDiscountHistory.mockResolvedValue({
    items: [record()],
    hasMore: false,
  });
  mocks.listDiscountRedemptionEvents.mockResolvedValue({
    items: [],
    hasMore: false,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.search = "";
  document.body.innerHTML = "";
});

async function render(ui: ReactNode): Promise<Root> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Suspense, { fallback: null }, ui),
      ),
    );
    await flush();
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(flush);
    }
  }
  throw lastError;
}

describe("discount archive detail route", () => {
  it("uses the opaque record filter and loads its PII-free timeline", async () => {
    prime();
    const root = await render(
      createElement(DiscountDetailPage, {
        params: Promise.resolve({ id: RECORD_ID }),
      }),
    );
    try {
      await waitFor(() => {
        expect(mocks.listDiscountHistory).toHaveBeenCalledWith({
          limit: 1,
          offset: 0,
          recordId: RECORD_ID,
        });
        expect(mocks.listDiscountRedemptionEvents).toHaveBeenCalledWith(
          RECORD_ID,
          { limit: 25, offset: 0 },
        );
      });
      expect(document.body.textContent).toContain("Discount record 11111111");
      expect(document.body.textContent).toContain("Inspection only");
      expect(document.body.textContent).not.toContain("subscriber_email");
    } finally {
      act(() => root.unmount());
    }
  });

  it("normalizes an uppercase UUID once before transport", async () => {
    prime();
    const lowercaseID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    mocks.listDiscountHistory.mockResolvedValue({
      items: [record(lowercaseID)],
      hasMore: false,
    });
    const root = await render(
      createElement(DiscountDetailPage, {
        params: Promise.resolve({ id: lowercaseID.toUpperCase() }),
      }),
    );
    try {
      await waitFor(() => {
        expect(mocks.listDiscountHistory).toHaveBeenCalledWith(
          expect.objectContaining({ recordId: lowercaseID }),
        );
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("rejects padded or code-like route values without an archive request", async () => {
    prime();
    for (const id of [` ${RECORD_ID} `, "SAVE20"]) {
      const root = await render(
        createElement(DiscountDetailPage, { params: Promise.resolve({ id }) }),
      );
      try {
        await waitFor(() =>
          expect(document.body.textContent).toContain(
            "Invalid discount archive link",
          ),
        );
        expect(mocks.listDiscountHistory).not.toHaveBeenCalled();
        expect(mocks.listDiscountRedemptionEvents).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        document.body.innerHTML = "";
      }
    }
  });

  it("caps an oversized event page and disables a no-op Next control at the offset boundary", async () => {
    prime();
    mocks.search = "page=999999";
    mocks.listDiscountRedemptionEvents.mockResolvedValue({
      items: Array.from({ length: 25 }, (_, day) => ({
        redeemed_at: `2026-07-${String((day % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        subscriber_linked: day % 2 === 0,
      })),
      hasMore: true,
    });
    const root = await render(
      createElement(DiscountDetailPage, {
        params: Promise.resolve({ id: RECORD_ID }),
      }),
    );
    try {
      await waitFor(() => {
        expect(mocks.routerReplace).toHaveBeenCalledWith(
          expect.stringContaining("page=401"),
          { scroll: false },
        );
        expect(mocks.listDiscountRedemptionEvents).toHaveBeenCalledWith(
          RECORD_ID,
          { limit: 25, offset: 10_000 },
        );
        expect(document.body.textContent).toContain(
          "Additional events exist beyond this view’s offset boundary",
        );
      });
      const next = document.querySelector(
        'button[aria-label="Next page"]',
      ) as HTMLButtonElement;
      expect(next.disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });
});
