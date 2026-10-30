/**
 * The inactive-key alert card's decisions, node-run.
 *
 * Every wire shape the card can be handed — the handler's object, a `null`
 * keys, a bare array, a paged envelope, an HTML page, nothing yet — must map
 * to a state the card can name, and the card must render NOTHING (not an
 * empty box, not an all-clear) whenever there is nothing to alert about.
 */
import { describe, expect, it } from "vitest";

import {
  INACTIVE_KEYS_DENIED_COPY,
  InactiveKeysError,
  inactiveKeyCopy,
  inactiveKeySeverityTone,
  inactiveKeysCardView,
  inactiveKeysHeadline,
  isInactiveKeysDenied,
  normalizeInactiveKey,
  parseInactiveKeysPayload,
  sortInactiveKeys,
  type InactiveKeyAlert,
} from "./inactiveKeyAlerts";

/** One row exactly as inactive_keys.go:56 encodes it. */
function wireRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "k1",
    label: "CI deploy key",
    prefix: "pw_live_9f2c",
    actor_type: "human",
    created_at: "2026-03-14T10:00:00Z",
    last_used_at: "2026-05-01T10:00:00Z",
    days_since_last_use: 124,
    never_used: false,
    severity: "high",
    ...overrides,
  };
}

function alert(overrides: Partial<InactiveKeyAlert> & { id: string }): InactiveKeyAlert {
  return {
    label: "key",
    prefix: "pw_",
    actorType: "human",
    createdAt: "2026-01-01T00:00:00Z",
    daysSinceLastUse: 100,
    neverUsed: false,
    severity: "warn",
    ...overrides,
  };
}

describe("normalizeInactiveKey", () => {
  it("maps the handler's snake_case row to the card's shape", () => {
    expect(normalizeInactiveKey(wireRow())).toEqual({
      id: "k1",
      label: "CI deploy key",
      prefix: "pw_live_9f2c",
      actorType: "human",
      createdAt: "2026-03-14T10:00:00Z",
      lastUsedAt: "2026-05-01T10:00:00Z",
      daysSinceLastUse: 124,
      neverUsed: false,
      severity: "high",
    });
  });

  it("omits last_used_at when the server did (omitempty) and defaults actor_type", () => {
    const row = normalizeInactiveKey(
      wireRow({ last_used_at: undefined, actor_type: undefined, never_used: true }),
    );
    expect(row).not.toBeNull();
    expect("lastUsedAt" in (row as object)).toBe(false);
    expect(row?.actorType).toBe("human");
    expect(row?.neverUsed).toBe(true);
  });

  it("drops a row the server did not describe completely rather than inventing a number", () => {
    expect(normalizeInactiveKey(wireRow({ id: "" }))).toBeNull();
    expect(normalizeInactiveKey(wireRow({ days_since_last_use: "124" }))).toBeNull();
    expect(normalizeInactiveKey(wireRow({ days_since_last_use: Number.NaN }))).toBeNull();
    expect(normalizeInactiveKey(wireRow({ days_since_last_use: -1 }))).toBeNull();
    expect(normalizeInactiveKey(wireRow({ severity: "" }))).toBeNull();
    expect(normalizeInactiveKey(wireRow({ severity: undefined }))).toBeNull();
    expect(normalizeInactiveKey("k1")).toBeNull();
    expect(normalizeInactiveKey(null)).toBeNull();
    expect(normalizeInactiveKey([wireRow()])).toBeNull();
  });

  it("keeps an unknown severity word verbatim instead of correcting it", () => {
    expect(normalizeInactiveKey(wireRow({ severity: "urgent" }))?.severity).toBe("urgent");
  });
});

