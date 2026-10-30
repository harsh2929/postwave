import { describe, expect, it } from "vitest";

import {
  feedWindowNotice,
  sharedInboxRemainingNotice,
  unrecognisedLinkNotice,
  unrecognisedLinkTelemetry,
} from "./shellNotices";

describe("unrecognisedLinkNotice", () => {
  it("stays silent when there was no link (the ordinary cold start)", () => {
    // planDeepLinkNavigation(null) also returns {kind:"ignore"}, so toasting
    // every launch would be a worse bug than the one being fixed.
    expect(unrecognisedLinkNotice(null)).toBeNull();
    expect(unrecognisedLinkNotice(undefined)).toBeNull();
    expect(unrecognisedLinkNotice("")).toBeNull();
    expect(unrecognisedLinkNotice("   ")).toBeNull();
  });

  it("explains the rejection for a custom-scheme link", () => {
    const notice = unrecognisedLinkNotice("moosewave://not-a-real-thing/42");
    expect(notice?.message).toMatch(/couldn't be opened/i);
    expect(notice?.scheme).toBe("postwave");
    expect(notice?.host).toBe("not-a-real-thing");
  });

  it("lower-cases the scheme and host of a universal link", () => {
    const notice = unrecognisedLinkNotice("HTTPS://App.Moosewave.COM/nope");
    expect(notice?.scheme).toBe("https");
    expect(notice?.host).toBe("app.moosewave.com");
  });

  it("still recovers a scheme from an unparseable link", () => {
    const notice = unrecognisedLinkNotice("postwave:%%%");
    expect(notice?.scheme).toBe("postwave");
    expect(notice?.host).toBe("");
  });

  it("survives a link with no scheme at all", () => {
    const notice = unrecognisedLinkNotice("just some shared text");
    expect(notice).not.toBeNull();
    expect(notice?.scheme).toBe("");
    expect(notice?.host).toBe("");
  });

  it("NEVER echoes the URL, its path, or its query back to the user", () => {
    // A malformed magic link still carries a single-use sign-in proof. The
    // toast is on screen, screenshotted, and read aloud by VoiceOver.
    const url =
      "https://app.moosewave.com/magic-link?proof=SECRET-PROOF-VALUE&email=a@b.test#frag";
    const notice = unrecognisedLinkNotice(url);
    expect(notice?.message).not.toContain("SECRET-PROOF-VALUE");
    expect(notice?.message).not.toContain("a@b.test");
    expect(notice?.message).not.toContain("magic-link");
    expect(notice?.message).not.toContain(url);
  });

  it("keeps the proof out of telemetry too", () => {
    const notice = unrecognisedLinkNotice(
      "moosewave://magic?proof=SECRET-PROOF-VALUE",
    );
    expect(notice).not.toBeNull();
    const props = unrecognisedLinkTelemetry(notice!);
    expect(props).toEqual({
      outcome: "ignored",
      scheme: "postwave",
      host: "magic",
    });
    expect(JSON.stringify(props)).not.toContain("SECRET-PROOF-VALUE");
  });
});

describe("sharedInboxRemainingNotice", () => {
  it("says nothing when the queue is empty", () => {
    expect(sharedInboxRemainingNotice(0)).toBeNull();
    expect(sharedInboxRemainingNotice(-3)).toBeNull();
  });

  it("distinguishes an unreadable queue from an empty one", () => {
    // ABSENCE IS NOT ZERO: a count we could not read must not be reported as
    // "0 more". Both stay silent, but for different reasons.
    expect(sharedInboxRemainingNotice(null)).toBeNull();
    expect(sharedInboxRemainingNotice(undefined)).toBeNull();
    expect(sharedInboxRemainingNotice(Number.NaN)).toBeNull();
  });

  it("uses the singular for exactly one", () => {
    expect(sharedInboxRemainingNotice(1)).toBe("1 more shared item is waiting.");
  });

  it("states the exact count, never a compacted one", () => {
    expect(sharedInboxRemainingNotice(7)).toBe(
      "7 more shared items are waiting.",
    );
  });
});

describe("feedWindowNotice", () => {
  it("stays silent when the list IS the whole feed", () => {
    expect(feedWindowNotice(0, 200)).toBeNull();
    expect(feedWindowNotice(199, 200)).toBeNull();
  });

  it("names the window once the page is full", () => {
    expect(feedWindowNotice(200, 200)).toBe(
      "Showing the 200 most recent notifications. Older ones are not loaded — mark these read to see further back.",
    );
  });

  it("still warns if the server ever returns more than it was asked for", () => {
    // The endpoint clamps today, so this cannot happen — but degrading to an
    // over-cautious notice beats degrading to a silent one.
    expect(feedWindowNotice(240, 200)).not.toBeNull();
  });

  it("says nothing rather than dividing by a nonsense limit", () => {
    expect(feedWindowNotice(10, 0)).toBeNull();
    expect(feedWindowNotice(Number.NaN, 200)).toBeNull();
    expect(feedWindowNotice(10, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
