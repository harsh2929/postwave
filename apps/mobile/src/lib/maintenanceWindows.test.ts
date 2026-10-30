import { describe, expect, it } from "vitest";

import {
  defaultMaintenanceDraft,
  groupMaintenanceWindows,
  isMaintenanceSurfaceHidden,
  maintenanceActionsFor,
  maintenanceErrorMessage,
  maintenancePhase,
  maintenancePhaseLabel,
  maintenancePhaseTone,
  normalizeMaintenanceWindows,
  parseMaintenanceComponents,
  validateMaintenanceDraft,
  type MaintenanceWindowView,
} from "@/lib/maintenanceWindows";

const NOW = new Date("2026-09-02T12:00:00.000Z").getTime();

function win(over: Partial<MaintenanceWindowView> = {}): MaintenanceWindowView {
  return {
    id: "w1",
    title: "DB failover",
    description: "",
    components: ["api"],
    startsAt: "2026-09-03T01:00:00.000Z",
    endsAt: "2026-09-03T02:00:00.000Z",
    status: "scheduled",
    platform: false,
    ...over,
  };
}

describe("normalizeMaintenanceWindows", () => {
  it("reads the handler's rows and marks platform-wide ones", () => {
    const rows = normalizeMaintenanceWindows({
      windows: [
        {
          id: "a",
          tenant_id: "t1",
          title: " DB failover ",
          description: "swap primary",
          components: ["api", "api", " smtp "],
          starts_at: "2026-09-03T01:00:00Z",
          ends_at: "2026-09-03T02:00:00Z",
          status: "scheduled",
        },
        {
          id: "b",
          tenant_id: null,
          title: "",
          starts_at: "2026-09-04T01:00:00Z",
          ends_at: "2026-09-04T02:00:00Z",
        },
      ],
    });
    expect(rows).toEqual([
      {
        id: "a",
        title: "DB failover",
        description: "swap primary",
        components: ["api", "smtp"],
        startsAt: "2026-09-03T01:00:00Z",
        endsAt: "2026-09-03T02:00:00Z",
        status: "scheduled",
        platform: false,
      },
      {
        id: "b",
        title: "Untitled window",
        description: "",
        components: [],
        startsAt: "2026-09-04T01:00:00Z",
        endsAt: "2026-09-04T02:00:00Z",
        status: "scheduled",
        platform: true,
      },
    ]);
  });

  it("drops rows without an id or a time range, and tolerates null", () => {
    expect(normalizeMaintenanceWindows(null)).toEqual([]);
    expect(
      normalizeMaintenanceWindows({
        windows: [{ id: "x" }, { starts_at: "a", ends_at: "b" }, null],
      }),
    ).toEqual([]);
  });
});

describe("maintenancePhase", () => {
  it("lets an operator's status win, then the clock", () => {
    expect(maintenancePhase(win({ status: "cancelled" }), NOW)).toBe("cancelled");
    expect(maintenancePhase(win({ status: "completed" }), NOW)).toBe("completed");
    expect(maintenancePhase(win({ status: "in_progress" }), NOW)).toBe("active");
    expect(maintenancePhase(win(), NOW)).toBe("upcoming");
    expect(
      maintenancePhase(
        win({
          startsAt: "2026-09-02T11:00:00.000Z",
          endsAt: "2026-09-02T13:00:00.000Z",
        }),
        NOW,
      ),
    ).toBe("active");
    expect(
      maintenancePhase(
        win({
          startsAt: "2026-09-01T11:00:00.000Z",
          endsAt: "2026-09-01T13:00:00.000Z",
        }),
        NOW,
      ),
    ).toBe("past");
    expect(maintenancePhase(win({ startsAt: "junk" }), NOW)).toBe("past");
  });

  it("labels and tones every phase with a word, never colour alone", () => {
    expect(maintenancePhaseLabel("active")).toBe("Active");
    expect(maintenancePhaseLabel("upcoming")).toBe("Upcoming");
    expect(maintenancePhaseLabel("past")).toBe("Past");
    expect(maintenancePhaseLabel("completed")).toBe("Completed");
    expect(maintenancePhaseLabel("cancelled")).toBe("Cancelled");
    expect(maintenancePhaseTone("active")).toBe("warning");
    expect(maintenancePhaseTone("upcoming")).toBe("info");
    expect(maintenancePhaseTone("completed")).toBe("success");
    expect(maintenancePhaseTone("cancelled")).toBe("neutral");
  });
});

describe("groupMaintenanceWindows", () => {
  it("puts the soonest active/upcoming on top and the newest past first", () => {
    const groups = groupMaintenanceWindows(
      [
        win({ id: "later", startsAt: "2026-09-05T01:00:00.000Z", endsAt: "2026-09-05T02:00:00.000Z" }),
        win({ id: "old", startsAt: "2026-08-01T01:00:00.000Z", endsAt: "2026-08-01T02:00:00.000Z" }),
        win({ id: "soon" }),
        win({ id: "live", status: "in_progress" }),
        win({ id: "older", startsAt: "2026-07-01T01:00:00.000Z", endsAt: "2026-07-01T02:00:00.000Z", status: "completed" }),
      ],
      NOW,
    );
    expect(groups.active.map((w) => w.id)).toEqual(["live"]);
    expect(groups.upcoming.map((w) => w.id)).toEqual(["soon", "later"]);
    expect(groups.past.map((w) => w.id)).toEqual(["old", "older"]);
  });
});

