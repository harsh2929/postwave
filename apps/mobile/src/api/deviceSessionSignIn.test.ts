import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelDeviceSessionGrant,
  confirmDeviceSessionGrant,
  decideDeviceSessionPoll,
  parseDeviceSessionGrantStart,
  pollDeviceSessionGrant,
} from "./deviceSessionSignIn";

const VALID_START = {
  device_code: "high-entropy-device-secret",
  user_code: "BCDF-GHJK",
  grant_kind: "session",
  remember: false,
  verification_uri: "https://app.moosewave.com/cli/auth",
  verification_uri_complete:
    "https://app.moosewave.com/cli/auth?user_code=BCDF-GHJK",
  expires_in: 600,
  interval: 5,
};
const API_BASE_URL = "https://api.moosewave.com";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseDeviceSessionGrantStart", () => {
  it("accepts a session grant without exposing the secret in either URL", () => {
    const parsed = parseDeviceSessionGrantStart(
      VALID_START,
      false,
      API_BASE_URL,
    );
    expect(parsed.userCode).toBe("BCDF-GHJK");
    expect(parsed.deviceCode).toBe("high-entropy-device-secret");
    expect(parsed.verificationUriComplete).not.toContain(parsed.deviceCode);
  });

  it("rejects an accidental legacy API-key grant", () => {
    expect(() =>
      parseDeviceSessionGrantStart(
        { ...VALID_START, grant_kind: "api_key" },
        false,
        API_BASE_URL,
      ),
    ).toThrow(/incomplete/);
  });

  it("rejects a remember downgrade or escalation", () => {
    expect(() =>
      parseDeviceSessionGrantStart(VALID_START, true, API_BASE_URL),
    ).toThrow(/incomplete/);
  });

  it("rejects a QR URL on a different origin or with a different code", () => {
    expect(() =>
      parseDeviceSessionGrantStart(
        {
          ...VALID_START,
          verification_uri_complete:
            "https://evil.example/cli/auth?user_code=BCDF-GHJK",
        },
        false,
        API_BASE_URL,
      ),
    ).toThrow(/unsafe/);
    expect(() =>
      parseDeviceSessionGrantStart(
        {
          ...VALID_START,
          verification_uri_complete:
            "https://app.moosewave.com/cli/auth?user_code=ZZZZ-ZZZZ",
        },
        false,
        API_BASE_URL,
      ),
    ).toThrow(/unsafe/);
  });

  it("rejects credentials, fragments, and oversized secrets", () => {
    expect(() =>
      parseDeviceSessionGrantStart(
        {
          ...VALID_START,
          verification_uri: "https://user:pass@app.moosewave.com/cli/auth",
        },
        false,
        API_BASE_URL,
      ),
    ).toThrow(/unsafe/);
    expect(() =>
      parseDeviceSessionGrantStart(
        { ...VALID_START, device_code: "x".repeat(1025) },
        false,
        API_BASE_URL,
      ),
    ).toThrow(/incomplete/);
  });

  it("rejects approval URLs that rely on URL-parser whitespace cleanup", () => {
    expect(() =>
      parseDeviceSessionGrantStart(
        {
          ...VALID_START,
          verification_uri: ` ${VALID_START.verification_uri}`,
        },
        false,
        API_BASE_URL,
      ),
    ).toThrow(/unsafe/);
    expect(() =>
      parseDeviceSessionGrantStart(
        {
          ...VALID_START,
          verification_uri_complete: `${VALID_START.verification_uri_complete}\n`,
        },
        false,
        API_BASE_URL,
      ),
    ).toThrow(/unsafe/);
  });

  it("rejects an insecure approval link from an HTTPS API", () => {
    expect(() =>
      parseDeviceSessionGrantStart(
        {
          ...VALID_START,
          verification_uri: "http://app.moosewave.com/cli/auth",
          verification_uri_complete:
            "http://app.moosewave.com/cli/auth?user_code=BCDF-GHJK",
        },
        false,
        API_BASE_URL,
      ),
    ).toThrow(/unsafe/);
  });

  it("rejects any response that places the bearer device secret in the QR", () => {
    expect(() =>
      parseDeviceSessionGrantStart(
        {
          ...VALID_START,
          verification_uri_complete:
            "https://app.moosewave.com/cli/auth?user_code=BCDF-GHJK&device_code=high-entropy-device-secret",
        },
        false,
        API_BASE_URL,
      ),
    ).toThrow(/unsafe/);
  });

  it.each([
    "https://app.moosewave.com/wrong?user_code=BCDF-GHJK",
    "https://app.moosewave.com/cli/auth?user_code=BCDF-GHJK&next=%2Fapp",
    "https://app.moosewave.com/cli/auth?user_code=BCDF-GHJK&user_code=BCDF-GHJK",
    "https://app.moosewave.com/cli/auth?user_code=BCDF-GHJK%26secret%3Dhigh-entropy-device-secret",
  ])("rejects a non-canonical or secret-bearing QR: %s", (url) => {
    expect(() =>
      parseDeviceSessionGrantStart(
        { ...VALID_START, verification_uri_complete: url },
        false,
        API_BASE_URL,
      ),
    ).toThrow(/unsafe/);
  });
});

