// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ContactPerformanceCard } from "../../components/subscribers/ContactPerformanceCard";
import type { SubscriberEngagementResult } from "../../lib/api-client";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function performance(
  counts: Partial<SubscriberEngagementResult["counts"]> = {},
): SubscriberEngagementResult {
  return {
    subscriber_id: "subscriber-1",
    email: "reader@example.com",
    score: 72,
    counts: {
      sends: 12,
      opens: 7,
      clicks: 3,
      replies: 2,
      revenue_cents: 12_345,
      revenue_cents_saturated: false,
      revenue_currency: "USD",
      revenue_by_currency: [
        {
          currency: "USD",
          conversions: 3,
          revenue_cents: 12_345,
          revenue_cents_saturated: false,
        },
      ],
      mixed_currency: false,
      unclassified_monetary_conversions: 0,
      ...counts,
    },
    window_days: 90,
    computed_at: "2026-07-19T10:00:00Z",
    opens_30d: 4,
    clicks_30d: 1,
  };
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("subscriber contact performance", () => {
  it("labels the dominant currency and discloses the complete mixed breakdown", () => {
    render(
      <ContactPerformanceCard
        performance={performance({
          revenue_by_currency: [
            {
              currency: "USD",
              conversions: 3,
              revenue_cents: 12_345,
              revenue_cents_saturated: false,
            },
            {
              currency: "EUR",
              conversions: 2,
              revenue_cents: 6_789,
              revenue_cents_saturated: false,
            },
          ],
          mixed_currency: true,
          unclassified_monetary_conversions: 2,
        })}
      />,
    );

    expect(document.body.textContent).toContain("Successful sends");
    expect(document.body.textContent).toContain("Replies");
    expect(document.body.textContent).toContain("Leading revenue");
    expect(document.body.textContent).toContain("USD");
    expect(document.body.textContent).toContain("Mixed");
    expect(document.body.textContent).toContain("Revenue by currency");
    expect(document.body.textContent).toContain("EUR");
    expect(document.body.textContent).toContain(
      "2 amount-bearing conversions were missing a recognized currency",
    );
  });

  it("hides a legacy amount whose currency is unknown", () => {
    render(
      <ContactPerformanceCard
        performance={performance({
          revenue_cents: 98_765_432,
          revenue_cents_saturated: undefined,
          revenue_currency: undefined,
          revenue_by_currency: undefined,
          mixed_currency: undefined,
          unclassified_monetary_conversions: undefined,
        })}
      />,
    );

    expect(document.body.textContent).toContain("Currency unavailable");
    expect(document.body.textContent).toContain(
      "hidden rather than being labelled as an assumed currency",
    );
    expect(document.body.textContent).not.toContain("987,654");
    expect(document.body.textContent).not.toContain("USD");
  });

  it("refuses rounded money and implausible counts outside desktop precision", () => {
    render(
      <ContactPerformanceCard
        performance={performance({
          sends: Number.MAX_SAFE_INTEGER + 1,
          revenue_cents: Number.MAX_SAFE_INTEGER + 1,
          revenue_cents_saturated: true,
          revenue_by_currency: [
            {
              currency: "USD",
              conversions: 1,
              revenue_cents: Number.MAX_SAFE_INTEGER + 1,
              revenue_cents_saturated: true,
            },
          ],
        })}
      />,
    );

    expect(document.body.textContent).toContain("Unavailable");
    expect(document.body.textContent).toContain("Exceeds display range");
    expect(document.body.textContent).toContain("No rounded total is shown");
    expect(document.body.textContent).not.toContain("9,007,199,254,740,992");
  });
});
