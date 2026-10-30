// @vitest-environment happy-dom
//
// ECO-01 (desktop): the client half of apps/api/internal/stepup.
//
// The server answers a stale-proof request on a high-risk route with 401 +
// `X-Postwave-Step-Up: <action>` + `{"error":{"code":"step_up_required",…}}`.
// Desktop's transport read EVERY 401 (except the /auth/me boot probe) as a dead
// session and fired `onApiUnauthorized`, whose registered listener is
// <AuthGate>: it wipes `me` and re-renders SignIn. Mounting the server gate
// without this change would therefore convert "confirm it's you before rotating
// an API key" into "you have been signed out" — on the surface that also holds
// the offline outbox.
//
// These tests pin the four behaviours that make the challenge usable on this
// surface: it is DETECTED, it RAISES A PROMPT (and not a logout), a successful
// proof RETRIES the original request with the same method/body/Idempotency-Key,
// and a second consecutive challenge STOPS instead of looping. Both of
// desktop's transports are covered — the JSON `request` core AND the direct
// native-fetch CSV export, which does not pass through the core at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  apiRequest,
  onApiUnauthorized,
  sendingSettingsApi,
} from "../lib/api-client";
import { resetApiIdentityTransitionForTests } from "../lib/api-identity-transition";
import { createSubscriberDataOperationsMethods } from "../lib/api/subscriber-data-operations";
import type { SubscriberDataOperationsDependencies } from "../lib/api/subscriber-data-operations";
import type { ApiErr } from "../lib/api/result";
import {
  STEP_UP_PROMPT_EVENT,
  resetStepUpState,
  type StepUpPromptDetail,
} from "../lib/step-up";

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
  action = "subscribers.export",
  message = "Confirm it's you before exporting subscriber data.",
  maxAgeSeconds = 900,
  opts: { withHeader?: boolean } = {},
): Response {
  return new Response(challengeBody(action, message, maxAgeSeconds), {
    // stepup.StatusCode — 401, not 403.
    status: 401,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Default OFF, deliberately. Desktop fetches from tauri://localhost, and
      // CORS hides every response header the API does not name in
      // Access-Control-Expose-Headers — `X-Postwave-Step-Up` is not in
      // apps/api/main.go's `browserExposedResponseHeaders` today. So the
      // realistic desktop response carries the BODY marker only, and these
      // tests exercise that case by default.
      ...(opts.withHeader === true
        ? { "X-Postwave-Step-Up": action }
        : {}),
    },
  });
}

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

/** Mounts a listener that behaves like <StepUpPrompt>: claims, then answers. */
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
let stopCountingLogouts: () => void = () => {};

beforeEach(() => {
  resetStepUpState();
  logouts = 0;
  stopCountingLogouts = onApiUnauthorized(() => {
    logouts += 1;
  });
});

afterEach(() => {
  stopCountingLogouts();
  resetStepUpState();
  resetApiIdentityTransitionForTests();
  vi.unstubAllGlobals();
});

