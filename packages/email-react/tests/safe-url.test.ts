// SPDX-License-Identifier: MIT
//
// safeEmailHref / safeEmailImageSrc decide which URLs reach a rendered email.
// Neither had a test.
//
// THE HOLE. The host denylist is hand-rolled, and WHATWG URL normalisation was
// doing more of the work than it appeared to: `http://2130706433/`,
// `http://0177.0.0.1/` and `http://0x7f000001/` all normalise back to
// `127.0.0.1` before the dotted-quad rules ever run, so those classic evasions
// were already covered — by the platform, not by this file.
//
// What normalisation does NOT undo is an IPv4 address carried inside an IPv6
// one. `[::ffff:127.0.0.1]` normalises to `[::ffff:7f00:1]`, which is not
// `::1`, not `fc00::/7` and not `fe80::/10`, so every private-range rule was
// skipped. `[::ffff:169.254.169.254]` — the cloud metadata address — passed the
// same way, as did the NAT64 form `[64:ff9b::a9fe:a9fe]`.
//
// Templates are customer-authored and the rendered `<img src>` is fetched by
// whatever opens the mail — including proxies that fetch on the reader's
// behalf. The point is narrower than "SSRF": this function advertises that
// loopback, private and metadata hosts cannot reach a rendered email, and for
// these forms that was not true.
//
// The fix folds the embedded IPv4 out and re-enters the SAME IPv4 rules, rather
// than adding a second set of hex patterns that would drift from the first.
import { describe, expect, it } from "vitest";

import { safeEmailHref, safeEmailImageSrc } from "../src/lib/safe-url.js";

describe("safeEmailImageSrc blocks internal hosts however they are spelled", () => {
  it.each([
    ["loopback", "http://127.0.0.1/x"],
    ["loopback by name", "http://localhost/x"],
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["private 10/8", "http://10.0.0.5/x"],
    ["private 192.168/16", "http://192.168.1.1/x"],
    ["private 172.16/12", "http://172.16.0.1/x"],
    ["carrier-grade NAT", "http://100.64.0.1/x"],
    ["decimal loopback", "http://2130706433/x"],
    ["octal loopback", "http://0177.0.0.1/x"],
    ["hex loopback", "http://0x7f000001/x"],
    ["IPv6 loopback", "http://[::1]/x"],
    ["IPv6 loopback expanded", "http://[0:0:0:0:0:0:0:1]/x"],
    ["IPv6 ULA", "http://[fd00::1]/x"],
    ["IPv6 link-local", "http://[fe80::1]/x"],
    // The forms that got through.
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/x"],
    ["IPv4-mapped metadata", "http://[::ffff:169.254.169.254]/x"],
    ["IPv4-mapped private", "http://[::ffff:10.0.0.5]/x"],
    ["IPv4-compatible loopback", "http://[::127.0.0.1]/x"],
    ["NAT64 loopback", "http://[64:ff9b::7f00:1]/x"],
    ["NAT64 metadata", "http://[64:ff9b::a9fe:a9fe]/x"],
  ])("blocks %s", (_label, url) => {
    expect(safeEmailImageSrc(url)).toBe("");
  });

  it.each([
    ["a normal https host", "https://example.com/logo.png"],
    ["a public IPv6", "http://[2001:db8::1]/x"],
    // The mirror of the fix: an embedded PUBLIC address must still pass, or the
    // repair would be over-blocking rather than correct.
    ["a mapped PUBLIC IPv4", "http://[::ffff:93.184.216.34]/x"],
    ["a NAT64-wrapped PUBLIC IPv4", "http://[64:ff9b::5db8:d822]/x"],
  ])("still allows %s", (_label, url) => {
    expect(safeEmailImageSrc(url)).not.toBe("");
  });
});

describe("safeEmailHref keeps its protocol allowlist", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ])("refuses %j", (url) => {
    expect(safeEmailHref(url)).toBe("#");
  });

  it.each(["https://example.com/a", "mailto:a@example.com", "tel:+15551234567"])(
    "allows %j",
    (url) => {
      expect(safeEmailHref(url)).not.toBe("#");
    },
  );

  it("refuses credentials embedded in the URL", () => {
    expect(safeEmailHref("https://user:pass@example.com/")).toBe("#");
  });

  it("refuses control characters, encoded or literal", () => {
    expect(safeEmailHref("https://example.com/\nSet-Cookie:x")).toBe("#");
    expect(safeEmailHref("https://example.com/%0d%0aSet-Cookie:x")).toBe("#");
  });

  it("passes a merge token through untouched", () => {
    // Templates carry `{{unsubscribe_url}}` and friends; the token grammar
    // excludes quotes and spaces, so it cannot break out of the attribute.
    expect(safeEmailHref("{{unsubscribe_url}}")).toBe("{{unsubscribe_url}}");
  });

  it("still resolves an ordinary URL", () => {
    // Guard the guard: a function returning the fallback for everything would
    // satisfy every refusal above.
    expect(safeEmailHref("https://moosewave.com/a?b=1")).toBe(
      "https://moosewave.com/a?b=1",
    );
  });
});
