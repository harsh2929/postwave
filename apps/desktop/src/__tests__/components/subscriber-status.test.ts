/**
 * subscriber-status — engine ↔ UI status mapping (Subscribers page,
 * stat strip, detail slideover).
 *
 * The high-stakes invariants:
 *   1. `disabled` / `unconfirmed` must NOT render or filter as
 *      "subscribed" (they used to — and re-saving the row select then
 *      silently flipped them to `enabled`).
 *   2. Every UI status round-trips through the engine vocabulary
 *      without drifting to a different state.
 *   3. There is no "bounced" engine status — reads fold legacy
 *      "bounced" strings into "unsubscribed", writes into
 *      `blocklisted`; the UI never offers it.
 */

import { describe, expect, it } from "vitest";

import {
  ENGINE_STATUSES,
  UI_STATUSES,
  UI_STATUS_LABELS,
  coerceUiStatus,
  engineStatusToUi,
  uiStatusToEngine,
} from "../../components/subscribers/subscriber-status";

describe("engineStatusToUi", () => {
  it("enabled/subscribed/active → subscribed", () => {
    expect(engineStatusToUi("enabled")).toBe("subscribed");
    expect(engineStatusToUi("subscribed")).toBe("subscribed");
    expect(engineStatusToUi("active")).toBe("subscribed");
    expect(engineStatusToUi("ENABLED")).toBe("subscribed");
  });

  it("blocklisted/unsubscribed → unsubscribed", () => {
    expect(engineStatusToUi("blocklisted")).toBe("unsubscribed");
    expect(engineStatusToUi("unsubscribed")).toBe("unsubscribed");
  });

  it("disabled is NOT presented as subscribed", () => {
    expect(engineStatusToUi("disabled")).toBe("disabled");
  });

  it("unconfirmed is NOT presented as subscribed", () => {
    expect(engineStatusToUi("unconfirmed")).toBe("unconfirmed");
  });

  it("legacy 'bounced' rows fold into unsubscribed (no bounced bucket)", () => {
    expect(engineStatusToUi("bounced")).toBe("unsubscribed");
  });

  it("never returns 'bounced' for any engine status", () => {
    for (const s of ENGINE_STATUSES) {
      expect(engineStatusToUi(s)).not.toBe("bounced");
    }
  });

  it("preserves unknown/missing values as visible, non-sendable unknown", () => {
    expect(engineStatusToUi(undefined)).toBe("unknown");
    expect(engineStatusToUi("")).toBe("unknown");
    expect(engineStatusToUi("weird")).toBe("unknown");
  });
});

describe("uiStatusToEngine", () => {
  it("maps each UI bucket onto the engine enum", () => {
    expect(uiStatusToEngine("subscribed")).toBe("enabled");
    expect(uiStatusToEngine("unsubscribed")).toBe("blocklisted");
    expect(uiStatusToEngine("disabled")).toBe("disabled");
    expect(uiStatusToEngine("unconfirmed")).toBe("unconfirmed");
  });

  it("legacy 'bounced' writes collapse onto blocklisted", () => {
    expect(uiStatusToEngine("bounced")).toBe("blocklisted");
  });

  it("emits valid engine statuses for recognized values and fails closed otherwise", () => {
    const inputs = [
      ...UI_STATUSES,
      ...ENGINE_STATUSES,
      "bounced",
      "active",
      "",
      "garbage",
    ];
    for (const s of inputs.slice(0, -2)) {
      const mapped = uiStatusToEngine(s);
      expect(mapped).not.toBeNull();
      expect(ENGINE_STATUSES).toContain(
        mapped as (typeof ENGINE_STATUSES)[number],
      );
    }
    expect(uiStatusToEngine("")).toBeNull();
    expect(uiStatusToEngine("garbage")).toBeNull();
  });
});

describe("round-trips (row select must not silently flip statuses)", () => {
  it("UI → engine → UI is the identity for every select option", () => {
    for (const ui of UI_STATUSES) {
      const engine = uiStatusToEngine(ui);
      expect(engine).not.toBeNull();
      expect(engineStatusToUi(engine ?? undefined)).toBe(ui);
    }
  });

  it("engine → UI → engine is the identity for every engine status", () => {
    for (const engine of ENGINE_STATUSES) {
      expect(uiStatusToEngine(engineStatusToUi(engine))).toBe(engine);
    }
  });

  it("re-saving a disabled row keeps it disabled (not enabled)", () => {
    // Regression: the select renders engineStatusToUi(row.status) and
    // writes uiStatusToEngine(selectValue). Pre-fix disabled rendered
    // as "subscribed", so an untouched re-save PATCHed `enabled`.
    const rendered = engineStatusToUi("disabled");
    expect(uiStatusToEngine(rendered)).toBe("disabled");
  });

  it("re-saving an unconfirmed row keeps it unconfirmed", () => {
    const rendered = engineStatusToUi("unconfirmed");
    expect(uiStatusToEngine(rendered)).toBe("unconfirmed");
  });
});

describe("labels", () => {
  it("every UI bucket has a label; disabled reads as Inactive", () => {
    for (const ui of UI_STATUSES) {
      expect(UI_STATUS_LABELS[ui]).toBeTruthy();
    }
    expect(UI_STATUS_LABELS.disabled).toBe("Inactive");
    expect(UI_STATUS_LABELS.unconfirmed).toBe("Unconfirmed");
    expect(UI_STATUS_LABELS.unknown).toBe("Unknown");
  });

  it("offers no Bounced label (bounce state lives in Suppressions)", () => {
    expect(Object.values(UI_STATUS_LABELS)).not.toContain("Bounced");
    expect(UI_STATUSES as readonly string[]).not.toContain("bounced");
  });
});

describe("coerceUiStatus (saved-segment filter values)", () => {
  it("accepts canonical UI buckets", () => {
    for (const ui of UI_STATUSES) {
      expect(coerceUiStatus(ui)).toBe(ui);
    }
  });

  it("folds retired/engine vocabulary into honest buckets", () => {
    expect(coerceUiStatus("bounced")).toBe("unsubscribed");
    expect(coerceUiStatus("blocklisted")).toBe("unsubscribed");
    expect(coerceUiStatus("enabled")).toBe("subscribed");
    expect(coerceUiStatus("active")).toBe("subscribed");
  });

  it("rejects values it can't honestly apply", () => {
    expect(coerceUiStatus("all")).toBeNull();
    expect(coerceUiStatus("")).toBeNull();
    expect(coerceUiStatus(42)).toBeNull();
    expect(coerceUiStatus(null)).toBeNull();
    expect(coerceUiStatus(undefined)).toBeNull();
    expect(coerceUiStatus({ op: "and" })).toBeNull();
  });
});
