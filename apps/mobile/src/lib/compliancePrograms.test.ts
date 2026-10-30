import { describe, expect, it } from "vitest";

import {
  frameworkCatalogueIndex,
  metaForFramework,
} from "@/lib/complianceFrameworks";
import {
  COMPLIANCE_EVENTS_LIMIT,
  ledgerMayBeTruncated,
  normalizeComplianceEvents,
  normalizeCompliancePrograms,
} from "@/lib/compliancePrograms";

describe("program normalization", () => {
  it("reads the envelope the Go handler actually writes", () => {
    // compliance.go:172 — writeJSON(w, 200, map{"programs": out}).
    const rows = normalizeCompliancePrograms({
      programs: [
        {
          framework: "soc2",
          status: "attested",
          signedByEmail: "dana@example.com",
          signerName: "Acme Legal",
          documentPath: "s3://compliance/soc2-2026.pdf",
          documentSha256: "abc123",
          attestedAt: "2026-01-05T09:00:00Z",
          renewalAt: "2027-01-05T09:00:00Z",
          updatedAt: "2026-01-05T09:00:00Z",
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      framework: "soc2",
      status: "attested",
      signedByEmail: "dana@example.com",
      documentSha256: "abc123",
      renewalAt: "2027-01-05T09:00:00Z",
    });
  });

  it("turns an absent *time.Time into an empty string, never an epoch", () => {
    // `attestedAt`/`renewalAt`/`updatedAt` are omitempty pointers
    // (compliance.go:80-82), so a never-attested program has no keys at all.
    const [row] = normalizeCompliancePrograms({
      programs: [{ framework: "gdpr", status: "in_progress" }],
    });
    expect(row?.attestedAt).toBe("");
    expect(row?.renewalAt).toBe("");
    expect(row?.updatedAt).toBe("");
  });

  it("preserves an empty document hash rather than hiding the field", () => {
    const [row] = normalizeCompliancePrograms({
      programs: [
        { framework: "casl", status: "attested", signedByEmail: "a@b.c" },
      ],
    });
    // An attestation with no evidence attached is a different fact from one
    // with a hash, so the empty string has to survive normalization.
    expect(row?.documentSha256).toBe("");
    expect(row?.status).toBe("attested");
  });

  it("keeps an unmodelled status as unknown and preserves what was sent", () => {
    const [row] = normalizeCompliancePrograms({
      programs: [{ framework: "soc2", status: "pending_review" }],
    });
    expect(row?.status).toBe("unknown");
    expect(row?.rawStatus).toBe("pending_review");
  });

  it("drops a row with no framework slug instead of rendering a blank card", () => {
    // The slug is half of the primary key (migration 0193 line 37); a row
    // without one cannot be looked up or described.
    const rows = normalizeCompliancePrograms({
      programs: [{ status: "attested" }, { framework: "soc2" }],
    });
    expect(rows.map((row) => row.framework)).toEqual(["soc2"]);
  });

  it("tolerates a bare array and a junk body without throwing", () => {
    expect(normalizeCompliancePrograms([{ framework: "gdpr" }])).toHaveLength(1);
    expect(normalizeCompliancePrograms(null)).toEqual([]);
    expect(normalizeCompliancePrograms("nope")).toEqual([]);
    expect(normalizeCompliancePrograms({ programs: "nope" })).toEqual([]);
  });
});

describe("event normalization", () => {
  it("reads the events envelope and backfills the framework", () => {
    const events = normalizeComplianceEvents(
      {
        events: [
          {
            id: 12,
            eventType: "renewed",
            signedByEmail: "dana@example.com",
            counterSignedBy: "Acme Legal",
            documentSha256: "deadbeef",
            at: "2026-06-03T10:00:00Z",
          },
        ],
      },
      "soc2",
    );
    expect(events[0]).toMatchObject({
      id: "12",
      framework: "soc2",
      eventType: "renewed",
      documentSha256: "deadbeef",
    });
  });

  it("keeps the server's newest-first order rather than re-sorting", () => {
    // `ORDER BY at DESC` (compliance.go:467) is authoritative; re-sorting on a
    // client-parsed timestamp would reorder rows whose `at` failed to parse.
    const events = normalizeComplianceEvents(
      {
        events: [
          { id: 3, eventType: "renewed", at: "2026-06-03T10:00:00Z" },
          { id: 1, eventType: "attested", at: "not a date" },
          { id: 2, eventType: "revoked", at: "2026-02-01T10:00:00Z" },
        ],
      },
      "soc2",
    );
    expect(events.map((event) => event.id)).toEqual(["3", "1", "2"]);
  });

  it("keeps an unmodelled event type as unknown and preserves the raw value", () => {
    const [event] = normalizeComplianceEvents(
      { events: [{ id: 1, eventType: "countersigned" }] },
      "gdpr",
    );
    expect(event?.eventType).toBe("unknown");
    expect(event?.rawEventType).toBe("countersigned");
  });
});

describe("the ledger cap is disclosed, not hidden", () => {
  it("flags a full page as possibly truncated", () => {
    expect(ledgerMayBeTruncated(COMPLIANCE_EVENTS_LIMIT)).toBe(true);
    expect(ledgerMayBeTruncated(COMPLIANCE_EVENTS_LIMIT - 1)).toBe(false);
  });
});

describe("the catalogue never drops an unknown framework", () => {
  it("falls back to a generic entry instead of returning nothing", () => {
    const meta = metaForFramework("eu_ai_act");
    expect(meta.short).toBe("EU AI ACT");
    expect(meta.region).toBe("—");
    expect(meta.url).toBe("");
    expect(meta.renewalCadenceMonths).toBeNull();
  });

  it("sorts an unknown framework after every known one", () => {
    expect(frameworkCatalogueIndex("eu_ai_act")).toBeGreaterThan(
      frameworkCatalogueIndex("casl"),
    );
  });

  it("matches the server's SupportedFrameworks order", () => {
    // compliance.go:60-69.
    expect(
      ["hipaa", "soc2", "gdpr", "ccpa", "pci_dss", "iso27001", "can_spam", "casl"].map(
        frameworkCatalogueIndex,
      ),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
