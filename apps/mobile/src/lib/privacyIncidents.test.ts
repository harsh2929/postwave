import { describe, expect, it } from "vitest";

import {
  epochOf,
  isoOrEmpty,
  normalizeIncident,
  normalizeIncidentEvents,
  normalizePrivacyIncidentDetail,
  normalizePrivacyIncidentPage,
} from "@/lib/privacyIncidents";

/**
 * These tests pin the five server facts the module header names. Each one is a
 * place where a naive parse would make the app state something untrue about a
 * legally significant record.
 */

const LIST_ROW = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  severity: "high",
  status: "open",
  detected_at: "2026-07-24T09:00:00Z",
  discovered_at: "2026-07-24T09:00:00Z",
  clock_started_at: "2026-07-24T09:00:00Z",
  gdpr_72h_deadline: "2026-07-27T09:00:00Z",
  template_version: "2026-06",
  affected_regions: ["GDPR", "CA"],
  affected_data_categories: ["email", "name"],
  notification_decisions: {},
  jurisdictions: ["GDPR", "CA"],
  summary: "Vendor exposed a subscriber export",
  created_at: "2026-07-24T09:00:05Z",
  updated_at: "2026-07-24T09:00:05Z",
};

describe("isoOrEmpty", () => {
  it("drops Go's zero time rather than treating it as year 1", () => {
    // `new Date("0001-01-01T00:00:00Z")` parses fine, so an unguarded read
    // renders every unresolved incident as two millennia overdue.
    expect(isoOrEmpty("0001-01-01T00:00:00Z")).toBe("");
  });

  it("keeps a real timestamp and rejects junk", () => {
    expect(isoOrEmpty("2026-07-24T09:00:00Z")).toBe("2026-07-24T09:00:00Z");
    expect(isoOrEmpty("not a date")).toBe("");
    expect(isoOrEmpty(null)).toBe("");
    expect(isoOrEmpty(1750000000)).toBe("");
  });
});

describe("epochOf", () => {
  it("answers 0 for an absent timestamp instead of a year-2000 date", () => {
    // `Date.parse("0")` is 2000-01-01 in V8 and NaN elsewhere; either would
    // sort an undated ledger row into the middle of a live incident.
    expect(epochOf("")).toBe(0);
    expect(epochOf("nope")).toBe(0);
    expect(epochOf("2026-07-24T09:00:00Z")).toBe(
      Date.UTC(2026, 6, 24, 9, 0, 0),
    );
  });
});

describe("normalizeIncident", () => {
  it("reads a list row that omits jurisdiction resolution", () => {
    const row = normalizeIncident(LIST_ROW);
    expect(row.id).toBe(LIST_ROW.id);
    expect(row.severity).toBe("high");
    expect(row.status).toBe("open");
    expect(row.deadlineAt).toBe("2026-07-27T09:00:00Z");
    expect(row.jurisdictions).toEqual(["GDPR", "CA"]);
    // No obligations leak out of a list row — the shape does not carry them.
    expect("obligations" in row).toBe(false);
  });

  it("keeps an absent subject count as null, never as a measured zero", () => {
    // `NULLIF($9, 0)` at insert means an unrecorded count is omitted; 0 people
    // affected is a claim nobody made.
    expect(normalizeIncident(LIST_ROW).affectedSubjectCount).toBeNull();
    expect(
      normalizeIncident({ ...LIST_ROW, affected_subject_count: 0 })
        .affectedSubjectCount,
    ).toBe(0);
    expect(
      normalizeIncident({ ...LIST_ROW, affected_subject_count: 12480 })
        .affectedSubjectCount,
    ).toBe(12480);
  });

  it("keeps an unrecognised severity and state verbatim instead of blanking", () => {
    const row = normalizeIncident({
      ...LIST_ROW,
      severity: "catastrophic",
      status: "escalated",
    });
    expect(row.severity).toBeNull();
    expect(row.severityRaw).toBe("catastrophic");
    expect(row.status).toBeNull();
    expect(row.statusRaw).toBe("escalated");
  });

  it("survives a payload with nothing in it", () => {
    const row = normalizeIncident(null);
    expect(row.id).toBe("");
    expect(row.affectedRegions).toEqual([]);
    expect(row.affectedSubjectCount).toBeNull();
    expect(row.deadlineAt).toBe("");
  });
});

