import { describe, expect, it } from "vitest";

import {
  AB_EVALUATION_WINDOWS,
  AB_SETTINGS_DEFAULT,
  AB_WINNER_METRICS,
  AB_WINNER_PCTS,
  abSettingsCaption,
  abSettingsError,
  abSettingsFrom,
  abSettingsPayload,
  abWinnerDecided,
  type ABSettingsDraft,
} from "./abSettings";

function draft(over: Partial<ABSettingsDraft> = {}): ABSettingsDraft {
  return { ...AB_SETTINGS_DEFAULT, ...over };
}

describe("the offered options stay inside the Go validator's bounds", () => {
  it("only offers metrics the server accepts", () => {
    // handlers.go SetSettings 400s on anything else.
    expect(AB_WINNER_METRICS.map((m) => m.value)).toEqual([
      "open_rate",
      "click_rate",
      "reply_rate",
    ]);
  });

  it("never offers a non-positive evaluation window", () => {
    for (const hours of AB_EVALUATION_WINDOWS) {
      expect(hours).toBeGreaterThan(0);
      expect(abSettingsError(draft({ evaluationWindowHours: hours }))).toBeNull();
    }
  });

  it("only offers winner shares in 0..100", () => {
    for (const pct of AB_WINNER_PCTS) {
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
      expect(abSettingsError(draft({ winnerRecipientsPct: pct }))).toBeNull();
    }
  });
});

describe("abSettingsFrom", () => {
  it("reads a populated settings row", () => {
    expect(
      abSettingsFrom({
        winner_metric: "click_rate",
        evaluation_window_hours: 48,
        winner_recipients_pct: 75,
      }),
    ).toEqual({
      winnerMetric: "click_rate",
      evaluationWindowHours: 48,
      winnerRecipientsPct: 75,
    });
  });

  it("falls back to the server's own defaults when no row exists", () => {
    // GetAB returns a zero-valued settings object rather than 404 when the
    // campaign has never been configured; a zero window is NOT "0 hours".
    expect(abSettingsFrom(null)).toEqual(AB_SETTINGS_DEFAULT);
    expect(
      abSettingsFrom({
        winner_metric: "",
        evaluation_window_hours: 0,
        winner_recipients_pct: 0,
      }),
    ).toEqual({
      winnerMetric: "open_rate",
      evaluationWindowHours: 24,
      // 0 IS a legal share ("don't send to anyone else"), so it survives.
      winnerRecipientsPct: 0,
    });
  });

  it("rejects an out-of-range share from the wire", () => {
    expect(
      abSettingsFrom({ winner_recipients_pct: 900 }).winnerRecipientsPct,
    ).toBe(100);
  });
});

describe("abSettingsError", () => {
  it("refuses values the server would 400 on, before the round trip", () => {
    expect(abSettingsError(draft({ evaluationWindowHours: 0 }))).toContain(
      "at least one hour",
    );
    expect(abSettingsError(draft({ winnerRecipientsPct: 101 }))).toContain(
      "between 0% and 100%",
    );
    expect(
      abSettingsError(draft({ winnerMetric: "bogus" as never })),
    ).toContain("winner metric");
  });

  it("accepts the defaults", () => {
    expect(abSettingsError(draft())).toBeNull();
  });
});

describe("abSettingsPayload", () => {
  it("emits exactly the wire field names the handler decodes", () => {
    expect(abSettingsPayload(draft())).toEqual({
      winner_metric: "open_rate",
      evaluation_window_hours: 24,
      winner_recipients_pct: 100,
    });
  });
});

describe("abSettingsCaption", () => {
  it("states the consequence in whole words", () => {
    expect(abSettingsCaption(draft({ winnerRecipientsPct: 100 }))).toContain(
      "the whole remaining audience",
    );
    expect(abSettingsCaption(draft({ winnerRecipientsPct: 0 }))).toContain(
      "no further recipients",
    );
    expect(abSettingsCaption(draft({ winnerRecipientsPct: 40 }))).toContain(
      "40% of the remaining audience",
    );
  });
});

describe("abWinnerDecided", () => {
  it("is true once the server has picked", () => {
    expect(abWinnerDecided({ winner_decided_at: "2026-07-01T00:00:00Z" })).toBe(
      true,
    );
    expect(abWinnerDecided({ winning_variant_id: "v2" })).toBe(true);
  });

  it("is false for an undecided or absent view", () => {
    expect(abWinnerDecided({})).toBe(false);
    expect(abWinnerDecided(null)).toBe(false);
    expect(abWinnerDecided({ winner_decided_at: null })).toBe(false);
  });
});
