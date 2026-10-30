import { describe, expect, it } from "vitest";

import {
  releaseSmsSuppressionWrite,
  tryAcquireSmsSuppressionWrite,
} from "./smsSuppressionWriteLock";

describe("SMS suppression roster global write lock", () => {
  it("refuses duplicate or cross-action acquisition until the first flow releases", () => {
    const lock = { current: false };

    expect(tryAcquireSmsSuppressionWrite(lock)).toBe(true);
    expect(tryAcquireSmsSuppressionWrite(lock)).toBe(false);
    releaseSmsSuppressionWrite(lock);
    expect(tryAcquireSmsSuppressionWrite(lock)).toBe(true);
  });
});