describe("normalizePrivacyIncidentPage", () => {
  it("reports truncation from the presence of a cursor", () => {
    const page = normalizePrivacyIncidentPage({
      incidents: [LIST_ROW],
      known_jurisdictions: [],
      nextCursor: "eyJrIjoi",
    });
    expect(page.incidents).toHaveLength(1);
    expect(page.truncated).toBe(true);
  });

  it("is not truncated when the server omitted the cursor", () => {
    const page = normalizePrivacyIncidentPage({
      incidents: [LIST_ROW],
      known_jurisdictions: [],
    });
    expect(page.truncated).toBe(false);
    expect(page.nextCursor).toBe("");
  });

  it("rejects a page when any required row identity is missing", () => {
    expect(() =>
      normalizePrivacyIncidentPage({
        incidents: [LIST_ROW, { severity: "low" }],
        known_jurisdictions: [],
      }),
    ).toThrowError(/wire contract/);
  });

  it("fails closed on a malformed body or empty nonterminal page", () => {
    expect(() => normalizePrivacyIncidentPage("nope")).toThrowError(
      /not an object/,
    );
    expect(() =>
      normalizePrivacyIncidentPage({
        incidents: [],
        known_jurisdictions: [],
        nextCursor: "nonterminal_cursor",
      }),
    ).toThrowError(/cannot be nonterminal/);
  });

  it("rejects duplicate, unordered, and enum-drift rows", () => {
    const envelope = (incidents: unknown[]) => ({
      incidents,
      known_jurisdictions: [],
    });
    expect(() =>
      normalizePrivacyIncidentPage(envelope([LIST_ROW, { ...LIST_ROW }])),
    ).toThrowError(/duplicate identities/);
    expect(() =>
      normalizePrivacyIncidentPage(
        envelope([
          { ...LIST_ROW, detected_at: "2026-07-23T09:00:00Z" },
          {
            ...LIST_ROW,
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            detected_at: "2026-07-24T09:00:00Z",
          },
        ]),
      ),
    ).toThrowError(/ordering/);
    expect(() =>
      normalizePrivacyIncidentPage(
        envelope([{ ...LIST_ROW, status: "escalated" }]),
      ),
    ).toThrowError(/wire contract/);
  });

  it("rejects bidi-formatting controls without rejecting ZWJ emoji", () => {
    const bidiControls = [
      "\u061c",
      "\u200e",
      "\u200f",
      "\u202a",
      "\u202b",
      "\u202c",
      "\u202d",
      "\u202e",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
    ];
    for (const control of bidiControls) {
      expect(() =>
        normalizePrivacyIncidentPage({
          incidents: [{ ...LIST_ROW, summary: `before${control}after` }],
          known_jurisdictions: [],
        }),
      ).toThrowError(/wire contract/);
    }
    expect(
      normalizePrivacyIncidentPage({
        incidents: [{ ...LIST_ROW, summary: "Family 👩‍👩‍👧‍👦 response" }],
        known_jurisdictions: [],
      }).incidents[0]?.summary,
    ).toContain("👩‍👩‍👧‍👦");
  });
});

describe("normalizePrivacyIncidentDetail", () => {
  it("accepts only the explicit sorted jurisdiction release hold", () => {
    const detail = normalizePrivacyIncidentDetail({
      ...LIST_ROW,
      jurisdictions: ["GDPR", "NY", "ZZ"],
      jurisdiction_resolution: {
        status: "release_held",
        release_hold_code: "jurisdiction_rules_release_hold",
        recognized: [
          { code: "GDPR", name: "European Union / EEA" },
          { code: "NY", name: "New York" },
        ],
        unknown_jurisdictions: ["ZZ"],
      },
    });
    expect(detail.jurisdictionResolution?.recognized).toEqual([
      { code: "GDPR", name: "European Union / EEA" },
      { code: "NY", name: "New York" },
    ]);
    expect(detail.jurisdictionResolution?.unknown).toEqual(["ZZ"]);
  });

  it("fails closed on the removed obligation-shaped legacy payload", () => {
    expect(() =>
      normalizePrivacyIncidentDetail({
        ...LIST_ROW,
        jurisdiction_resolution: {
          // Explicitly rejected historical nanosecond/obligation shape.
          matched: [{ Code: "GDPR", Name: "EU GDPR" }],
          deadline_seconds: 259_200_000_000_000,
          notify_authorities: ["GDPR"],
        },
      }),
    ).toThrowError(/wire contract/);
  });

  it("rejects unsorted, duplicate, or extra release-hold fields", () => {
    for (const jurisdiction_resolution of [
      {
        status: "release_held",
        release_hold_code: "jurisdiction_rules_release_hold",
        recognized: [
          { code: "NY", name: "New York" },
          { code: "GDPR", name: "European Union / EEA" },
        ],
      },
      {
        status: "release_held",
        release_hold_code: "jurisdiction_rules_release_hold",
        recognized: [],
        deadline_seconds: 0,
      },
    ]) {
      expect(() =>
        normalizePrivacyIncidentDetail({
          ...LIST_ROW,
          jurisdiction_resolution,
        }),
      ).toThrowError(/wire contract/);
    }
  });

  it("rejects an absent hold, mismatched codes, overlaps, and wrong identity", () => {
    expect(() => normalizePrivacyIncidentDetail(LIST_ROW)).toThrowError(
      /wire contract/,
    );
    const baseResolution = {
      status: "release_held",
      release_hold_code: "jurisdiction_rules_release_hold",
      recognized: [{ code: "GDPR", name: "European Union / EEA" }],
    };
    expect(() =>
      normalizePrivacyIncidentDetail({
        ...LIST_ROW,
        jurisdictions: ["TX"],
        jurisdiction_resolution: baseResolution,
      }),
    ).toThrowError(/wire contract/);
    expect(() =>
      normalizePrivacyIncidentDetail({
        ...LIST_ROW,
        jurisdictions: ["GDPR"],
        jurisdiction_resolution: {
          ...baseResolution,
          unknown_jurisdictions: ["GDPR"],
        },
      }),
    ).toThrowError(/wire contract/);
    expect(() =>
      normalizePrivacyIncidentDetail(
        {
          ...LIST_ROW,
          jurisdictions: ["GDPR"],
          jurisdiction_resolution: baseResolution,
        },
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ),
    ).toThrowError(/different incident/);
  });
});

