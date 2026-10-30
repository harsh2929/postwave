// Feature-flag section helpers (full-surface wiring #56): override
// rows sort above platform defaults, the resolve preview reports the
// server's source verbatim, and key validation only blocks the
// obviously-broken inputs (backend stays the source of truth).

import { describe, expect, it } from "vitest";

import type { FeatureFlag } from "../../lib/api-client";
import {
  flagSourceLabel,
  resolveSourceCopy,
  resolveSourceTone,
  sortFlags,
  validateFlagKey,
} from "../../components/settings/feature-flags-helpers";

const flag = (key: string, isDefault: boolean): FeatureFlag => ({
  id: key,
  key,
  value: "on",
  is_default: isDefault,
  enabled: true,
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
});

describe("sortFlags", () => {
  it("puts tenant overrides above defaults, alpha inside each group", () => {
    const sorted = sortFlags([
      flag("zeta", true),
      flag("beta", false),
      flag("alpha", true),
      flag("delta", false),
    ]);
    expect(sorted.map((f) => `${f.key}:${f.is_default}`)).toEqual([
      "beta:false",
      "delta:false",
      "alpha:true",
      "zeta:true",
    ]);
  });

  it("sorts flags with a missing key field without crashing", () => {
    // A flag row can arrive without `key`; the sort must not throw on
    // `undefined.localeCompare`.
    const partial = [
      { id: "1", value: "on", is_default: false, enabled: true, created_at: "", updated_at: "" },
      flag("alpha", false),
    ] as unknown as FeatureFlag[];
    expect(() => sortFlags(partial)).not.toThrow();
  });
});

describe("flagSourceLabel", () => {
  it("labels by is_default", () => {
    expect(flagSourceLabel({ is_default: false })).toBe("Tenant override");
    expect(flagSourceLabel({ is_default: true })).toBe("Platform default");
  });
});

describe("validateFlagKey", () => {
  it("rejects empty and whitespace-bearing keys", () => {
    expect(validateFlagKey("")).not.toBeNull();
    expect(validateFlagKey("   ")).not.toBeNull();
    expect(validateFlagKey("two words")).not.toBeNull();
  });

  it("accepts normal keys (backend validates the rest)", () => {
    expect(validateFlagKey("new_composer")).toBeNull();
    expect(validateFlagKey("beta.flag-2")).toBeNull();
  });

  it("rejects absurdly long keys", () => {
    expect(validateFlagKey("x".repeat(129))).not.toBeNull();
  });
});

describe("resolve preview", () => {
  it("maps each server source to a distinct tone", () => {
    expect(resolveSourceTone("tenant")).toBe("success");
    expect(resolveSourceTone("default")).toBe("");
    expect(resolveSourceTone("missing")).toBe("warning");
  });

  it("reports tenant/default/missing sources verbatim", () => {
    expect(
      resolveSourceCopy({ key: "k", value: "on", source: "tenant" }),
    ).toContain("override");
    expect(
      resolveSourceCopy({ key: "k", value: "on", source: "default" }),
    ).toContain("platform default");
    const missing = resolveSourceCopy({ key: "k", value: "", source: "missing" });
    expect(missing).toContain("not set");
    // Missing must never pretend there's a value.
    expect(missing).not.toContain('resolves to ""');
  });

  it("doesn't invent a meaning for unknown sources", () => {
    expect(
      resolveSourceCopy({ key: "k", value: "v", source: "weird" }),
    ).toContain('unrecognized source "weird"');
  });
});
