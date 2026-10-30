import { describe, expect, it } from "vitest";

import { EMDASH } from "@/lib/format";
import {
  INCIDENT_CLOSURE_RELEASE_HOLD,
  INCIDENT_TRANSITION_OFFLINE_NOTICE,
  humanGap,
  incidentClock,
  incidentCounts,
  incidentHeadline,
  incidentReadAccess,
  incidentRegisterDataState,
  incidentTransitionAccess,
  incidentTransitionError,
  incidentTransitionOptions,
  orderIncidents,
} from "@/lib/privacyIncidentPolicy";
import {
  normalizeIncident,
  type PrivacyIncident,
} from "@/lib/privacyIncidents";

const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);

function incident(over: Record<string, unknown> = {}): PrivacyIncident {
  return normalizeIncident({
    id: "inc-1",
    severity: "high",
    status: "open",
    detected_at: "2026-07-24T09:00:00Z",
    clock_started_at: "2026-07-24T09:00:00Z",
    gdpr_72h_deadline: "2026-07-27T09:00:00Z",
    summary: "Vendor exposed a subscriber export",
    affected_regions: ["GDPR"],
    jurisdictions: ["GDPR"],
    ...over,
  });
}

describe("humanGap", () => {
  it("uses at most two units", () => {
    expect(humanGap(30_000)).toBe("under a minute");
    expect(humanGap(45 * 60_000)).toBe("45m");
    expect(humanGap(9 * 3_600_000 + 12 * 60_000)).toBe("9h 12m");
    expect(humanGap(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
    expect(humanGap(-2 * 3_600_000)).toBe("2h");
  });
});

describe("incidentClock", () => {
  it("counts down to the legacy 72-hour operational target", () => {
    // Deadline 2026-07-27T09:00Z, now 2026-07-25T12:00Z → 45 hours.
    const clock = incidentClock(incident(), NOW);
    expect(clock.state).toBe("running");
    expect(clock.label).toBe("1d 21h left");
    expect(clock.tone).toBe("neutral");
  });

  it("warns inside the last twelve hours", () => {
    const clock = incidentClock(
      incident({ gdpr_72h_deadline: "2026-07-25T20:00:00Z" }),
      NOW,
    );
    expect(clock.state).toBe("due-soon");
    expect(clock.tone).toBe("warning");
    expect(clock.label).toBe("8h left");
  });

  it("says how far past the operational target it is, in danger", () => {
    const clock = incidentClock(
      incident({ gdpr_72h_deadline: "2026-07-25T06:00:00Z" }),
      NOW,
    );
    expect(clock.state).toBe("overdue");
    expect(clock.tone).toBe("danger");
    expect(clock.label).toBe("6h over");
    expect(clock.spoken).toContain("legacy 72-hour operational target");
    expect(clock.spoken).toContain("not a legal deadline determination");
  });

  it("stops the clock on a closed incident instead of shouting forever", () => {
    // Historical closed rows do not keep an active operational countdown.
    const clock = incidentClock(
      incident({ status: "closed", gdpr_72h_deadline: "2026-07-20T09:00:00Z" }),
      NOW,
    );
    expect(clock.state).toBe("stopped");
    expect(clock.tone).toBe("success");
    expect(clock.label).toBe("Closed");
  });

  it("shows an em-dash — never an overdue clock — when there is no deadline", () => {
    const clock = incidentClock(incident({ gdpr_72h_deadline: null }), NOW);
    expect(clock.state).toBe("unknown");
    expect(clock.label).toBe(EMDASH);
    expect(clock.msRemaining).toBeNull();
  });

  it("treats Go's zero time as no deadline, not as maximally overdue", () => {
    const clock = incidentClock(
      incident({ gdpr_72h_deadline: "0001-01-01T00:00:00Z" }),
      NOW,
    );
    expect(clock.state).toBe("unknown");
  });
});

describe("incidentCounts", () => {
  const rows = [
    incident({ id: "a", gdpr_72h_deadline: "2026-07-25T06:00:00Z" }), // overdue
    incident({ id: "b", gdpr_72h_deadline: "2026-07-25T20:00:00Z" }), // due soon
    incident({
      id: "c",
      detected_at: "2026-07-25T11:00:00Z",
      gdpr_72h_deadline: "2026-07-28T11:00:00Z",
    }), // fresh
    incident({
      id: "d",
      status: "closed",
      counsel_signoff_at: "2026-07-24T12:00:00Z",
      gdpr_72h_deadline: "2026-07-20T09:00:00Z",
    }),
  ];

  it("counts only what is still open, and never counts a closed one as overdue", () => {
    const counts = incidentCounts(rows, NOW);
    expect(counts.total).toBe(4);
    expect(counts.open).toBe(3);
    expect(counts.overdue).toBe(1);
    expect(counts.dueSoon).toBe(1);
  });

  it("counts open-over-24h without treating legacy sign-off as authority", () => {
    const counts = incidentCounts(rows, NOW);
    // a and b were detected 2026-07-24T09:00Z (27h ago); c an hour ago.
    expect(counts.staleOpen).toBe(2);
  });
});

describe("orderIncidents", () => {
  it("leads with the overdue, then due-soon, then the rest, with closed last", () => {
    const rows = [
      incident({ id: "closed", status: "closed" }),
      incident({ id: "fresh", gdpr_72h_deadline: "2026-07-28T11:00:00Z" }),
      incident({ id: "overdue", gdpr_72h_deadline: "2026-07-25T06:00:00Z" }),
      incident({ id: "soon", gdpr_72h_deadline: "2026-07-25T20:00:00Z" }),
    ];
    expect(orderIncidents(rows, NOW).map((row) => row.id)).toEqual([
      "overdue",
      "soon",
      "fresh",
      "closed",
    ]);
  });

  it("sorts an unknown clock to the BACK of its band, not the front", () => {
    // Sorting a missing deadline as 0 would put every unresolved incident
    // above the ones whose countdown is real.
    const rows = [
      incident({ id: "nodeadline", gdpr_72h_deadline: null }),
      incident({ id: "fresh", gdpr_72h_deadline: "2026-07-28T11:00:00Z" }),
    ];
    expect(orderIncidents(rows, NOW).map((row) => row.id)).toEqual([
      "fresh",
      "nodeadline",
    ]);
  });

  it("does not mutate the input", () => {
    const rows = [
      incident({ id: "a" }),
      incident({ id: "b", status: "closed" }),
    ];
    orderIncidents(rows, NOW);
    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
  });
});

describe("incidentTransitionOptions", () => {
  it("mirrors the server adjacency for each state", () => {
    expect(incidentTransitionOptions(incident()).map((o) => o.to)).toEqual([
      "contained",
      "notifications_pending",
      "closed",
    ]);
    expect(
      incidentTransitionOptions(incident({ status: "contained" })).map(
        (o) => o.to,
      ),
    ).toEqual(["notifications_pending", "closed"]);
    expect(
      incidentTransitionOptions(
        incident({ status: "notifications_pending" }),
      ).map((o) => o.to),
    ).toEqual(["contained", "closed"]);
    expect(incidentTransitionOptions(incident({ status: "closed" }))).toEqual(
      [],
    );
  });

  it("offers close disabled with the release-hold reason", () => {
    const close = incidentTransitionOptions(incident()).find(
      (o) => o.to === "closed",
    );
    expect(close?.allowed).toBe(false);
    expect(close?.blockedReason).toBe(INCIDENT_CLOSURE_RELEASE_HOLD);
    expect(close?.destructive).toBe(true);
  });

  it("does not treat a legacy sign-off field as closure authority", () => {
    const close = incidentTransitionOptions(
      incident({ counsel_signoff_at: "2026-07-25T09:00:00Z" }),
    ).find((o) => o.to === "closed");
    expect(close?.allowed).toBe(false);
    expect(close?.blockedReason).toBe(INCIDENT_CLOSURE_RELEASE_HOLD);
  });

  it("offers nothing at all from a state this build does not recognise", () => {
    // Guessing an adjacency for an unknown state would mean posting a
    // transition into an audited workflow on a hunch.
    expect(
      incidentTransitionOptions(incident({ status: "escalated" })),
    ).toEqual([]);
  });
});

describe("incidentReadAccess / incidentTransitionAccess", () => {
  const base = { role: "admin", mode: "session" as const, online: true };

  it("withholds a verdict while the session role is still unknown", () => {
    const access = incidentReadAccess({
      isAdmin: false,
      role: null,
      mode: null,
      online: true,
    });
    expect(access.known).toBe(false);
    expect(access.notice).toBeNull();
  });

  it("admits owner/admin and explains the refusal to everyone else", () => {
    expect(incidentReadAccess({ ...base, isAdmin: true }).allowed).toBe(true);
    const denied = incidentReadAccess({
      ...base,
      role: "editor",
      isAdmin: false,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.known).toBe(true);
    expect(denied.notice).toContain("owner or admin role");
    // The load-bearing fact: there is no read-only tier on this group.
    expect(denied.notice).toContain("no read-only view");
  });

  it("says the API-key version of the same refusal", () => {
    const denied = incidentReadAccess({
      isAdmin: false,
      role: null,
      mode: "api_key",
      online: true,
    });
    expect(denied.known).toBe(true);
    expect(denied.notice).toContain("admin scope");
  });

  it("admits an online admin to the transition rail", () => {
    const access = incidentTransitionAccess({
      ...base,
      isAdmin: true,
      online: true,
    });
    expect(access.allowed).toBe(true);
    expect(access.known).toBe(true);
    expect(access.notice).toBeNull();
  });

  it("pauses transitions offline and says why they are never queued", () => {
    const access = incidentTransitionAccess({
      ...base,
      isAdmin: true,
      online: false,
    });
    expect(access.allowed).toBe(false);
    expect(access.notice).toBe(INCIDENT_TRANSITION_OFFLINE_NOTICE);
    expect(access.notice).toContain("never queued");
  });

  it("does not offer a write to a session that cannot even read", () => {
    const access = incidentTransitionAccess({
      ...base,
      role: "viewer",
      isAdmin: false,
    });
    expect(access.allowed).toBe(false);
    expect(access.notice).toContain("owner or admin role");
  });
});

describe("incidentTransitionError", () => {
  it("keeps release holds and every transition conflict fact distinct", () => {
    expect(
      incidentTransitionError({
        status: 503,
        code: "incident_closure_release_hold",
      }),
    ).toBe(INCIDENT_CLOSURE_RELEASE_HOLD);
    expect(
      incidentTransitionError({ status: 409, code: "stale_incident_state" }),
    ).toContain("already moved this incident");
    expect(
      incidentTransitionError({ status: 409, code: "invalid_transition" }),
    ).toContain("move is unavailable");
    expect(incidentTransitionError({ status: 409, code: "no_op" })).toContain(
      "already in the requested state",
    );
    expect(
      incidentTransitionError({ status: 409, code: "transition_conflict" }),
    ).toContain("already moved this incident");
    expect(incidentTransitionError({ status: 404 })).toContain(
      "no longer exists",
    );
    expect(incidentTransitionError({ status: 403 })).toContain(
      "owner or admin",
    );
  });

  it("falls back to the server's own message before a generic one", () => {
    expect(
      incidentTransitionError({ status: 500, message: "database is down" }),
    ).toBe("database is down");
    expect(incidentTransitionError(null)).toBe(
      "The state change did not go through.",
    );
  });
});

describe("incidentRegisterDataState", () => {
  const base = {
    canReadNow: true,
    forbidden: false,
    hasRows: true,
    fetching: false,
    failed: false,
  };

  it("hides cached rows whenever the live gate is closed", () => {
    expect(incidentRegisterDataState({ ...base, canReadNow: false })).toBe(
      "hidden",
    );
  });

  it("hides cached rows after an authorization refusal", () => {
    expect(incidentRegisterDataState({ ...base, forbidden: true })).toBe(
      "hidden",
    );
  });

  it("labels non-empty cached rows while refreshing or stale", () => {
    expect(incidentRegisterDataState({ ...base, fetching: true })).toBe(
      "refreshing",
    );
    expect(incidentRegisterDataState({ ...base, failed: true })).toBe("stale");
  });

  it("does not turn an empty cached page into a stale-data presentation", () => {
    expect(
      incidentRegisterDataState({
        ...base,
        hasRows: false,
        fetching: true,
      }),
    ).toBe("current");
  });
});

describe("incidentHeadline", () => {
  const zero = {
    total: 3,
    open: 3,
    overdue: 0,
    dueSoon: 0,
    staleOpen: 0,
  };

  it("leads with overdue, then due-soon, then stale", () => {
    expect(incidentHeadline({ ...zero, overdue: 2, dueSoon: 1 })).toContain(
      "2 incidents are past their legacy 72-hour operational target",
    );
    expect(incidentHeadline({ ...zero, dueSoon: 1, staleOpen: 3 })).toContain(
      "1 incident is inside the last 12 hours",
    );
    expect(incidentHeadline({ ...zero, staleOpen: 1 })).toContain(
      "open for more than 24 hours",
    );
  });

  it("says nothing at all when nothing is wrong", () => {
    expect(incidentHeadline(zero)).toBeNull();
  });
});
