// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  predictiveApi: { profile: mocks.profile },
}));

import { RFMProfileCard } from "../../components/subscribers/RFMProfileCard";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => Promise.resolve());
    }
  }
  throw lastError;
}

function profile() {
  return {
    data: {
      prediction: {
        email: "reader@example.com",
        historic_clv_cents: 987_654,
        predicted_clv_cents: 123_456,
        total_clv_cents: 1_111_110,
        churn_risk: 0.29,
        predicted_order_count: 3.2,
        average_days_between_orders: 41.5,
        expected_next_order_at: "2026-08-20T10:00:00Z",
        predicted_gender: "unknown",
        confidence: 0.82,
        data_sufficiency: "sufficient",
      },
      rfm: {
        email: "reader@example.com",
        recency_days: 12,
        frequency: 9,
        monetary_cents: 987_654,
        recency_score: 4,
        frequency_score: 3,
        monetary_score: 5,
        rfm_score: "435",
        segment_key: "champions",
      },
    },
  };
}

beforeEach(() => {
  mocks.profile.mockReset().mockResolvedValue(profile());
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("subscriber predictive profile currency safety", () => {
  it("keeps safe cadence signals and hides unproven monetary projections", async () => {
    render(<RFMProfileCard email=" Reader@Example.com " />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Observed purchase signals");
    });

    expect(mocks.profile).toHaveBeenCalledWith("reader@example.com", {
      signal: expect.any(AbortSignal),
    });
    expect(document.body.textContent).toContain(
      "Currency-safe value insights unavailable",
    );
    expect(document.body.textContent).toContain("R4");
    expect(document.body.textContent).toContain("F3");
    expect(document.body.textContent).toContain("9 orders");
    expect(document.body.textContent).toContain("29%");
    expect(document.body.textContent).toContain("3.2");
    expect(document.body.textContent).not.toContain("$9,876");
    expect(document.body.textContent).not.toContain("Historic CLV");
    expect(document.body.textContent).not.toContain("Predicted CLV");
    expect(document.body.textContent).not.toContain("champions");
    expect(document.body.textContent).not.toContain("435");
  });

  it("does not turn malformed predictive metrics into plausible values", async () => {
    const malformed = profile();
    malformed.data.prediction.churn_risk = 4;
    malformed.data.prediction.predicted_order_count = -3;
    malformed.data.prediction.confidence = Number.NaN;
    malformed.data.rfm.recency_score = 9;
    malformed.data.rfm.frequency = -8;
    mocks.profile.mockResolvedValueOnce(malformed);

    render(<RFMProfileCard email="reader@example.com" />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Observed purchase signals");
    });

    expect(document.body.textContent).toContain("Unavailable");
    expect(document.body.textContent).toContain("count unavailable");
    expect(document.body.textContent).not.toContain("400%");
    expect(document.body.textContent).not.toContain("R9");
    expect(document.body.textContent).not.toContain("-3");
  });

  it("aborts the profile request when the predictive tab unmounts", () => {
    let signal: AbortSignal | undefined;
    mocks.profile.mockImplementation(
      (_email: string, opts?: { signal?: AbortSignal }) => {
        signal = opts?.signal;
        return new Promise(() => undefined);
      },
    );

    render(<RFMProfileCard email="reader@example.com" />);
    expect(signal?.aborted).toBe(false);
    act(() => root?.unmount());
    root = null;
    expect(signal?.aborted).toBe(true);
  });
});