describe("parseInactiveKeysPayload", () => {
  it("reads the handler's {threshold_days, keys, count} object", () => {
    const payload = parseInactiveKeysPayload({
      threshold_days: 90,
      keys: [wireRow(), wireRow({ id: "k2" })],
      count: 2,
    });
    expect(payload?.thresholdDays).toBe(90);
    expect(payload?.keys.map((k) => k.id)).toEqual(["k1", "k2"]);
  });

  it("returns null for anything that is not the handler's object", () => {
    // Each of these has crashed a screen in this repo when `?? []` stood in
    // for a type check: undefined before the first fetch, a bare array, a
    // paged envelope with no `keys`, and an HTML SPA fallback parsed as text.
    expect(parseInactiveKeysPayload(undefined)).toBeNull();
    expect(parseInactiveKeysPayload(null)).toBeNull();
    expect(parseInactiveKeysPayload([wireRow()])).toBeNull();
    expect(parseInactiveKeysPayload({ items: [], total: 0 })).toBeNull();
    expect(parseInactiveKeysPayload("<!doctype html><html></html>")).toBeNull();
    expect(parseInactiveKeysPayload(42)).toBeNull();
  });

  it("treats a null or non-array `keys` as an empty list, never iterating it", () => {
    expect(parseInactiveKeysPayload({ threshold_days: 90, keys: null })?.keys).toEqual([]);
    expect(parseInactiveKeysPayload({ threshold_days: 90, keys: {} })?.keys).toEqual([]);
    expect(
      parseInactiveKeysPayload({ threshold_days: 90, keys: "k1,k2" })?.keys,
    ).toEqual([]);
  });

  it("drops malformed rows and keeps the well-formed ones", () => {
    const payload = parseInactiveKeysPayload({
      threshold_days: 90,
      keys: [wireRow(), null, "junk", wireRow({ id: "k3", severity: "" }), wireRow({ id: "k4" })],
    });
    expect(payload?.keys.map((k) => k.id)).toEqual(["k1", "k4"]);
  });

  it("reports no threshold rather than a made-up one when the body lacks a usable number", () => {
    expect(parseInactiveKeysPayload({ keys: [] })?.thresholdDays).toBeNull();
    expect(parseInactiveKeysPayload({ keys: [], threshold_days: 0 })?.thresholdDays).toBeNull();
    expect(parseInactiveKeysPayload({ keys: [], threshold_days: "90" })?.thresholdDays).toBeNull();
    expect(parseInactiveKeysPayload({ keys: [], threshold_days: 90.9 })?.thresholdDays).toBe(90);
  });
});

describe("copy", () => {
  it("maps the server's severity words to badge tones and everything else to neutral", () => {
    expect(inactiveKeySeverityTone("critical")).toBe("danger");
    expect(inactiveKeySeverityTone("high")).toBe("warning");
    expect(inactiveKeySeverityTone("warn")).toBe("warning");
    expect(inactiveKeySeverityTone("urgent")).toBe("neutral");
  });

  it("distinguishes never-used from gone-quiet, with the server's day count", () => {
    expect(inactiveKeyCopy({ neverUsed: true, daysSinceLastUse: 40 })).toBe(
      "never used since creation",
    );
    expect(inactiveKeyCopy({ neverUsed: false, daysSinceLastUse: 1 })).toBe(
      "unused for 1 day",
    );
    expect(inactiveKeyCopy({ neverUsed: false, daysSinceLastUse: 124 })).toBe(
      "unused for 124 days",
    );
  });

  it("writes the headline with the server's threshold, singular and plural", () => {
    expect(inactiveKeysHeadline(1, 90)).toBe("1 API key unused for 90+ days.");
    expect(inactiveKeysHeadline(3, 30)).toBe("3 API keys unused for 30+ days.");
    expect(inactiveKeysHeadline(2, null)).toBe("2 API keys flagged as inactive.");
  });
});

