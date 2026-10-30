// Tests for the pure form-variants logic behind the Variants panel
// (form_variants — camelCase on the wire; conversionRate is a 0..1
// fraction; trafficPct is a plain percentage).

import { describe, expect, it } from "vitest";

import {
  buildVariantInput,
  decisionWeightRows,
  fmtFraction,
  newVariantDraft,
  sampleContextLine,
  significanceLabel,
  toggledStatus,
  trafficSplitSummary,
  variantToDraft,
} from "../../components/forms/variants-helpers";
import type { FormVariant } from "../../lib/api-client";

const variant = (over: Partial<FormVariant> = {}): FormVariant => ({
  id: "v1",
  tenantId: "t1",
  formId: "f1",
  label: "Control",
  displayConfig: {},
  trafficPct: 50,
  status: "active",
  lastZScore: 0,
  impressions: 0,
  submissions: 0,
  conversionRate: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("fmtFraction", () => {
  it("renders 0..1 fractions as percentages", () => {
    expect(fmtFraction(0.125)).toBe("12.5%");
    expect(fmtFraction(0.5)).toBe("50%");
    expect(fmtFraction(0)).toBe("0%");
    expect(fmtFraction(1)).toBe("100%");
  });
  it("rounds to one decimal", () => {
    expect(fmtFraction(0.12345)).toBe("12.3%");
  });
  it("em-dash on missing / non-finite values", () => {
    expect(fmtFraction(undefined)).toBe("—");
    expect(fmtFraction(null)).toBe("—");
    expect(fmtFraction(Number.NaN)).toBe("—");
  });
});

describe("trafficSplitSummary", () => {
  it("flags a balanced 100% split", () => {
    const s = trafficSplitSummary([
      variant({ trafficPct: 60 }),
      variant({ trafficPct: 40 }),
    ]);
    expect(s).toEqual({ totalPct: 100, balanced: true, activeCount: 2 });
  });
  it("excludes paused variants from the live split", () => {
    const s = trafficSplitSummary([
      variant({ trafficPct: 60 }),
      variant({ trafficPct: 40, status: "paused" }),
    ]);
    expect(s.totalPct).toBe(60);
    expect(s.balanced).toBe(false);
    expect(s.activeCount).toBe(1);
  });
  it("counts promoted variants as live", () => {
    const s = trafficSplitSummary([variant({ trafficPct: 100, status: "promoted" })]);
    expect(s.balanced).toBe(true);
  });
  it("empty list totals zero", () => {
    expect(trafficSplitSummary([])).toEqual({
      totalPct: 0,
      balanced: false,
      activeCount: 0,
    });
  });
});

describe("significanceLabel", () => {
  it("maps |z| to confidence tiers", () => {
    expect(significanceLabel(2.6)).toEqual({ label: "99% confidence", significant: true });
    expect(significanceLabel(-2.0)).toEqual({ label: "95% confidence", significant: true });
    expect(significanceLabel(1.7).label).toBe("90% confidence");
    expect(significanceLabel(1.7).significant).toBe(false);
    expect(significanceLabel(0.5)).toEqual({
      label: "not significant yet",
      significant: false,
    });
  });
  it("treats zero / missing as no data", () => {
    expect(significanceLabel(0).label).toBe("no significance data");
    expect(significanceLabel(undefined).label).toBe("no significance data");
    expect(significanceLabel(Number.NaN).label).toBe("no significance data");
  });
});

describe("sampleContextLine", () => {
  it("combines impressions and visits when both exist", () => {
    const line = sampleContextLine(1200, [
      variant({ impressions: 300 }),
      variant({ impressions: 700 }),
    ]);
    expect(line).toBe(
      "1,000 variant impressions recorded · 1,200 hosted-page visits in 30d",
    );
  });
  it("renders visits alone when no impressions", () => {
    expect(sampleContextLine(50, [])).toBe("50 hosted-page visits in 30d");
  });
  it("null when there is nothing real to say", () => {
    expect(sampleContextLine(undefined, [])).toBeNull();
    expect(sampleContextLine(0, [variant({ impressions: 0 })])).toBeNull();
  });
});

describe("buildVariantInput", () => {
  it("builds create + patch bodies from a valid draft", () => {
    const r = buildVariantInput({
      id: null,
      label: " Shorter headline ",
      trafficPctText: "25",
      displayConfigText: '{"heading":"Hi"}',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.create).toEqual({
      label: "Shorter headline",
      displayConfig: { heading: "Hi" },
      trafficPct: 25,
    });
    expect(r.patch.trafficPct).toBe(25);
  });
  it("blank config saves an empty object; blank traffic omits the field", () => {
    const r = buildVariantInput({
      id: null,
      label: "A",
      trafficPctText: "",
      displayConfigText: "",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.create.displayConfig).toEqual({});
    expect("trafficPct" in r.create).toBe(false);
  });
  it("rejects missing label", () => {
    const r = buildVariantInput(newVariantDraft());
    expect(r).toMatchObject({ ok: false, field: "label" });
  });
  it("rejects out-of-range traffic", () => {
    for (const t of ["-5", "150", "abc"]) {
      const r = buildVariantInput({
        id: null,
        label: "A",
        trafficPctText: t,
        displayConfigText: "",
      });
      expect(r).toMatchObject({ ok: false, field: "trafficPct" });
    }
  });
  it("rejects non-object display config", () => {
    for (const cfg of ["[1,2]", '"str"', "{nope"]) {
      const r = buildVariantInput({
        id: null,
        label: "A",
        trafficPctText: "",
        displayConfigText: cfg,
      });
      expect(r).toMatchObject({ ok: false, field: "displayConfig" });
    }
  });
});

describe("variantToDraft", () => {
  it("round-trips a wire row into editable text", () => {
    const d = variantToDraft(
      variant({ id: "v9", trafficPct: 30, displayConfig: { heading: "x" } }),
    );
    expect(d.id).toBe("v9");
    expect(d.trafficPctText).toBe("30");
    expect(JSON.parse(d.displayConfigText)).toEqual({ heading: "x" });
  });
  it("empty config renders as blank text", () => {
    expect(variantToDraft(variant()).displayConfigText).toBe("");
  });
});

describe("toggledStatus", () => {
  it("toggles active↔paused only", () => {
    expect(toggledStatus("active")).toBe("paused");
    expect(toggledStatus("paused")).toBe("active");
    // promoted is server-assigned — never user-switchable.
    expect(toggledStatus("promoted")).toBeNull();
    expect(toggledStatus(undefined)).toBeNull();
  });
});

describe("decisionWeightRows", () => {
  it("sorts numeric weights descending and drops junk", () => {
    const rows = decisionWeightRows({
      a: 0.2,
      b: 0.7,
      c: Number.NaN,
    });
    expect(rows).toEqual([
      { id: "b", weight: 0.7 },
      { id: "a", weight: 0.2 },
    ]);
  });
  it("empty on missing weights", () => {
    expect(decisionWeightRows(undefined)).toEqual([]);
  });
});
