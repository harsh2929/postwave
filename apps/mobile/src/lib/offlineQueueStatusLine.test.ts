import { describe, expect, it } from "vitest";

import { setMessageLocale } from "./i18n";
import {
  offlineQueueReviewHint,
  offlineQueueReviewLabel,
  offlineQueueReviewSpoken,
  offlineQueueStatusLine,
} from "./offlineQueueStatusLine";

describe("offlineQueueStatusLine", () => {
  it("joins only the non-zero clauses, in pipeline order", () => {
    expect(
      offlineQueueStatusLine({ queued: 3, syncing: 1, failed: 0, sent: 0 }),
    ).toBe("3 queued · 1 syncing");
  });

  it("drops zeroes rather than saying them", () => {
    // "0 failed" on a bar that only appears when something is unsent reads as
    // an alarm about nothing.
    expect(
      offlineQueueStatusLine({ queued: 0, syncing: 0, failed: 2, sent: 0 }),
    ).toBe("2 failed");
    expect(
      offlineQueueStatusLine({ queued: 0, syncing: 0, failed: 0, sent: 0 }),
    ).toBe("");
  });

  it("groups the count like every other number in the app", () => {
    // The old `${count} ${status}` printed the app's only ungrouped number.
    setMessageLocale("en-US");
    expect(
      offlineQueueStatusLine({ queued: 1234, syncing: 0, failed: 0, sent: 0 }),
    ).toBe("1,234 queued");
    setMessageLocale(undefined);
  });

  it("keeps every status word available to plural selection", () => {
    // English reuses one participle for both numbers; the catalogue entry is
    // still a plural so a language that inflects can say something different.
    expect(
      offlineQueueStatusLine({ queued: 1, syncing: 0, failed: 0, sent: 0 }),
    ).toBe("1 queued");
    expect(
      offlineQueueStatusLine({ queued: 0, syncing: 0, failed: 0, sent: 5 }),
    ).toBe("5 sent");
  });
});

describe("the bar's action", () => {
  it("speaks the summary with the one-word label", () => {
    const spoken = offlineQueueReviewSpoken("3 queued · 1 syncing");
    expect(spoken).toBe("Review offline change status. 3 queued · 1 syncing");
  });

  it("still says something useful when there is no summary", () => {
    // A trailing ". " with nothing after it is what naive concatenation gives.
    expect(offlineQueueReviewSpoken("")).toBe("Review offline change status.");
  });

  it("resolves the visible label and hint from the catalogue", () => {
    expect(offlineQueueReviewLabel()).toBe("Review");
    expect(offlineQueueReviewHint()).toContain("diagnostics");
  });
});
