/**
 * ECO-01 (mobile): the client half of apps/api/internal/stepup.
 *
 * The server answers a stale-proof request on a high-risk route with 401 +
 * `X-Postwave-Step-Up: <action>` + `{"error":{"code":"step_up_required",…}}`.
 * Mobile's SDK transport wrapper ran `interceptExpiredSession` on every 401,
 * and `isExpiredSessionResponse` treats a 401 with NO readable error code as a
 * dead session — so a challenge whose body a proxy stripped signed the user
 * out of a live session. Even with the body intact the request only ever failed
 * with a raw SDK error and no way to answer.
 *
 * These tests pin the four behaviours that make the challenge usable here: it
 * is DETECTED, it RAISES A PROMPT (and not a sign-out), a successful proof
 * RETRIES the original request with the same method/body/Idempotency-Key, and a
 * second consecutive challenge STOPS rather than looping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const track = vi.hoisted(() => vi.fn());
const revalidateSession = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/store/auth", () => ({
  useAuthStore: {
    getState: vi.fn(() => ({ mode: "session", revalidateSession })),
  },
}));
vi.mock("@/lib/telemetry", () => ({ track }));

// eslint-disable-next-line import/first
import { createMfaAwareFetch } from "./sdkClient";
// eslint-disable-next-line import/first
import {
  onStepUpPrompt,
  resetStepUpState,
  type StepUpPromptDetail,
} from "@/lib/stepUp";

const URL_UNDER_TEST = "https://api.example.com/api/v1/api-keys";

/** The exact body `stepup.Requirement.Body()` encodes, as writeChallenge sends it. */
function challengeBody(
  action: string,
  message: string,
  maxAgeSeconds: number,
): string {
  return JSON.stringify({
    error: {
      code: "step_up_required",
      action,
      message,
      max_age_seconds: maxAgeSeconds,
    },
  });
}

function challengeResponse(
  action = "api_key.create",
  message = "Confirm it's you before creating an API key.",
  maxAgeSeconds = 900,
): Response {
  return new Response(challengeBody(action, message, maxAgeSeconds), {
    // stepup.StatusCode — 401, not 403.
    status: 401,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Postwave-Step-Up": action,
    },
  });
}

interface Recorded {
  input: string;
  init: RequestInit | undefined;
}

function recordingFetch(responses: (() => Response)[]): {
  calls: Recorded[];
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
} {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (input: string, init?: RequestInit) => {
      calls.push({ input, init });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch #${calls.length}`);
      return next();
    },
  };
}

/** Mounts a subscriber that behaves like <StepUpPrompt>: claims, then answers. */
function mountPrompt(answer: (detail: StepUpPromptDetail) => void): {
  seen: StepUpPromptDetail[];
  unmount: () => void;
} {
  const seen: StepUpPromptDetail[] = [];
  const unmount = onStepUpPrompt((detail) => {
    if (!detail.claim()) return;
    seen.push(detail);
    answer(detail);
  });
  return { seen, unmount };
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers((init?.headers ?? {}) as HeadersInit).get(name);
}

/** Indexed read that fails loudly. mobile's tsconfig sets noUncheckedIndexedAccess. */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) {
    throw new Error(`expected element ${index}, saw ${list.length}`);
  }
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStepUpState();
});

afterEach(() => {
  resetStepUpState();
});

