// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { formatDateWithToken } from "@/lib/date-format-preview";
import { isValidHexColor, normalizeHexColor } from "@/lib/hex-color";
import { isValidHostname } from "@/lib/hostname";
import {
  activeSettingsLabel,
  flattenSettingsNav,
  isActiveSettingsTab,
  SETTINGS_NAV_SECTIONS,
} from "@/lib/settings-nav";
import {
  isPrivilegedScope,
  scopeHeaderLabel,
} from "@/lib/team-roles-api";
import { validateAllowedIp } from "@/lib/api-keys-api";
import {
  complianceFieldErrors,
  isValidCountryCode,
  readinessItemHint,
  severityLabel,
} from "@/app/(dashboard)/app/settings/sender/sender-settings-helpers";
import { isKnownTimeZone, listTimeZones } from "@/lib/timezones";

describe("hex-color", () => {
  it("accepts a 6-digit hex with or without #", () => {
    expect(isValidHexColor("#3b82f6")).toBe(true);
    expect(isValidHexColor("3b82f6")).toBe(true);
    expect(isValidHexColor("  #AABBCC  ")).toBe(true);
  });

  it("rejects malformed hex", () => {
    expect(isValidHexColor("blue")).toBe(false);
    expect(isValidHexColor("#12")).toBe(false);
    expect(isValidHexColor("#12345g")).toBe(false);
  });

  it("normalizes to canonical #rrggbb", () => {
    expect(normalizeHexColor("3B82F6")).toBe("#3b82f6");
    expect(normalizeHexColor("#ABC")).toBe("#aabbcc");
    expect(normalizeHexColor("not-a-color")).toBeNull();
  });
});

describe("hostname", () => {
  it("accepts real hostnames", () => {
    expect(isValidHostname("newsletter.example.com")).toBe(true);
    expect(isValidHostname("example.co.uk")).toBe(true);
    expect(isValidHostname("EXAMPLE.COM")).toBe(true);
  });

  it("rejects URLs, bare words, and junk", () => {
    expect(isValidHostname("not a domain")).toBe(false);
    expect(isValidHostname("https://example.com")).toBe(false);
    expect(isValidHostname("example.com/path")).toBe(false);
    expect(isValidHostname("example.com:443")).toBe(false);
    expect(isValidHostname("example")).toBe(false);
    expect(isValidHostname("")).toBe(false);
  });
});

describe("date-format-preview", () => {
  const date = new Date(2026, 6, 5); // 2026-07-05 local

  it("renders each supported token", () => {
    expect(formatDateWithToken("YYYY-MM-DD", date)).toBe("2026-07-05");
    expect(formatDateWithToken("MMM D, YYYY", date)).toBe("Jul 5, 2026");
    expect(formatDateWithToken("D MMM YYYY", date)).toBe("5 Jul 2026");
    expect(formatDateWithToken("MM/DD/YYYY", date)).toBe("07/05/2026");
  });

  it("returns empty for unknown token or invalid date", () => {
    expect(formatDateWithToken("bogus", date)).toBe("");
    expect(formatDateWithToken("YYYY-MM-DD", new Date("nope"))).toBe("");
  });
});

describe("timezones", () => {
  it("returns a non-empty, UTC-inclusive sorted list", () => {
    const zones = listTimeZones();
    expect(zones.length).toBeGreaterThan(10);
    expect(zones).toContain("UTC");
    // A user in a non-hardcoded zone must be representable.
    expect(zones).toContain("America/Chicago");
    const sorted = [...zones].sort((a, b) => a.localeCompare(b));
    expect(zones).toEqual(sorted);
  });

  it("recognises valid zones and rejects junk", () => {
    expect(isKnownTimeZone("America/Chicago")).toBe(true);
    expect(isKnownTimeZone("Not/AZone")).toBe(false);
    expect(isKnownTimeZone("")).toBe(false);
  });
});

describe("settings-nav", () => {
  it("groups all tabs into labeled sections without duplicates", () => {
    const flat = flattenSettingsNav();
    const hrefs = flat.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(SETTINGS_NAV_SECTIONS.length).toBeGreaterThan(1);
    expect(flat.length).toBe(18);
  });

  it("resolves the active tab, preferring nested routes over the index", () => {
    expect(isActiveSettingsTab("/app/settings", "/app/settings")).toBe(true);
    expect(isActiveSettingsTab("/app/settings", "/app/settings/api")).toBe(
      false,
    );
    expect(activeSettingsLabel("/app/settings")).toBe("Workspace");
    expect(activeSettingsLabel("/app/settings/api")).toBe("API Keys");
    expect(
      activeSettingsLabel("/app/settings/topics/123/edit"),
    ).toBe("Topics");
  });
});

