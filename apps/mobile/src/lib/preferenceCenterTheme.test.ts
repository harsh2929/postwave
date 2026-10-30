/**
 * The preference-centre theme policy, pinned against the Go validator it
 * mirrors (apps/api/internal/privacy_portal/preference_center.go).
 *
 * The expectations below are transcribed from THAT FILE, not derived from the
 * module under test: each one names the Go rule it encodes, so a drift in
 * either direction is a failing test rather than a silently-agreeing pair.
 */
import { describe, expect, it } from "vitest";

import {
  PREFERENCE_THEME_DEFAULTS,
  SERVER_COLOR_REFUSAL,
  SERVER_FOOTER_CONTROL_REFUSAL,
  SERVER_FOOTER_LONG_REFUSAL,
  SERVER_LOGO_REFUSAL,
  parsePreferenceCenterTheme,
  preferenceFooterBytes,
  preferenceThemeContrast,
  preferenceThemeContrastAdvisory,
  preferenceThemeDirty,
  preferenceThemeEffectiveColor,
  preferenceThemeIssue,
  preferenceThemePayload,
  preferenceThemeSaveError,
  type PreferenceCenterTheme,
} from "./preferenceCenterTheme";

function theme(over: Partial<PreferenceCenterTheme> = {}): PreferenceCenterTheme {
  return { ...PREFERENCE_THEME_DEFAULTS, ...over };
}

function logoIssue(logoUrl: string) {
  return preferenceThemeIssue(theme({ logoUrl }));
}

describe("parsePreferenceCenterTheme", () => {
  it("reads the wire shape the GET handler writes", () => {
    expect(
      parsePreferenceCenterTheme({
        tenantId: "t-1",
        logo_url: "https://cdn.example.com/logo.png",
        primary_color: "#123ABC",
        footer_text: "Bye",
        show_postwave_badge: false,
      }),
    ).toEqual({
      logoUrl: "https://cdn.example.com/logo.png",
      primaryColor: "#123ABC",
      footerText: "Bye",
      showPostwaveBadge: false,
    });
  });

  it("never reads a missing badge as OFF — the server's zero-row default is ON", () => {
    expect(parsePreferenceCenterTheme({}).showPostwaveBadge).toBe(true);
    // A non-boolean is the wire being wrong, not the operator asking for OFF.
    expect(
      parsePreferenceCenterTheme({ show_postwave_badge: "false" })
        .showPostwaveBadge,
    ).toBe(true);
  });

  it("falls back to the package default colour, and to empty for a bad logo", () => {
    const parsed = parsePreferenceCenterTheme({
      primary_color: "   ",
      logo_url: 42,
      footer_text: null,
    });
    expect(parsed.primaryColor).toBe("#5B6CFF");
    expect(parsed.logoUrl).toBe("");
    expect(parsed.footerText).toBe("");
  });

  it("survives a null / non-object payload", () => {
    expect(parsePreferenceCenterTheme(null).primaryColor).toBe("#5B6CFF");
  });
});

describe("preferenceThemePayload", () => {
  it("sends exactly the four columns and never echoes tenantId back", () => {
    const body = preferenceThemePayload(theme());
    expect(Object.keys(body).sort()).toEqual([
      "footer_text",
      "logo_url",
      "primary_color",
      "show_postwave_badge",
    ]);
    expect("tenantId" in body).toBe(false);
  });

  it("trims what validate() trims and leaves the footer's bytes alone", () => {
    const body = preferenceThemePayload(
      theme({
        logoUrl: "  https://cdn.example.com/l.png  ",
        primaryColor: " #ABCDEF ",
        footerText: "  padded  ",
      }),
    );
    expect(body.logo_url).toBe("https://cdn.example.com/l.png");
    expect(body.primary_color).toBe("#ABCDEF");
    // The Go validator does NOT trim footer_text, and its 4096-byte budget is
    // measured on the untrimmed value.
    expect(body.footer_text).toBe("  padded  ");
  });
});

describe("preferenceThemeDirty", () => {
  it("is true for a change in any of the four fields, false for none", () => {
    expect(preferenceThemeDirty(theme(), theme())).toBe(false);
    expect(preferenceThemeDirty(theme(), theme({ logoUrl: "x" }))).toBe(true);
    expect(preferenceThemeDirty(theme(), theme({ primaryColor: "#000000" }))).toBe(true);
    expect(preferenceThemeDirty(theme(), theme({ footerText: "x" }))).toBe(true);
    expect(
      preferenceThemeDirty(theme(), theme({ showPostwaveBadge: false })),
    ).toBe(true);
  });
});

