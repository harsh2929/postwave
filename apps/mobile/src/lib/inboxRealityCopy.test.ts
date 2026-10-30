import { describe, expect, it } from "vitest";

import { inboxRealityErrorCopy } from "./inboxRealityCopy";

describe("inboxRealityErrorCopy", () => {
  it("distinguishes 'not configured' from 'broken'", () => {
    for (const status of [404, 405, 501, 503]) {
      expect(inboxRealityErrorCopy(status)).toContain("isn't configured");
    }
    expect(inboxRealityErrorCopy(500)).toContain("on our side");
  });

  it("names an access boundary as one, and an expired session as one", () => {
    expect(inboxRealityErrorCopy(403)).toContain("role");
    expect(inboxRealityErrorCopy(401)).toContain("session expired");
    expect(inboxRealityErrorCopy(429)).toContain("rate-limiting");
    expect(inboxRealityErrorCopy(0)).toContain("couldn't reach");
  });

  it("always tells the user the send itself is unaffected", () => {
    // The banner is rendered inside a send sheet. Copy that reads as a blocker
    // stops people mailing over a failure in an advisory check.
    for (const status of [0, 401, 403, 404, 418, 429, 500, 503]) {
      expect(inboxRealityErrorCopy(status)).toContain(
        "Sending is unaffected.",
      );
    }
  });

  it("never leaks a transport string, whatever the status", () => {
    for (const status of [0, 400, 401, 403, 404, 429, 500, 502, 503]) {
      const copy = inboxRealityErrorCopy(status);
      expect(copy).not.toMatch(/\d{3}/);
      expect(copy.toLowerCase()).not.toContain("request failed");
      expect(copy.toLowerCase()).not.toContain("status");
    }
  });
});
