// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STEP_UP_REASON,
  STEP_UP_CODE,
  STEP_UP_HEADER,
  createStepUpBroker,
  createStepUpPromptBus,
  formatStepUpAction,
  parseStepUpChallenge,
  type StepUpPromptDetail,
} from "./index";

/**
 * The exact body `stepup.Requirement.Body()` encodes, wrapped as
 * `writeChallenge` sends it. Written out rather than built by a helper that
 * "knows" the shape, so a server-side rename shows up here as a diff.
 */
function serverBody(
  action: string,
  message: string,
  maxAgeSeconds: number,
): unknown {
  return {
    error: {
      code: "step_up_required",
      action,
      message,
      max_age_seconds: maxAgeSeconds,
    },
  };
}

describe("parseStepUpChallenge", () => {
  it("detects the middleware's challenge from header + body", () => {
    const challenge = parseStepUpChallenge(
      401,
      new Headers({ "X-Postwave-Step-Up": "api_key.rotate" }),
      serverBody(
        "api_key.rotate",
        "Confirm it's you before rotating an API key.",
        900,
      ),
    );
    expect(challenge).toEqual({
      action: "api_key.rotate",
      reason: "Confirm it's you before rotating an API key.",
      maxAgeSeconds: 900,
    });
  });

  it("still detects it when a proxy strips the header (body code alone)", () => {
    const challenge = parseStepUpChallenge(
      401,
      new Headers(),
      serverBody(
        "team.invite",
        "Confirm it's you before inviting someone to this workspace.",
        43200,
      ),
    );
    expect(challenge?.action).toBe("team.invite");
    expect(challenge?.maxAgeSeconds).toBe(43200);
  });

  it("still detects it when the body is lost (header alone)", () => {
    const challenge = parseStepUpChallenge(
      401,
      new Headers({ "X-Postwave-Step-Up": "security.settings" }),
      undefined,
    );
    expect(challenge?.action).toBe("security.settings");
    expect(challenge?.reason).toBe(DEFAULT_STEP_UP_REASON);
    expect(challenge?.maxAgeSeconds).toBeUndefined();
  });

  it("reads the header from a plain record, whatever the casing", () => {
    // React Native and the desktop native-fetch bridge both hand back header
    // bags that are not always a DOM `Headers`; a record lookup that only tried
    // one spelling would silently miss the hint and fall through to a logout.
    expect(
      parseStepUpChallenge(401, { "X-Postwave-Step-Up": "api_key.create" }, {})
        ?.action,
    ).toBe("api_key.create");
    expect(
      parseStepUpChallenge(401, { [STEP_UP_HEADER]: "api_key.create" }, {})
        ?.action,
    ).toBe("api_key.create");
  });

  it("is not a challenge: an ordinary 401, or the marker on another status", () => {
    expect(
      parseStepUpChallenge(401, new Headers(), {
        error: { code: "no_session" },
      }),
    ).toBeNull();
    expect(
      parseStepUpChallenge(
        403,
        new Headers({ "X-Postwave-Step-Up": "api_key.create" }),
        undefined,
      ),
    ).toBeNull();
    expect(parseStepUpChallenge(401, null, undefined)).toBeNull();
  });

  it("ignores a nonsense max_age_seconds rather than showing it", () => {
    for (const bad of [0, -1, "900", Number.NaN, null]) {
      const challenge = parseStepUpChallenge(401, new Headers(), {
        error: { code: STEP_UP_CODE, action: "a.b", max_age_seconds: bad },
      });
      expect(challenge?.maxAgeSeconds).toBeUndefined();
    }
  });
});

describe("formatStepUpAction", () => {
  it("makes the action id legible without inventing per-action copy", () => {
    expect(formatStepUpAction("subscribers.export")).toBe(
      "Subscribers · export",
    );
    expect(formatStepUpAction("team.member_change")).toBe("Team · member change");
    expect(formatStepUpAction("")).toBe("");
  });
});