describe("device session confirmation transport", () => {
  it("polls, confirms, and cancels with the exact memory-held capability", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { action?: string };
        bodies.push(body);
        const response =
          body.action === "confirm"
            ? {
                grant_kind: "session",
                session: true,
                confirmed: true,
                confirmation_required: false,
                expires_in: 43_200,
                remember: false,
              }
            : body.action === "cancel"
              ? { ok: true, grant_kind: "session" }
              : {
                  grant_kind: "session",
                  session: true,
                  confirmation_required: true,
                  confirmation_expires_in: 120,
                  expires_in: 43_200,
                  remember: false,
                };
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const polled = await pollDeviceSessionGrant(
      API_BASE_URL,
      "memory-only-secret",
      false,
    );
    const confirmed = await confirmDeviceSessionGrant(
      API_BASE_URL,
      "memory-only-secret",
      false,
    );
    await cancelDeviceSessionGrant(API_BASE_URL, "memory-only-secret");

    expect(polled.data?.confirmation_expires_in).toBe(120);
    expect(confirmed.data?.confirmed).toBe(true);
    expect(bodies).toEqual([
      { device_code: "memory-only-secret" },
      { device_code: "memory-only-secret", action: "confirm" },
      { device_code: "memory-only-secret", action: "cancel" },
    ]);
  });

  it("fails closed on remember or intended-lifetime escalation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              grant_kind: "session",
              session: true,
              confirmation_required: true,
              confirmation_expires_in: 120,
              expires_in: 30 * 24 * 60 * 60,
              remember: true,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const result = await pollDeviceSessionGrant(
      API_BASE_URL,
      "memory-only-secret",
      false,
    );

    expect(result.error?.code).toBe("invalid_device_grant");
    expect(result.error?.kind).toBe("parse");
  });
});

describe("decideDeviceSessionPoll", () => {
  it("maps every RFC 8628 terminal and retry status", () => {
    expect(
      decideDeviceSessionPoll({ code: "authorization_pending", message: "" }),
    ).toEqual({
      kind: "pending",
    });
    expect(decideDeviceSessionPoll({ code: "slow_down", message: "" })).toEqual(
      {
        kind: "slow_down",
      },
    );
    expect(
      decideDeviceSessionPoll({ code: "access_denied", message: "" }),
    ).toEqual({
      kind: "denied",
    });
    expect(
      decideDeviceSessionPoll({ code: "expired_token", message: "" }),
    ).toEqual({
      kind: "expired",
    });
  });

  it("retries transport/server failures but fails malformed client errors", () => {
    expect(
      decideDeviceSessionPoll({ kind: "network", message: "offline" }),
    ).toEqual({ kind: "network" });
    expect(decideDeviceSessionPoll({ status: 503, message: "down" })).toEqual({
      kind: "network",
    });
    expect(decideDeviceSessionPoll({ status: 400, message: "bad" })).toEqual({
      kind: "fatal",
      message: "bad",
    });
  });
});
