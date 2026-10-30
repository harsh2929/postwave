// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  parseIncidentDetail,
  parseIncidents,
  severityColor,
  statusColor,
} from "./incidents";

const incident = {
  id: "018f4f4c-53de-7c12-ae4d-fbbac8f735b1",
  title: "Provider outage",
  severity: "sev1",
  status: "open",
  opened_by: "operator@postwave.test",
  opened_at: "2026-07-15T10:00:00Z",
  updated_at: "2026-07-15T10:01:00Z",
} as const;
const update = {
  id: "018f4f4c-53de-7c12-ae4d-fbbac8f735b2",
  body: "Investigating provider failures",
  author: "operator@postwave.test",
  requested_status: "open",
  created_at: "2026-07-15T10:00:00Z",
} as const;

describe("parseIncidents", () => {
  it("fails loud on non-200 and unexpected envelopes", () => {
    expect(parseIncidents(500, {}).ok).toBe(false);
    expect(parseIncidents(200, { rows: [] }).ok).toBe(false);
  });

  it("accepts the strict bounded incident envelope", () => {
    const result = parseIncidents(200, { incidents: [incident], truncated: false });
    expect(result).toEqual({ ok: true, rows: [incident], truncated: false });
  });

  it("rejects duplicate IDs, invalid enums, timestamps, and extra fields", () => {
    expect(parseIncidents(200, { incidents: [incident, incident], truncated: false }).ok).toBe(false);
    expect(parseIncidents(200, { incidents: [{ ...incident, severity: "sev0" }], truncated: false }).ok).toBe(false);
    expect(parseIncidents(200, { incidents: [{ ...incident, updated_at: "yesterday" }], truncated: false }).ok).toBe(false);
    expect(parseIncidents(200, { incidents: [{ ...incident, updated_at: "2026-02-31T10:01:00Z" }], truncated: false }).ok).toBe(false);
    expect(parseIncidents(200, { incidents: [{ ...incident, secret: "x" }], truncated: false }).ok).toBe(false);
  });

  it("requires resolved_at exactly for terminal incidents", () => {
    expect(parseIncidents(200, { incidents: [{ ...incident, status: "resolved" }], truncated: false }).ok).toBe(false);
    expect(parseIncidents(200, { incidents: [{ ...incident, resolved_at: "2026-07-15T10:02:00Z" }], truncated: false }).ok).toBe(false);
  });
});

describe("parseIncidentDetail", () => {
  it("accepts chronological updates and discloses truncation", () => {
    const result = parseIncidentDetail(200, {
      ...incident,
      updates: [
        update,
        {
          ...update,
          id: "018f4f4c-53de-7c12-ae4d-fbbac8f735b3",
          requested_status: "monitoring",
          created_at: "2026-07-15T10:01:00Z",
        },
      ],
      updates_truncated: true,
      next_before: update.id,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.incident.updates).toHaveLength(2);
      expect(result.incident.updates_truncated).toBe(true);
      expect(result.incident.updates[1].requested_status).toBe("monitoring");
    }
  });

  it("accepts bounded Unicode titles and multiline timeline notes", () => {
    const result = parseIncidentDetail(200, {
      ...incident,
      title: "🚨".repeat(256),
      updates: [{ ...update, body: "Investigating\nProvider acknowledged\tETA pending" }],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts an empty terminal page", () => {
    const result = parseIncidentDetail(200, { ...incident, updates: [] });
    expect(result).toEqual({
      ok: true,
      incident: { ...incident, updates: [], updates_truncated: false },
    });
  });

  it("uses the UUID as the deterministic tie-breaker for equal timestamps", () => {
    expect(parseIncidentDetail(200, {
      ...incident,
      updates: [
        update,
        { ...update, id: "018f4f4c-53de-7c12-ae4d-fbbac8f735b3" },
      ],
    }).ok).toBe(true);
    expect(parseIncidentDetail(200, {
      ...incident,
      updates: [
        { ...update, id: "018f4f4c-53de-7c12-ae4d-fbbac8f735b3" },
        update,
      ],
    }).ok).toBe(false);
  });

  it("rejects duplicate, reverse-ordered, or invalid-status timelines", () => {
    expect(parseIncidentDetail(200, { ...incident, updates: [update, update] }).ok).toBe(false);
    expect(parseIncidentDetail(200, {
      ...incident,
      updates: [
        { ...update, created_at: "2026-07-15T10:02:00Z" },
        { ...update, id: "018f4f4c-53de-7c12-ae4d-fbbac8f735b3", created_at: "2026-07-15T10:01:00Z" },
      ],
    }).ok).toBe(false);
    expect(parseIncidentDetail(200, { ...incident, updates: [{ ...update, requested_status: "reopened" }] }).ok).toBe(false);
    expect(parseIncidentDetail(200, {
      ...incident,
      updates: [{ ...update, created_at: "2026-07-15T10:02:00Z" }],
    }).ok).toBe(false);
  });

  it("requires a canonical cursor bound to the oldest update only when truncated", () => {
    expect(parseIncidentDetail(200, {
      ...incident,
      updates: [update],
      updates_truncated: true,
    }).ok).toBe(false);
    expect(parseIncidentDetail(200, {
      ...incident,
      updates: [update],
      updates_truncated: true,
      next_before: "NOT-A-UUID",
    }).ok).toBe(false);
    expect(parseIncidentDetail(200, {
      ...incident,
      updates: [update],
      updates_truncated: true,
      next_before: "018f4f4c-53de-7c12-ae4d-fbbac8f735b3",
    }).ok).toBe(false);
    expect(parseIncidentDetail(200, {
      ...incident,
      updates: [update],
      next_before: update.id,
    }).ok).toBe(false);
  });
});

describe("severity/status colors", () => {
  it("escalates severity", () => {
    expect(severityColor("sev1")).toBe("var(--red)");
    expect(severityColor("sev3")).toBe("var(--blue)");
  });
  it("greens resolved, reds open", () => {
    expect(statusColor("resolved")).toBe("var(--green)");
    expect(statusColor("open")).toBe("var(--red)");
  });
});
