// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// commerce-30 — discount-record filter chips (all / within stored rules /
// closed / expired / cap reached / data issues), clickable summary cells,
// Reset, and the "Review data issues" banner. discount-cards.tsx is another
// session's WIP, so a minimal host drives the component and renders the rows
// the chosen filter keeps — the assertion is which records the operator
// would see, not that a chip exists.
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DiscountRecordFilters,
  discountRecordMatchesFilter,
  type DiscountRecordFilter,
} from "@/components/discounts/DiscountRecordFilters";
import type { DiscountHistoryRecord } from "@/lib/discounts-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-09-12T12:00:00Z");

function record(
  label: string,
  overrides: Partial<DiscountHistoryRecord> = {},
): DiscountHistoryRecord {
  return {
    id: label,
    label,
    percent_off: 10,
    amount_off_cents: null,
    currency: "USD",
    max_redemptions: null,
    times_redeemed: 1,
    expires_at: null,
    applies_to: "first_payment",
    created_at: "2026-01-01T00:00:00Z",
    issues: [],
    ...overrides,
  };
}

const RECORDS = [
  record("OPEN", { times_redeemed: 2 }),
  record("EXPIRED", { expires_at: "2026-09-01T00:00:00Z", times_redeemed: 3 }),
  record("CAPPED", { max_redemptions: 5, times_redeemed: 5 }),
  record("BROKEN", { issues: ["count_exceeds_cap"], times_redeemed: 4 }),
];

function Host({
  onClearSearch,
  initialSearch = "",
}: {
  onClearSearch?: () => void;
  initialSearch?: string;
}) {
  const [filter, setFilter] = useState<DiscountRecordFilter>("all");
  const [search, setSearch] = useState(initialSearch);
  const visible = RECORDS.filter((row) =>
    discountRecordMatchesFilter(row, filter, NOW),
  );
  return (
    <>
      <DiscountRecordFilters
        records={RECORDS}
        filter={filter}
        onFilterChange={setFilter}
        search={search}
        onClearSearch={() => {
          setSearch("");
          onClearSearch?.();
        }}
        now={NOW}
      />
      <ul aria-label="Visible records">
        {visible.map((row) => (
          <li key={row.id}>{row.label}</li>
        ))}
      </ul>
    </>
  );
}

let root: Root | null = null;

function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  return container;
}

function visible(scope: ParentNode): string[] {
  return [...scope.querySelectorAll('ul[aria-label="Visible records"] li')].map(
    (node) => node.textContent ?? "",
  );
}

function chip(scope: ParentNode, label: string): HTMLButtonElement {
  const node = [
    ...scope.querySelectorAll<HTMLButtonElement>("fieldset button"),
  ].find((candidate) => candidate.textContent?.startsWith(label));
  if (!node) throw new Error(`missing chip ${label}`);
  return node;
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const node = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label")?.startsWith(label),
  );
  if (!node) throw new Error(`missing button ${label}`);
  return node;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("DiscountRecordFilters", () => {
  it("counts every stored-rule state on the page", () => {
    const scope = render(<Host />);
    expect(chip(scope, "All records").textContent).toBe("All records4");
    expect(chip(scope, "Within stored rules").textContent).toBe(
      "Within stored rules1",
    );
    expect(chip(scope, "Closed by stored rules").textContent).toBe(
      "Closed by stored rules2",
    );
    expect(chip(scope, "Expired").textContent).toBe("Expired1");
    expect(chip(scope, "Cap reached").textContent).toBe("Cap reached1");
    expect(chip(scope, "Data issues").textContent).toBe("Data issues1");
    // Recorded uses: 2 + 3 + 5 + 4.
    expect(scope.textContent).toContain("Recorded uses14");
  });

  it("keeps only the records each chip names", () => {
    const scope = render(<Host />);
    expect(visible(scope)).toEqual(["OPEN", "EXPIRED", "CAPPED", "BROKEN"]);

    act(() => chip(scope, "Expired").click());
    expect(chip(scope, "Expired").getAttribute("aria-pressed")).toBe("true");
    expect(visible(scope)).toEqual(["EXPIRED"]);

    act(() => chip(scope, "Cap reached").click());
    expect(visible(scope)).toEqual(["CAPPED"]);

    act(() => chip(scope, "Closed by stored rules").click());
    expect(visible(scope)).toEqual(["EXPIRED", "CAPPED"]);

    act(() => chip(scope, "Within stored rules").click());
    expect(visible(scope)).toEqual(["OPEN"]);
  });

  it("filters from the summary cells", () => {
    const scope = render(<Host />);
    act(() => button(scope, "Stored-rule closures: 2").click());
    expect(visible(scope)).toEqual(["EXPIRED", "CAPPED"]);
    act(() => button(scope, "Records on page: 4").click());
    expect(visible(scope)).toHaveLength(4);
  });

  it("routes the integrity banner to the data-issue records", () => {
    const scope = render(<Host />);
    expect(scope.textContent).toContain(
      "1 record on this page has field integrity warnings.",
    );
    act(() => button(scope, "Review data issues").click());
    expect(visible(scope)).toEqual(["BROKEN"]);
    expect(() => button(scope, "Review data issues")).toThrow();
  });

  it("Reset clears both the page search and the state filter", () => {
    const onClearSearch = vi.fn();
    const scope = render(
      <Host initialSearch="exp" onClearSearch={onClearSearch} />,
    );
    act(() => chip(scope, "Expired").click());
    act(() => button(scope, "Reset").click());
    expect(onClearSearch).toHaveBeenCalledTimes(1);
    expect(visible(scope)).toHaveLength(4);
    expect(chip(scope, "All records").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(() => button(scope, "Reset")).toThrow();
  });
});
