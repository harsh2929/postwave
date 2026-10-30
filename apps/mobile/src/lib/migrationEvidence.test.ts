/**
 * PARITY (commerce-data) — migration verification evidence, field level.
 *
 * The property under test is that the server's own before/after values survive
 * the trip UNCHANGED. A diff whose inputs have been tidied proves nothing, so
 * the assertions below are deliberately hostile to helpfulness: untrimmed
 * names stay untrimmed, an unknown status word stays whatever it was, an
 * absent count stays null rather than becoming a zero, and a mapping with no
 * destination is described in words rather than drawn as an arrow to nothing.
 */
import { describe, expect, it } from "vitest";

import {
  evidenceIsEmpty,
  evidenceScopeCopy,
  fieldMappingLine,
  parseMigrationEvidence,
  resourceCountsLine,
  resourceShortfall,
} from "./migrationEvidence";

/** Shaped exactly like `canonical.VerificationReport` (types.go:444). */
const REPORT = {
  resource_completeness: [
    {
      resource: "subscribers",
      label: "Subscribers",
      source_total: 10450,
      imported: 10450,
      supported: true,
      status: "imported_runtime",
      notes: [],
    },
    {
      resource: "automations",
      label: "Automations",
      source_total: 12,
      imported: 9,
      supported: true,
      status: "manual_rebuild_required",
      notes: ["3 flows use a trigger with no Moosewave equivalent."],
    },
    {
      resource: "landing_pages",
      label: "Landing pages",
      source_total: 0,
      imported: 0,
      supported: false,
      status: "not_supported",
    },
  ],
  custom_fields_mapped: [
    { source: " Renewal Date ", canonical: "renewal_date", type: "date" },
    { source: "MMERGE7", canonical: "", type: "text" },
  ],
  custom_fields_unmapped: ["Legacy Score", "internal_notes"],
  segments_with_warnings: [
    { name: "VIP · 2024", warning: "nested OR group flattened" },
  ],
  automations_unsupported: [
    { name: "Win-back 90d", reason: "goal-based exit is not supported" },
  ],
  campaign_archive_warnings: [
    {
      resource: "campaigns",
      source_id: "c_88",
      name: "March newsletter",
      warning: "inline CSS was rewritten",
    },
  ],
  template_warnings: [{ resource: "templates", warning: "1 template had no HTML" }],
};

describe("parseMigrationEvidence", () => {
  it("carries every string across exactly as the server sent it", () => {
    const evidence = parseMigrationEvidence(REPORT)!;
    // Untrimmed on purpose: the spaces ARE the evidence.
    expect(evidence.fieldsMapped[0]).toEqual({
      source: " Renewal Date ",
      canonical: "renewal_date",
      type: "date",
    });
    expect(evidence.fieldsUnmapped).toEqual(["Legacy Score", "internal_notes"]);
    expect(evidence.segmentWarnings).toEqual([
      { name: "VIP · 2024", detail: "nested OR group flattened" },
    ]);
    expect(evidence.automationsUnsupported).toEqual([
      { name: "Win-back 90d", detail: "goal-based exit is not supported" },
    ]);
  });

  it("passes an unfamiliar status word through instead of folding it away", () => {
    const evidence = parseMigrationEvidence({
      resource_completeness: [
        {
          resource: "gizmos",
          label: "Gizmos",
          source_total: 4,
          imported: 4,
          status: "quarantined_by_a_future_build",
        },
      ],
    })!;
    expect(evidence.resources[0]?.status).toBe("quarantined_by_a_future_build");
    expect(evidence.resources[0]?.supported).toBeNull();
  });

  it("reads all three ResourceWarning arrays as one ordered list", () => {
    const evidence = parseMigrationEvidence(REPORT)!;
    expect(evidence.resourceWarnings).toEqual([
      {
        resource: "campaigns",
        name: "March newsletter",
        sourceId: "c_88",
        warning: "inline CSS was rewritten",
      },
      {
        resource: "templates",
        name: null,
        sourceId: null,
        warning: "1 template had no HTML",
      },
    ]);
  });

  it("keeps an absent count null and drops only rows with nothing to name", () => {
    const evidence = parseMigrationEvidence({
      resource_completeness: [
        { resource: "orders" },
        { label: "" },
        "not an object",
      ],
      custom_fields_mapped: [{ canonical: "x" }],
    })!;
    expect(evidence.resources).toHaveLength(1);
    expect(evidence.resources[0]).toEqual({
      resource: "orders",
      label: "orders",
      sourceTotal: null,
      imported: null,
      supported: null,
      status: null,
      notes: [],
    });
    // A mapping with no SOURCE names nothing and is not evidence of anything.
    expect(evidence.fieldsMapped).toEqual([]);
  });

  it("refuses a non-object body", () => {
    expect(parseMigrationEvidence(null)).toBeNull();
    expect(parseMigrationEvidence([REPORT])).toBeNull();
    expect(parseMigrationEvidence("report")).toBeNull();
  });
});