describe("sortInactiveKeys", () => {
  it("puts critical before high before warn, then longest-idle first, then id", () => {
    const rows = sortInactiveKeys([
      alert({ id: "warn-200", severity: "warn", daysSinceLastUse: 200 }),
      alert({ id: "high-10", severity: "high", daysSinceLastUse: 10 }),
      alert({ id: "crit-b", severity: "critical", daysSinceLastUse: 100 }),
      alert({ id: "crit-a", severity: "critical", daysSinceLastUse: 100 }),
      alert({ id: "high-50", severity: "high", daysSinceLastUse: 50 }),
      alert({ id: "odd", severity: "urgent", daysSinceLastUse: 999 }),
    ]);
    expect(rows.map((r) => r.id)).toEqual([
      "crit-a",
      "crit-b",
      "high-50",
      "high-10",
      "warn-200",
      "odd",
    ]);
  });

  it("does not mutate its input", () => {
    const input = [
      alert({ id: "b", severity: "warn" }),
      alert({ id: "a", severity: "critical" }),
    ];
    sortInactiveKeys(input);
    expect(input.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("inactiveKeysCardView", () => {
  const loaded = {
    threshold_days: 90,
    keys: [wireRow({ id: "k-warn", severity: "warn" }), wireRow({ id: "k-crit", severity: "critical" })],
    count: 2,
  };
  const base = { mayRead: true, online: true, isError: false, error: null };

  it("renders the alerts, most urgent first, under the server's headline", () => {
    const view = inactiveKeysCardView({ ...base, data: loaded });
    expect(view.kind).toBe("alerts");
    if (view.kind !== "alerts") return;
    expect(view.headline).toBe("2 API keys unused for 90+ days.");
    expect(view.thresholdDays).toBe(90);
    expect(view.keys.map((k) => k.id)).toEqual(["k-crit", "k-warn"]);
  });

  it("hides the card entirely when the report is clean — no all-clear noise", () => {
    expect(
      inactiveKeysCardView({ ...base, data: { threshold_days: 90, keys: [], count: 0 } }),
    ).toEqual({ kind: "hidden", reason: "clean" });
    expect(
      inactiveKeysCardView({ ...base, data: { threshold_days: 90, keys: null } }),
    ).toEqual({ kind: "hidden", reason: "clean" });
  });

  it("hides, rather than crashes, on a payload never proven to be the server's object", () => {
    expect(inactiveKeysCardView({ ...base, data: [wireRow()] })).toEqual({
      kind: "hidden",
      reason: "unreadable",
    });
    expect(inactiveKeysCardView({ ...base, data: { items: [] } })).toEqual({
      kind: "hidden",
      reason: "unreadable",
    });
    expect(inactiveKeysCardView({ ...base, data: null })).toEqual({
      kind: "hidden",
      reason: "unreadable",
    });
  });

  it("names loading and offline apart when nothing has arrived yet", () => {
    expect(inactiveKeysCardView({ ...base, data: undefined })).toEqual({
      kind: "hidden",
      reason: "loading",
    });
    expect(inactiveKeysCardView({ ...base, online: false, data: undefined })).toEqual({
      kind: "hidden",
      reason: "offline",
    });
  });

  it("hides below admin even when the cache holds alerts", () => {
    expect(inactiveKeysCardView({ ...base, mayRead: false, data: loaded })).toEqual({
      kind: "hidden",
      reason: "role",
    });
  });

  it("shows a failed read as a failure carrying the server's message, never as silence", () => {
    const view = inactiveKeysCardView({
      ...base,
      isError: true,
      error: new InactiveKeysError(500, "upstream unavailable"),
      data: loaded,
    });
    expect(view).toEqual({
      kind: "error",
      denied: false,
      message: "Couldn't check key activity: upstream unavailable",
    });
    expect(
      inactiveKeysCardView({ ...base, isError: true, error: new Error("   "), data: undefined }),
    ).toEqual({ kind: "error", denied: false, message: "Couldn't check key activity." });
    expect(
      inactiveKeysCardView({ ...base, isError: true, error: "string error", data: undefined }),
    ).toEqual({ kind: "error", denied: false, message: "Couldn't check key activity." });
  });

  it("reads exactly a 403 as the permission rule", () => {
    const denied = new InactiveKeysError(403, "your role does not have permission for this route");
    expect(isInactiveKeysDenied(denied)).toBe(true);
    expect(isInactiveKeysDenied(new InactiveKeysError(500, "boom"))).toBe(false);
    expect(isInactiveKeysDenied(new Error("forbidden"))).toBe(false);
    expect(
      inactiveKeysCardView({ ...base, isError: true, error: denied, data: undefined }),
    ).toEqual({ kind: "error", denied: true, message: INACTIVE_KEYS_DENIED_COPY });
  });
});
