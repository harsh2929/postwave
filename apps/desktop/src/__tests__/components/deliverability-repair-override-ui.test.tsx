// @vitest-environment happy-dom

import { act } from "react";
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
  repairOverride: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../../lib/store", () => ({ useCanAdmin: () => true }));

vi.mock("../../lib/api-client", () => ({
  deliverabilityHubApi: { repairOverride: mocks.repairOverride },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    success: mocks.success,
    error: mocks.error,
    info: mocks.info,
  },
}));

vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: ({
    open,
    onConfirm,
  }: {
    open: boolean;
    onConfirm: () => void | Promise<void>;
  }) =>
    open ? (
      <button type="button" onClick={() => void onConfirm()}>
        Confirm cap restoration
      </button>
    ) : null,
}));

import { ScoreCard } from "../../components/deliverability/ScoreCard";
import type { DeliverabilityHubSummary } from "../../lib/api-client";

const SUMMARY: DeliverabilityHubSummary = {
  tenant_id: "00000000-0000-4000-8000-000000000001",
  score: 42,
  grade: "D",
  status: "Repair active",
  trend: "down",
  trend_delta: -8,
  history: [62, 50, 42],
  bounce_rate: 0.03,
  complaint_rate: 0.002,
  engagement_rate: 0.05,
  opens_machine_pct: 0.1,
  event_rate_scope: "campaigns",
  model_version: "campaign-cohort-v2-2026-08-02",
  sample_qualified: true,
  minimum_sample_sends: 1_000,
  window_days: 30,
  breaches: [],
  auto_throttled: true,
  auto_throttle_reason: "auto: reputation_repair score=42",
  totals: { sends_7d: 1_500, sends_30d: 4_000 },
  computed_at: "2026-08-31T00:00:00Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of [
    mocks.repairOverride,
    mocks.success,
    mocks.error,
    mocks.info,
  ]) {
    mock.mockReset();
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container = null;
  document.body.replaceChildren();
});

function render(summary: DeliverabilityHubSummary, onRepaired = vi.fn()): void {
  act(() => {
    root?.render(
      <ScoreCard summary={summary} loading={false} onRepaired={onRepaired} />,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

async function confirmRestoration(): Promise<void> {
  act(() => button("Review cap restoration").click());
  await act(async () => {
    button("Confirm cap restoration").click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("deliverability repair-override lifecycle", () => {
  it("reports a committed fence truthfully and blocks replay until a fresh summary", async () => {
    const onRepaired = vi.fn();
    mocks.repairOverride.mockResolvedValue({
      error: {
        kind: "http",
        status: 503,
        code: "sending_cap_convergence_pending",
        message: "Server error.",
        details: {
          ok: true,
          cleared: true,
          cap_coordination_outcome: "committed-conservatively-fenced",
        },
      },
      responseMetadata: {
        status: 503,
        sendingCapOutcome: "committed-conservatively-fenced",
      },
    });
    render(SUMMARY, onRepaired);

    await confirmRestoration();

    expect(mocks.repairOverride).toHaveBeenCalledTimes(1);
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Repair override cleared; sending remains safely fenced",
      }),
    );
    expect(onRepaired).toHaveBeenCalledTimes(1);
    const refreshing = button("Refreshing recorded state");
    expect(refreshing.disabled).toBe(false);
    expect(refreshing.getAttribute("aria-disabled")).toBe("true");
    act(() => refreshing.click());
    expect(mocks.repairOverride).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Waiting for a fresh authoritative summary",
    );

    render({ ...SUMMARY }, onRepaired);
    expect(button("Review cap restoration").disabled).toBe(false);
  });

  it("holds an unknown outcome without presenting it as a success", async () => {
    const onRepaired = vi.fn();
    mocks.repairOverride.mockResolvedValue({
      error: {
        kind: "http",
        status: 503,
        code: "sending_cap_commit_outcome_unknown",
        message: "Server error.",
        details: {
          ok: false,
          cleared: false,
          cap_coordination_outcome:
            "commit-outcome-unknown-conservatively-fenced",
        },
      },
      responseMetadata: {
        status: 503,
        sendingCapOutcome: "commit-outcome-unknown-conservatively-fenced",
      },
    });
    render(SUMMARY, onRepaired);

    await confirmRestoration();

    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Cap restoration outcome needs verification",
      }),
    );
    expect(onRepaired).toHaveBeenCalledTimes(1);
    const verificationRequired = button("Verification required");
    expect(verificationRequired.disabled).toBe(false);
    expect(verificationRequired.getAttribute("aria-disabled")).toBe("true");
    act(() => verificationRequired.click());
    expect(mocks.repairOverride).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Do not repeat this action until a fresh authoritative summary arrives",
    );
  });

  it("holds a generic 503 for a GET reconciliation instead of exposing replay", async () => {
    const onRepaired = vi.fn();
    mocks.repairOverride.mockResolvedValue({
      error: { kind: "http", status: 503, message: "Server error." },
    });
    render(SUMMARY, onRepaired);

    await confirmRestoration();

    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Cap restoration outcome needs verification",
      }),
    );
    expect(onRepaired).toHaveBeenCalledTimes(1);
    const verificationRequired = button("Verification required");
    expect(verificationRequired.disabled).toBe(false);
    expect(verificationRequired.getAttribute("aria-disabled")).toBe("true");
    act(() => verificationRequired.click());
    expect(mocks.repairOverride).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Do not repeat this action until a fresh authoritative summary arrives",
    );
  });
});
