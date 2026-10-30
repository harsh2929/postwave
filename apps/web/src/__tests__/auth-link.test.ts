import { describe, expect, it } from "vitest";

import {
  WEB_AUTH_LINK_START,
  hasAnyAuthLinkCredential,
  nativeAuthHandoffUrl,
  parseAuthLinkProof,
} from "../lib/auth-link";

const SIG = "A".repeat(43);

describe("signed v1 browser auth-link contract", () => {
  it("parses a browser magic-link proof for API consumption", () => {
    const params = new URLSearchParams({
      token: "one-time-token",
      v: "1",
      flow: "magic",
      aud: "web",
      sig: SIG,
    });

    expect(parseAuthLinkProof(params, "magic")).toEqual({
      token: "one-time-token",
      link_version: 1,
      link_flow: "magic",
      link_audience: "web",
      link_signature: SIG,
    });
    expect(WEB_AUTH_LINK_START).toEqual({
      link_version: 1,
      link_audience: "web",
    });
  });

  it("recognizes but does not erase the device binding on a mobile reset link", () => {
    const params = new URLSearchParams({
      token: "one-time-token",
      v: "1",
      flow: "reset",
      aud: "mobile",
      state: "device-state",
      sig: SIG,
    });

    const proof = parseAuthLinkProof(params, "reset");
    expect(proof).toMatchObject({
      link_audience: "mobile",
      state: "device-state",
    });
    expect(proof && nativeAuthHandoffUrl(proof)).toBe(
      "moosewave://auth/reset?token=one-time-token&v=1&flow=reset&aud=mobile&state=device-state&sig=" +
        SIG,
    );
    expect(hasAnyAuthLinkCredential(params)).toBe(true);
  });

  it.each([
    ["missing signature", "token=t&v=1&flow=magic&aud=web"],
    ["wrong flow", "token=t&v=1&flow=reset&aud=web&sig=" + SIG],
    [
      "web state ambiguity",
      "token=t&v=1&flow=magic&aud=web&state=x&sig=" + SIG,
    ],
    ["mobile state missing", "token=t&v=1&flow=magic&aud=mobile&sig=" + SIG],
    [
      "link-selected API base",
      "token=t&v=1&flow=magic&aud=web&sig=" +
        SIG +
        "&base_url=https://evil.example",
    ],
    [
      "duplicate token",
      "token=t&token=u&v=1&flow=magic&aud=web&sig=" + SIG,
    ],
  ])("rejects %s", (_name, query) => {
    expect(parseAuthLinkProof(new URLSearchParams(query), "magic")).toBeNull();
  });
});
