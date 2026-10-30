/**
 * The advisory send-window line under the schedule picker.
 *
 * Two regressions matter. The silent one: a `block` verdict that stops
 * reading as blocked — the operator schedules, the server refuses with 422
 * `outside_send_window`, and the sheet gave no warning. The loud one: a
 * state that gates Save, or a state sentence that forgets to say scheduling
 * still works — the check is advisory by contract (the schedule handler
 * evaluates the policy itself).
 */
import { describe, expect, it } from "vitest";

import { parseSendWindowVerdict } from "./sendWindowVerdict";
import {
  SEND_WINDOW_CHECK_FALLBACK,
  sendWindowCheckState,
  sendWindowRefusalMessage,
  sendWindowScheduleLine,
  sendWindowVerdictSentence,
  sendWindowVerdictTone,
  type SendWindowCheckInputs,
} from "./sendWindowScheduleLine";

const BLOCKED = parseSendWindowVerdict({
  inside_window: false,
  enforcement: "block",
  should: "block",
  reason: "weekday Sunday not in policy bitmap",
})!;

const WARNED = parseSendWindowVerdict({
  inside_window: false,
  enforcement: "warn",
  should: "warn",
  reason: "local time 20:15 outside 09:00-17:00",
})!;

const INSIDE = parseSendWindowVerdict({
  inside_window: true,
  enforcement: "block",
  should: "allow",
})!;

const NO_POLICY = parseSendWindowVerdict({
  inside_window: true,
  enforcement: "off",
  should: "allow",
})!;

function inputs(over: Partial<SendWindowCheckInputs> = {}): SendWindowCheckInputs {
  return {
    applicable: true,
    online: true,
    settling: false,
    fetching: false,
    errorMessage: null,
    verdict: null,
    ...over,
  };
}

describe("sendWindowVerdictSentence — desktop's sendWindowRowDetail, verbatim", () => {
  it("block names the refusal and carries the server reason untouched", () => {
    expect(sendWindowVerdictSentence(BLOCKED)).toBe(
      "Outside the send window — sends are blocked (weekday Sunday not in policy bitmap).",
    );
    expect(sendWindowVerdictTone(BLOCKED)).toBe("danger");
  });

  it("warn says the policy warns, with the reason", () => {
    expect(sendWindowVerdictSentence(WARNED)).toBe(
      "Outside the send window — policy warns (local time 20:15 outside 09:00-17:00).",
    );
    expect(sendWindowVerdictTone(WARNED)).toBe("warning");
  });

  it("outside with no reason omits the parentheses rather than printing empty ones", () => {
    const bare = parseSendWindowVerdict({
      inside_window: false,
      enforcement: "block",
      should: "block",
    })!;
    expect(sendWindowVerdictSentence(bare)).toBe(
      "Outside the send window — sends are blocked.",
    );
  });

  it("inside an enforced window / no policy read as desktop's two pass lines", () => {
    expect(sendWindowVerdictSentence(INSIDE)).toBe(
      "Inside the configured send window.",
    );
    expect(sendWindowVerdictTone(INSIDE)).toBe("ok");
    expect(sendWindowVerdictSentence(NO_POLICY)).toBe(
      "No send-window policy is enforced.",
    );
    expect(sendWindowVerdictTone(NO_POLICY)).toBe("muted");
  });
});

describe("sendWindowCheckState — precedence", () => {
  it("not applicable (best-time mode / sheet closed) says nothing, whatever else is true", () => {
    expect(
      sendWindowCheckState(
        inputs({ applicable: false, verdict: BLOCKED, fetching: true }),
      ),
    ).toEqual({ kind: "idle" });
  });

  it("offline beats a spinner that could never resolve and a stale verdict", () => {
    expect(
      sendWindowCheckState(inputs({ online: false, fetching: true, verdict: BLOCKED })),
    ).toEqual({ kind: "offline" });
  });

  it("a settling picker or an in-flight check is 'checking', never the previous instant's verdict", () => {
    expect(sendWindowCheckState(inputs({ settling: true, verdict: INSIDE }))).toEqual({
      kind: "checking",
    });
    expect(sendWindowCheckState(inputs({ fetching: true, verdict: INSIDE }))).toEqual({
      kind: "checking",
    });
  });

  it("a failed check outranks an old success", () => {
    expect(
      sendWindowCheckState(
        inputs({ errorMessage: SEND_WINDOW_CHECK_FALLBACK, verdict: INSIDE }),
      ),
    ).toEqual({ kind: "error", message: SEND_WINDOW_CHECK_FALLBACK });
  });

  it("a verdict with nothing in the way is the verdict; nothing at all is idle", () => {
    expect(sendWindowCheckState(inputs({ verdict: WARNED }))).toEqual({
      kind: "verdict",
      verdict: WARNED,
    });
    expect(sendWindowCheckState(inputs())).toEqual({ kind: "idle" });
  });
});

describe("sendWindowScheduleLine — every non-verdict state says scheduling still works", () => {
  it("idle renders nothing", () => {
    expect(sendWindowScheduleLine({ kind: "idle" })).toBeNull();
  });

  it("checking is a muted progress line", () => {
    expect(sendWindowScheduleLine({ kind: "checking" })).toEqual({
      text: "Checking the send window…",
      tone: "muted",
    });
  });

  it("offline and error are advisory, not gates", () => {
    expect(sendWindowScheduleLine({ kind: "offline" })).toEqual({
      text: "Offline — the send window can't be checked. You can still schedule.",
      tone: "muted",
    });
    expect(
      sendWindowScheduleLine({ kind: "error", message: SEND_WINDOW_CHECK_FALLBACK }),
    ).toEqual({
      text: "Couldn't check the send window. You can still schedule.",
      tone: "muted",
    });
  });

  it("a verdict line carries the desktop sentence and its tone", () => {
    expect(sendWindowScheduleLine({ kind: "verdict", verdict: BLOCKED })).toEqual({
      text: "Outside the send window — sends are blocked (weekday Sunday not in policy bitmap).",
      tone: "danger",
    });
  });
});

describe("sendWindowRefusalMessage — the server's refusal sentence, verbatim", () => {
  it("returns the handlers_schedule.go sentence for outside_send_window", () => {
    expect(
      sendWindowRefusalMessage(
        "outside_send_window",
        "that time is outside this workspace's sending window: weekday Sunday not in policy bitmap",
      ),
    ).toBe(
      "that time is outside this workspace's sending window: weekday Sunday not in policy bitmap",
    );
  });

  it("falls back to a sentence of its own only when the server sent an empty one", () => {
    expect(sendWindowRefusalMessage("outside_send_window", "  ")).toBe(
      "That time is outside this workspace's sending window.",
    );
  });

  it("is null for every other code so the ordinary mapping decides", () => {
    expect(sendWindowRefusalMessage("campaign_dispatch_state_owned", "x")).toBeNull();
    expect(sendWindowRefusalMessage(undefined, "x")).toBeNull();
  });
});
