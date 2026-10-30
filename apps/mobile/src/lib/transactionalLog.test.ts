import { describe, expect, it } from "vitest";

import {
  TRANSACTIONAL_ATTEMPT_STATES,
  parseTransactionalSends,
  transactionalOutcomeUnknown,
  transactionalTriageSummary,
} from "./transactionalLog";

const send = (extra: Record<string, unknown> = {}) => ({
  id: "e1",
  to: ["a@example.com"],
  subject: "Receipt",
  status: "sent",
  attempt_state: "acknowledged",
  created_at: "today",
  ...extra,
});

describe("TRANSACTIONAL_ATTEMPT_STATES", () => {
  it("matches the filter values the handler accepts", () => {
    // handlers.go:207 — anything else is a 400 invalid_attempt_state.
    expect([...TRANSACTIONAL_ATTEMPT_STATES]).toEqual([
      "prepared",
      "submitted",
      "acknowledged",
      "rejected",
      "unknown",
    ]);
  });
});

describe("parseTransactionalSends", () => {
  it("reads both envelope shapes", () => {
    expect(parseTransactionalSends({ emails: [send()] })).toHaveLength(1);
    expect(parseTransactionalSends({ items: [send()] })).toHaveLength(1);
    expect(parseTransactionalSends([send()])).toHaveLength(1);
    expect(parseTransactionalSends(null)).toEqual([]);
  });

  it("joins every recipient rather than reporting the first", () => {
    // `to` is an array; taking [0] would silently report a 3-recipient send as
    // going to one person.
    const [row] = parseTransactionalSends([
      send({ to: ["a@x.com", "b@x.com", "c@x.com"] }),
    ]);
    expect(row?.to).toBe("a@x.com, b@x.com, c@x.com");
  });

  it("tolerates a missing or non-array recipient list", () => {
    expect(parseTransactionalSends([send({ to: undefined })])[0]?.to).toBe("");
    expect(parseTransactionalSends([send({ to: "a@x.com" })])[0]?.to).toBe("");
  });

  it("never renders an empty subject line", () => {
    expect(parseTransactionalSends([send({ subject: "" })])[0]?.subject).toBe(
      "(no subject)",
    );
  });

  it("drops a row with no id", () => {
    expect(parseTransactionalSends([send({ id: "" })])).toEqual([]);
  });
});

describe("transactionalOutcomeUnknown", () => {
  it("is true only for the unknown attempt state", () => {
    expect(
      transactionalOutcomeUnknown(
        parseTransactionalSends([send({ attempt_state: "unknown" })])[0]!,
      ),
    ).toBe(true);
  });

  it("does NOT treat a rejection as unknown", () => {
    // A rejected send is a KNOWN bad outcome the suppression machinery already
    // acts on. Conflating them would bury the only state a human must resolve.
    for (const state of ["rejected", "acknowledged", "submitted", "prepared"]) {
      expect(
        transactionalOutcomeUnknown(
          parseTransactionalSends([send({ attempt_state: state })])[0]!,
        ),
      ).toBe(false);
    }
  });
});

describe("transactionalTriageSummary", () => {
  it("says plainly that nobody can vouch for an unknown send", () => {
    const rows = parseTransactionalSends([
      send({ attempt_state: "unknown" }),
      send({ id: "e2", attempt_state: "unknown" }),
      send({ id: "e3" }),
    ]);
    const summary = transactionalTriageSummary(rows);
    expect(summary).toContain("2 sends");
    expect(summary).toContain("whether these landed");
  });

  it("uses the singular for one", () => {
    const rows = parseTransactionalSends([send({ attempt_state: "unknown" })]);
    expect(transactionalTriageSummary(rows)).toContain("1 send ");
  });

  it("reports a clean slate as a statement about OUTCOMES, not delivery", () => {
    const rows = parseTransactionalSends([send()]);
    expect(transactionalTriageSummary(rows)).toContain("known provider outcome");
  });
});
