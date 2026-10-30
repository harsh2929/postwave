import { describe, expect, it } from "vitest";

import {
  engineStatusToUi,
  ENGINE_STATUSES,
  statusFilterByKey,
  statusFilterNoun,
  SUBSCRIBER_STATUS_FILTERS,
  subscriberStatusAccessibilityLabel,
  subscriberStatusLabel,
  subscriberStatusTone,
  UI_STATUS_LABELS,
  uiStatusToEngine,
} from "./subscriberStatus";

describe("uiStatusToEngine", () => {
  it("maps unsubscribed to blocklisted, matching desktop AND web", () => {
    // The bug this module exists to fix: mobile used to write `disabled`
    // for the same button desktop/web use to write `blocklisted`.
    expect(uiStatusToEngine("unsubscribed")).toBe("blocklisted");
  });

  it("keeps Inactive on its own engine state", () => {
    expect(uiStatusToEngine("disabled")).toBe("disabled");
    expect(uiStatusToEngine("inactive")).toBe("disabled");
  });

  it("collapses the retired 'bounced' vocabulary onto blocklisted", () => {
    expect(uiStatusToEngine("bounced")).toBe("blocklisted");
  });

  it("fails closed on anything it cannot honestly map", () => {
    expect(uiStatusToEngine("cleaned")).toBeNull();
    expect(uiStatusToEngine("")).toBeNull();
    expect(uiStatusToEngine(undefined)).toBeNull();
    expect(uiStatusToEngine("  ")).toBeNull();
  });

  it("accepts engine values verbatim (idempotent at the write boundary)", () => {
    for (const s of ENGINE_STATUSES) {
      expect(uiStatusToEngine(s)).toBe(s);
    }
  });
});

describe("engineStatusToUi", () => {
  it("round-trips every UI bucket through the engine and back", () => {
    for (const ui of ["subscribed", "unsubscribed", "disabled", "unconfirmed"]) {
      const engine = uiStatusToEngine(ui);
      expect(engine).not.toBeNull();
      expect(engineStatusToUi(engine!)).toBe(ui);
    }
  });

  it("never returns a sendable bucket for an unrecognised value", () => {
    expect(engineStatusToUi("cleaned")).toBe("unknown");
    expect(engineStatusToUi(undefined)).toBe("unknown");
    expect(engineStatusToUi("")).toBe("unknown");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(engineStatusToUi("  BlockListed ")).toBe("unsubscribed");
  });
});

describe("subscriberStatusLabel", () => {
  it("never leaks a Postgres enum to a human", () => {
    expect(subscriberStatusLabel("enabled")).toBe("Subscribed");
    expect(subscriberStatusLabel("blocklisted")).toBe("Unsubscribed");
    // "disabled" must read as Inactive, not as an account/RBAC state.
    expect(subscriberStatusLabel("disabled")).toBe("Inactive");
    expect(subscriberStatusLabel("unconfirmed")).toBe("Unconfirmed");
    expect(subscriberStatusLabel(undefined)).toBe("Unknown");
  });

  it("has a label for every UI bucket", () => {
    for (const key of Object.keys(UI_STATUS_LABELS)) {
      expect(UI_STATUS_LABELS[key as keyof typeof UI_STATUS_LABELS]).toBeTruthy();
    }
  });
});

describe("subscriberStatusTone", () => {
  it("tones the four engine states distinctly enough to matter", () => {
    expect(subscriberStatusTone("enabled")).toBe("success");
    expect(subscriberStatusTone("blocklisted")).toBe("danger");
    expect(subscriberStatusTone("disabled")).toBe("warning");
    expect(subscriberStatusTone("unconfirmed")).toBe("warning");
    expect(subscriberStatusTone("wat")).toBe("neutral");
  });
});

describe("subscriberStatusAccessibilityLabel", () => {
  it("keeps the raw engine value available for support without showing it", () => {
    expect(subscriberStatusAccessibilityLabel("blocklisted")).toBe(
      "Status: Unsubscribed (blocklisted)",
    );
  });

  it("omits a redundant parenthetical", () => {
    expect(subscriberStatusAccessibilityLabel("unconfirmed")).toBe(
      "Status: Unconfirmed",
    );
  });

  it("degrades honestly with no status at all", () => {
    expect(subscriberStatusAccessibilityLabel(undefined)).toBe(
      "Status: Unknown",
    );
  });
});

describe("SUBSCRIBER_STATUS_FILTERS", () => {
  it("offers no Bounced chip — the engine has no bounced status", () => {
    expect(SUBSCRIBER_STATUS_FILTERS.map((f) => f.key)).not.toContain(
      "bounced",
    );
  });

  it("sends only engine-valid status values to the server", () => {
    for (const filter of SUBSCRIBER_STATUS_FILTERS) {
      if (filter.key === "all") {
        expect(filter.engineStatus).toBeUndefined();
        continue;
      }
      expect(ENGINE_STATUSES).toContain(filter.engineStatus!);
    }
  });

  it("resolves an unknown chip key back to All rather than crashing", () => {
    expect(statusFilterByKey("nonsense").key).toBe("all");
    expect(statusFilterNoun("nonsense")).toBe("");
    expect(statusFilterNoun("disabled")).toBe("inactive");
  });
});
