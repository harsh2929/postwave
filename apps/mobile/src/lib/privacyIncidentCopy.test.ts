import { describe, expect, it } from "vitest";

import { EMDASH } from "@/lib/format";
import {
  incidentEventSentence,
  incidentRegisterSubtitle,
  incidentSampleCaveat,
  incidentSeverityBadge,
  incidentStateBadge,
  incidentSubjectCount,
} from "@/lib/privacyIncidentCopy";
import {
  normalizeIncident,
  normalizeIncidentEvents,
} from "@/lib/privacyIncidents";

function incident(over: Record<string, unknown> = {}) {
  return normalizeIncident({
    id: "inc-1",
    severity: "high",
    status: "open",
    summary: "Vendor exposed a subscriber export",
    ...over,
  });
}

describe("incidentSeverityBadge", () => {
  it("gives every graded severity a word, not only a colour", () => {
    expect(
      incidentSeverityBadge(incident({ severity: "critical" })).label,
    ).toBe("Critical");
    expect(incidentSeverityBadge(incident({ severity: "low" })).tone).toBe(
      "neutral",
    );
  });

  it("does not let the server's DEFAULT read as a settled low severity", () => {
    // `normalizeSeverity("")` returns "investigating" — it means nobody has
    // graded the breach yet, which is not the same as grading it low.
    const badge = incidentSeverityBadge(
      incident({ severity: "investigating" }),
    );
    expect(badge.label).toBe("Investigating");
    expect(badge.tone).toBe("info");
    expect(badge.spoken).toContain("not graded yet");
  });

  it("shows an unknown severity verbatim and says it is unknown", () => {
    const badge = incidentSeverityBadge(incident({ severity: "catastrophic" }));
    expect(badge.label).toBe("catastrophic");
    expect(badge.spoken).toContain("does not recognise");
  });

  it("is an em-dash, not a blank pill, when severity is missing entirely", () => {
    const badge = incidentSeverityBadge(normalizeIncident({ id: "x" }));
    expect(badge.label).toBe(EMDASH);
    expect(badge.spoken).toBe("No severity recorded");
  });
});

describe("incidentStateBadge", () => {
  it("names the four workflow states", () => {
    expect(incidentStateBadge(incident({ status: "open" })).label).toBe("Open");
    expect(
      incidentStateBadge(incident({ status: "notifications_pending" })).label,
    ).toBe("Notifying");
    expect(incidentStateBadge(incident({ status: "closed" })).tone).toBe(
      "success",
    );
  });

  it("keeps an unrecognised state visible rather than rendering nothing", () => {
    const badge = incidentStateBadge(incident({ status: "escalated" }));
    expect(badge.label).toBe("escalated");
    expect(badge.spoken).toContain("does not recognise");
  });
});

describe("incidentSubjectCount", () => {
  it("is an em-dash with an explanation when nothing was recorded", () => {
    const badge = incidentSubjectCount(incident());
    expect(badge.label).toBe(EMDASH);
    expect(badge.spoken).toBe("Affected people not recorded");
  });

  it("ships the exact figure to assistive tech beside the compact one", () => {
    const badge = incidentSubjectCount(
      incident({ affected_subject_count: 12480 }),
    );
    expect(badge.spoken).toBe("12480 people affected");
    expect(badge.label).toContain("12");
  });

  it("uses the singular for one person", () => {
    expect(
      incidentSubjectCount(incident({ affected_subject_count: 1 })).spoken,
    ).toBe("1 person affected");
  });
});

describe("incidentEventSentence", () => {
  function events(raw: unknown[]) {
    return normalizeIncidentEvents({
      incident_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      events: raw,
    });
  }

  it("reads a transition as from → to, with actor and reason", () => {
    const [event] = events([
      {
        event_id: "11111111-1111-4111-8111-111111111111",
        source: "incident_state_transitions",
        schema_version: 1,
        kind: "transition",
        from_state: "open",
        to_state: "contained",
        actor: "ada@example.com",
        reason: "vendor key rotated",
        at: "2026-07-24T18:00:00Z",
      },
    ]);
    expect(incidentEventSentence(event!)).toBe(
      "open → contained by ada@example.com — vendor key rotated",
    );
  });

  it("calls the opening row 'created', not an empty arrow", () => {
    const [event] = events([
      {
        event_id: "22222222-2222-4222-8222-222222222222",
        source: "incident_state_transitions",
        schema_version: 1,
        kind: "transition",
        to_state: "open",
        at: "2026-07-24T09:00:00Z",
      },
    ]);
    expect(incidentEventSentence(event!)).toBe("created → open");
  });

  it("describes a notification by audience and template, never by recipient", () => {
    // `recipient_ref` can be a data subject's email; a ledger scrolled on a
    // train must not put it on the glass.
    const [event] = events([
      {
        event_id: "33333333-3333-4333-8333-333333333333",
        source: "incident_notifications",
        schema_version: 1,
        kind: "notification",
        audience: "data_subject",
        template_key: "gdpr_subject",
        recipient_ref: "ada@example.com",
        actor: "grace@example.com",
        at: "2026-07-25T10:00:00Z",
      },
    ]);
    const sentence = incidentEventSentence(event!);
    expect(sentence).toBe(
      "Legacy notification assertion recorded for data_subject using gdpr_subject by grace@example.com",
    );
    expect(sentence).not.toContain("ada@example.com");
  });

  it("rejects an unrecognised historical ledger kind before rendering", () => {
    expect(() =>
      events([
        // Explicitly rejected history without stable event/source identity.
        { kind: "packet_downloaded", at: "2026-07-25T10:00:00Z" },
      ]),
    ).toThrowError(/wire contract/);
  });
});

describe("incidentRegisterSubtitle", () => {
  it("states a total only when the page WAS the whole register", () => {
    expect(incidentRegisterSubtitle({ open: 3, total: 12 }, false)).toBe(
      "3 open of 12 incidents",
    );
  });

  it("scopes the total to the sample when the server offered more", () => {
    // "3 open of 50 incidents" would be a claim about a workspace that may
    // hold four hundred; the rows are `detected_at DESC`, so 50 is a floor.
    expect(incidentRegisterSubtitle({ open: 3, total: 50 }, true)).toBe(
      "3 open in the newest 50 incidents",
    );
  });

  it("uses the singular for a register of one", () => {
    expect(incidentRegisterSubtitle({ open: 1, total: 1 }, false)).toBe(
      "1 open of 1 incident",
    );
  });
});

describe("incidentSampleCaveat", () => {
  it("says the counts above it were computed over a sample", () => {
    expect(incidentSampleCaveat(50)).toBe(
      "These counts cover the 50 most recent incidents only — older history is on the web admin.",
    );
    expect(incidentSampleCaveat(1)).toContain("1 most recent incident only");
  });
});
