import { describe, expect, it } from "vitest";

import { testSendOutcome } from "./notificationTestSend";

describe("test-notification outcomes", () => {
  it("names the address the server says it mailed", () => {
    const out = testSendOutcome({ data: { to: "ops@example.com" }, error: null });
    expect(out.kind).toBe("success");
    expect(out.message).toContain("ops@example.com");
  });

  it("still confirms a send when the server echoes no address", () => {
    const out = testSendOutcome({ data: {}, error: null });
    expect(out.kind).toBe("success");
    expect(out.message).toBe("Test notification sent.");
  });

  it("reports a deployment with no mailer as unfixable from here", () => {
    const out = testSendOutcome({
      data: null,
      error: { status: 503, message: "email delivery is not configured", code: "mailer_unavailable" },
    });
    expect(out.kind).toBe("error");
    expect(out.retryable).toBe(false);
    expect(out.message).toMatch(/no email delivery configured/i);
  });

  it("distinguishes an account with no address from a broken mailer", () => {
    const out = testSendOutcome({
      data: null,
      error: { status: 422, message: "your account has no email address to send to", code: "no_email" },
    });
    expect(out.retryable).toBe(false);
    expect(out.message).toMatch(/no email address on it/i);
    // The two 4xx/5xx boundaries must not share a sentence: they are fixed in
    // completely different places.
    expect(out.message).not.toMatch(/deployment/i);
  });

  it("treats an ordinary failure as retryable and quotes the server", () => {
    const out = testSendOutcome({
      data: null,
      error: { status: 500, message: "internal error" },
    });
    expect(out.retryable).toBe(true);
    expect(out.message).toContain("internal error");
  });

  it("does not blame the network for a role refusal", () => {
    const out = testSendOutcome({
      data: null,
      error: { status: 403, message: "forbidden" },
    });
    expect(out.retryable).toBe(false);
    expect(out.message).toMatch(/admins/i);
  });
});