describe("mobile SDK transport: step-up challenge", () => {
  it("raises a prompt carrying the action, and does NOT sign the user out", async () => {
    const { fetch } = recordingFetch([
      () =>
        challengeResponse(
          "api_key.rotate",
          "Confirm it's you before rotating an API key.",
        ),
    ]);
    const prompt = mountPrompt((detail) => detail.settle(false));
    try {
      const response = await createMfaAwareFetch(fetch)(URL_UNDER_TEST);
      expect(response.status).toBe(401);
      expect(prompt.seen).toHaveLength(1);
      expect(at(prompt.seen, 0).challenge.action).toBe("api_key.rotate");
      expect(at(prompt.seen, 0).challenge.reason).toBe(
        "Confirm it's you before rotating an API key.",
      );
      expect(at(prompt.seen, 0).challenge.maxAgeSeconds).toBe(900);
      // The whole point: a live session asking a question is not a dead one.
      expect(revalidateSession).not.toHaveBeenCalled();
      // The SDK still gets a readable body — the challenge was read off a clone.
      await expect(response.text()).resolves.toContain("step_up_required");
    } finally {
      prompt.unmount();
    }
  });

  it("does NOT sign the user out when a proxy strips the body (header alone)", async () => {
    // The regression this guards: `isExpiredSessionResponse(401, null)` is
    // TRUE, so a bodyless challenge used to take the sign-out path. Header-only
    // detection is the only thing standing between that and a logout.
    const { fetch } = recordingFetch([
      () =>
        new Response("", {
          status: 401,
          headers: { "X-Postwave-Step-Up": "subscribers.export" },
        }),
    ]);
    const prompt = mountPrompt((detail) => detail.settle(false));
    try {
      await createMfaAwareFetch(fetch)(URL_UNDER_TEST);
      expect(prompt.seen).toHaveLength(1);
      expect(at(prompt.seen, 0).challenge.action).toBe("subscribers.export");
      expect(revalidateSession).not.toHaveBeenCalled();
    } finally {
      prompt.unmount();
    }
  });

  it("an ordinary 401 still signs the user out (the old path is intact)", async () => {
    const { fetch } = recordingFetch([
      () =>
        new Response(JSON.stringify({ error: { code: "no_session" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    await createMfaAwareFetch(fetch)(URL_UNDER_TEST);
    expect(revalidateSession).toHaveBeenCalledTimes(1);
  });

  it("retries after a proof, preserving method, body and Idempotency-Key", async () => {
    const { calls, fetch } = recordingFetch([
      () => challengeResponse(),
      () =>
        new Response(JSON.stringify({ id: "key_1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      const body = JSON.stringify({
        name: "deploy",
        scopes: ["campaigns:read"],
      });
      const init: RequestInit = {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "0192f3aa-0000-7000-8000-000000000001",
        },
      };
      const response = await createMfaAwareFetch(fetch)(URL_UNDER_TEST, init);
      expect(response.status).toBe(201);
      expect(calls).toHaveLength(2);
      expect(at(calls, 1).input).toBe(at(calls, 0).input);
      expect(at(calls, 1).init?.method).toBe("POST");
      expect(at(calls, 1).init?.body).toBe(body);
      // The SAME key. A re-minted one would make the retry a second write, and
      // the first attempt is indistinguishable from one the server applied.
      expect(headerOf(at(calls, 1).init, "Idempotency-Key")).toBe(
        "0192f3aa-0000-7000-8000-000000000001",
      );
      expect(revalidateSession).not.toHaveBeenCalled();
    } finally {
      prompt.unmount();
    }
  });

  it.each([
    [
      "root API base",
      "https://api.example.com",
      "https://api.example.com/api/v1/settings/sending",
    ],
    [
      "path-prefixed API base",
      "https://api.example.com/gateway",
      "https://api.example.com/gateway/api/v1/settings/sending",
    ],
  ])(
    "never replays the sending-settings PUT after proof with a %s",
    async (_name, baseUrl, requestUrl) => {
      const { calls, fetch } = recordingFetch([
        () => challengeResponse("sending_settings.update"),
        () => new Response("{}", { status: 200 }),
      ]);
      const prompt = mountPrompt((detail) => detail.settle(true));
      try {
        const response = await createMfaAwareFetch(fetch, baseUrl)(requestUrl, {
          method: "PUT",
          body: JSON.stringify({ max_sends_per_hour: 250 }),
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "must-be-stripped",
          },
        });

        expect(response.status).toBe(401);
        expect(prompt.seen).toHaveLength(1);
        expect(calls).toHaveLength(1);
        expect(headerOf(at(calls, 0).init, "Idempotency-Key")).toBeNull();
        expect(at(calls, 0).init?.redirect).toBe("error");
        expect(revalidateSession).not.toHaveBeenCalled();
      } finally {
        prompt.unmount();
      }
    },
  );

  it.each([
    ["https://api.example.com/evil/api/v1/settings/sending"],
    ["https://other.example.com/gateway/api/v1/settings/sending"],
  ])("does not misclassify an out-of-base path %s", async (requestUrl) => {
    const { calls, fetch } = recordingFetch([
      () => challengeResponse(),
      () => new Response("{}", { status: 200 }),
    ]);
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      const response = await createMfaAwareFetch(
        fetch,
        "https://api.example.com/gateway",
      )(requestUrl, { method: "PUT" });
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(2);
    } finally {
      prompt.unmount();
    }
  });

  it("gives the retry a FRESH abort signal, not the timed-out one", async () => {
    // The SDK starts a 30s AbortController before calling this wrapper, and the
    // human typing a rotating code routinely outlives it. Re-sending the same
    // `init` would hand the retry an already-aborted signal and turn a
    // completed proof into a spurious timeout.
    const expired = new AbortController();
    expired.abort();
    const { calls, fetch } = recordingFetch([
      () => challengeResponse(),
      () => new Response("{}", { status: 200 }),
    ]);
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      await createMfaAwareFetch(fetch)(URL_UNDER_TEST, {
        method: "POST",
        body: "{}",
        signal: expired.signal,
      });
      expect(at(calls, 0).init?.signal?.aborted).toBe(true);
      expect(at(calls, 1).init?.signal).toBeDefined();
      expect(at(calls, 1).init?.signal?.aborted).toBe(false);
    } finally {
      prompt.unmount();
    }
  });

  it("does not retry when the user cancels the prompt", async () => {
    const { calls, fetch } = recordingFetch([() => challengeResponse()]);
    const prompt = mountPrompt((detail) => detail.settle(false));
    try {
      const response = await createMfaAwareFetch(fetch)(URL_UNDER_TEST);
      expect(response.status).toBe(401);
      expect(calls).toHaveLength(1);
      expect(revalidateSession).not.toHaveBeenCalled();
    } finally {
      prompt.unmount();
    }
  });

  it("a second consecutive challenge stops instead of looping forever", async () => {
    const { calls, fetch } = recordingFetch([
      () => challengeResponse(),
      () => challengeResponse(),
      () => challengeResponse(),
    ]);
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      const response = await createMfaAwareFetch(fetch)(URL_UNDER_TEST);
      expect(response.status).toBe(401);
      // Exactly two network attempts and exactly one prompt.
      expect(calls).toHaveLength(2);
      expect(prompt.seen).toHaveLength(1);
      expect(revalidateSession).not.toHaveBeenCalled();
    } finally {
      prompt.unmount();
    }
  });

  it("signs the user out when the session really dies during the prompt", async () => {
    // The retry's 401 is NOT a challenge — the cookie was revoked while the
    // sheet was open. That must still take the expired-session path, or the
    // user is left typing codes at a session that no longer exists.
    const { fetch } = recordingFetch([
      () => challengeResponse(),
      () =>
        new Response(JSON.stringify({ error: { code: "no_session" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      await createMfaAwareFetch(fetch)(URL_UNDER_TEST);
      expect(revalidateSession).toHaveBeenCalledTimes(1);
    } finally {
      prompt.unmount();
    }
  });

  it("with nothing mounted, returns the server's 401 rather than hanging", async () => {
    const { calls, fetch } = recordingFetch([() => challengeResponse()]);
    const response = await createMfaAwareFetch(fetch)(URL_UNDER_TEST);
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(1);
    // Nothing claimed it, so it is not a prompt — but it is still not a
    // sign-out, because the code says what it is.
    expect(revalidateSession).not.toHaveBeenCalled();
  });
});
