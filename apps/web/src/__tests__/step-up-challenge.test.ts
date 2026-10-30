// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// ECO-01: the client half of apps/api/internal/stepup.
//
// The server's middleware answers a stale-proof request with 401 +
// `X-Postwave-Step-Up: <action>` + `{"error":{"code":"step_up_required",…}}`.
// Web's transport previously read any 401 on an /app route as a dead session
// and logged the user out. These tests pin the four behaviours that make the
// challenge usable: it is DETECTED, it RAISES A PROMPT (and not a logout), a
// successful proof RETRIES the original request unchanged, and a second
// consecutive challenge STOPS rather than looping.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

import { api, ApiError, fetchTextAuthed } from "@/lib/api";
import { AUTH_SESSION_EXPIRED_EVENT } from "@/lib/api";
import {
  STEP_UP_PROMPT_EVENT,
  formatStepUpAction,
  parseStepUpChallenge,
  requestStepUpProof,
  resetStepUpState,
  type StepUpPromptDetail,
} from "@/lib/step-up";

/** The exact body stepup.Requirement.Body() encodes, wrapped as the server sends it. */
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
  action = "subscribers.export",
  message = "Confirm it's you before exporting subscriber data.",
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

/** Records every request the transport made, in order. */
interface Recorded {
  url: string;
  init: RequestInit;
}

function recordingFetch(responses: Array<() => Response>): {
  calls: Recorded[];
  fetch: ReturnType<typeof vi.fn>;
} {
  const calls: Recorded[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch #${calls.length} to ${url}`);
    return next();
  });
  return { calls, fetch: fetchMock };
}

/** Mounts a listener that behaves like StepUpPrompt: claims, then answers. */
function mountPrompt(answer: (detail: StepUpPromptDetail) => void): {
  seen: StepUpPromptDetail[];
  unmount: () => void;
} {
  const seen: StepUpPromptDetail[] = [];
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<StepUpPromptDetail>).detail;
    if (!detail.claim()) return;
    seen.push(detail);
    answer(detail);
  };
  window.addEventListener(STEP_UP_PROMPT_EVENT, handler);
  return {
    seen,
    unmount: () => window.removeEventListener(STEP_UP_PROMPT_EVENT, handler),
  };
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers as HeadersInit).get(name);
}

let logouts = 0;
const countLogout = (): void => {
  logouts += 1;
};

beforeEach(() => {
  resetStepUpState();
  logouts = 0;
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, countLogout);
  // The logout branch only fires on the /app tree — put us there so "no
  // logout" is a real assertion rather than an accident of the test URL.
  window.history.replaceState({}, "", "/app/subscribers");
});

afterEach(() => {
  window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, countLogout);
  resetStepUpState();
  vi.unstubAllGlobals();
});

describe("parseStepUpChallenge", () => {
  it("detects the middleware's challenge from header + body", () => {
    const res = challengeResponse("api_key.rotate", "Confirm it's you before rotating an API key.");
    const challenge = parseStepUpChallenge(401, res.headers, {
      error: {
        code: "step_up_required",
        action: "api_key.rotate",
        message: "Confirm it's you before rotating an API key.",
        max_age_seconds: 900,
      },
    });
    expect(challenge).toEqual({
      action: "api_key.rotate",
      reason: "Confirm it's you before rotating an API key.",
      maxAgeSeconds: 900,
    });
  });

  it("still detects it when a proxy strips the header (body code alone)", () => {
    const challenge = parseStepUpChallenge(401, new Headers(), {
      error: {
        code: "step_up_required",
        action: "team.invite",
        message: "Confirm it's you before inviting someone to this workspace.",
        max_age_seconds: 43200,
      },
    });
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
    expect(challenge?.reason).toBe("Confirm it's you to continue.");
    expect(challenge?.maxAgeSeconds).toBeUndefined();
  });

  it("is not a challenge: an ordinary 401, or the marker on another status", () => {
    expect(
      parseStepUpChallenge(401, new Headers(), { error: { code: "no_session" } }),
    ).toBeNull();
    expect(
      parseStepUpChallenge(
        403,
        new Headers({ "X-Postwave-Step-Up": "api_key.create" }),
        undefined,
      ),
    ).toBeNull();
  });
});

