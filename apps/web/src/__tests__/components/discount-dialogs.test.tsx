// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CouponPoolsCard,
  DiscountHistoryCard,
} from "@/app/(dashboard)/app/discounts/discount-cards";
import { RedemptionHistoryDialog } from "@/app/(dashboard)/app/discounts/discount-dialogs";
import { ApiError } from "@/lib/api";
import type { DiscountHistoryRecord } from "@/lib/discounts-api";

const RECORD_ID = "11111111-2222-4333-8444-555555555555";
const apiMocks = vi.hoisted(() => ({
  listDiscountRedemptionEvents: vi.fn(),
}));

vi.mock("@/lib/discounts-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/discounts-api")>(
    "@/lib/discounts-api",
  );
  return {
    ...actual,
    listDiscountRedemptionEvents: apiMocks.listDiscountRedemptionEvents,
  };
});

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  } & Record<string, unknown>) =>
    createElement("a", { href, ...props }, children),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function record(
  patch: Partial<DiscountHistoryRecord> = {},
): DiscountHistoryRecord {
  return {
    id: RECORD_ID,
    label: "Discount record 11111111",
    percent_off: 20,
    amount_off_cents: null,
    currency: "USD",
    max_redemptions: 10,
    times_redeemed: 3,
    expires_at: null,
    applies_to: "both",
    created_at: "2026-01-01T00:00:00Z",
    issues: [],
    ...patch,
  };
}

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { gcTime: 0, retry: false },
    },
  });
}

function render(ui: ReactNode, queryClient = testQueryClient()): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement("div", null, ui),
      ),
    );
  });
  return root;
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element.textContent?.trim() === text ||
      element.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