describe("desktop request core: step-up challenge", () => {
  it("raises a prompt carrying the action, and does NOT sign the user out", async () => {
    const { fetch } = recordingFetch([
      () =>
        challengeResponse(
          "api_key.rotate",
          "Confirm it's you before rotating an API key.",
        ),
    ]);
    vi.stubGlobal("fetch", fetch);
    const prompt = mountPrompt((detail) => detail.settle(false));
    try {
      const res = await apiRequest("/api/v1/api-keys/k1/rotate", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect((res as ApiErr).error.status).toBe(401);
      expect(prompt.seen).toHaveLength(1);
      expect(prompt.seen[0].challenge.action).toBe("api_key.rotate");
      expect(prompt.seen[0].challenge.reason).toBe(
        "Confirm it's you before rotating an API key.",
      );
      expect(prompt.seen[0].challenge.maxAgeSeconds).toBe(900);
      // The whole point: a live session asking a question is not a dead one.
      expect(logouts).toBe(0);
    } finally {
      prompt.unmount();
    }
  });

  it("detects the challenge from the header alone when a proxy drops the body", async () => {
    const { fetch } = recordingFetch([
      () =>
        new Response("", {
          status: 401,
          headers: { "X-Postwave-Step-Up": "security.settings" },
        }),
    ]);
    vi.stubGlobal("fetch", fetch);
    const prompt = mountPrompt((detail) => detail.settle(false));
    try {
      await apiRequest("/api/v1/security/settings", {
        method: "PUT",
        body: JSON.stringify({}),
      });
      expect(prompt.seen).toHaveLength(1);
      expect(prompt.seen[0].challenge.action).toBe("security.settings");
      expect(logouts).toBe(0);
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
    vi.stubGlobal("fetch", fetch);
    await apiRequest("/api/v1/subscribers");
    expect(logouts).toBe(1);
  });

  it("retries after a proof, preserving method, body and Idempotency-Key", async () => {
    const { calls, fetch } = recordingFetch([
      () =>
        challengeResponse(
          "api_key.create",
          "Confirm it's you before creating an API key.",
        ),
      () =>
        new Response(JSON.stringify({ id: "key_1" }), {
          status: 201,
          headers: {
            "Content-Type": "application/json",
            ETag: '"campaign:v2"',
            Location: "/api/v1/campaigns/campaign-1/content-revisions/revision-2",
          },
        }),
    ]);
    vi.stubGlobal("fetch", fetch);
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      const body = JSON.stringify({ name: "deploy", scopes: ["campaigns:read"] });
      const res = await apiRequest<{ id: string }>("/api/v1/api-keys", {
        method: "POST",
        body,
      });
      expect(res.data).toEqual({ id: "key_1" });
      expect(res.serverVersion).toBe('"campaign:v2"');
      expect(res.responseLocation).toBe(
        "/api/v1/campaigns/campaign-1/content-revisions/revision-2",
      );
      expect(calls).toHaveLength(2);
      expect(calls[1].init.method).toBe("POST");
      expect(calls[1].url).toBe(calls[0].url);
      expect(calls[1].init.body).toBe(body);
      // The SAME key. A re-minted one would make the retry a second write, and
      // the first attempt is indistinguishable from one the server applied.
      const firstKey = headerOf(calls[0].init, "Idempotency-Key");
      expect(firstKey).toBeTruthy();
      expect(headerOf(calls[1].init, "Idempotency-Key")).toBe(firstKey);
      expect(logouts).toBe(0);
    } finally {
      prompt.unmount();
    }
  });

  it("does not replay the keyless sending-settings PUT after a successful proof", async () => {
    const { calls, fetch } = recordingFetch([
      () =>
        challengeResponse(
          "sending.settings.update",
          "Confirm it's you before changing sending settings.",
        ),
    ]);
    vi.stubGlobal("fetch", fetch);
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      const result = await sendingSettingsApi.put({
        max_sends_per_hour: 5000,
        quiet_hours_start: "22:00",
        quiet_hours_end: "06:00",
        quiet_hours_tz: "UTC",
        quiet_hours_per_recipient: true,
        expected_updated_at: "2026-08-31T11:00:00Z",
      });

      expect(prompt.seen).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].init.method).toBe("PUT");
      expect(new URL(calls[0].url).pathname).toBe(
        "/api/v1/settings/sending",
      );
      expect(headerOf(calls[0].init, "Idempotency-Key")).toBeNull();
      expect(result.error).toMatchObject({
        kind: "parse",
        status: 401,
        code: "sending_settings_mutation_unproven",
      });
    } finally {
      prompt.unmount();
    }
  });

  it("does not retry when the user cancels the prompt", async () => {
    const { calls, fetch } = recordingFetch([() => challengeResponse()]);
    vi.stubGlobal("fetch", fetch);
    const prompt = mountPrompt((detail) => detail.settle(false));
    try {
      await apiRequest("/api/v1/subscribers");
      expect(calls).toHaveLength(1);
      expect(logouts).toBe(0);
    } finally {
      prompt.unmount();
    }
  });

  it("a second consecutive challenge stops instead of looping forever", async () => {
    // The server keeps refusing even after a 'successful' proof — a clock skew,
    // a session rotated mid-prompt. Without the one-shot guard this is an
    // infinite authenticator-code prompt.
    const { calls, fetch } = recordingFetch([
      () => challengeResponse(),
      () => challengeResponse(),
      () => challengeResponse(),
    ]);
    vi.stubGlobal("fetch", fetch);
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      const res = await apiRequest("/api/v1/subscribers");
      expect((res as ApiErr).error.status).toBe(401);
      expect((res as ApiErr).error.code).toBe("step_up_required");
      // Exactly two network attempts and exactly one prompt.
      expect(calls).toHaveLength(2);
      expect(prompt.seen).toHaveLength(1);
      expect(logouts).toBe(0);
    } finally {
      prompt.unmount();
    }
  });

  it("throws the server's 401 when no prompt is mounted, rather than hanging", async () => {
    const { calls, fetch } = recordingFetch([() => challengeResponse()]);
    vi.stubGlobal("fetch", fetch);
    const res = await apiRequest("/api/v1/subscribers");
    expect((res as ApiErr).error.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(logouts).toBe(0);
  });
});