describe("formatStepUpAction", () => {
  it("makes the action id legible without inventing per-action copy", () => {
    expect(formatStepUpAction("subscribers.export")).toBe("Subscribers · export");
    expect(formatStepUpAction("team.member_change")).toBe("Team · member change");
    expect(formatStepUpAction("")).toBe("");
  });
});

describe("requestStepUpProof", () => {
  it("resolves false when nothing is listening (never hangs the request)", async () => {
    await expect(
      requestStepUpProof({ action: "api_key.create", reason: "why" }),
    ).resolves.toBe(false);
  });

  it("shares one prompt between concurrent challenges", async () => {
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      const [a, b] = await Promise.all([
        requestStepUpProof({ action: "api_key.create", reason: "a" }),
        requestStepUpProof({ action: "subscribers.export", reason: "b" }),
      ]);
      expect(a).toBe(true);
      expect(b).toBe(true);
      // One proof refreshes mfa_satisfied_at for the whole session, so asking
      // twice would be asking for a second code to authorise one moment.
      expect(prompt.seen).toHaveLength(1);
    } finally {
      prompt.unmount();
    }
  });
});

describe("api transport: step-up challenge", () => {
  it("raises a prompt carrying the action, and does NOT log the user out", async () => {
    const { fetch } = recordingFetch([
      () => challengeResponse("api_key.rotate", "Confirm it's you before rotating an API key."),
    ]);
    vi.stubGlobal("fetch", fetch);
    const prompt = mountPrompt((detail) => detail.settle(false));
    try {
      await expect(
        api.post("/api/v1/api-keys/k1/rotate", { name: "ci" }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(prompt.seen).toHaveLength(1);
      expect(prompt.seen[0].challenge.action).toBe("api_key.rotate");
      expect(prompt.seen[0].challenge.reason).toBe(
        "Confirm it's you before rotating an API key.",
      );
      // The whole point: a live session asking a question is not a dead one.
      expect(logouts).toBe(0);
    } finally {
      prompt.unmount();
    }
  });

  it("an ordinary 401 still logs the user out (the old path is intact)", async () => {
    const { fetch } = recordingFetch([
      () =>
        new Response(JSON.stringify({ error: { code: "no_session" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    vi.stubGlobal("fetch", fetch);
    await expect(api.get("/api/v1/subscribers")).rejects.toBeInstanceOf(ApiError);
    expect(logouts).toBe(1);
  });

  it("carries the unanswered challenge on the thrown ApiError", async () => {
    const { fetch } = recordingFetch([() => challengeResponse()]);
    vi.stubGlobal("fetch", fetch);
    const prompt = mountPrompt((detail) => detail.settle(false));
    try {
      const err = await api
        .get("/api/v1/subscribers")
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("step_up_required");
      expect((err as ApiError).stepUp?.action).toBe("subscribers.export");
    } finally {
      prompt.unmount();
    }
  });

  it("retries the original request after a proof, preserving method, body and Idempotency-Key", async () => {
    const { calls, fetch } = recordingFetch([
      () => challengeResponse("api_key.create", "Confirm it's you before creating an API key."),
      () => new Response(JSON.stringify({ id: "key_1" }), { status: 201 }),
    ]);
    vi.stubGlobal("fetch", fetch);
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      const out = await api.post<{ id: string }>("/api/v1/api-keys", {
        name: "deploy",
        scopes: ["campaigns:read"],
      });
      expect(out).toEqual({ id: "key_1" });
      expect(calls).toHaveLength(2);
      expect(calls[1].init.method).toBe("POST");
      expect(calls[1].url).toBe(calls[0].url);
      expect(calls[1].init.body).toBe(calls[0].init.body);
      expect(JSON.parse(String(calls[1].init.body))).toEqual({
        name: "deploy",
        scopes: ["campaigns:read"],
      });
      // The SAME key. A re-minted one would make the retry a second write, and
      // the first attempt is indistinguishable from one the server applied.
      const firstKey = headerOf(calls[0].init, "Idempotency-Key");
      expect(firstKey).toBeTruthy();
      expect(headerOf(calls[1].init, "Idempotency-Key")).toBe(firstKey);
    } finally {
      prompt.unmount();
    }
  });

  it("does not retry when the user cancels the prompt", async () => {
    const { calls, fetch } = recordingFetch([() => challengeResponse()]);
    vi.stubGlobal("fetch", fetch);
    const prompt = mountPrompt((detail) => detail.settle(false));
    try {
      await expect(api.get("/api/v1/subscribers")).rejects.toBeInstanceOf(
        ApiError,
      );
      expect(calls).toHaveLength(1);
    } finally {
      prompt.unmount();
    }
  });

  it("a second consecutive challenge stops instead of looping forever", async () => {
    // The server keeps refusing even after a 'successful' proof — a clock
    // skew, a rotated session. Without the one-shot guard this is an infinite
    // authenticator-code prompt.
    const { calls, fetch } = recordingFetch([
      () => challengeResponse(),
      () => challengeResponse(),
      () => challengeResponse(),
    ]);
    vi.stubGlobal("fetch", fetch);
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      const err = await api
        .get("/api/v1/subscribers/export")
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(401);
      expect((err as ApiError).stepUp?.action).toBe("subscribers.export");
      // Exactly two network attempts and exactly one prompt.
      expect(calls).toHaveLength(2);
      expect(prompt.seen).toHaveLength(1);
      expect(logouts).toBe(0);
    } finally {
      prompt.unmount();
    }
  });
});

describe("fetchTextAuthed: step-up challenge", () => {
  // GET /api/v1/subscribers/export.csv is BOTH the route web downloads this way
  // and the protected route with the largest blast radius.
  it("prompts and retries the CSV export rather than logging the user out", async () => {
    const { calls, fetch } = recordingFetch([
      () => challengeResponse(),
      () => new Response("email,name\na@b.co,A\n", { status: 200 }),
    ]);
    vi.stubGlobal("fetch", fetch);
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      const csv = await fetchTextAuthed("/api/v1/subscribers/export.csv");
      expect(csv).toBe("email,name\na@b.co,A\n");
      expect(calls).toHaveLength(2);
      expect(prompt.seen[0].challenge.action).toBe("subscribers.export");
      expect(logouts).toBe(0);
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
    vi.stubGlobal("fetch", fetch);
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      const err = await fetchTextAuthed("/api/v1/subscribers/export.csv")
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).stepUp?.action).toBe("subscribers.export");
      expect(calls).toHaveLength(2);
      expect(prompt.seen).toHaveLength(1);
    } finally {
      prompt.unmount();
    }
  });
});

// A wrong code is not a dead session.
//
// The step-up prompt exists so a high-risk action does not log you out. It
// answers with a six-digit code, and the TOTP endpoints reject a wrong one with
// 401 — the same status the transport used to read as "session gone" on any
// /app route. So the prompt's single most likely path, mistyping a digit,
// cleared the query cache, wiped offline storage and redirected to /login: the
// user was logged out of the workspace they were in the middle of proving they
// still owned. Enrolment shares this transport and had the same exposure.
//
// Keyed on the error CODE, so the one 401 that really does mean the session
// died still logs out.
describe("a failed re-authentication is not a logout", () => {
  function respond(status: number, code: string): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code, message: "nope" } }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  }

  for (const code of ["invalid_code", "missing_code", "not_enrolled"]) {
    it(`does not log the user out on 401 ${code}`, async () => {
      respond(401, code);
      await expect(api.post("/api/v1/auth/totp/verify", {})).rejects.toBeInstanceOf(
        ApiError,
      );
      expect(logouts).toBe(0);
    });
  }

  it("still logs the user out on 401 no_session, which really is a dead session", async () => {
    respond(401, "no_session");
    await expect(api.post("/api/v1/auth/totp/verify", {})).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(logouts).toBe(1);
  });

  it("still logs the user out on a 401 carrying no code at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } })),
    );
    await expect(api.get("/api/v1/subscribers")).rejects.toBeInstanceOf(ApiError);
    expect(logouts).toBe(1);
  });
});
