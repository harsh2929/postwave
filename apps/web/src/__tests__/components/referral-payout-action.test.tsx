// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PayoutAction } from "@/app/(dashboard)/app/referrals/page-client";
import type { ReferralPayout } from "@/lib/referrals-api";

const apiMocks = vi.hoisted(() => ({
  updateReferralPayout: vi.fn(),
}));
const toastMocks = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("@/lib/referrals-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/referrals-api")>(
    "@/lib/referrals-api",
  );
  return { ...actual, updateReferralPayout: apiMocks.updateReferralPayout };
});

vi.mock("sonner", () => ({ toast: toastMocks }));

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  apiMocks.updateReferralPayout.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return root;
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const node = [...scope.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(node instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${label}`);
  }
  return node;
}

function payout(status: ReferralPayout["status"]): ReferralPayout {
  return {
    id: `reward-${status}`,
    referrer_id: "subscriber-1",
    milestone: 5,
    reward_label: "Launch reward",
    status,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
  };
}

describe("referral reward fulfillment confirmation", () => {
  it("renders a release hold and cannot invoke fulfillment", () => {
    const onChanged = vi.fn();
    const root = render(
      <PayoutAction row={payout("pending")} onChanged={onChanged} />,
    );

    try {
      expect(document.body.textContent).toContain("Review-gated");
      expect(() => button(document, "Approve")).toThrow(/Missing button/);
      expect(apiMocks.updateReferralPayout).not.toHaveBeenCalled();
      expect(onChanged).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