describe("normalizeIncidentEvents", () => {
  it("merges and orders the ledger newest first", () => {
    const events = normalizeIncidentEvents({
      incident_id: LIST_ROW.id,
      events: [
        {
          event_id: "11111111-1111-4111-8111-111111111111",
          source: "incident_state_transitions",
          schema_version: 1,
          kind: "transition",
          to_state: "open",
          at: "2026-07-24T09:00:00Z",
          actor: "ada@example.com",
          reason: "incident opened",
        },
        {
          event_id: "33333333-3333-4333-8333-333333333333",
          source: "incident_state_transitions",
          schema_version: 1,
          kind: "transition",
          from_state: "open",
          to_state: "contained",
          at: "2026-07-24T18:00:00Z",
          actor: "ada@example.com",
        },
        {
          event_id: "22222222-2222-4222-8222-222222222222",
          source: "incident_notifications",
          schema_version: 1,
          kind: "notification",
          audience: "authority",
          template_key: "gdpr_authority",
          at: "2026-07-25T10:00:00Z",
          actor: "grace@example.com",
          recipient_ref: "case-9912",
        },
      ],
    });
    expect(events.map((event) => event.at)).toEqual([
      "2026-07-25T10:00:00Z",
      "2026-07-24T18:00:00Z",
      "2026-07-24T09:00:00Z",
    ]);
    expect(events[0]?.kind).toBe("notification");
    expect(events[0]?.audience).toBe("authority");
  });

  it("keeps equal UUIDs from independent event sources distinct", () => {
    const sharedId = "11111111-1111-4111-8111-111111111111";
    const events = normalizeIncidentEvents({
      incident_id: LIST_ROW.id,
      events: [
        {
          event_id: sharedId,
          source: "incident_state_transitions",
          schema_version: 1,
          kind: "transition",
          to_state: "contained",
          at: "2026-07-24T09:00:00Z",
        },
        {
          event_id: sharedId,
          source: "incident_notifications",
          schema_version: 1,
          kind: "notification",
          audience: "authority",
          at: "2026-07-24T10:00:00Z",
        },
      ],
    });
    expect(events).toHaveLength(2);
    expect(events.map((event) => `${event.source}:${event.eventId}`)).toEqual([
      `incident_notifications:${sharedId}`,
      `incident_state_transitions:${sharedId}`,
    ]);
  });

  it("rejects legacy rows without stable source identity", () => {
    expect(() =>
      normalizeIncidentEvents({
        incident_id: LIST_ROW.id,
        events: [
          {
            // Explicitly rejected historical index-only event shape.
            kind: "transition",
            to_state: "contained",
            at: "2026-07-25T10:00:00Z",
          },
        ],
      }),
    ).toThrowError(/wire contract/);
  });

  it("rejects malformed and wrong-parent ledgers", () => {
    expect(() => normalizeIncidentEvents(undefined)).toThrowError(
      /wire contract/,
    );
    expect(() =>
      normalizeIncidentEvents(
        { incident_id: LIST_ROW.id, events: [] },
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ),
    ).toThrowError(/different incident/);
  });

  it("rejects duplicate composite event identities and unordered rows", () => {
    const event = {
      event_id: "11111111-1111-4111-8111-111111111111",
      source: "incident_state_transitions",
      schema_version: 1,
      kind: "transition",
      to_state: "contained",
      at: "2026-07-24T09:00:00Z",
    };
    expect(() =>
      normalizeIncidentEvents({
        incident_id: LIST_ROW.id,
        events: [event, { ...event }],
      }),
    ).toThrowError(/duplicate source identities/);
    expect(() =>
      normalizeIncidentEvents({
        incident_id: LIST_ROW.id,
        events: [
          { ...event, at: "2026-07-25T09:00:00Z" },
          {
            ...event,
            event_id: "22222222-2222-4222-8222-222222222222",
          },
        ],
      }),
    ).toThrowError(/ordering/);
  });

  it("rejects bidi-formatting controls in event narratives", () => {
    expect(() =>
      normalizeIncidentEvents({
        incident_id: LIST_ROW.id,
        events: [
          {
            event_id: "11111111-1111-4111-8111-111111111111",
            source: "incident_state_transitions",
            schema_version: 1,
            kind: "transition",
            to_state: "contained",
            at: "2026-07-24T09:00:00Z",
            reason: "safe prefix\u2066spoofed suffix",
          },
        ],
      }),
    ).toThrowError(/wire contract/);
  });
});
