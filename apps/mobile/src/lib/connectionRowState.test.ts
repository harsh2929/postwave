import { describe, expect, it } from "vitest";

import type { ConnectionRow } from "./connectionLifecycle";
import {
  connectionIsDisconnected,
  connectionRollup,
  connectionRowSummary,
  connectionRowTone,
  connectionRowVerbs,
  connectionVerbErrorMessage,
  rollupSentence,
} from "./connectionRowState";

/** api/connectionFamilies.ts: marketing and the five P2.39 families. */
const NO_RESUME = ["sync", "backfill", "pause", "disconnect"] as const;
/** api/connectionFamilies.ts: write-back targets. */
const WITH_RESUME = ["run", "pause", "resume", "disconnect"] as const;

function row(over: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "a1",
    name: "Segment",
    status: "active",
    lastRunAt: "",
    errorMessage: "",
    ...over,
  };
}

describe("connectionIsDisconnected", () => {
  it("matches the status the families' lists return, case- and space-insensitively", () => {
    expect(connectionIsDisconnected("disconnected")).toBe(true);
    expect(connectionIsDisconnected(" Disconnected ")).toBe(true);
    expect(connectionIsDisconnected("active")).toBe(false);
    expect(connectionIsDisconnected("")).toBe(false);
  });
});

describe("connectionRowTone", () => {
  it("never paints a disconnected row green", () => {
    expect(connectionRowTone("disconnected")).toBe("neutral");
  });

  it("keeps the lifecycle's tones for the rest", () => {
    expect(connectionRowTone("error")).toBe("warning");
    expect(connectionRowTone("failed")).toBe("warning");
    expect(connectionRowTone("paused")).toBe("neutral");
    expect(connectionRowTone("active")).toBe("success");
  });
});

describe("connectionRowSummary", () => {
  it("says a disconnected row must be reconnected from the web admin", () => {
    expect(connectionRowSummary(row({ status: "disconnected" }))).toBe(
      "Disconnected. Reconnect it from the web admin before it can run again.",
    );
  });

  it("defers to the lifecycle summary otherwise", () => {
    expect(connectionRowSummary(row({ status: "paused" }))).toMatch(/^Paused\./);
    expect(
      connectionRowSummary(
        row({ status: "error", errorMessage: "401 from Segment" }),
      ),
    ).toBe("Failing — 401 from Segment");
    expect(connectionRowSummary(row({ status: "active" }))).toBe("Healthy.");
  });
});

describe("connectionRowVerbs", () => {
  it("offers nothing on a disconnected row — every verb would answer 409", () => {
    expect(connectionRowVerbs(NO_RESUME, "disconnected")).toEqual([]);
    expect(connectionRowVerbs(WITH_RESUME, "Disconnected")).toEqual([]);
  });

  it("otherwise offers the family's own verbs for the row's state", () => {
    expect(connectionRowVerbs(NO_RESUME, "active")).toEqual([
      "sync",
      "backfill",
      "pause",
      "disconnect",
    ]);
    // No resume route in these families: a paused row keeps sync/backfill and
    // never grows a Resume button the server has no endpoint for.
    expect(connectionRowVerbs(NO_RESUME, "paused")).toEqual([
      "sync",
      "backfill",
      "disconnect",
    ]);
    expect(connectionRowVerbs(WITH_RESUME, "paused")).toEqual([
      "resume",
      "disconnect",
    ]);
  });
});

describe("connectionVerbErrorMessage", () => {
  const FALLBACK = "Couldn't sync now Segment.";
  // analytics_integrations/handlers.go:354 and :538, verbatim.
  const PAYLOAD_REQUIRED =
    "analytics sync/backfill requires canonical profiles or events; no provider puller is wired for this provider";
  const DISCONNECTED =
    "analytics integration is disconnected; reconnect it before syncing or mutating it";

  it("keeps the server's sentence for a row-level 4xx verdict", () => {
    expect(
      connectionVerbErrorMessage(
        { status: 422, message: PAYLOAD_REQUIRED },
        FALLBACK,
      ),
    ).toBe(PAYLOAD_REQUIRED);
    expect(
      connectionVerbErrorMessage({ status: 409, message: DISCONNECTED }, FALLBACK),
    ).toBe(DISCONNECTED);
  });

  it("defers to the classified copy for auth, missing, and rate-limit statuses", () => {
    for (const status of [401, 403, 404, 429]) {
      expect(
        connectionVerbErrorMessage({ status, message: "raw server text" }, FALLBACK),
      ).toBe(FALLBACK);
    }
  });

  it("defers for 5xx, for a blank message, and for anything that is not an error object", () => {
    expect(
      connectionVerbErrorMessage({ status: 500, message: "internal" }, FALLBACK),
    ).toBe(FALLBACK);
    expect(connectionVerbErrorMessage({ status: 422, message: "   " }, FALLBACK)).toBe(
      FALLBACK,
    );
    expect(connectionVerbErrorMessage({ status: 422 }, FALLBACK)).toBe(FALLBACK);
    expect(connectionVerbErrorMessage({ message: "no status" }, FALLBACK)).toBe(
      FALLBACK,
    );
    expect(connectionVerbErrorMessage(null, FALLBACK)).toBe(FALLBACK);
    expect(connectionVerbErrorMessage("422", FALLBACK)).toBe(FALLBACK);
    expect(
      connectionVerbErrorMessage(new TypeError("Network request failed"), FALLBACK),
    ).toBe(FALLBACK);
  });
});

describe("connectionRollup", () => {
  it("tallies the rows a family list returned", () => {
    expect(
      connectionRollup([
        row({ status: "active" }),
        row({ status: "error" }),
        row({ status: "failed" }),
        row({ status: "paused" }),
        row({ status: "disconnected" }),
      ]),
    ).toEqual({ total: 5, failing: 2, paused: 1, disconnected: 1 });
  });

  it("counts an unknown status toward the total and nothing else", () => {
    expect(
      connectionRollup([row({ status: "" }), row({ status: "provisioning" })]),
    ).toEqual({ total: 2, failing: 0, paused: 0, disconnected: 0 });
  });

  it("is all zeros for anything that is not an array, and skips non-object entries", () => {
    const zero = { total: 0, failing: 0, paused: 0, disconnected: 0 };
    expect(connectionRollup(undefined)).toEqual(zero);
    expect(connectionRollup(null)).toEqual(zero);
    expect(connectionRollup({ items: [row()] })).toEqual(zero);
    expect(connectionRollup([null, 3, "x", row({ status: "error" })])).toEqual({
      total: 1,
      failing: 1,
      paused: 0,
      disconnected: 0,
    });
  });
});

describe("rollupSentence", () => {
  it("names the total and only the non-zero clauses", () => {
    expect(
      rollupSentence(
        { total: 3, failing: 1, paused: 1, disconnected: 0 },
        "destination",
      ),
    ).toBe("3 destinations · 1 failing · 1 paused");
    expect(
      rollupSentence(
        { total: 2, failing: 0, paused: 0, disconnected: 2 },
        "destination",
      ),
    ).toBe("2 destinations · 2 disconnected");
  });

  it("is singular for one row and never says '0 failing'", () => {
    const one = rollupSentence(
      { total: 1, failing: 0, paused: 0, disconnected: 0 },
      "destination",
    );
    expect(one).toBe("1 destination");
    expect(one).not.toMatch(/0 /);
  });

  it("is empty when there are no rows — an absence is not a sentence", () => {
    expect(
      rollupSentence(
        { total: 0, failing: 0, paused: 0, disconnected: 0 },
        "destination",
      ),
    ).toBe("");
  });
});
