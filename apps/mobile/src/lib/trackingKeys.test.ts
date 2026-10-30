import { describe, expect, it } from "vitest";

import {
  parseTrackingKeys,
  trackingKeyIsActive,
  trackingKeyRevokeCopy,
  type TrackingKey,
} from "./trackingKeys";

/** One row exactly as conversions.go `TrackingKey` encodes it. */
function wireRow(over: Record<string, unknown> = {}) {
  return {
    id: "3f7c1a2e-9b4d-4c8e-a1f0-5d6e7f8a9b0c",
    tenant_id: "11111111-1111-4111-8111-111111111111",
    label: "Production storefront",
    prefix: "pk_live_ab12",
    created_at: "2026-08-30T10:00:00Z",
    ...over,
  };
}

describe("parseTrackingKeys", () => {
  it("maps the handler's bare array and reads an omitted revoked_at as live", () => {
    // `revoked_at` is `omitempty` on the Go struct: a live key has no field
    // at all, not a null one.
    const out = parseTrackingKeys([wireRow()]);
    expect(out).toEqual([
      {
        id: "3f7c1a2e-9b4d-4c8e-a1f0-5d6e7f8a9b0c",
        label: "Production storefront",
        prefix: "pk_live_ab12",
        createdAt: "2026-08-30T10:00:00Z",
        revokedAt: "",
      },
    ]);
    expect(out[0] && trackingKeyIsActive(out[0])).toBe(true);
  });

  it("keeps a revoked row and its timestamp rather than dropping it", () => {
    // The row stays so a person can see WHEN a key died; only the verb goes.
    const out = parseTrackingKeys([
      wireRow({ revoked_at: "2026-08-29T10:00:00Z" }),
    ]);
    expect(out[0]?.revokedAt).toBe("2026-08-29T10:00:00Z");
    expect(out[0] && trackingKeyIsActive(out[0])).toBe(false);
  });

  it("names a key by label, then public prefix, then id — never blank", () => {
    // Under pressure a person matches a row to the leaked snippet by the
    // prefix; nobody can decide about a blank line.
    expect(parseTrackingKeys([wireRow({ label: "" })])[0]?.label).toBe(
      "pk_live_ab12",
    );
    expect(
      parseTrackingKeys([wireRow({ label: "   ", prefix: "" })])[0]?.label,
    ).toBe("3f7c1a2e-9b4d-4c8e-a1f0-5d6e7f8a9b0c");
  });

  it("trims every string it keeps", () => {
    const out = parseTrackingKeys([
      wireRow({ id: "  k1  ", label: "  Shop  ", prefix: " pk_x " }),
    ]);
    expect(out[0]).toMatchObject({ id: "k1", label: "Shop", prefix: "pk_x" });
  });

  it("drops rows without an id and rows that are not objects", () => {
    const out = parseTrackingKeys([
      wireRow({ id: "" }),
      wireRow({ id: 42 }),
      null,
      "pk_live_leaked",
      [wireRow()],
      wireRow({ id: "kept" }),
    ]);
    expect(out.map((row) => row.id)).toEqual(["kept"]);
  });

  it("parses every non-array wire shape to nothing rather than crashing", () => {
    // Go `omitempty`, a paged envelope, an SPA fallback — all shapes a
    // panel reached mid-incident must survive.
    for (const hostile of [undefined, null, {}, { items: [] }, "x", 1]) {
      expect(parseTrackingKeys(hostile)).toEqual([]);
    }
  });

  it("never carries plaintext forward, even if the wire leaked it", () => {
    // The register is documented as metadata-only. If that ever regressed
    // server-side, the phone must still be a dead end for the secret.
    const out = parseTrackingKeys([
      wireRow({ plaintext: "pk_live_ab12_FULLSECRET", key_hash: "deadbeef" }),
    ]);
    expect(Object.keys(out[0] ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "label",
      "prefix",
      "revokedAt",
    ]);
    expect(JSON.stringify(out)).not.toContain("FULLSECRET");
    expect(JSON.stringify(out)).not.toContain("deadbeef");
  });
});

describe("trackingKeyRevokeCopy", () => {
  const key: TrackingKey = {
    id: "k1",
    label: "Production storefront",
    prefix: "pk_live_ab12",
    createdAt: "2026-08-30T10:00:00Z",
    revokedAt: "",
  };

  it("names the key and both consequences, and uses a verb to confirm", () => {
    const copy = trackingKeyRevokeCopy(key);
    expect(copy.title).toBe("Revoke Production storefront?");
    // Stops the forgery AND stops the tenant's own pages. Naming only the
    // first would make revocation look free.
    expect(copy.body).toMatch(/stop being recorded immediately/u);
    expect(copy.body).toMatch(/your own pages/u);
    expect(copy.body).toMatch(/cannot be undone/u);
    expect(copy.confirmLabel).toBe("Revoke key");
  });

  it("points issuance back at a desk surface, never at this screen", () => {
    expect(trackingKeyRevokeCopy(key).body).toMatch(/issue a new key from the web/u);
  });
});