/* ---------- the SECOND transport: the direct native-fetch CSV export ------- */

function csvHarness(responses: Array<() => Response>): {
  exportSubscribersCSV: ReturnType<
    typeof createSubscriberDataOperationsMethods
  >["exportSubscribersCSV"];
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const deps = {
    request: (async () => ({ data: undefined })) as never,
    createDownloadController: () => ({
      signal: new AbortController().signal,
      dispose: () => {},
    }),
    normalizeApiKey: (key: string | null | undefined) => key ?? null,
    getApiKey: () => null,
    nativeAwareFetch: async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(input), init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected fetch #${calls.length}`);
      return next();
    },
    apiUrl: (path: string) => `http://localhost:8080${path}`,
    errorFromResponse: async (response: Response): Promise<ApiErr["error"]> => ({
      kind: "http",
      status: response.status,
      code: `http_${response.status}`,
      message: `HTTP ${response.status}`,
    }),
    transportError: (): ApiErr["error"] => ({
      kind: "network",
      code: "network_error",
      message: "network",
    }),
    buildStreamUrl: async (path: string) => path,
    nativeClientHeaders: {},
  } as unknown as SubscriberDataOperationsDependencies;
  return {
    exportSubscribersCSV:
      createSubscriberDataOperationsMethods(deps).exportSubscribersCSV,
    calls,
  };
}

describe("desktop CSV export transport: step-up challenge", () => {
  // GET /api/v1/subscribers/export.csv is BOTH the route desktop downloads
  // this way and the protected route with the largest blast radius. It never
  // touches the JSON request core, so detection wired only there would leave
  // it unable to answer.
  it("prompts and retries the export rather than failing with a bare 401", async () => {
    const { exportSubscribersCSV, calls } = csvHarness([
      () => challengeResponse(),
      () =>
        new Response("email,name\na@b.co,A\n", {
          status: 200,
          headers: { "Content-Type": "text/csv" },
        }),
    ]);
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      const res = await exportSubscribersCSV();
      expect(res.error).toBeUndefined();
      expect(await res.data?.blob.text()).toBe("email,name\na@b.co,A\n");
      expect(calls).toHaveLength(2);
      expect(prompt.seen).toHaveLength(1);
      expect(prompt.seen[0].challenge.action).toBe("subscribers.export");
    } finally {
      prompt.unmount();
    }
  });

  it("a second consecutive challenge stops instead of looping forever", async () => {
    const { exportSubscribersCSV, calls } = csvHarness([
      () => challengeResponse(),
      () => challengeResponse(),
      () => challengeResponse(),
    ]);
    const prompt = mountPrompt((detail) => detail.settle(true));
    try {
      const res = await exportSubscribersCSV();
      expect(res.error?.status).toBe(401);
      expect(calls).toHaveLength(2);
      expect(prompt.seen).toHaveLength(1);
    } finally {
      prompt.unmount();
    }
  });

  it("does not retry when the user cancels", async () => {
    const { exportSubscribersCSV, calls } = csvHarness([
      () => challengeResponse(),
    ]);
    const prompt = mountPrompt((detail) => detail.settle(false));
    try {
      const res = await exportSubscribersCSV();
      expect(res.error?.status).toBe(401);
      expect(calls).toHaveLength(1);
    } finally {
      prompt.unmount();
    }
  });
});