describe("createStepUpBroker", () => {
  it("resolves false when nothing claims the prompt (never hangs the request)", async () => {
    const broker = createStepUpBroker({ deliver: () => {} });
    await expect(
      broker.request({ action: "api_key.create", reason: "why" }),
    ).resolves.toBe(false);
    expect(broker.pending).toBe(false);
  });

  it("resolves false when prompting is unavailable, without delivering", async () => {
    const deliver = vi.fn();
    const broker = createStepUpBroker({ deliver, isAvailable: () => false });
    await expect(
      broker.request({ action: "api_key.create", reason: "why" }),
    ).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("shares one prompt between concurrent challenges", async () => {
    const seen: StepUpPromptDetail[] = [];
    const broker = createStepUpBroker({
      deliver: (detail) => {
        if (!detail.claim()) return;
        seen.push(detail);
        detail.settle(true);
      },
    });
    const [a, b] = await Promise.all([
      broker.request({ action: "api_key.create", reason: "a" }),
      broker.request({ action: "subscribers.export", reason: "b" }),
    ]);
    expect([a, b]).toEqual([true, true]);
    // One proof refreshes mfa_satisfied_at for the whole session, so asking
    // twice would be asking for a second code to authorise one moment.
    expect(seen).toHaveLength(1);
  });

  it("only the first settle counts, and a second claim is refused", async () => {
    let captured: StepUpPromptDetail | null = null;
    const broker = createStepUpBroker({
      deliver: (detail) => {
        captured = detail;
        expect(detail.claim()).toBe(true);
        expect(detail.claim()).toBe(false);
      },
    });
    const pending = broker.request({ action: "a.b", reason: "r" });
    expect(broker.pending).toBe(true);
    captured!.settle(true);
    captured!.settle(false);
    await expect(pending).resolves.toBe(true);
  });

  it("frees the slot once settled so a later challenge prompts again", async () => {
    let deliveries = 0;
    const broker = createStepUpBroker({
      deliver: (detail) => {
        deliveries += 1;
        detail.claim();
        detail.settle(false);
      },
    });
    await broker.request({ action: "a.b", reason: "r" });
    await broker.request({ action: "a.b", reason: "r" });
    expect(deliveries).toBe(2);
    expect(broker.pending).toBe(false);
  });
});

describe("createStepUpPromptBus", () => {
  it("delivers synchronously and unsubscribes", () => {
    const bus = createStepUpPromptBus();
    const seen: string[] = [];
    const off = bus.subscribe((detail) => seen.push(detail.challenge.action));
    expect(bus.listenerCount).toBe(1);
    bus.publish({
      challenge: { action: "a.b", reason: "r" },
      claim: () => true,
      settle: () => {},
    });
    expect(seen).toEqual(["a.b"]);
    off();
    expect(bus.listenerCount).toBe(0);
  });

  it("a throwing listener does not stop the others or the transport", () => {
    const bus = createStepUpPromptBus();
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error("prompt renderer exploded");
    });
    bus.subscribe((detail) => seen.push(detail.challenge.action));
    expect(() =>
      bus.publish({
        challenge: { action: "a.b", reason: "r" },
        claim: () => true,
        settle: () => {},
      }),
    ).not.toThrow();
    expect(seen).toEqual(["a.b"]);
  });
});

describe("the broker survives a delivery mechanism that throws", () => {
  const challenge = { action: "subscribers.export", reason: "Confirm it's you." };

  it("does not reject when deliver throws", async () => {
    // The interface says request() NEVER REJECTS: "a failure to prompt must
    // surface as the original server error, not as a second unrelated one".
    // A throwing deliver propagated straight out, so the transport saw an
    // exception from the step-up layer instead of the 401 it was holding.
    const broker = createStepUpBroker({
      deliver: () => {
        throw new Error("renderer blew up");
      },
    });
    await expect(broker.request(challenge)).resolves.toBe(false);
  });

  it("does not wedge every later prompt after one failed delivery", async () => {
    // The severe half. settle() was skipped, so the promise never resolved,
    // the .then(clear) never ran, and `inFlight` kept pointing at a dead
    // promise. Every subsequent request returned THAT promise — so after a
    // single delivery failure, every high-risk action hung forever with no
    // error and no prompt.
    let throwOnce = true;
    const broker = createStepUpBroker({
      deliver: (detail) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("renderer blew up");
        }
        detail.claim();
        detail.settle(true);
      },
    });

    await expect(broker.request(challenge)).resolves.toBe(false);
    expect(broker.pending, "broker still believes a prompt is open").toBe(false);
    // The next one must work normally rather than inherit the dead promise.
    await expect(broker.request(challenge)).resolves.toBe(true);
  });

  it("settles even when deliver claims and then throws", async () => {
    // A half-rendered prompt cannot be trusted to report back, and an
    // unanswered claim wedges the broker exactly as an unsettled one does.
    const broker = createStepUpBroker({
      deliver: (detail) => {
        detail.claim();
        throw new Error("blew up after claiming");
      },
    });
    await expect(broker.request(challenge)).resolves.toBe(false);
    expect(broker.pending).toBe(false);
  });

  it("treats a throwing isAvailable as 'cannot prompt'", async () => {
    // isAvailable touches host globals on every surface (typeof window, a
    // navigation ref, a mount registry); a throw must degrade, not escape.
    const broker = createStepUpBroker({
      deliver: () => {
        throw new Error("should never be reached");
      },
      isAvailable: () => {
        throw new Error("no window");
      },
    });
    await expect(broker.request(challenge)).resolves.toBe(false);
    expect(broker.pending).toBe(false);
  });

  it("still resolves true on a normal claimed-and-proved prompt", async () => {
    // Guard the guard: a broker that resolved false unconditionally would pass
    // every assertion above.
    const broker = createStepUpBroker({
      deliver: (detail) => {
        detail.claim();
        detail.settle(true);
      },
    });
    await expect(broker.request(challenge)).resolves.toBe(true);
  });
});
