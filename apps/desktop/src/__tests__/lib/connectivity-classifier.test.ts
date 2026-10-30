import { describe, expect, it } from "vitest";

import { classifyConnectivityFailure } from "../../lib/online-manager";

describe("desktop connectivity classification", () => {
  it("distinguishes interface, authentication, maintenance, captive portal, and TLS failures", () => {
    expect(classifyConnectivityFailure(undefined, undefined, false)).toBe(
      "no-interface",
    );
    expect(
      classifyConnectivityFailure(
        new Response(null, { status: 401 }),
        null,
        true,
      ),
    ).toBe("authentication");
    expect(
      classifyConnectivityFailure(
        new Response(null, {
          status: 503,
          headers: { "retry-after": "120" },
        }),
        null,
        true,
      ),
    ).toBe("maintenance");
    expect(
      classifyConnectivityFailure(
        new Response("Sign in", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
        null,
        true,
      ),
    ).toBe("captive-portal");
    expect(
      classifyConnectivityFailure(
        undefined,
        new Error("TLS certificate rejected by proxy"),
        true,
      ),
    ).toBe("proxy-tls");
  });

  it("separates transport loss from a responding but unhealthy API", () => {
    expect(
      classifyConnectivityFailure(
        undefined,
        new Error("Failed to fetch: network timeout"),
        true,
      ),
    ).toBe("internet-unavailable");
    expect(
      classifyConnectivityFailure(
        new Response(null, { status: 500 }),
        null,
        true,
      ),
    ).toBe("api-unavailable");
  });
});
