// @vitest-environment happy-dom

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
  getHoldoutLift: vi.fn(),
}));

vi.mock("../../lib/holdout-lift", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../lib/holdout-lift")>();
  return { ...original, getHoldoutLift: mocks.getHoldoutLift };
});

import { HoldoutLiftPanel } from "../../components/campaigns/CampaignMeasurementPanels";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.getHoldoutLift.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("HoldoutLiftPanel", () => {
  it("stays silent only when the campaign has no holdout", async () => {
    mocks.getHoldoutLift.mockResolvedValue({
      error: { message: "not found", status: 404 },
    });

    await render(<HoldoutLiftPanel campaignId="campaign-without-holdout" />);

    expect(document.body.textContent).not.toContain("Incremental lift");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("fails loudly for a server error without presenting it as zero lift", async () => {
    mocks.getHoldoutLift.mockResolvedValue({
      error: { message: "service unavailable", status: 503 },
    });

    await render(<HoldoutLiftPanel campaignId="campaign-with-holdout" />);

    expect(document.body.textContent).toContain("Incremental lift");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "This is not a result of zero",
    );
  });

  it("fails loudly when the request rejects", async () => {
    mocks.getHoldoutLift.mockRejectedValue(new Error("offline"));

    await render(<HoldoutLiftPanel campaignId="campaign-with-holdout" />);

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be loaded",
    );
  });
});

async function render(node: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
