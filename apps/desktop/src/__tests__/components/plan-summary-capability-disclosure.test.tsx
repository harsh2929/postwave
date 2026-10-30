// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  planSummary: vi.fn().mockResolvedValue({
    data: {
      tier: "studio",
      current_period_end: null,
      resources: [],
      sends_projection: null,
    },
  }),
  setSection: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  billingApi: { planSummary: mocks.planSummary },
}));

vi.mock("../../lib/store", () => ({
  useMe: () => ({ user: "user-1", tenant: "tenant-1" }),
  setSection: mocks.setSection,
}));

import { PlanSummaryCard } from "../../components/settings/PlanSummaryCard";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  mocks.planSummary.mockClear();
  mocks.setSection.mockReset();
});

async function render(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<PlanSummaryCard />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PlanSummaryCard capability disclosure", () => {
  it("loads the secondary availability matrix only after the user requests it", async () => {
    await render();

    expect(mocks.planSummary).toHaveBeenCalledTimes(1);
    expect(
      document.getElementById("product-availability-disclosure"),
    ).toBeNull();

    const review = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Review product availability",
    );
    expect(review?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      review?.click();
      await import("../../components/settings/CapabilityAvailabilityCard");
      await Promise.resolve();
    });

    expect(review?.getAttribute("aria-expanded")).toBe("true");
    expect(
      document.getElementById("product-availability-disclosure"),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Current plan: Studio");
    expect(document.body.textContent).toContain(
      "a usage limit is never guessed to be an entitlement",
    );
    expect(document.body.textContent).toContain("Admin role");
    expect(document.body.textContent).toContain("Audit permission");

    const discountHistory = Array.from(
      document.querySelectorAll("button"),
    ).find((button) => button.textContent === "Discount history");
    act(() => discountHistory?.click());
    expect(mocks.setSection).toHaveBeenCalledWith("discounts");
  });
});
