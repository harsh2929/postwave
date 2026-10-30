import { describe, expect, it } from "vitest";

import {
  canDeleteSequence,
  sequenceDeleteConfirm,
  sequenceDeleteErrorMessage,
} from "./sequenceDelete";

describe("sequenceDeleteConfirm", () => {
  it("gates on the sequence's own name", () => {
    const confirm = sequenceDeleteConfirm({ name: "Welcome", stepCount: 4 });
    expect(confirm.confirmPhrase).toBe("Welcome");
    expect(confirm.title).toBe("Delete “Welcome”?");
    expect(confirm.consequence).toBe(
      "4 steps will be deleted. This cannot be undone.",
    );
    expect(confirm.destructive).toBe(true);
  });

  it("omits the typed gate rather than inventing a constant phrase", () => {
    const confirm = sequenceDeleteConfirm({ name: "   " });
    expect(confirm).not.toHaveProperty("confirmPhrase");
    expect(confirm.title).toBe("Delete this sequence?");
  });

  it("singularises one step and tolerates an unknown count", () => {
    expect(sequenceDeleteConfirm({ name: "x", stepCount: 1 }).consequence).toBe(
      "1 step will be deleted. This cannot be undone.",
    );
    expect(sequenceDeleteConfirm({ name: "x" }).consequence).toBe(
      "This cannot be undone.",
    );
    expect(
      sequenceDeleteConfirm({ name: "x", stepCount: Number.NaN }).consequence,
    ).toBe("This cannot be undone.");
  });
});

describe("sequenceDeleteErrorMessage", () => {
  it("tells a 412 apart from a 404 and a 403", () => {
    expect(sequenceDeleteErrorMessage(412)).toContain("changed on another device");
    expect(sequenceDeleteErrorMessage(404)).toBe("This sequence is already gone.");
    expect(sequenceDeleteErrorMessage(403)).toContain("Ask an admin");
  });

  it("explains a missing precondition rather than echoing 428", () => {
    expect(sequenceDeleteErrorMessage(428)).toContain("Reload this sequence");
  });

  it("names an unsupported deployment", () => {
    expect(sequenceDeleteErrorMessage(501)).toContain("doesn't allow deleting");
  });

  it("falls back to the transport message, then to a default", () => {
    expect(sequenceDeleteErrorMessage(500, "boom")).toBe("boom");
    expect(sequenceDeleteErrorMessage(0, "  ")).toBe(
      "Couldn't delete this sequence.",
    );
  });
});

describe("canDeleteSequence", () => {
  it("requires online, write access and a positive version", () => {
    expect(
      canDeleteSequence({ online: true, version: 3, canWrite: true }),
    ).toBe(true);
  });

  it("is false offline — DELETE can never be queued (offlineQueueSafety)", () => {
    expect(
      canDeleteSequence({ online: false, version: 3, canWrite: true }),
    ).toBe(false);
  });

  it("is false without write access", () => {
    expect(
      canDeleteSequence({ online: true, version: 3, canWrite: false }),
    ).toBe(false);
  });

  it("is false without a usable version — the server demands If-Match", () => {
    for (const version of [null, undefined, 0, -1, 1.5, Number.NaN]) {
      expect(canDeleteSequence({ online: true, version, canWrite: true })).toBe(
        false,
      );
    }
  });
});
