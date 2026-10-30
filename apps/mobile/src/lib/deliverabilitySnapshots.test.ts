import { describe, expect, it } from "vitest";

// Imports the PURE module directly. `deliverabilitySnapshots` itself reaches
// `connectivity` → `@react-native-community/netinfo` + `react-native`, which
// the node environment cannot transform — which is exactly why these two rules
// were split out into an import-free module.
import {
  REFERENCE_SNAPSHOT_MAX_BYTES,
  capRowsForVault,
  snapshotNotice,
  snapshotVaultId,
} from "./deliverabilitySnapshotKeys";

describe("snapshotVaultId", () => {
  it("namespaces every resource away from the suppression page's own key", () => {
    expect(snapshotVaultId("custom-domains")).toBe(
      "deliverability.custom-domains",
    );
    expect(snapshotVaultId("archive-index")).not.toBe("latest");
  });

  it("gives each resource a distinct id", () => {
    const ids = (
      [
        "custom-domains",
        "dmarc-reports",
        "archive-index",
        "sending-settings",
        "deliverability-hub",
        "suppression-page",
      ] as const
    ).map(snapshotVaultId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("snapshotNotice", () => {
  const relative = (value: number) => `${Math.round(value / 1000)}s ago`;

  it("says nothing when the data is live — the common case", () => {
    expect(
      snapshotNotice({ fromSnapshot: false, capturedAt: Date.now() }, relative),
    ).toBeNull();
    expect(snapshotNotice(undefined, relative)).toBeNull();
  });

  it("labels a cached read with its capture time", () => {
    expect(
      snapshotNotice({ fromSnapshot: true, capturedAt: 3000 }, relative),
    ).toBe("Cached 3s ago — reconnect to refresh.");
  });

  it("still admits staleness when the capture time is unknown", () => {
    const notice = snapshotNotice(
      { fromSnapshot: true, capturedAt: null },
      relative,
    );
    expect(notice).toContain("Cached");
    expect(notice).not.toContain("NaN");
  });
});

describe("reference snapshot ids (COMMERCE#15 / AUDIENCE#66)", () => {
  it("keeps reference catalogues in their own namespace", () => {
    expect(snapshotVaultId("discounts")).toBe("reference.discounts");
    expect(snapshotVaultId("lists")).toBe("reference.lists");
    expect(snapshotVaultId("tags")).toBe("reference.tags");
  });

  it("never collides with a deliverability id or with `latest`", () => {
    const ids = (
      [
        "custom-domains",
        "dmarc-reports",
        "archive-index",
        "sending-settings",
        "deliverability-hub",
        "suppression-page",
        "discounts",
        "lists",
        "tags",
      ] as const
    ).map(snapshotVaultId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("latest");
  });

  it("does not change the six original ids", () => {
    // A changed prefix orphans every snapshot already written to a device.
    expect(snapshotVaultId("suppression-page")).toBe(
      "deliverability.suppression-page",
    );
    expect(snapshotVaultId("sending-settings")).toBe(
      "deliverability.sending-settings",
    );
  });
});

describe("capRowsForVault", () => {
  const measure = (value: unknown) => JSON.stringify(value).length;

  it("passes a catalogue that already fits through untouched", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(capRowsForVault(rows, 1000)).toEqual({ rows, truncated: false });
  });

  it("keeps the longest prefix that fits and says it truncated", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: `row-${i}` }));
    const budget = measure(rows.slice(0, 10));
    const capped = capRowsForVault(rows, budget);
    expect(capped.truncated).toBe(true);
    expect(capped.rows.length).toBe(10);
    expect(measure(capped.rows)).toBeLessThanOrEqual(budget);
    // Trimmed from the TAIL: the head is what a picker shows first.
    expect(capped.rows[0]).toEqual({ id: "row-0" });
  });

  it("returns nothing rather than an oversized payload the vault would drop", () => {
    const rows = [{ id: "x".repeat(500) }];
    const capped = capRowsForVault(rows, 10);
    expect(capped.rows).toEqual([]);
    expect(capped.truncated).toBe(true);
  });

  it("handles an empty catalogue without claiming truncation", () => {
    expect(capRowsForVault([], 10)).toEqual({ rows: [], truncated: false });
  });

  it("never mutates the input", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    capRowsForVault(rows, 5);
    expect(rows).toHaveLength(3);
  });

  it("uses the real budget the vault enforces", () => {
    // secureVault silently DROPS a record over 24 KB, so the reference budget
    // must leave room for the envelope it wraps around the value.
    expect(REFERENCE_SNAPSHOT_MAX_BYTES).toBeLessThan(24_000);
  });
});
