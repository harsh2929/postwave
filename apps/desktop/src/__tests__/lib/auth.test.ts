import { describe, expect, it } from "vitest";

import contractFixtures from "../../../auth-link-v1-contract-fixtures.json";
import { inspectDesktopAuthLink } from "../../lib/auth-link-contract";
import { extractAuthToken, scorePassword } from "../../lib/auth";

describe("desktop auth deep-link token extraction", () => {
  const signature = "A".repeat(43);
  const signed = (flow: "magic" | "reset") =>
    `moosewave://auth/${flow}?token=${flow}-token&v=1&flow=${flow}&aud=mobile&state=native_state_123456&sig=${signature}`;

  it("extracts complete signed-v1 native magic and reset proofs", () => {
    expect(extractAuthToken(signed("magic"))).toEqual({
      token: "magic-token",
      link_version: 1,
      link_flow: "magic",
      link_audience: "mobile",
      state: "native_state_123456",
      link_signature: signature,
    });
    expect(extractAuthToken(signed("reset"))).toEqual({
      token: "reset-token",
      link_version: 1,
      link_flow: "reset",
      link_audience: "mobile",
      state: "native_state_123456",
      link_signature: signature,
    });
  });

  it("parses the shared backend-compatible magic, OAuth, and reset fixtures", () => {
    expect(contractFixtures.cases.map((fixture) => fixture.source)).toEqual([
      "magic_email",
      "oauth_callback",
      "password_reset",
    ]);
    for (const fixture of contractFixtures.cases) {
      expect(extractAuthToken(fixture.native_url)).toEqual({
        token: fixture.token,
        link_version: contractFixtures.version,
        link_flow: fixture.flow,
        link_audience: contractFixtures.audience,
        state: fixture.state,
        link_signature: fixture.signature,
      });
    }
  });

  it("returns safe recovery reasons without returning secret fields", () => {
    const valid = contractFixtures.cases[0]!.native_url;
    expect(inspectDesktopAuthLink(valid.replace("v=1", "v=2"))).toEqual({
      kind: "invalid",
      reason: "unsupported_version",
      flow: "magic",
    });
    expect(
      inspectDesktopAuthLink(valid.replace("aud=mobile", "aud=web")),
    ).toEqual({
      kind: "invalid",
      reason: "wrong_device",
      flow: "magic",
    });
    expect(
      inspectDesktopAuthLink(valid.replace("flow=magic", "flow=reset")),
    ).toEqual({
      kind: "invalid",
      reason: "wrong_flow",
      flow: "magic",
    });
    expect(
      inspectDesktopAuthLink(valid.replace(/sig=[^&]+/, "sig=short")),
    ).toEqual({
      kind: "invalid",
      reason: "invalid_signature",
      flow: "magic",
    });
  });

  it("rejects legacy, browser-audience, cross-flow, duplicate, and link-origin inputs", () => {
    expect(extractAuthToken("moosewave://auth/magic?token=abc")).toBeNull();
    expect(
      extractAuthToken(signed("magic").replace("aud=mobile", "aud=web")),
    ).toBeNull();
    expect(
      extractAuthToken(signed("magic").replace("flow=magic", "flow=reset")),
    ).toBeNull();
    expect(extractAuthToken(signed("magic") + "&state=other")).toBeNull();
    expect(
      extractAuthToken(
        signed("magic") + "&base_url=https%3A%2F%2Fevil.example",
      ),
    ).toBeNull();
  });

  it("rejects ambiguous or unsafe auth state parameters", () => {
    expect(extractAuthToken(signed("magic") + "&state=two")).toBeNull();
    expect(
      extractAuthToken(
        signed("magic").replace(
          "state=native_state_123456",
          `state=${"a".repeat(300)}`,
        ),
      ),
    ).toBeNull();
    expect(
      extractAuthToken(
        signed("magic").replace("state=native_state_123456", "state=%0a"),
      ),
    ).toBeNull();
  });

  it("rejects oversized auth tokens", () => {
    expect(
      extractAuthToken(
        signed("magic").replace("magic-token", "a".repeat(3000)),
      ),
    ).toBeNull();
    expect(
      extractAuthToken(
        signed("reset").replace("reset-token", "a".repeat(3000)),
      ),
    ).toBeNull();
  });

  it("requires the first moosewave:// segment to be `auth`", () => {
    // `magic`/`reset` in any other path segment must NOT trigger the
    // consume flow (login-CSRF-shaped widening).
    expect(
      extractAuthToken(signed("magic").replace("auth/magic", "campaign/magic")),
    ).toBeNull();
    expect(
      extractAuthToken(signed("reset").replace("auth/reset", "approval/reset")),
    ).toBeNull();
    expect(
      extractAuthToken(signed("magic").replace("auth/magic", "magic")),
    ).toBeNull();
    expect(
      extractAuthToken(
        signed("magic").replace("auth/magic", "auth/magic/extra"),
      ),
    ).toBeNull();
    expect(
      extractAuthToken(signed("magic").replace("auth/magic", "auth/settings")),
    ).toBeNull();
    expect(
      extractAuthToken(
        signed("magic").replace("auth/magic", "user@auth/magic"),
      ),
    ).toBeNull();
    expect(extractAuthToken(signed("magic") + "#fragment")).toBeNull();
    expect(
      extractAuthToken(signed("magic").replace("auth/magic?", "auth/magic/?")),
    ).toBeNull();
  });

  it("requires the native custom-scheme handoff", () => {
    const query = signed("magic").split("?")[1];
    expect(
      extractAuthToken(`https://app.moosewave.com/magic-link?${query}`),
    ).toBeNull();
    expect(
      extractAuthToken(`https://evil.example/magic-link?${query}`),
    ).toBeNull();
  });

  it("returns null for malformed inputs", () => {
    expect(extractAuthToken("")).toBeNull();
    expect(extractAuthToken("not a url")).toBeNull();
    expect(extractAuthToken("moosewave://auth/magic")).toBeNull();
  });
});

describe("scorePassword length gate", () => {
  it("caps anything under 12 chars at Weak regardless of complexity", () => {
    const short = scorePassword("Ab1!abcd"); // 8 chars, all classes
    expect(short.score).toBeLessThanOrEqual(1);
    expect(["Too short", "Weak"]).toContain(short.label);
  });

  it("scores 12+ char passwords above Weak", () => {
    const ok = scorePassword("Ab1!abcdefgh"); // 12 chars, all classes
    expect(ok.score).toBeGreaterThanOrEqual(2);
  });
});
