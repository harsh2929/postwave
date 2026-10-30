import { describe, expect, it } from "vitest";

import { migrationAuditEventLabel } from "@/lib/migration-audit";
import {
  buildAuditLogCsv,
  buildVerificationReportCsv,
} from "@/lib/migration-verification-export";
import {
  detectEmailColumn,
  extractHeaderLine,
  parseCsvHeaderRow,
  validateCsvColumns,
} from "@/lib/migration-csv-mapping";
import { migrationDocsHref, hasMigrationDocsGuide } from "@/lib/migration-docs";
import type { AuditEntry, VerificationReport } from "@/lib/types";

describe("migration audit labels (MIGR-029)", () => {
  it("maps known event codes to human labels", () => {
    expect(migrationAuditEventLabel("migration.dry_run_started")).toBe(
      "Dry-run started",
    );
    expect(migrationAuditEventLabel("migration.completed")).toBe(
      "Migration completed",
    );
  });

  it("humanises unknown codes deterministically", () => {
    expect(migrationAuditEventLabel("migration.some_new_thing")).toBe(
      "Some new thing",
    );
    expect(migrationAuditEventLabel("bare_code")).toBe("Bare code");
  });
});

describe("migration docs links (MIGR-017)", () => {
  it("links per-source when a guide exists, index otherwise", () => {
    expect(hasMigrationDocsGuide("mailchimp")).toBe(true);
    expect(migrationDocsHref("mailchimp")).toBe("/docs/migrations/mailchimp");
    // klaviyo has no per-source guide → fall back to the index
    expect(hasMigrationDocsGuide("klaviyo")).toBe(false);
    expect(migrationDocsHref("klaviyo")).toBe("/docs/migrations");
  });
});

describe("verification / audit export (MIGR-026)", () => {
  const report: VerificationReport = {
    subscribers_imported: 12543,
    suppression_list_size: 40,
    duplicate_subscribers_merged: 2,
    custom_fields_mapped: [
      { source: "FNAME", canonical: "first_name", type: "string" },
    ],
    custom_fields_unmapped: ["WEIRD"],
    segments_translated: 7,
    segments_with_warnings: [
      { name: "VIPs", warning: "predicate unsupported" },
    ],
    automations_translated: 3,
    automations_unsupported: [{ name: "Winback", reason: "graph not exposed" }],
    paid_subs_imported: 0,
    archive_imported: 142,
    data_loss_estimate_pct: 0.4,
  };

  it("emits a CSV with summary, mapping, and warnings", () => {
    const csv = buildVerificationReportCsv(report, "Mailchimp");
    expect(csv).toContain("section,key,value,detail");
    expect(csv).toContain("fidelity_pct,99.6");
    expect(csv).toContain("custom_field_mapped,FNAME,first_name,string");
    expect(csv).toContain("automation_unsupported,Winback,graph not exposed");
  });

  it("labels exported preview counts without claiming a completed import", () => {
    const csv = buildVerificationReportCsv(report, "CSV upload", "preview");
    expect(csv).toContain(
      "summary,report_kind,preview,Planned counts; no completed import is confirmed",
    );
    expect(buildVerificationReportCsv(report, "CSV upload")).toContain(
      "summary,report_kind,imported",
    );
  });

  it("emits the full audit log as CSV with human labels + raw codes", () => {
    const entries: AuditEntry[] = [
      {
        id: "a1",
        timestamp: "2026-07-02T00:00:00.000Z",
        event: "migration.dry_run_started",
        actor: "user@example.com",
        fields: { job_id: "j1" },
      },
    ];
    const csv = buildAuditLogCsv(entries);
    expect(csv).toContain("timestamp,event,event_code,actor,fields");
    expect(csv).toContain("Dry-run started");
    expect(csv).toContain("migration.dry_run_started");
    expect(csv).toContain("job_id=j1");
  });
});

describe("CSV column mapping (MIGR-023)", () => {
  it("parses quoted header rows", () => {
    expect(parseCsvHeaderRow('email,"first, last",tags')).toEqual([
      "email",
      "first, last",
      "tags",
    ]);
    expect(parseCsvHeaderRow('"a""b",c\r')).toEqual(['a"b', "c"]);
    expect(parseCsvHeaderRow("\uFEFFemail,name")).toEqual(["email", "name"]);
  });

  it("extracts only the header line", () => {
    expect(extractHeaderLine("email,name\nfoo@bar.com,Foo")).toBe("email,name");
  });

  it("detects the email column, exact hint before contains", () => {
    expect(detectEmailColumn(["Email Address", "name"])).toBe(0);
    expect(detectEmailColumn(["name", "contact_email"])).toBe(1);
    expect(detectEmailColumn(["name", "id"])).toBe(-1);
  });

  it("requires a valid, non-empty email column", () => {
    expect(validateCsvColumns(["email", "name"], 0).ok).toBe(true);
    expect(validateCsvColumns(["email", "name"], -1).ok).toBe(false);
    expect(validateCsvColumns([], 0).ok).toBe(false);
    expect(validateCsvColumns(["", "name"], 0).ok).toBe(false);
  });
});