describe("validateMaintenanceDraft", () => {
  const base = {
    ...defaultMaintenanceDraft(NOW),
    title: "Rotate certs",
    description: " renew ",
    components: "api, smtp",
  };

  it("mirrors the handler's rejections in order", () => {
    expect(validateMaintenanceDraft({ ...base, title: "  " }, NOW)).toEqual({
      ok: false,
      message: "Give the window a title.",
    });
    expect(
      validateMaintenanceDraft({ ...base, endsAt: base.startsAt }, NOW),
    ).toEqual({ ok: false, message: "The window must end after it starts." });
    expect(
      validateMaintenanceDraft(
        {
          ...base,
          startsAt: new Date(NOW - 2 * 60 * 60_000),
          endsAt: new Date(NOW + 60_000),
        },
        NOW,
      ),
    ).toEqual({ ok: false, message: "The window must start in the future." });
    expect(
      validateMaintenanceDraft({ ...base, startsAt: new Date("junk") }, NOW).ok,
    ).toBe(false);
  });

  it("allows the handler's one-hour skew tolerance", () => {
    const result = validateMaintenanceDraft(
      {
        ...base,
        startsAt: new Date(NOW - 30 * 60_000),
        endsAt: new Date(NOW + 30 * 60_000),
      },
      NOW,
    );
    expect(result.ok).toBe(true);
  });

  it("yields the exact POST body, trimmed and de-duplicated", () => {
    const result = validateMaintenanceDraft(base, NOW);
    expect(result).toEqual({
      ok: true,
      body: {
        title: "Rotate certs",
        description: "renew",
        components: ["api", "smtp"],
        starts_at: base.startsAt.toISOString(),
        ends_at: base.endsAt.toISOString(),
      },
    });
  });

  it("defaults to the next whole hour, one hour long", () => {
    const draft = defaultMaintenanceDraft(NOW);
    expect(draft.startsAt.getTime()).toBeGreaterThan(NOW);
    expect(draft.startsAt.getMinutes()).toBe(0);
    expect(draft.endsAt.getTime() - draft.startsAt.getTime()).toBe(60 * 60_000);
  });

  it("parses comma-separated components", () => {
    expect(parseMaintenanceComponents("api, smtp,, api ")).toEqual(["api", "smtp"]);
    expect(parseMaintenanceComponents("")).toEqual([]);
  });
});

describe("maintenanceActionsFor", () => {
  it("offers start+cancel while scheduled and complete+cancel while running", () => {
    expect(maintenanceActionsFor(win(), true).map((a) => a.key)).toEqual([
      "start",
      "cancel",
    ]);
    expect(
      maintenanceActionsFor(win({ status: "in_progress" }), true).map((a) => a.key),
    ).toEqual(["complete", "cancel"]);
    expect(maintenanceActionsFor(win(), true)[0]?.status).toBe("in_progress");
    expect(maintenanceActionsFor(win(), true)[1]?.destructive).toBe(true);
  });

  it("offers nothing to non-admins, on platform-wide rows, or once history", () => {
    expect(maintenanceActionsFor(win(), false)).toEqual([]);
    expect(maintenanceActionsFor(win({ platform: true }), true)).toEqual([]);
    expect(maintenanceActionsFor(win({ status: "completed" }), true)).toEqual([]);
    expect(maintenanceActionsFor(win({ status: "cancelled" }), true)).toEqual([]);
  });
});

describe("maintenanceErrorMessage", () => {
  it("names the role floor on 403, repeats a 400 verbatim, falls back otherwise", () => {
    expect(maintenanceErrorMessage({ status: 403, message: "no" })).toMatch(
      /workspace admins/,
    );
    expect(
      maintenanceErrorMessage({
        status: 400,
        code: "starts_in_past",
        message: "starts_at must be in the future (1h tolerance for clock skew)",
      }),
    ).toBe("starts_at must be in the future (1h tolerance for clock skew)");
    expect(maintenanceErrorMessage({ status: 0, message: "" })).toBe(
      "Couldn't update the maintenance window.",
    );
  });
});

describe("isMaintenanceSurfaceHidden", () => {
  it("hides on the statuses that mean 'not this reader's to see'", () => {
    // A plain Error carrying the envelope's status — what the section's
    // queryFn throws — not a class the card would have to know about.
    expect(
      isMaintenanceSurfaceHidden(Object.assign(new Error("forbidden"), { status: 403 })),
    ).toBe(true);
    expect(isMaintenanceSurfaceHidden({ status: 404 })).toBe(true);
    expect(isMaintenanceSurfaceHidden({ status: 501 })).toBe(true);
    // A lapsed session is the shell's problem, not this card's.
    expect(isMaintenanceSurfaceHidden({ status: 401 })).toBe(true);
  });

  it("keeps an outage, a bad request and junk as errors the card shows", () => {
    expect(isMaintenanceSurfaceHidden({ status: 500 })).toBe(false);
    expect(isMaintenanceSurfaceHidden({ status: 503 })).toBe(false);
    expect(isMaintenanceSurfaceHidden({ status: 400 })).toBe(false);
    expect(isMaintenanceSurfaceHidden(new Error("no status"))).toBe(false);
    expect(isMaintenanceSurfaceHidden(null)).toBe(false);
    expect(isMaintenanceSurfaceHidden("403")).toBe(false);
  });
});