describe("the colour", () => {
  it("treats an empty colour as the reset-to-default the server performs", () => {
    expect(preferenceThemeEffectiveColor(theme({ primaryColor: "  " }))).toBe(
      "#5B6CFF",
    );
    expect(
      preferenceThemeEffectiveColor(theme({ primaryColor: " #ABCDEF " })),
    ).toBe("#ABCDEF");
  });

  it("measures white-on-colour contrast", () => {
    expect(preferenceThemeContrast("#000000")).toBeCloseTo(21, 5);
    expect(preferenceThemeContrast("#FFFFFF")).toBeCloseTo(1, 5);
    expect(preferenceThemeContrast("nope")).toBeNull();
  });

  it("warns about the API's OWN DEFAULT colour without refusing it", () => {
    // 4.17:1 — the reason contrast cannot be a save-blocker on this card.
    const advisory = preferenceThemeContrastAdvisory(theme());
    expect(advisory?.ratio).toBeCloseTo(4.17, 2);
    expect(advisory?.message).toContain("4.17:1");
    expect(advisory?.message).toContain("The API accepts it");
    expect(preferenceThemeIssue(theme())).toBeNull();
  });

  it("stays silent above the 4.5:1 floor", () => {
    expect(
      preferenceThemeContrastAdvisory(theme({ primaryColor: "#2563EB" })),
    ).toBeNull();
  });

  it("does not warn about a colour the server would refuse — that is a refusal", () => {
    expect(
      preferenceThemeContrastAdvisory(theme({ primaryColor: "#GGGGGG" })),
    ).toBeNull();
  });

  it("refuses a non-six-digit hex in the server's own words", () => {
    expect(preferenceThemeIssue(theme({ primaryColor: "#abc" }))).toEqual({
      field: "primaryColor",
      message: SERVER_COLOR_REFUSAL,
    });
    expect(preferenceThemeIssue(theme({ primaryColor: "#GGGGGG" }))?.message).toBe(
      SERVER_COLOR_REFUSAL,
    );
    // Mixed case is fine: the CHECK constraint is /^#[0-9A-Fa-f]{6}$/.
    expect(preferenceThemeIssue(theme({ primaryColor: "#aB12Cd" }))).toBeNull();
  });
});

describe("the logo URL (validPreferenceLogoURL, rule for rule)", () => {
  it("accepts empty — no logo is a valid theme", () => {
    expect(logoIssue("")).toBeNull();
    expect(logoIssue("   ")).toBeNull();
  });

  it("accepts a public https URL", () => {
    expect(logoIssue("https://cdn.example.com/logo.png?v=2#x")).toBeNull();
    // url.Parse lower-cases the scheme, so the case does not matter.
    expect(logoIssue("HTTPS://Example.com/logo.png")).toBeNull();
    // TrimSuffix(host, ".") — a fully-qualified trailing dot is still public.
    expect(logoIssue("https://example.com./logo.png")).toBeNull();
    expect(logoIssue("https://cdn.example.com:8443/logo.png")).toBeNull();
  });

  it("refuses every non-https scheme with the server's sentence", () => {
    for (const url of [
      "http://cdn.example.com/l.png",
      "data:image/svg+xml;base64,AAAA",
      "ftp://cdn.example.com/l.png",
      "//cdn.example.com/l.png",
      "cdn.example.com/l.png",
    ]) {
      expect(logoIssue(url)).toEqual({
        field: "logoUrl",
        message: SERVER_LOGO_REFUSAL,
      });
    }
  });

  it("refuses embedded credentials (u.User != nil)", () => {
    expect(logoIssue("https://user:pw@cdn.example.com/l.png")).not.toBeNull();
    expect(logoIssue("https://@cdn.example.com/l.png")).not.toBeNull();
  });

  it("refuses local and single-label hosts", () => {
    for (const host of ["localhost", "assets.localhost", "printer.local", "intranet"]) {
      expect(logoIssue(`https://${host}/l.png`)).not.toBeNull();
    }
  });

  it("refuses the IPv4 classes safePreferenceLogoHost names", () => {
    for (const ip of [
      "0.0.0.0",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "224.0.0.1",
      "239.1.1.1",
    ]) {
      expect(logoIssue(`https://${ip}/l.png`)).not.toBeNull();
    }
  });

  it("accepts public IPv4 just outside those ranges", () => {
    for (const ip of ["172.15.0.1", "172.32.0.1", "8.8.8.8", "223.255.255.1"]) {
      expect(logoIssue(`https://${ip}/l.png`)).toBeNull();
    }
  });

  it("treats a leading-zero quad as a hostname, exactly as net.ParseIP does", () => {
    // Go rejects "010.1.1.1" as an IP, so the host falls through to the
    // contains-a-dot rule and is ACCEPTED. Mirroring this matters: being
    // stricter than the server would refuse a value the server takes.
    expect(logoIssue("https://010.1.1.1/l.png")).toBeNull();
  });

  it("classifies IPv6 literals", () => {
    for (const ip of ["::1", "::", "fd00::1", "fc00::5", "fe80::1", "ff02::1"]) {
      expect(logoIssue(`https://[${ip}]/l.png`)).not.toBeNull();
    }
    expect(logoIssue("https://[2001:db8::1]/l.png")).toBeNull();
    expect(logoIssue("https://[2001:db8::1]:8443/l.png")).toBeNull();
  });

  it("unwraps an IPv4-mapped IPv6 literal, exactly as ip.To4() does", () => {
    // ::ffff:127.0.0.1 IS the loopback to Go, so it must be to us.
    expect(logoIssue("https://[::ffff:127.0.0.1]/l.png")).not.toBeNull();
    expect(logoIssue("https://[::ffff:10.0.0.1]/l.png")).not.toBeNull();
    expect(logoIssue("https://[::ffff:8.8.8.8]/l.png")).toBeNull();
  });

  it("blocks 224/4 but not 240/4 — IsMulticast is ip4[0]&0xf0 == 0xe0", () => {
    expect(logoIssue("https://239.255.255.255/l.png")).not.toBeNull();
    expect(logoIssue("https://240.0.0.1/l.png")).toBeNull();
    expect(logoIssue("https://255.255.255.255/l.png")).toBeNull();
  });

  it("accepts an internationalised domain (parseHost leaves bytes >= 0x80 alone)", () => {
    expect(logoIssue("https://例え.jp/l.png")).toBeNull();
    expect(logoIssue("https://xn--r8jz45g.xn--zckzah/l.png")).toBeNull();
  });

  it("refuses a %-escaped host, which is how a path is smuggled into one", () => {
    expect(logoIssue("https://a.com%2f.evil.com/l.png")).not.toBeNull();
    expect(logoIssue("https://%41.example.com/l.png")).not.toBeNull();
  });

  it("refuses a URL past logoURLMaxBytes, measured in bytes", () => {
    const under = `https://cdn.example.com/${"a".repeat(2048 - 24)}`;
    expect(under.length).toBe(2048);
    expect(logoIssue(under)).toBeNull();
    expect(logoIssue(`${under}a`)).not.toBeNull();
  });

  it("refuses a control byte anywhere in the URL (net/url does)", () => {
    expect(logoIssue("https://cdn.example.com/l\u0001.png")).not.toBeNull();
    // ...but a SPACE inside the path is not a control byte, and Go's parser
    // accepts it, so we must not be stricter than the route we mirror.
    expect(logoIssue("https://cdn.example.com/l .png")).toBeNull();
  });
});

