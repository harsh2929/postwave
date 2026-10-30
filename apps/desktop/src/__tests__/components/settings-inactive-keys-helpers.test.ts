// Inactive-keys card helpers (full-surface wiring #23): copy never
// fabricates usage ("never used" vs "unused for N days" comes straight
// off the wire), severity ordering puts critical first, and the empty
// state explicitly affirms recent use of all keys.

import { describe, expect, it } from "vitest";

import type { InactiveKeyAlert } from "../../lib/api/inactive-keys";
import {
  inactiveKeyCopy,
  inactiveKeySeverityTone,
  inactiveKeysHeadline,
  sortInactiveKeys,
} from "../../components/settings/inactive-keys-helpers";

const key = (
  id: string,
  severity: string,
  days: number,
  neverUsed = false,
): InactiveKeyAlert => ({
  id,
  label: id,
  prefix: "pw_a",
  actor_type: "api_key",
  created_at: "2026-01-01T00:00:00Z",
  days_since_last_use: days,
  never_used: neverUsed,
  severity,
});

describe("inactiveKeySeverityTone", () => {
  it("maps server severities to badge tones", () => {
    expect(inactiveKeySeverityTone("critical")).toBe("danger");
    expect(inactiveKeySeverityTone("high")).toBe("warning");
    expect(inactiveKeySeverityTone("warn")).toBe("warning");
    expect(inactiveKeySeverityTone("???")).toBe("");
  });
});

describe("inactiveKeyCopy", () => {
  it("distinguishes never-used from gone-quiet, with pluralization", () => {
    expect(inactiveKeyCopy({ never_used: true, days_since_last_use: 0 })).toBe(
      "never used since creation",
    );
    expect(inactiveKeyCopy({ never_used: false, days_since_last_use: 1 })).toBe(
      "unused for 1 day",
    );
    expect(
      inactiveKeyCopy({ never_used: false, days_since_last_use: 45 }),
    ).toBe("unused for 45 days");
  });
});

describe("sortInactiveKeys", () => {
  it("orders critical → high → warn, then idle days desc", () => {
    const sorted = sortInactiveKeys([
      key("a", "warn", 40),
      key("b", "critical", 100),
      key("c", "high", 60),
      key("d", "warn", 90),
    ]);
    expect(sorted.map((k) => k.id)).toEqual(["b", "c", "d", "a"]);
  });
});

describe("inactiveKeysHeadline", () => {
  it("affirms recent use when the list is empty", () => {
    expect(inactiveKeysHeadline(0, 30)).toBe(
      "All API keys have been used within the last 30 days.",
    );
  });

  it("counts honestly with the threshold", () => {
    expect(inactiveKeysHeadline(1, 30)).toBe(
      "1 API key unused for 30+ days.",
    );
    expect(inactiveKeysHeadline(4, 60)).toBe(
      "4 API keys unused for 60+ days.",
    );
  });
});
