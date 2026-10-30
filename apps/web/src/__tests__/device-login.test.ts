import { describe, expect, it } from "vitest";

import { ApiError } from "../lib/api";
import {
  devicePollDecision,
  normalizeDeviceUserCode,
  parseDeviceGrantDetails,
  parseDeviceLoginStart,
} from "../lib/device-login";

const START = {
  device_code: "target-only-possession-secret",
  user_code: "BCDF-GHJK",
  grant_kind: "session",
  remember: false,
  verification_uri: "https://app.moosewave.com/cli/auth",
  verification_uri_complete:
    "https://app.moosewave.com/cli/auth?user_code=BCDF-GHJK",
  expires_in: 600,
  interval: 5,
};

describe("device sign-in protocol", () => {
  it("accepts a same-origin session grant without widening its links", () => {
    expect(parseDeviceLoginStart(START, "https://app.moosewave.com")).toEqual({
      deviceCode: "target-only-possession-secret",
      userCode: "BCDF-GHJK",
      verificationUri: "https://app.moosewave.com/cli/auth",
      verificationUriComplete:
        "https://app.moosewave.com/cli/auth?user_code=BCDF-GHJK",
      expiresIn: 600,
      interval: 5,
      remember: false,
    });
  });

  it.each([
    [
      "foreign host",
      {
        verification_uri_complete:
          "https://evil.test/cli/auth?user_code=BCDF-GHJK",
      },
    ],
    [
      "credentials",
      {
        verification_uri_complete:
          "https://user:pass@app.moosewave.com/cli/auth?user_code=BCDF-GHJK",
      },
    ],
    [
      "fragment",
      {
        verification_uri_complete:
          "https://app.moosewave.com/cli/auth?user_code=BCDF-GHJK#approve",
      },
    ],
    [
      "different code",
      {
        verification_uri_complete:
          "https://app.moosewave.com/cli/auth?user_code=PRST-VWXZ",
      },
    ],
    ["API-key downgrade", { grant_kind: "api_key" }],
    ["unexpected persistent session", { remember: true }],
  ])("rejects an unsafe or mismatched %s response", (_name, patch) => {
    expect(() =>
      parseDeviceLoginStart({ ...START, ...patch }, "https://app.moosewave.com"),
    ).toThrow();
  });

  it("accepts an explicitly requested persistent session without changing the QR", () => {
    expect(
      parseDeviceLoginStart(
        { ...START, remember: true },
        "https://app.moosewave.com",
        true,
      ),
    ).toMatchObject({ remember: true, userCode: "BCDF-GHJK" });
  });

  it("normalizes only the eight displayed user-code characters", () => {
    expect(normalizeDeviceUserCode("bcdf ghjk extra")).toBe("BCDF-GHJK");
  });

  it("maps every RFC terminal state and raises slow_down by five seconds", () => {
    expect(
      devicePollDecision(
        new ApiError("pending", 400, undefined, {
          code: "authorization_pending",
        }),
        5,
        0,
      ),
    ).toEqual({ kind: "retry", delaySeconds: 5, status: "waiting" });
    expect(
      devicePollDecision(
        new ApiError("slow", 400, undefined, { code: "slow_down" }),
        5,
        0,
      ),
    ).toEqual({
      kind: "retry",
      delaySeconds: 10,
      status: "waiting",
      raiseInterval: true,
    });
    expect(
      devicePollDecision(
        new ApiError("denied", 400, undefined, { code: "access_denied" }),
        5,
        0,
      ),
    ).toEqual({ kind: "denied" });
    expect(
      devicePollDecision(
        new ApiError("expired", 400, undefined, { code: "expired_token" }),
        5,
        0,
      ),
    ).toEqual({ kind: "expired" });
  });

  it("uses bounded exponential delay for transport failures", () => {
    const failure = new ApiError("offline", 0, undefined, {
      code: "network_error",
      kind: "network",
    });
    expect(devicePollDecision(failure, 5, 1)).toEqual({
      kind: "retry",
      delaySeconds: 10,
      status: "network",
    });
    expect(devicePollDecision(failure, 5, 8)).toEqual({
      kind: "retry",
      delaySeconds: 30,
      status: "network",
    });
  });

  it("parses authoritative session and API-key disclosures", () => {
    expect(
      parseDeviceGrantDetails({
        grant_kind: "session",
        account: {
          email: "ada@example.com",
          workspace_name: "Ada Labs",
          workspace_slug: "ada-labs",
        },
        device: {
          device_label: "Chrome on Windows",
          device_type: "desktop",
          device_os: "Windows",
          device_client: "Chrome",
        },
        expires_in: 420,
        remember: false,
      }),
    ).toEqual({
      grantKind: "session",
      account: {
        email: "ada@example.com",
        workspaceName: "Ada Labs",
        workspaceSlug: "ada-labs",
      },
      device: {
        label: "Chrome on Windows",
        type: "desktop",
        os: "Windows",
        client: "Chrome",
      },
      expiresIn: 420,
      remember: false,
      scopes: [],
      requiresMfa: false,
    });

    expect(
      parseDeviceGrantDetails({
        grant_kind: "api_key",
        account: { email: "owner@example.com" },
        device: { device_label: "Moosewave CLI", device_type: "cli" },
        expires_in: 120,
        remember: false,
        scopes: ["read:reports"],
        requires_mfa: true,
      }),
    ).toMatchObject({
      grantKind: "api_key",
      scopes: ["read:reports"],
      requiresMfa: true,
    });
  });
});
