/**
 * The broadcast list's dispatch banner must not quote a server gate code at an
 * operator.
 *
 * The fallback branch used to read
 * `Broadcast dispatch is unavailable (${reason ?? "unknown reason"}); drafts
 * remain editable.` — an internal identifier printed into a sentence a human
 * reads, and one they cannot act on. The explanation the reader actually needs
 * (dispatch is off, drafts are still editable) never depended on it.
 */
import { describe, expect, it } from "vitest";

import {
  broadcastDispatchUnavailableSentence,
  SMS_BROADCAST_DISPATCH_RELEASE_HELD,
} from "@/lib/smsBroadcastCopy";

/** Anything shaped like `lower_snake_case_code` reads as an identifier. */
const IDENTIFIER = /[a-z0-9]+(?:_[a-z0-9]+){2,}/u;

describe("broadcastDispatchUnavailableSentence", () => {
  it("keeps the full release-hold explanation", () => {
    const sentence = broadcastDispatchUnavailableSentence(
      SMS_BROADCAST_DISPATCH_RELEASE_HELD,
    );
    expect(sentence).toContain("release-held server-side");
    expect(sentence).toContain("drafts can be authored, edited, and deleted");
    expect(sentence).not.toMatch(IDENTIFIER);
  });

  it("never prints an unrecognised reason code at the reader", () => {
    for (const reason of [
      "sms_broadcast_dispatch_release_held_v2",
      "provider_account_suspended",
      "",
    ]) {
      const sentence = broadcastDispatchUnavailableSentence(reason);
      if (reason) expect(sentence).not.toContain(reason);
      expect(sentence).not.toMatch(IDENTIFIER);
      // Still says the part that matters to someone holding a draft.
      expect(sentence).toContain("drafts remain editable");
    }
  });

  it("says something true when the server sent no reason at all", () => {
    for (const reason of [null, undefined]) {
      const sentence = broadcastDispatchUnavailableSentence(reason);
      expect(sentence).toContain("unavailable");
      expect(sentence).not.toContain("unknown reason");
      expect(sentence).not.toMatch(IDENTIFIER);
    }
  });
});
