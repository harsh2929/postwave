// @vitest-environment happy-dom

import { act, createRef, type ReactElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { RetentionOfferDetail } from "../../components/retention/RetentionOfferDetail";
import type { RetentionOfferHistoryRow } from "../../lib/retention-offers-contract";

const OFFER_ID = "20000000-0000-4000-8000-000000000001";
const TIER_ID = "30000000-0000-4000-8000-000000000001";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

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
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

function row(
  overrides: Partial<RetentionOfferHistoryRow> = {},
): RetentionOfferHistoryRow {
  return {
    offer: {
      id: OFFER_ID,
      tierId: TIER_ID,
      discount: { kind: "fixed", minorUnits: 1250, currency: null },
      durationMonths: 2,
      headline: "Keep your member rate",
      body: "First paragraph.\n\nSecond paragraph with averylongwordthatmustwrapsafely.",
      providerCouponPresent: true,
      active: true,
      createdAt: "2026-07-01T09:00:00.000Z",
      updatedAt: "2026-07-02T10:30:00.000Z",
    },
    tierName: "Founders",
    funnel: {
      offerId: OFFER_ID,
      tierId: TIER_ID,
      shown: 12,
      accepted: 3,
      declined: 6,
      expired: 1,
    },
    funnelState: "matched",
    ...overrides,
  };
}

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next) {
      act(() => root?.render(next));
    },
  };
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

describe("Retention offer detail", () => {
  it("renders complete bounded evidence without inventing currency or delivery", () => {
    const returnFocusRef = createRef<HTMLElement>();
    render(
      <RetentionOfferDetail
        row={row()}
        open
        onClose={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const text = document.body.textContent ?? "";
    expect(text).toContain("Keep your member rate");
    expect(text).toContain("Founders");
    expect(text).toContain(OFFER_ID);
    expect(text).toContain(TIER_ID);
    expect(text).toContain("1,250 minor units off");
    expect(text).toContain("Currency is absent from this record.");
    expect(text).not.toContain("$12.50");
    expect(text).toContain("2 months");
    expect(text).toContain("First paragraph.");
    expect(text).toContain("Second paragraph");
    expect(text).toContain("12");
    expect(text).toContain("3");
    expect(text).toContain("6");
    expect(text).toContain("1");
    expect(text).toContain("25.0%");
    expect(text).toContain("Not available from this API");
    expect(text).toContain(
      "This drawer never edits an offer or certifies provider delivery.",
    );
    expect(text).not.toMatch(/\b(?:Edit|Save|Activate|Delete|Apply)\b/u);
    expect(
      Array.from(document.querySelectorAll("button")).map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(["✕", "Close"]);
    for (const group of dialog?.querySelectorAll(".rhs-detail-grid > div") ??
      []) {
      expect(Array.from(group.children, (child) => child.tagName)).toEqual([
        "DT",
        "DD",
      ]);
    }
  });

  it("shows anomalous raw counters but withholds the derived rate", () => {
    const returnFocusRef = createRef<HTMLElement>();
    render(
      <RetentionOfferDetail
        row={row({
          funnel: {
            offerId: OFFER_ID,
            tierId: TIER_ID,
            shown: 2,
            accepted: 3,
            declined: 1,
            expired: 0,
          },
          funnelState: "outcome-excess",
        })}
        open
        onClose={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );

    const text = document.body.textContent ?? "";
    expect(text).toContain("Outcome-count conflict");
    expect(text).toContain("Withheld");
    expect(text).not.toContain("150.0%");
  });

  it("describes paired reconciliation as pending instead of calling the funnel unavailable", () => {
    const returnFocusRef = createRef<HTMLElement>();
    render(
      <RetentionOfferDetail
        row={row()}
        open
        reconciliationPending
        onClose={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );

    const text = document.body.textContent ?? "";
    expect(text).toContain("Reconciliation in progress");
    expect(text).toContain("Offer and funnel refreshes are being reconciled");
    expect(text).toContain(
      "Counts remain withheld until both critical reads verify together.",
    );
    expect(text).not.toContain("Funnel unavailable");
    expect(text).not.toContain("No reconciled funnel row");
    expect(text).not.toContain("25.0%");
  });

  it("labels a missing name as a verified catalogue gap when the catalogue loaded", () => {
    const returnFocusRef = createRef<HTMLElement>();
    render(
      <RetentionOfferDetail
        row={row({ tierName: null })}
        open
        tierCatalogueAvailable
        tierCatalogueStale={false}
        onClose={vi.fn()}
        returnFocusRef={returnFocusRef}
      />,
    );

    const text = document.body.textContent ?? "";
    expect(text).toContain("absent from verified catalogue");
    expect(text).toContain("Name absent from the verified catalogue");
    expect(text).not.toContain("Name unavailable");
  });

  it("closes with Escape and restores the exact opener", async () => {
    function Harness(): ReactElement {
      const [open, setOpen] = useState(false);
      const opener = useRef<HTMLButtonElement | null>(null);
      return (
        <>
          <button ref={opener} type="button" onClick={() => setOpen(true)}>
            Inspect offer
          </button>
          <RetentionOfferDetail
            row={row()}
            open={open}
            onClose={() => setOpen(false)}
            returnFocusRef={opener}
          />
        </>
      );
    }

    render(<Harness />);
    const opener = button("Inspect offer");
    act(() => opener.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
