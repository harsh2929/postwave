// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  getReferralProgram: vi.fn(),
  getSubscriberReferral: vi.fn(),
  listReferralPayouts: vi.fn(),
  updateReferralPayout: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getReferralProgram: mocks.getReferralProgram,
      getSubscriberReferral: mocks.getSubscriberReferral,
      listReferralPayouts: mocks.listReferralPayouts,
      updateReferralPayout: mocks.updateReferralPayout,
    },
  };
});

import { PayoutChecklist } from "../../components/referrals/PayoutChecklist";
import { ReferralProgressPanel } from "../../components/referrals/ReferralProgressPanel";
import {
  REFERRAL_ATTRIBUTION_RUNTIME_AVAILABLE,
  REFERRAL_PAYOUT_OPERATIONS_AVAILABLE,
  REFERRAL_PROGRAM_MUTATIONS_AVAILABLE,
  REFERRAL_PUBLIC_WIDGET_INSTALL_AVAILABLE,
  REFERRAL_SUBSCRIBER_LINKS_AVAILABLE,
} from "../../lib/referral-operational-availability";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

async function settleEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function expectNoLiveReferralControls(): void {
  expect(container?.querySelector("button")).toBeNull();
  expect(container?.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).not.toMatch(
    /copy url|share this newsletter|embed code|install widget/i,
  );
  expect(document.body.textContent).not.toContain("{{SUBSCRIBER_REF_CODE}}");
  expect(container?.querySelector('script[src*="/widget.js"]')).toBeNull();
}

function expectNoReferralRequests(): void {
  expect(mocks.getReferralProgram).not.toHaveBeenCalled();
  expect(mocks.getSubscriberReferral).not.toHaveBeenCalled();
  expect(mocks.listReferralPayouts).not.toHaveBeenCalled();
  expect(mocks.updateReferralPayout).not.toHaveBeenCalled();
}

describe("referral operational gates", () => {
  it("keeps every unqualified referral capability fail-closed", () => {
    expect({
      attributionRuntime: REFERRAL_ATTRIBUTION_RUNTIME_AVAILABLE,
      payoutOperations: REFERRAL_PAYOUT_OPERATIONS_AVAILABLE,
      programMutations: REFERRAL_PROGRAM_MUTATIONS_AVAILABLE,
      publicWidgetInstall: REFERRAL_PUBLIC_WIDGET_INSTALL_AVAILABLE,
      subscriberLinks: REFERRAL_SUBSCRIBER_LINKS_AVAILABLE,
    }).toEqual({
      attributionRuntime: false,
      payoutOperations: false,
      programMutations: false,
      publicWidgetInstall: false,
      subscriberLinks: false,
    });
  });

  it.each([
    ["admin", true],
    ["viewer", false],
  ] as const)(
    "contains the reward surface and all payout requests for the %s role",
    async (_role, canMutate) => {
      render(<PayoutChecklist canMutate={canMutate} />);
      await settleEffects();

      const surface = container?.querySelector(
        '[data-testid="referral-payout-checklist"]',
      );
      expect(surface?.textContent).toContain("Reward fulfillment");
      expect(surface?.textContent).toContain(
        "The reward queue is review-gated",
      );
      expect(surface?.querySelector('[role="status"]')).not.toBeNull();
      expectNoLiveReferralControls();
      expectNoReferralRequests();
    },
  );

  it("contains subscriber-link reads before any token can be minted", async () => {
    render(<ReferralProgressPanel subscriberId="subscriber-7" />);
    await settleEffects();

    const surface = container?.querySelector("[data-referral-links-gated]");
    expect(surface?.textContent).toContain("Referral progress");
    expect(surface?.textContent).toContain(
      "Subscriber referral links are review-gated",
    );
    expect(surface?.querySelector('[role="note"]')).not.toBeNull();
    expectNoLiveReferralControls();
    expectNoReferralRequests();
  });

  it("keeps the combined gated surfaces free of serious accessibility findings", async () => {
    render(
      <main aria-label="Referral operations availability">
        <PayoutChecklist canMutate />
        <ReferralProgressPanel subscriberId="subscriber-8" />
      </main>,
    );
    await settleEffects();

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
    expectNoLiveReferralControls();
    expectNoReferralRequests();
  });
});
