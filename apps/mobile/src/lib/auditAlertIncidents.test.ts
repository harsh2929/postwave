import { describe, expect, it } from "vitest";

import {
  incidentLink,
  incidentPresentation,
  incidentState,
  incidentSystemLabel,
  outstandingIncidentCount,
  parseAuditAlertIncident,
  parseAuditAlertIncidentPage,
  type AuditAlertIncident,
} from "./auditAlertIncidents";

/** A row shaped exactly like `Deps.Incidents` scans and writes it. */
function wireIncident(overrides: Record<string, unknown> = {}) {
  return {
    id: 41,
    rule_id: "9d2b7f6e-0000-4000-8000-000000000001",
    audit_id: 90210,
    external_system: "servicenow",
    external_incident_id: "INC0012345",
    incident_status: "open",
    incident_url: "https://acme.service-now.com/nav_to.do?uri=incident.do",
    last_synced_at: "2026-07-24T10:00:00Z",
    created_at: "2026-07-24T09:00:00Z",
    updated_at: "2026-07-24T10:00:00Z",
    ...overrides,
  };
}

function incident(overrides: Partial<AuditAlertIncident> = {}) {
  const parsed = parseAuditAlertIncident(wireIncident());
  if (!parsed) throw new Error("fixture failed to parse");
  return { ...parsed, ...overrides };
}

describe("parsing the incidents envelope", () => {
  it("reads the {incidents:[…]} envelope the handler actually writes", () => {
    const page = parseAuditAlertIncidentPage({
      incidents: [wireIncident(), wireIncident({ id: 42 })],
    });
    expect(page.incidents.map((row) => row.id)).toEqual([41, 42]);
    // `nextCursor` is added ONLY when another page exists.
    expect(page.nextCursor).toBeNull();
  });

  it("carries nextCursor through, so the screen can admit it is truncated", () => {
    const page = parseAuditAlertIncidentPage({
      incidents: [wireIncident()],
      nextCursor: "eyJzayI6IjIwMjYifQ",
    });
    expect(page.nextCursor).toBe("eyJzayI6IjIwMjYifQ");
  });

  it("tolerates a bare array, and yields nothing for a malformed body", () => {
    expect(parseAuditAlertIncidentPage([wireIncident()]).incidents).toHaveLength(
      1,
    );
    expect(parseAuditAlertIncidentPage(null).incidents).toEqual([]);
    expect(parseAuditAlertIncidentPage({ rows: [] }).incidents).toEqual([]);
  });

  it("drops rows that name no ticket rather than inventing a placeholder", () => {
    expect(parseAuditAlertIncident(wireIncident({ id: null }))).toBeNull();
    expect(
      parseAuditAlertIncident(wireIncident({ external_incident_id: "" })),
    ).toBeNull();
  });

  it("keeps an absent audit_id absent instead of collapsing it to zero", () => {
    const parsed = parseAuditAlertIncident(wireIncident({ audit_id: null }));
    expect(parsed?.auditId).toBeNull();
  });

  it("treats Go's zero timestamp as no timestamp", () => {
    const parsed = parseAuditAlertIncident(
      wireIncident({ last_synced_at: "0001-01-01T00:00:00Z" }),
    );
    expect(parsed?.lastSyncedAt).toBeNull();
  });
});

describe("incident status", () => {
  it("maps the four states the inbound webhook documents", () => {
    expect(incidentState("open")).toBe("open");
    expect(incidentState("in_progress")).toBe("in_progress");
    expect(incidentState("resolved")).toBe("resolved");
    expect(incidentState("CLOSED")).toBe("closed");
  });

  it("never reads an unsynced ticket as a finished one", () => {
    // incident_status is nullable and COALESCEd to '' — a ticket created by
    // recordOutboundIncident whose system never called back lands here.
    const view = incidentPresentation(incident({ incidentStatus: "" }));
    expect(incidentState("")).toBe("unsynced");
    expect(view.outstanding).toBe(true);
    expect(view.label).not.toBe("Closed");
    expect(view.spoken).toContain("no status has been synced back");
  });

  it("shows a status the column has no CHECK for verbatim", () => {
    const view = incidentPresentation(
      incident({ incidentStatus: "awaiting_change_board" }),
    );
    expect(view.label).toBe("awaiting_change_board");
    expect(view.spoken).toContain("does not recognise");
  });

  it("gives every state a WORD, so state is never colour-alone", () => {
    for (const status of ["open", "in_progress", "resolved", "closed", ""]) {
      expect(
        incidentPresentation(incident({ incidentStatus: status })).label.length,
      ).toBeGreaterThan(0);
    }
  });

  it("counts only the tickets somebody still owns", () => {
    expect(
      outstandingIncidentCount([
        incident({ id: 1, incidentStatus: "open" }),
        incident({ id: 2, incidentStatus: "in_progress" }),
        incident({ id: 3, incidentStatus: "resolved" }),
        incident({ id: 4, incidentStatus: "closed" }),
        incident({ id: 5, incidentStatus: "" }),
      ]),
    ).toBe(3);
  });
});

describe("the external link", () => {
  it("admits an https ticket URL", () => {
    expect(incidentLink(incident())).toBe(
      "https://acme.service-now.com/nav_to.do?uri=incident.do",
    );
  });

  it("refuses every scheme that is not https, because the value is external", () => {
    // InboundWebhook lets the remote system OVERRIDE incident_url, so this is
    // attacker-influenced input on the way to Linking.openURL.
    for (const url of [
      "javascript:alert(1)",
      "http://acme.service-now.com/x",
      "file:///etc/passwd",
      "",
      "https://",
      "https:// spaced.example",
    ]) {
      expect(incidentLink(incident({ incidentUrl: url }))).toBeNull();
    }
  });
});

describe("system labels", () => {
  it("names the three systems the CHECK constraint admits", () => {
    expect(incidentSystemLabel("servicenow")).toBe("ServiceNow");
    expect(incidentSystemLabel("jira")).toBe("Jira");
    expect(incidentSystemLabel("pagerduty")).toBe("PagerDuty");
  });

  it("does not dress an unexpected system up as a known one", () => {
    expect(incidentSystemLabel("opsgenie")).toBe("opsgenie");
    expect(incidentSystemLabel("")).toBe("External system");
  });
});
