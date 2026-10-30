import { describe, expect, it } from "vitest";

import { webhookFreshness } from "./outboundWebhookFreshness";

const NOW = Date.now();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

describe("webhookFreshness", () => {
  it("reports a success when that is the most recent event", () => {
    const f = webhookFreshness({
      last_succeeded_at: minutesAgo(5),
      last_failed_at: minutesAgo(600),
    });
    expect(f.failed).toBe(false);
    expect(f.text).toContain("Last delivered");
  });

  it("NEVER claims a delivery when the endpoint has been failing since", () => {
    // Succeeded Monday, failing since Tuesday: the old row would have said
    // "Last delivered 4d ago" and looked fine.
    const f = webhookFreshness({
      last_succeeded_at: minutesAgo(6000),
      last_failed_at: minutesAgo(30),
      consecutive_failures: 4,
    });
    expect(f.failed).toBe(true);
    expect(f.text).toContain("Last failure");
    expect(f.text).toContain("4 consecutive failures");
  });

  it("singularises a lone failure", () => {
    const f = webhookFreshness({
      last_failed_at: minutesAgo(10),
      consecutive_failures: 1,
    });
    expect(f.text).toContain("1 consecutive failure");
    expect(f.text).not.toContain("failures");
  });

  it("omits the failure count when the streak has been cleared", () => {
    const f = webhookFreshness({
      last_failed_at: minutesAgo(10),
      consecutive_failures: 0,
    });
    expect(f.failed).toBe(true);
    expect(f.text).not.toContain("consecutive");
  });

  it("says so plainly when nothing has ever been delivered", () => {
    const f = webhookFreshness({});
    expect(f).toEqual({
      text: "No deliveries yet",
      spoken: "No deliveries yet",
      failed: false,
    });
  });

  it("distinguishes 'never delivered' from 'never tried'", () => {
    const f = webhookFreshness({ consecutive_failures: 3 });
    expect(f.failed).toBe(true);
    expect(f.text).toContain("No successful delivery yet");
    expect(f.text).toContain("3 failed attempts");
  });

  it("ignores unparseable timestamps rather than rendering Invalid Date", () => {
    const f = webhookFreshness({
      last_succeeded_at: "not-a-date",
      last_failed_at: null,
    });
    expect(f.text).toBe("No deliveries yet");
  });

  it("speaks an absolute time even though it shows a relative one", () => {
    const f = webhookFreshness({ last_succeeded_at: minutesAgo(5) });
    expect(f.spoken).not.toBe(f.text);
    expect(f.spoken).toContain("Last delivered");
  });
});
