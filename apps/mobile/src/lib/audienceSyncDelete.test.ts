/**
 * The delete-a-sync policy: the promise made before the cascade, the refusal
 * that must not read as a fault, and the 404 that is a success in disguise.
 */
import { describe, expect, it } from "vitest";

import {
  deleteAlreadyGone,
  deleteSyncBlockedReason,
  deleteSyncCopy,
  deleteSyncErrorMessage,
  deleteSyncSuccessMessage,
} from "./audienceSyncDelete";

const SUBJECT = {
  name: "Warehouse mirror",
  destinationLabel: "Signed webhook",
  sourceLabel: "Segment",
  runCount: null as number | null,
};

describe("deleteSyncCopy", () => {
  it("says the run ledger goes with the sync — the part the row cannot show", () => {
    const copy = deleteSyncCopy({ ...SUBJECT, runCount: 12 });
    expect(copy.title).toBe("Delete Warehouse mirror?");
    expect(copy.message).toContain("Its 12 recorded runs go with them");
    expect(copy.message).toContain("consent-exclusion receipt");
    expect(copy.destructive).toBe(true);
    expect(copy.confirmLabel).toBe("Delete sync");
  });

  it("says there is no undo, because the API has no route that restores one", () => {
    expect(deleteSyncCopy(SUBJECT).consequence).toContain("no undo");
  });

  it("does not invent a run count when the history was never read", () => {
    const copy = deleteSyncCopy({ ...SUBJECT, runCount: null });
    expect(copy.message).toContain("Its run history goes with it");
    expect(copy.message).not.toMatch(/\d+ recorded run/);
  });

  it("keeps the single run singular", () => {
    expect(deleteSyncCopy({ ...SUBJECT, runCount: 1 }).message).toContain(
      "Its one recorded run goes with it",
    );
  });

  it("still asks a question when the sync has no name", () => {
    expect(deleteSyncCopy({ ...SUBJECT, name: "" }).title).toBe(
      "Delete this sync?",
    );
  });
});

describe("deleteSyncBlockedReason", () => {
  it("refuses offline, because a delete is never queued", () => {
    expect(deleteSyncBlockedReason(false)).toContain("never queued");
  });

  it("allows it online", () => {
    expect(deleteSyncBlockedReason(true)).toBeNull();
  });
});

describe("deleteSyncErrorMessage", () => {
  it("reads a mid-delivery refusal as 'wait', not as a failure", () => {
    const message = deleteSyncErrorMessage({
      status: 409,
      code: "audience_operation_in_progress",
    });
    expect(message).toContain("running right now");
    expect(message).toContain("Wait for the run to finish");
  });

  it("maps a bare 409 the same way — the code is not always present", () => {
    expect(deleteSyncErrorMessage({ status: 409 })).toContain(
      "running right now",
    );
  });

  it("names the concurrent editor on a 412", () => {
    expect(deleteSyncErrorMessage({ status: 412 })).toContain(
      "changed this sync while you were looking at it",
    );
  });

  it("names the editor floor on a 403", () => {
    expect(deleteSyncErrorMessage({ status: 403 })).toContain("editor role");
  });

  it("treats an already-gone sync as gone, not as a failure", () => {
    expect(deleteSyncErrorMessage({ status: 404 })).toBe(
      "That sync is already gone.",
    );
  });

  it("claims the network only when a status of 0 is actually present", () => {
    expect(deleteSyncErrorMessage({ status: 0 })).toContain(
      "never reached the server",
    );
    expect(deleteSyncErrorMessage({ message: "boom" })).toBe("boom");
  });

  it("falls back to a sentence rather than an empty toast", () => {
    expect(deleteSyncErrorMessage(null)).toBe(
      "The sync could not be deleted. Please try again.",
    );
  });
});

describe("deleteAlreadyGone", () => {
  it("is true only for 404", () => {
    expect(deleteAlreadyGone({ status: 404 })).toBe(true);
    expect(deleteAlreadyGone({ status: 409 })).toBe(false);
    expect(deleteAlreadyGone(new Error("nope"))).toBe(false);
  });
});

describe("deleteSyncSuccessMessage", () => {
  it("states the consequence rather than 'Deleted'", () => {
    expect(deleteSyncSuccessMessage("Warehouse mirror")).toContain(
      "Nothing further will be pushed",
    );
  });
});
