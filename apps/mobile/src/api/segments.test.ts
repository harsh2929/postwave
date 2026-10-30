import { describe, expect, it, vi } from "vitest";

vi.mock("@/api/sdkClient", () => ({ getClient: vi.fn() }));

// eslint-disable-next-line import/first
import { parseSegment, parseSegmentList, parseSizeHistory } from "./segments";

const WIRE = {
  id: "seg-1",
  tenantId: "t1",
  name: "Champions",
  description: "RFM champions",
  queryAst: { op: "condition", field: "rfm.segment_key", value: "champions" },
  lastCount: 1204,
  lastEvaluatedAt: "2026-07-01T10:00:00Z",
  isTemplate: false,
  includeArchived: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-07-01T10:00:00Z",
};

describe("parseSegment", () => {
  it("reads the camelCase wire shape the Go handler emits", () => {
    expect(parseSegment(WIRE)).toEqual({
      id: "seg-1",
      name: "Champions",
      description: "RFM champions",
      queryAst: WIRE.queryAst,
      lastCount: 1204,
      lastEvaluatedAt: "2026-07-01T10:00:00Z",
      isTemplate: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-07-01T10:00:00Z",
    });
  });

  it("also accepts snake_case, so an envelope change doesn't blank the screen", () => {
    const parsed = parseSegment({
      id: "seg-2",
      name: "Lapsed",
      query_ast: { op: "condition" },
      last_count: 7,
      last_evaluated_at: "2026-07-01T10:00:00Z",
      is_template: true,
    });
    expect(parsed?.lastCount).toBe(7);
    expect(parsed?.isTemplate).toBe(true);
    expect(parsed?.queryAst).toEqual({ op: "condition" });
  });

  it("keeps an unevaluated segment's size NULL, never 0", () => {
    // "never evaluated" and "matches nobody" are different facts and the
    // screen renders them differently.
    const parsed = parseSegment({ id: "seg-3", name: "New" });
    expect(parsed?.lastCount).toBeNull();
    expect(parsed?.lastEvaluatedAt).toBeNull();
  });

  it("falls back to a usable name", () => {
    expect(parseSegment({ id: "seg-4" })?.name).toBe("Segment seg-4");
  });

  it("rejects rows with no id and non-objects", () => {
    expect(parseSegment({ name: "orphan" })).toBeNull();
    expect(parseSegment(null)).toBeNull();
    expect(parseSegment("nope")).toBeNull();
    expect(parseSegment([WIRE])).toBeNull();
  });
});

describe("parseSegmentList", () => {
  it("reads the BARE ARRAY the handler actually returns", () => {
    // The SDK types this as {items, next_cursor}; the server sends an array.
    // Getting this wrong renders an empty workspace.
    expect(parseSegmentList([WIRE]).map((s) => s.id)).toEqual(["seg-1"]);
  });

  it("also reads an {items} envelope if one ever lands", () => {
    expect(parseSegmentList({ items: [WIRE] }).map((s) => s.id)).toEqual([
      "seg-1",
    ]);
  });

  it("drops unusable rows instead of rendering dead taps", () => {
    expect(parseSegmentList([WIRE, null, 5, { name: "no id" }])).toHaveLength(1);
  });

  it("returns [] for every other shape", () => {
    expect(parseSegmentList(null)).toEqual([]);
    expect(parseSegmentList({})).toEqual([]);
    expect(parseSegmentList("nope")).toEqual([]);
  });
});

describe("parseSizeHistory", () => {
  it("reads the series and the server's honesty note", () => {
    expect(
      parseSizeHistory({
        segment_id: "seg-1",
        window_days: 30,
        series: [
          { evaluated_at: "2026-06-01T00:00:00Z", count: 100 },
          { evaluated_at: "2026-06-02T00:00:00Z", count: 120 },
        ],
        note: "segment_size_history table not yet provisioned",
      }),
    ).toEqual({
      series: [
        { at: "2026-06-01T00:00:00Z", count: 100 },
        { at: "2026-06-02T00:00:00Z", count: 120 },
      ],
      windowDays: 30,
      note: "segment_size_history table not yet provisioned",
    });
  });

  it("drops points missing a timestamp or a count rather than charting NaN", () => {
    const history = parseSizeHistory({
      series: [
        { count: 5 },
        { evaluated_at: "2026-06-01T00:00:00Z" },
        { evaluated_at: "2026-06-02T00:00:00Z", count: 7 },
        null,
      ],
    });
    expect(history.series).toEqual([{ at: "2026-06-02T00:00:00Z", count: 7 }]);
  });

  it("keeps a legitimate zero count", () => {
    expect(
      parseSizeHistory({ series: [{ evaluated_at: "x", count: 0 }] }).series,
    ).toEqual([{ at: "x", count: 0 }]);
  });

  it("defaults the window and reports no note", () => {
    expect(parseSizeHistory({})).toEqual({
      series: [],
      windowDays: 90,
      note: null,
    });
    expect(parseSizeHistory(null).series).toEqual([]);
  });
});
