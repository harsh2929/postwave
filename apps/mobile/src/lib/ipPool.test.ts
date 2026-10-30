/**
 * The ip_pool projection's honesty rule: absent, malformed, or unnamed pool
 * data must read as UNKNOWN — never default to "Shared", which would be a
 * claim about the workspace the response did not make.
 *
 * And the second half of the same rule, which the first version of this module
 * did not keep: "the server did not report a pool" and "we never got a
 * response" are DIFFERENT unknowns. The sending-settings screen renders its
 * body with no row at all whenever the read gate is closed, so collapsing the
 * two made the phone report on a server it had not spoken to.
 */
import { describe, expect, it } from "vitest";

import { describeIpPool, ipPoolLine } from "./ipPool";

describe("describeIpPool", () => {
  it("reads a dedicated pool off the wire shape", () => {
    expect(describeIpPool({ name: "pool-eu-1", dedicated: true }, true)).toEqual({
      kind: "known",
      name: "pool-eu-1",
      dedicated: true,
    });
  });

  it("reads a shared pool only when the server SAYS dedicated=false", () => {
    expect(describeIpPool({ name: "shared", dedicated: false }, true)).toEqual({
      kind: "known",
      name: "shared",
      dedicated: false,
    });
  });

  it("is not_reported when a VERIFIED row omitted the field (older API build)", () => {
    expect(describeIpPool(undefined, true).kind).toBe("not_reported");
    expect(describeIpPool(null, true).kind).toBe("not_reported");
  });

  it("is not_reported for malformed shapes rather than inventing a pool", () => {
    expect(describeIpPool("shared", true).kind).toBe("not_reported");
    expect(describeIpPool(["pool"], true).kind).toBe("not_reported");
    expect(describeIpPool({ dedicated: true }, true).kind).toBe("not_reported");
    expect(describeIpPool({ name: "   " }, true).kind).toBe("not_reported");
  });

  it("is unverified when no row was loaded, whatever the field would say", () => {
    // The unverified branch must win even over a well-formed pool object: if
    // there is no verified row, any pool value reaching here is not evidence.
    expect(describeIpPool(undefined, false).kind).toBe("unverified");
    expect(describeIpPool({ name: "pool-eu-1", dedicated: true }, false).kind).toBe(
      "unverified",
    );
  });

  it("treats a non-boolean dedicated flag as not-dedicated, never truthy-coerced", () => {
    expect(describeIpPool({ name: "p", dedicated: "yes" }, true)).toEqual({
      kind: "known",
      name: "p",
      dedicated: false,
    });
  });
});

describe("ipPoolLine", () => {
  it("prints the pool and its tier", () => {
    expect(ipPoolLine({ kind: "known", name: "pool-eu-1", dedicated: true })).toBe(
      "pool-eu-1 · Dedicated",
    );
    expect(ipPoolLine({ kind: "known", name: "shared", dedicated: false })).toBe(
      "shared · Shared",
    );
  });

  it("says unknown out loud instead of defaulting to Shared", () => {
    expect(ipPoolLine({ kind: "not_reported" })).toMatch(/Unknown/);
    expect(ipPoolLine({ kind: "not_reported" })).not.toMatch(/Shared/);
    expect(ipPoolLine({ kind: "unverified" })).toMatch(/Unknown/);
    expect(ipPoolLine({ kind: "unverified" })).not.toMatch(/Shared/);
  });

  it("blames the right party for each unknown", () => {
    // "not reported by this server" about a server nobody called is the exact
    // fabrication this split exists to prevent, so the two lines must differ.
    expect(ipPoolLine({ kind: "not_reported" })).toBe(
      "Unknown — not reported by this server",
    );
    expect(ipPoolLine({ kind: "unverified" })).toBe(
      "Unknown — no settings response has been verified",
    );
  });
});
