/**
 * Diagnostics cards' pure logic (#42 placement report, #43 auth-checks
 * matrix, #44 diagnostician):
 *
 *   1. placementRows / providerPlacementTable — canonical placement
 *      ordering, fraction→pct clamping, and the "never drop an unknown
 *      wire key" guarantee;
 *   2. auth-matrix helpers — status badges never paint unknown values
 *      green; the domain rollup takes the WORST of the five checks;
 *   3. diagnosis helpers — markdown section splitting (calibrated
 *      prompts emit `## ` headings, the stub prompt emits one
 *      sentence), impact formatting, and fix ranking.
 */

import { describe, expect, it } from "vitest";

import {
  placementPct,
  placementRows,
  providerPlacementTable,
} from "../../components/deliverability/placement-report-helpers";
import {
  AUTH_CHECK_KEYS,
  authStatusBadgeClass,
  authStatusLabel,
  domainWorstStatus,
  parseAuthCheckMatrix,
} from "../../components/deliverability/auth-matrix-helpers";
import {
  fixActionLabel,
  formatImpact,
  predictedImpactRows,
  sortFixesByImpact,
  splitDiagnosisSections,
} from "../../components/deliverability/diagnosis-helpers";
import type { AuthCheckMatrixRow, DiagnosisFix } from "../../lib/api-client";

describe("placementPct — fraction → clamped percent", () => {
  it("converts and rounds to one decimal", () => {
    expect(placementPct(0.4789)).toBe(47.9);
    expect(placementPct(1)).toBe(100);
    expect(placementPct(0)).toBe(0);
  });

  it("clamps out-of-range and treats null/NaN as 0", () => {
    expect(placementPct(1.5)).toBe(100);
    expect(placementPct(-0.1)).toBe(0);
    expect(placementPct(null)).toBe(0);
    expect(placementPct(Number.NaN)).toBe(0);
  });
});

describe("placementRows — canonical order, no fabricated rows", () => {
  it("orders known placements primary-first and skips absent keys", () => {
    const rows = placementRows({ spam: 0.1, primary: 0.8, missing: 0.1 });
    expect(rows.map((r) => r.code)).toEqual(["primary", "spam", "missing"]);
    expect(rows[0]).toEqual({ code: "primary", label: "Primary", pct: 80 });
  });

  it("keeps unknown wire keys (sorted) instead of dropping them", () => {
    const rows = placementRows({ primary: 0.5, zz_new: 0.3, aa_new: 0.2 });
    expect(rows.map((r) => r.code)).toEqual(["primary", "aa_new", "zz_new"]);
    // Unknown codes label as themselves — visible, not prettified away.
    expect(rows[1]?.label).toBe("aa_new");
  });

  it("returns [] for missing maps", () => {
    expect(placementRows(null)).toEqual([]);
    expect(placementRows(undefined)).toEqual([]);
  });
});

describe("providerPlacementTable — aligned columns across providers", () => {
  it("builds the column union in canonical order and zero-fills gaps", () => {
    const { columns, rows } = providerPlacementTable({
      providers: [
        { provider: "gmail", total: 5, placements: { primary: 4, spam: 1 } },
        { provider: "yahoo", total: 3, placements: { promotions: 3 } },
      ],
    });
    expect(columns).toEqual(["primary", "promotions", "spam"]);
    expect(rows[0]?.cells.map((c) => c.count)).toEqual([4, 0, 1]);
    expect(rows[1]?.cells.map((c) => c.count)).toEqual([0, 3, 0]);
  });

  it("handles an empty providers array", () => {
    const t = providerPlacementTable({ providers: [] });
    expect(t.columns).toEqual([]);
    expect(t.rows).toEqual([]);
  });
});

function authRow(
  statuses: Partial<Record<(typeof AUTH_CHECK_KEYS)[number], string>>,
): AuthCheckMatrixRow {
  const cell = (k: (typeof AUTH_CHECK_KEYS)[number]) => ({
    status: statuses[k] ?? "ok",
    detail: `${k} detail`,
  });
  return {
    domain: "example.com",
    spf: cell("spf"),
    dkim: cell("dkim"),
    dmarc: cell("dmarc"),
    bimi: cell("bimi"),
    ptr: cell("ptr"),
  };
}

