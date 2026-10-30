import { describe, expect, it } from "vitest";

import {
  AUDIT_TAIL_PROBE_LIMIT,
  auditTailExplanation,
  auditTailStreamRefreshDelay,
  AUDIT_TAIL_STREAM_MIN_REFRESH_MS,
  isAuditStreamRowFrame,
  auditStreamFrameAction,
  auditStreamFrameTriggersProbe,
  isSelfInflictedAuditAction,
  auditTailLabel,
  countNewerRows,
  newestAuditId,
} from "./auditTail";

describe("countNewerRows", () => {
  it("counts strictly-newer ids only", () => {
    const rows = [{ id: 12 }, { id: 11 }, { id: 10 }, { id: 9 }];
    // 10 is the newest row already on screen, so it is not new.
    expect(countNewerRows(rows, 10)).toBe(2);
  });

  it("reports zero — not everything — when nothing is loaded", () => {
    expect(countNewerRows([{ id: 5 }, { id: 4 }], null)).toBe(0);
  });

  it("ignores rows with a missing or non-numeric id", () => {
    const rows = [{ id: 12 }, { id: null }, {}, { id: 13 }];
    expect(countNewerRows(rows, 10)).toBe(2);
  });

  it("returns zero for an empty probe", () => {
    expect(countNewerRows([], 10)).toBe(0);
  });
});

describe("newestAuditId", () => {
  it("takes the maximum rather than the first row", () => {
    // The list is id-DESC today, but a cache rehydrated from an older build
    // must not be trusted to be ordered.
    expect(newestAuditId([{ id: 4 }, { id: 9 }, { id: 7 }])).toBe(9);
  });

  it("is null for an empty or unusable list", () => {
    expect(newestAuditId([])).toBeNull();
    expect(newestAuditId([{ id: null }, {}])).toBeNull();
  });
});

describe("auditTailLabel", () => {
  it("says nothing when the tail is off or nothing is new", () => {
    expect(auditTailLabel({ count: 3, atLeast: false, live: false })).toBeNull();
    expect(auditTailLabel({ count: 0, atLeast: false, live: true })).toBeNull();
  });

  it("singularises one event", () => {
    expect(auditTailLabel({ count: 1, atLeast: false, live: true })).toBe(
      "1 new event — tap to load",
    );
  });

  it("marks a saturated probe as a lower bound", () => {
    expect(
      auditTailLabel({
        count: AUDIT_TAIL_PROBE_LIMIT,
        atLeast: true,
        live: true,
      }),
    ).toBe("50+ new events — tap to load");
  });
});

describe("auditTailExplanation", () => {
  it("says it is a poll, not a stream", () => {
    expect(auditTailExplanation(true)).toContain("every 20s");
    expect(auditTailExplanation(true)).toContain("counted, not inserted");
  });

  it("explains the off state without claiming anything about the log", () => {
    expect(auditTailExplanation(false)).toContain("Live off");
  });
});

describe("auditTailStreamRefreshDelay", () => {
  it("acts immediately when nothing has been re-checked yet", () => {
    expect(auditTailStreamRefreshDelay(null, 1_000)).toBe(0);
  });

  it("acts immediately once the cooldown has elapsed", () => {
    expect(auditTailStreamRefreshDelay(1_000, 1_000 + AUDIT_TAIL_STREAM_MIN_REFRESH_MS)).toBe(0);
    expect(auditTailStreamRefreshDelay(1_000, 99_000)).toBe(0);
  });

  it("returns the REMAINING cooldown so a burst collapses into one re-check", () => {
    // The audit stream emits one frame per row. Without this, a busy tenant
    // turns the cheapest tail in the product into the most expensive read.
    expect(auditTailStreamRefreshDelay(1_000, 1_500)).toBe(
      AUDIT_TAIL_STREAM_MIN_REFRESH_MS - 500,
    );
  });

  it("never produces a negative delay when the clock goes backwards", () => {
    expect(auditTailStreamRefreshDelay(5_000, 1_000)).toBe(
      AUDIT_TAIL_STREAM_MIN_REFRESH_MS,
    );
  });

  it("honours an explicit interval", () => {
    expect(auditTailStreamRefreshDelay(1_000, 1_100, 1_000)).toBe(900);
  });
});