beforeEach(() => {
  apiMocks.listDiscountRedemptionEvents.mockResolvedValue({
    items: [],
    hasMore: false,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("historical discount card", () => {
  it("routes and inspects by opaque ID without exposing mutation controls", () => {
    const onViewEvents = vi.fn();
    const root = render(
      <DiscountHistoryCard records={[record()]} onViewEvents={onViewEvents} />,
    );
    try {
      expect(document.body.textContent).toContain("Discount record 11111111");
      expect(document.querySelector("a")?.getAttribute("href")).toBe(
        `/app/discounts/${RECORD_ID}`,
      );
      expect(document.body.textContent).toContain("Within stored rules");
      expect(document.body.textContent).not.toMatch(
        /SAVE20|Edit|Delete|Export|Redeemable/u,
      );

      const trigger = button("View recent events for Discount record 11111111");
      act(() => trigger.click());
      expect(onViewEvents).toHaveBeenCalledWith(record(), trigger);
    } finally {
      act(() => root.unmount());
    }
  });

  it("distinguishes a true empty archive from a filtered-empty page", () => {
    const clear = vi.fn();
    const emptyRoot = render(
      <DiscountHistoryCard records={[]} onViewEvents={vi.fn()} />,
    );
    expect(document.body.textContent).toContain("No discount history on file");
    expect(document.body.textContent).not.toContain("Reset page filters");
    act(() => emptyRoot.unmount());
    document.body.innerHTML = "";

    const filteredRoot = render(
      <DiscountHistoryCard
        records={[record()]}
        search="EUR"
        onClearSearch={clear}
        onViewEvents={vi.fn()}
      />,
    );
    try {
      expect(document.body.textContent).toContain(
        "No historical records match on this page",
      );
      act(() => button("Reset page filters").click());
      expect(clear).toHaveBeenCalledTimes(1);
    } finally {
      act(() => filteredRoot.unmount());
    }
  });

  it("keeps the last snapshot visible after a transient refresh failure", () => {
    const retry = vi.fn();
    const root = render(
      <DiscountHistoryCard
        records={[record()]}
        error
        onRetry={retry}
        onViewEvents={vi.fn()}
      />,
    );
    try {
      expect(document.body.textContent).toContain("Snapshot refresh failed");
      expect(document.body.textContent).toContain("Discount record 11111111");
      act(() => button("Retry refresh").click());
      expect(retry).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders a contained legacy anomaly without throwing or inventing currency", () => {
    const root = render(
      <DiscountHistoryCard
        records={[
          record({
            percent_off: null,
            amount_off_cents: 250,
            currency: "XXX",
            issues: ["invalid_currency"],
          }),
        ]}
        onViewEvents={vi.fn()}
      />,
    );
    try {
      expect(document.body.textContent).toContain(
        "250 minor units · currency unavailable",
      );
      expect(document.body.textContent).toContain("Data needs review");
      expect(document.body.textContent).not.toMatch(/\$2\.50|USD/u);
    } finally {
      act(() => root.unmount());
    }
  });

  it("hides rows when access has been revoked", () => {
    const root = render(
      <DiscountHistoryCard
        records={null}
        error
        accessDenied
        onViewEvents={vi.fn()}
      />,
    );
    try {
      expect(document.body.textContent).toContain(
        "Discount history access is unavailable",
      );
      expect(document.body.textContent).not.toContain(
        "Discount record 11111111",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("wires bounded archive pagination", () => {
    const changePage = vi.fn();
    const root = render(
      <DiscountHistoryCard
        records={[record()]}
        page={2}
        hasMore
        onPageChange={changePage}
        onViewEvents={vi.fn()}
      />,
    );
    try {
      act(() => button("Previous archive page").click());
      act(() => button("Next archive page").click());
      expect(changePage.mock.calls).toEqual([[1], [3]]);
    } finally {
      act(() => root.unmount());
    }
  });

  it("disables Next and discloses continuation at the maximum offset", () => {
    const changePage = vi.fn();
    const root = render(
      <DiscountHistoryCard
        records={[record()]}
        page={201}
        hasMore
        reachedOffsetLimit
        onPageChange={changePage}
        onViewEvents={vi.fn()}
      />,
    );
    try {
      expect(document.body.textContent).toContain(
        "Additional records exist beyond this view’s offset boundary",
      );
      const next = button("Next archive page");
      expect(next.disabled).toBe(true);
      act(() => next.click());
      expect(changePage).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("PII-free redemption history dialog", () => {
  it("renders linkage booleans only and offers no export or mutation", async () => {
    apiMocks.listDiscountRedemptionEvents.mockResolvedValueOnce({
      items: [
        { redeemed_at: "2026-08-26T00:00:00Z", subscriber_linked: true },
        { redeemed_at: "2026-08-25T00:00:00Z", subscriber_linked: false },
      ],
      hasMore: true,
    });
    const onClose = vi.fn();
    const root = render(
      <RedemptionHistoryDialog
        recordId={RECORD_ID}
        recordLabel="Discount record 11111111"
        discountsBaseKey={["discounts", "tenant-1"]}
        onClose={onClose}
      />,
    );
    try {
      await waitFor(() => {
        expect(apiMocks.listDiscountRedemptionEvents).toHaveBeenCalledWith(
          RECORD_ID,
          { limit: 25, offset: 0 },
        );
        expect(document.querySelectorAll("tbody tr")).toHaveLength(2);
      });
      expect(document.body.textContent).toContain("Linked record");
      expect(document.body.textContent).toContain("No linked record");
      expect(document.body.textContent).not.toMatch(
        /@example|subscriber-|Export|Edit|Delete/u,
      );
      expect(document.querySelector("a")?.getAttribute("href")).toBe(
        `/app/discounts/${RECORD_ID}`,
      );
      act(() => button("Close").click());
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps request errors distinct from an empty timeline and retries", async () => {
    apiMocks.listDiscountRedemptionEvents.mockRejectedValue(
      new Error("offline"),
    );
    const root = render(
      <RedemptionHistoryDialog
        recordId={RECORD_ID}
        recordLabel="Discount record 11111111"
        discountsBaseKey={["discounts", "tenant-1"]}
        onClose={vi.fn()}
      />,
    );
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Recent events could not be loaded",
        ),
      );
      apiMocks.listDiscountRedemptionEvents.mockResolvedValue({
        items: [],
        hasMore: false,
      });
      act(() => button("Try again").click());
      await waitFor(() =>
        expect(document.body.textContent).toContain("No recorded events"),
      );
      expect(apiMocks.listDiscountRedemptionEvents).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
    }
  });

  it("evicts a previously readable timeline immediately after a 403", async () => {
    const queryClient = testQueryClient();
    const key = [
      "discounts",
      "tenant-1",
      "redemption-events",
      RECORD_ID,
      "preview",
    ] as const;
    queryClient.setQueryData(
      key,
      {
        items: [
          {
            redeemed_at: "2026-08-26T00:00:00Z",
            subscriber_linked: true,
          },
        ],
        hasMore: false,
      },
      { updatedAt: 1 },
    );
    apiMocks.listDiscountRedemptionEvents.mockRejectedValue(
      new ApiError("forbidden", 403),
    );
    const root = render(
      <RedemptionHistoryDialog
        recordId={RECORD_ID}
        recordLabel="Discount record 11111111"
        discountsBaseKey={["discounts", "tenant-1"]}
        onClose={vi.fn()}
      />,
      queryClient,
    );
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Recent-event access is unavailable",
        );
        expect(queryClient.getQueryData(key)).toBeUndefined();
      });
      expect(document.body.textContent).not.toContain("Linked record");
      expect(document.body.textContent).not.toContain("Try again");
    } finally {
      act(() => root.unmount());
    }
  });
});

it("keeps coupon-pool operations undiscoverable on the active route", () => {
  const root = render(<CouponPoolsCard />);
  try {
    expect(document.body.textContent).toContain(
      "Inventory and issuance are unavailable",
    );
    expect(document.body.textContent).not.toMatch(
      /New coupon pool|Create pool|Import codes|Assign coupon/u,
    );
    expect(document.querySelector("button")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