describe("auth-matrix helpers", () => {
  it("rejects a malformed successful response before rendering", () => {
    const row = authRow({});
    expect(parseAuthCheckMatrix([row])).toEqual([row]);
    expect(parseAuthCheckMatrix({})).toBeNull();
    expect(parseAuthCheckMatrix([{ ...row, dmarc: undefined }])).toBeNull();
  });

  it("maps ok/warn/fail to badges; unknown stays neutral", () => {
    expect(authStatusBadgeClass("ok")).toBe("badge success");
    expect(authStatusBadgeClass("warn")).toBe("badge warning");
    expect(authStatusBadgeClass("fail")).toBe("badge danger");
    expect(authStatusBadgeClass("mystery")).toBe("badge");
    expect(authStatusLabel("ok")).toBe("Pass");
    expect(authStatusLabel("")).toBe("—");
  });

  it("domain rollup is the worst of the five checks", () => {
    expect(domainWorstStatus(authRow({}))).toBe("ok");
    expect(domainWorstStatus(authRow({ bimi: "warn" }))).toBe("warn");
    expect(
      domainWorstStatus(authRow({ bimi: "warn", dmarc: "fail" })),
    ).toBe("fail");
  });

  it("unknown statuses are more alarming than ok, less than warn", () => {
    expect(domainWorstStatus(authRow({ ptr: "??" }))).toBe("unknown");
    expect(domainWorstStatus(authRow({ ptr: "??", spf: "warn" }))).toBe(
      "warn",
    );
  });
});

describe("splitDiagnosisSections", () => {
  it("splits on ## headings with a heading-less preamble", () => {
    const md = [
      "Overall the campaign is landing in Promotions.",
      "## Placement analysis",
      "Gmail seeds: 60% promotions.",
      "### Reputation assessment",
      "Domain reputation is medium.",
    ].join("\n");
    const s = splitDiagnosisSections(md);
    expect(s).toHaveLength(3);
    expect(s[0]).toEqual({
      heading: "",
      body: "Overall the campaign is landing in Promotions.",
    });
    expect(s[1]?.heading).toBe("Placement analysis");
    expect(s[2]?.heading).toBe("Reputation assessment");
  });

  it("a heading-free stub diagnosis yields one section", () => {
    const s = splitDiagnosisSections("SPF is failing; add the record.");
    expect(s).toEqual([
      { heading: "", body: "SPF is failing; add the record." },
    ]);
  });

  it("blank input yields no sections (card renders honest empty copy)", () => {
    expect(splitDiagnosisSections("")).toEqual([]);
    expect(splitDiagnosisSections("   \n  ")).toEqual([]);
  });

  it("keeps a heading even when its body is empty", () => {
    const s = splitDiagnosisSections("## Recommendations");
    expect(s).toEqual([{ heading: "Recommendations", body: "" }]);
  });
});

describe("diagnosis fixes + impact", () => {
  const fixes: DiagnosisFix[] = [
    { title: "small", detail: "", action: "copy_change", estimated_impact: 0.02 },
    { title: "big", detail: "", action: "dns_record", estimated_impact: 0.15 },
  ];

  it("sortFixesByImpact ranks the biggest win first, purely", () => {
    const out = sortFixesByImpact(fixes);
    expect(out.map((f) => f.title)).toEqual(["big", "small"]);
    expect(fixes[0]?.title).toBe("small"); // input untouched
  });

  it("formatImpact renders +N% and refuses to promise on 0/invalid", () => {
    expect(formatImpact(0.15)).toBe("+15%");
    expect(formatImpact(0.024)).toBe("+2.4%");
    expect(formatImpact(0)).toBe("—");
    expect(formatImpact(null)).toBe("—");
    expect(formatImpact(Number.NaN)).toBe("—");
  });

  it("fixActionLabel humanizes known actions, passes unknowns through", () => {
    expect(fixActionLabel("dns_record")).toBe("DNS record");
    expect(fixActionLabel("brand_new_action")).toBe("brand_new_action");
  });

  it("predictedImpactRows orders desc and humanizes keys", () => {
    const rows = predictedImpactRows({ spam_rate: 0.02, inbox_rate: 0.1 });
    expect(rows.map((r) => r.key)).toEqual(["inbox_rate", "spam_rate"]);
    expect(rows[0]?.label).toBe("inbox rate");
    expect(rows[0]?.value).toBe("+10%");
    expect(predictedImpactRows(null)).toEqual([]);
  });
});