describe("isAuditStreamRowFrame", () => {
  it("accepts only the per-row event", () => {
    expect(isAuditStreamRowFrame({ event: "audit" })).toBe(true);
    expect(isAuditStreamRowFrame({ event: " audit " })).toBe(true);
  });

  it("rejects the connect cursor seed — it describes history, not an arrival", () => {
    expect(isAuditStreamRowFrame({ event: "hello" })).toBe(false);
  });

  it("rejects anything else", () => {
    expect(isAuditStreamRowFrame({ event: "" })).toBe(false);
    expect(isAuditStreamRowFrame({ event: "message" })).toBe(false);
  });
});

describe("auditStreamFrameAction", () => {
  it("reads the action out of the row payload", () => {
    expect(
      auditStreamFrameAction('{"id":43,"action":"campaign.sent"}'),
    ).toBe("campaign.sent");
  });

  it("returns null for anything it cannot read an action from", () => {
    expect(auditStreamFrameAction("")).toBeNull();
    expect(auditStreamFrameAction("not json")).toBeNull();
    expect(auditStreamFrameAction("null")).toBeNull();
    expect(auditStreamFrameAction("[1,2]")).toBeNull();
    expect(auditStreamFrameAction('{"id":43}')).toBeNull();
    expect(auditStreamFrameAction('{"action":42}')).toBeNull();
    expect(auditStreamFrameAction('{"action":"   "}')).toBeNull();
  });
});

describe("isSelfInflictedAuditAction", () => {
  it("names the meta-read actions the audit surface generates about itself", () => {
    // These are the exact strings AuditMetaMiddleware writes
    // (apps/api/internal/middleware/audit_meta.go).
    expect(isSelfInflictedAuditAction("audit.read.list")).toBe(true);
    expect(isSelfInflictedAuditAction("audit.read.stream_open")).toBe(true);
    expect(isSelfInflictedAuditAction("http.request")).toBe(true);
  });

  it("leaves real workspace activity alone", () => {
    expect(isSelfInflictedAuditAction("campaign.sent")).toBe(false);
    expect(isSelfInflictedAuditAction("subscriber.deleted")).toBe(false);
    // Near-misses must not be swallowed: `audit.read` is not a prefix match
    // for `audit.read.`, and these are real operator actions on audit config.
    expect(isSelfInflictedAuditAction("audit.retention.updated")).toBe(false);
    expect(isSelfInflictedAuditAction("audit.export.created")).toBe(false);
  });
});

describe("auditStreamFrameTriggersProbe", () => {
  // THE FEEDBACK LOOP. The tail's own probe is `GET /api/v1/audit`, which
  // AuditMetaMiddleware records as an `audit.read.list` row; the stream's row
  // query has no action filter, so that row comes straight back as
  // `event: audit`. Classifying on the event NAME alone made the tail re-fire
  // itself every AUDIT_TAIL_STREAM_MIN_REFRESH_MS on a completely idle tenant.
  it("does not act on the row the tail's own probe just wrote", () => {
    expect(
      auditStreamFrameTriggersProbe({
        event: "audit",
        data: '{"id":44,"action":"audit.read.list","actorType":"user"}',
      }),
    ).toBe(false);
  });

  it("does not act on the row opening this very stream wrote", () => {
    expect(
      auditStreamFrameTriggersProbe({
        event: "audit",
        data: '{"id":45,"action":"audit.read.stream_open"}',
      }),
    ).toBe(false);
  });

  it("does not act on the generic http meta-trail either", () => {
    expect(
      auditStreamFrameTriggersProbe({
        event: "audit",
        data: '{"id":46,"action":"http.request"}',
      }),
    ).toBe(false);
  });

  it("still acts on real workspace activity", () => {
    expect(
      auditStreamFrameTriggersProbe({
        event: "audit",
        data: '{"id":47,"action":"campaign.sent"}',
      }),
    ).toBe(true);
  });

  it("still ignores the connect cursor seed", () => {
    expect(
      auditStreamFrameTriggersProbe({
        event: "hello",
        data: '{"sinceId":42}',
      }),
    ).toBe(false);
  });

  it("fails CLOSED on a payload whose action cannot be read", () => {
    // An unreadable frame is not evidence that it is not our own read, and the
    // defect being fixed is a self-sustaining request loop. The 20s poll is
    // untouched, so failing closed costs freshness and nothing else.
    expect(
      auditStreamFrameTriggersProbe({ event: "audit", data: "not json" }),
    ).toBe(false);
    expect(auditStreamFrameTriggersProbe({ event: "audit", data: "" })).toBe(
      false,
    );
    expect(
      auditStreamFrameTriggersProbe({ event: "audit", data: '{"id":48}' }),
    ).toBe(false);
  });
});
