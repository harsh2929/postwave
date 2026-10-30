// SPDX-License-Identifier: AGPL-3.0-only
//
// Pins the canonical money/date formatters shared across billing, discounts,
// and affiliates so an ICU/Node bump can't silently regress one surface.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  estimatedNextCharge,
  formatCents,
  formatCount,
  formatLocaleDate,
} from "@/lib/format-currency";

describe("formatCents", () => {
  it("renders USD by default and rounds at the cent boundary", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(99)).toBe("$0.99");
    expect(formatCents(1234)).toBe("$12.34");
    expect(formatCents(100)).toBe("$1.00");
  });

  it("groups thousands", () => {
    expect(formatCents(1_234_567)).toBe("$12,345.67");
  });

  it("respects a currency override without asserting the glyph", () => {
    const eur = formatCents(1234, "EUR");
    expect(eur).not.toBe("$12.34");
    expect(eur).toMatch(/12[.,]34/);
  });

  it("treats a non-finite amount as zero rather than throwing", () => {
    expect(formatCents(Number.NaN)).toBe("$0.00");
  });
});

describe("formatCount", () => {
  it("adds grouping separators", () => {
    expect(formatCount(31420)).toBe("31,420");
    expect(formatCount(0)).toBe("0");
  });
});

describe("formatLocaleDate", () => {
  it("renders a localized short date", () => {
    // Pin the parts, not the exact separators (ICU spacing varies).
    const out = formatLocaleDate("2026-04-08T00:00:00Z");
    expect(out).toMatch(/2026/);
    expect(out).not.toBe("2026-04-08T00:00:00Z");
  });

  it("returns a dash for empty and the raw value for a bad date", () => {
    expect(formatLocaleDate("")).toBe("—");
    expect(formatLocaleDate(null)).toBe("—");
    expect(formatLocaleDate("not-a-date")).toBe("not-a-date");
  });
});

describe("estimatedNextCharge", () => {
  it("returns the catalog price only for monthly tiers", () => {
    expect(
      estimatedNextCharge({ cadence: "monthly", price: "$29" }),
    ).toBe("$29");
    expect(
      estimatedNextCharge({ cadence: "lifetime", price: "$349" }),
    ).toBeNull();
    expect(estimatedNextCharge({ cadence: "free", price: "$0" })).toBeNull();
  });
});

// WEB-RENDER-09: these helpers run once or twice per rendered table row, so a
// per-call `new Intl.*Format(...)` is the dominant cost of painting a 50-row
// list. Count real constructor invocations (not a shape assertion) so a
// regression back to inline construction fails here.
describe("Intl formatter reuse", () => {
  const RealNumberFormat = Intl.NumberFormat;
  const RealDateTimeFormat = Intl.DateTimeFormat;

  afterEach(() => {
    Object.defineProperty(Intl, "NumberFormat", {
      value: RealNumberFormat,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Intl, "DateTimeFormat", {
      value: RealDateTimeFormat,
      configurable: true,
      writable: true,
    });
    vi.resetModules();
  });

  it("builds one formatter per option set no matter how many rows render", async () => {
    let numberCtors = 0;
    let dateCtors = 0;
    class CountingNumberFormat extends RealNumberFormat {
      constructor(...args: ConstructorParameters<typeof Intl.NumberFormat>) {
        numberCtors += 1;
        super(...args);
      }
    }
    class CountingDateTimeFormat extends RealDateTimeFormat {
      constructor(...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        dateCtors += 1;
        super(...args);
      }
    }
    Object.defineProperty(Intl, "NumberFormat", {
      value: CountingNumberFormat,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(Intl, "DateTimeFormat", {
      value: CountingDateTimeFormat,
      configurable: true,
      writable: true,
    });

    vi.resetModules();
    const mod = await import("@/lib/format-currency");

    for (let row = 0; row < 50; row += 1) {
      mod.formatCents(1234 + row);
      mod.formatCents(999 + row, "EUR");
      mod.formatCount(31_420 + row);
      mod.formatLocaleDate("2026-04-08T00:00:00Z");
    }

    // USD + EUR + the bare grouping formatter.
    expect(numberCtors).toBe(3);
    expect(dateCtors).toBe(1);
    // Values must be unchanged by the memoization.
    expect(mod.formatCents(1234)).toBe("$12.34");
    expect(mod.formatCount(31_420)).toBe("31,420");
  });
});
