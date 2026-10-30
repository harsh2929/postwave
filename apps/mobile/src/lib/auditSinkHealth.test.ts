import { describe, expect, it } from "vitest";

import {
  canResetCircuit,
  circuitLabel,
  failureBudgetPct,
  relativeFromNow,
  sinkTone,
  type AuditSinkHealthInput,
} from "./auditSinkHealth";

function sink(over: Partial<AuditSinkHealthInput> = {}): AuditSinkHealthInput {
  return {
    enabled: true,
    circuit_state: "closed",
    consecutive_failures: 0,
    auto_disable_after: 10,
    ...over,
  };
}

describe("sinkTone", () => {
  it("treats a disabled sink as danger even with a closed breaker", () => {
    expect(sinkTone(sink({ enabled: false }))).toBe("danger");
  });

  it("escalates open to danger and half_open / any failure to warning", () => {
    expect(sinkTone(sink({ circuit_state: "open" }))).toBe("danger");
    expect(sinkTone(sink({ circuit_state: "half_open" }))).toBe("warning");
    expect(sinkTone(sink({ consecutive_failures: 1 }))).toBe("warning");
    expect(sinkTone(sink())).toBe("success");
  });
});

describe("circuitLabel", () => {
  it("prefers disabled over the breaker state", () => {
    expect(circuitLabel(sink({ enabled: false, circuit_state: "open" }))).toBe(
      "disabled",
    );
  });

  it("passes an unknown state through rather than lying", () => {
    expect(circuitLabel(sink({ circuit_state: "quarantined" }))).toBe(
      "quarantined",
    );
    expect(circuitLabel(sink({ circuit_state: "" }))).toBe("unknown");
  });
});

describe("failureBudgetPct", () => {
  it("returns 0 for a zero, negative or non-finite denominator", () => {
    expect(
      failureBudgetPct(sink({ auto_disable_after: 0, consecutive_failures: 3 })),
    ).toBe(0);
    expect(
      failureBudgetPct(
        sink({ auto_disable_after: -5, consecutive_failures: 3 }),
      ),
    ).toBe(0);
    expect(
      failureBudgetPct(
        sink({ auto_disable_after: Number.NaN, consecutive_failures: 3 }),
      ),
    ).toBe(0);
  });

  it("clamps above 100 when failures exceed the budget", () => {
    expect(
      failureBudgetPct(
        sink({ auto_disable_after: 5, consecutive_failures: 50 }),
      ),
    ).toBe(100);
  });

  it("rounds to the nearest percent", () => {
    expect(
      failureBudgetPct(sink({ auto_disable_after: 3, consecutive_failures: 1 })),
    ).toBe(33);
  });
});

describe("canResetCircuit", () => {
  it("offers the reset only where it changes something", () => {
    expect(canResetCircuit(sink({ circuit_state: "open" }))).toBe(true);
    expect(canResetCircuit(sink({ circuit_state: "half_open" }))).toBe(true);
    expect(canResetCircuit(sink({ circuit_state: "closed" }))).toBe(false);
  });
});

describe("relativeFromNow", () => {
  const now = Date.parse("2026-07-25T12:00:00.000Z");

  it("reads 'now' once the cooldown has elapsed", () => {
    expect(relativeFromNow("2026-07-25T11:59:00.000Z", now)).toBe("now");
    expect(relativeFromNow("2026-07-25T12:00:00.000Z", now)).toBe("now");
  });

  it("steps through sub-minute, minutes, hours and days", () => {
    expect(relativeFromNow("2026-07-25T12:00:20.000Z", now)).toBe("<1m");
    expect(relativeFromNow("2026-07-25T12:04:00.000Z", now)).toBe("4m");
    expect(relativeFromNow("2026-07-25T15:00:00.000Z", now)).toBe("3h");
    expect(relativeFromNow("2026-07-27T12:00:00.000Z", now)).toBe("2d");
  });

  it("degrades to 'soon' for an unparseable timestamp", () => {
    expect(relativeFromNow("not-a-date", now)).toBe("soon");
  });
});