describe("team-roles scope helpers", () => {
  it("disambiguates read/write columns (SETC-013)", () => {
    expect(scopeHeaderLabel("read:subscribers")).toBe("Subscribers (read)");
    expect(scopeHeaderLabel("write:subscribers")).toBe("Subscribers (write)");
    expect(scopeHeaderLabel("read:subscribers")).not.toBe(
      scopeHeaderLabel("write:subscribers"),
    );
    expect(scopeHeaderLabel("admin")).toBe("Admin");
  });

  it("flags high-privilege scopes (SETC-015)", () => {
    expect(isPrivilegedScope("admin")).toBe(true);
    expect(isPrivilegedScope("audit:read_all_tenants")).toBe(true);
    expect(isPrivilegedScope("audit:execute_actions")).toBe(true);
    expect(isPrivilegedScope("audit:configure_sinks")).toBe(true);
    expect(isPrivilegedScope("audit:read")).toBe(false);
    expect(isPrivilegedScope("read:subscribers")).toBe(false);
  });
});

describe("sender compliance + readiness helpers", () => {
  const base = {
    legal_sender_name: "",
    physical_address_line1: "",
    physical_address_line2: "",
    physical_address_city: "",
    physical_address_region: "",
    physical_address_postal_code: "",
    physical_address_country: "US",
    compliance_contact_email: "",
    default_footer_text: "",
    list_unsubscribe_enabled: true,
    one_click_unsubscribe_enabled: true,
    verified_sender_domain: false,
  };

  it("flags missing/invalid required compliance fields (SETC-027)", () => {
    const errors = complianceFieldErrors(base);
    expect(errors.legal_sender_name).toBeDefined();
    expect(errors.physical_address_line1).toBeDefined();
    expect(errors.compliance_contact_email).toBeDefined();
    // Country defaults to a valid ISO code.
    expect(errors.physical_address_country).toBeUndefined();

    const bad = complianceFieldErrors({
      ...base,
      physical_address_country: "USA",
      compliance_contact_email: "not-an-email",
    });
    expect(bad.physical_address_country).toContain("ISO");
    expect(bad.compliance_contact_email).toContain("valid");
  });

  it("validates ISO country codes", () => {
    expect(isValidCountryCode("US")).toBe(true);
    expect(isValidCountryCode("gb")).toBe(true);
    expect(isValidCountryCode("USA")).toBe(false);
    expect(isValidCountryCode("")).toBe(false);
  });

  it("title-cases severity labels (SETC-049)", () => {
    expect(severityLabel("blocker")).toBe("Required");
    expect(severityLabel("warning")).toBe("Recommended");
    expect(severityLabel("info")).toBe("Info");
  });

  it("resolves readiness items to a fix affordance (SETC-005)", () => {
    expect(
      readinessItemHint({ key: "max_sends_per_hour", label: "Hourly send cap" }),
    ).toEqual({ kind: "anchor", target: "sending-limits", label: "Configure" });
    expect(
      readinessItemHint({ key: "sender_domain", label: "Sender domain verified" }),
    ).toEqual({ kind: "anchor", target: "auth-health", label: "Check auth" });
    expect(
      readinessItemHint({ key: "compliance", label: "Compliance profile" }),
    ).toEqual({
      kind: "anchor",
      target: "compliance-profile",
      label: "Complete",
    });
    expect(
      readinessItemHint({ key: "warmup", label: "Warmup" }).kind,
    ).toBe("note");
  });
});

describe("api-key IP allowlist validation (SETC-051)", () => {
  it("accepts bare IPs and CIDR blocks", () => {
    expect(validateAllowedIp("203.0.113.4")).toBeNull();
    expect(validateAllowedIp("203.0.113.0/24")).toBeNull();
    expect(validateAllowedIp("2001:db8::/32")).toBeNull();
  });

  it("rejects malformed entries and bad prefixes", () => {
    expect(validateAllowedIp("")).not.toBeNull();
    expect(validateAllowedIp("not-an-ip")).not.toBeNull();
    expect(validateAllowedIp("203.0.113.4/99")).not.toBeNull();
    expect(validateAllowedIp("999.1.1.1")).not.toBeNull();
  });
});