describe("evidenceIsEmpty", () => {
  it("is empty only when no list carries anything", () => {
    expect(evidenceIsEmpty(null)).toBe(true);
    expect(evidenceIsEmpty(parseMigrationEvidence({}))).toBe(true);
    expect(
      evidenceIsEmpty(parseMigrationEvidence({ custom_fields_unmapped: ["x"] })),
    ).toBe(false);
    expect(evidenceIsEmpty(parseMigrationEvidence(REPORT))).toBe(false);
  });
});

describe("resourceShortfall / resourceCountsLine", () => {
  const rows = parseMigrationEvidence(REPORT)!.resources;

  it("shows the two server numbers and the gap between them", () => {
    expect(resourceShortfall(rows[1]!)).toBe(3);
    expect(resourceCountsLine(rows[1]!)).toBe("9 of 12 · 3 short");
  });

  it("calls a matched pair no shortfall at all", () => {
    expect(resourceShortfall(rows[0]!)).toBeNull();
    expect(resourceCountsLine(rows[0]!)).toBe("10,450 of 10,450");
  });

  it("never reads an unexposed resource as a clean zero-of-zero", () => {
    expect(resourceCountsLine(rows[2]!)).toBe(
      "The provider did not expose this resource.",
    );
  });

  it("refuses to invent a shortfall from a half-reported row", () => {
    const [partial] = parseMigrationEvidence({
      resource_completeness: [
        { resource: "orders", imported: 5 },
        { resource: "carts", source_total: 5, imported: 9 },
      ],
    })!.resources;
    expect(resourceShortfall(partial!)).toBeNull();
    expect(resourceCountsLine(partial!)).toBe("5 of —");
    // An over-import is not a negative shortfall.
    expect(
      resourceCountsLine(
        parseMigrationEvidence({
          resource_completeness: [
            { resource: "carts", source_total: 5, imported: 9 },
          ],
        })!.resources[0]!,
      ),
    ).toBe("9 of 5");
  });
});

describe("fieldMappingLine", () => {
  it("draws the arrow with both names and the server's type", () => {
    const [mapped, orphan] = parseMigrationEvidence(REPORT)!.fieldsMapped;
    expect(fieldMappingLine(mapped!)).toBe(" Renewal Date  → renewal_date (date)");
    // An empty `canonical` must not render as an arrow to nothing.
    expect(fieldMappingLine(orphan!)).toBe(
      "MMERGE7 reported with no destination field (text)",
    );
  });
});

describe("evidenceScopeCopy", () => {
  it("refuses to call a running job's numbers a final reconciliation", () => {
    expect(evidenceScopeCopy("running").badge).toBe("Provisional evidence");
    expect(evidenceScopeCopy("running").sentence).toContain("landed so far");
    expect(evidenceScopeCopy(undefined).badge).toBe("Provisional evidence");
  });

  it("marks a settled job final and still disclaims what it cannot attest to", () => {
    for (const status of ["completed", "committed", "rolled_back"]) {
      expect(evidenceScopeCopy(status).badge).toBe("Final server report");
    }
    expect(evidenceScopeCopy("completed").sentence).toContain(
      "never exposed",
    );
  });
});