describe("the footer", () => {
  it("counts UTF-8 bytes, like Go's len(string)", () => {
    expect(preferenceFooterBytes("abc")).toBe(3);
    expect(preferenceFooterBytes("€")).toBe(3);
    expect(preferenceFooterBytes("🙂")).toBe(4);
  });

  it("allows exactly footerMaxBytes and refuses one byte more", () => {
    expect(preferenceThemeIssue(theme({ footerText: "a".repeat(4096) }))).toBeNull();
    expect(preferenceThemeIssue(theme({ footerText: "a".repeat(4097) }))).toEqual({
      field: "footerText",
      message: SERVER_FOOTER_LONG_REFUSAL,
    });
  });

  it("measures multi-byte copy in bytes, not characters", () => {
    // 1366 * 3 = 4098 bytes from only 1366 characters.
    const wide = "€".repeat(1366);
    expect(wide.length).toBeLessThan(4096);
    expect(preferenceThemeIssue(theme({ footerText: wide }))?.message).toBe(
      SERVER_FOOTER_LONG_REFUSAL,
    );
  });

  it("permits the three whitespace controls validate() continues past", () => {
    expect(
      preferenceThemeIssue(theme({ footerText: "line\nnext\r\tindented" })),
    ).toBeNull();
  });

  it("refuses other control, format and surrogate characters", () => {
    for (const bad of ["\u0000", "\u0007", "\u007f", "\u200b", "\u202e", "\ufeff", "\ud800"]) {
      expect(preferenceThemeIssue(theme({ footerText: `hi${bad}` }))).toEqual({
        field: "footerText",
        message: SERVER_FOOTER_CONTROL_REFUSAL,
      });
    }
  });
});

describe("refusal order", () => {
  it("reports the first field validate() would have refused", () => {
    // validate() checks logo, then colour, then footer length, then footer
    // characters — so a draft that is wrong in every field must name the logo.
    const broken = theme({
      logoUrl: "http://localhost/l.png",
      primaryColor: "#zzz",
      footerText: `${"a".repeat(5000)} `,
    });
    expect(preferenceThemeIssue(broken)?.field).toBe("logoUrl");
    const colourFirst = theme({
      primaryColor: "#zzz",
      footerText: "a".repeat(5000),
    });
    expect(colourFirst && preferenceThemeIssue(colourFirst)?.field).toBe(
      "primaryColor",
    );
    expect(
      preferenceThemeIssue(theme({ footerText: `${"a".repeat(5000)} ` }))
        ?.message,
    ).toBe(SERVER_FOOTER_LONG_REFUSAL);
  });
});

describe("preferenceThemeSaveError", () => {
  it("renders the 422's own sentence verbatim", () => {
    expect(
      preferenceThemeSaveError({
        status: 422,
        code: "validation_failed",
        message: SERVER_COLOR_REFUSAL,
      }),
    ).toBe(SERVER_COLOR_REFUSAL);
  });

  it("names the role rule on a 403 and falls back when the server said nothing", () => {
    expect(
      preferenceThemeSaveError({ status: 403, message: "forbidden" }),
    ).toBe("Only workspace admins can change the preference-centre theme.");
    expect(preferenceThemeSaveError({ status: 500, message: "   " })).toBe(
      "Couldn't save the preference-centre theme.",
    );
  });
});
