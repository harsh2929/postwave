import { describe, expect, it } from "vitest";

import {
  authMethodLabel,
  compareSessions,
  deviceLabel,
  sessionRowSummary,
  shortIp,
} from "./sessionDevice";

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const EDGE =
  "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0";

describe("deviceLabel", () => {
  it("names browser and platform for a desktop session", () => {
    expect(deviceLabel(CHROME_WINDOWS)).toBe("Chrome · Windows");
  });

  it("prefers Edge over the Chrome token it also carries", () => {
    expect(deviceLabel(EDGE)).toBe("Edge · Windows");
  });

  it("names Safari on iPhone rather than the raw Version/ token", () => {
    expect(deviceLabel(SAFARI_IPHONE)).toBe("Safari · iPhone");
  });

  it("recognises first-party non-browser clients", () => {
    expect(deviceLabel("postwave-cli/1.4.0")).toBe("Moosewave CLI");
    expect(deviceLabel("postwave-mobile/2.1 (iOS 17)")).toBe("Moosewave app");
    expect(deviceLabel("curl/8.4.0")).toBe("Command line");
  });

  it("never renders a blank row", () => {
    expect(deviceLabel("")).toBe("Unknown device");
    expect(deviceLabel(null)).toBe("Unknown device");
    expect(deviceLabel("   ")).toBe("Unknown device");
  });

  it("never echoes hostile user-agent text into the security screen", () => {
    const hostile = `<script>alert(1)</script> ${"A".repeat(5000)}`;
    expect(deviceLabel(hostile)).toBe("Unknown device");
  });
});

describe("authMethodLabel", () => {
  it("maps the known methods and refuses to echo unknown ones", () => {
    expect(authMethodLabel("password")).toBe("Password");
    expect(authMethodLabel("magic_link")).toBe("Magic link");
    expect(authMethodLabel("oauth")).toBe("Google");
    expect(authMethodLabel("device_grant")).toBe(
      "Approved from another device",
    );
    expect(authMethodLabel("webauthn")).toBe("Passkey");
    expect(authMethodLabel("something-else")).toBe("Unknown method");
    expect(authMethodLabel(null)).toBe("Unknown method");
  });
});

describe("shortIp", () => {
  it("truncates IPv4 to the network half", () => {
    expect(shortIp("93.184.216.34")).toBe("93.184.×.×");
  });

  it("truncates IPv6 to the first two groups", () => {
    expect(shortIp("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8::…");
  });

  it("drops anything that is not an address", () => {
    expect(shortIp("")).toBeNull();
    expect(shortIp(null)).toBeNull();
    expect(shortIp("not-an-ip")).toBeNull();
    expect(shortIp("1.2.3")).toBeNull();
    expect(shortIp("x".repeat(200))).toBeNull();
  });
});

describe("sessionRowSummary", () => {
  it("composes a title and a detail line from only the fields present", () => {
    expect(
      sessionRowSummary({
        userAgent: CHROME_WINDOWS,
        authMethod: "password",
        ip: "93.184.216.34",
        current: true,
      }),
    ).toEqual({
      title: "Chrome · Windows",
      detail: "Password · 93.184.×.×",
      current: true,
    });
  });

  it("omits the IP segment entirely when the server sent none", () => {
    expect(
      sessionRowSummary({ userAgent: SAFARI_IPHONE, authMethod: "magic_link" }),
    ).toEqual({
      title: "Safari · iPhone",
      detail: "Magic link",
      current: false,
    });
  });
});

describe("compareSessions", () => {
  it("always puts the current device first", () => {
    const rows = [
      { current: false, lastSeenAt: "2026-07-25T12:00:00Z" },
      { current: true, lastSeenAt: "2026-07-01T12:00:00Z" },
    ];
    expect([...rows].sort(compareSessions)[0]?.current).toBe(true);
  });

  it("orders the rest most-recently-seen first", () => {
    const rows = [
      { current: false, lastSeenAt: "2026-07-01T12:00:00Z" },
      { current: false, lastSeenAt: "2026-07-24T12:00:00Z" },
    ];
    expect([...rows].sort(compareSessions)[0]?.lastSeenAt).toBe(
      "2026-07-24T12:00:00Z",
    );
  });

  it("sinks rows with an unparseable timestamp rather than throwing", () => {
    const rows = [
      { current: false, lastSeenAt: null },
      { current: false, lastSeenAt: "2026-07-24T12:00:00Z" },
    ];
    expect([...rows].sort(compareSessions)[0]?.lastSeenAt).toBe(
      "2026-07-24T12:00:00Z",
    );
  });
});
