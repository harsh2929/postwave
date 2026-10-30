import { describe, expect, it } from "vitest";

import {
  MAX_PENDING_REVOKES,
  normalizePushServerBaseUrl,
  parseRevocationJournal,
  validDeviceKey,
  withQueuedRevocation,
  type PendingPushRevocation,
} from "./pushRevocationRecords";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const NOW = 1_700_000_000_000;

function record(
  over: Partial<PendingPushRevocation> = {},
): PendingPushRevocation {
  return {
    baseUrl: "https://api.moosewave.com",
    deviceKey: KEY_A,
    createdAt: NOW - 1_000,
    ...over,
  };
}

describe("normalizePushServerBaseUrl", () => {
  it("canonicalises an https origin and drops the trailing slash", () => {
    expect(normalizePushServerBaseUrl("https://api.moosewave.com/")).toBe(
      "https://api.moosewave.com",
    );
  });

  it("refuses credentials, query and fragment", () => {
    for (const value of [
      "https://user:pass@api.moosewave.com",
      "https://api.moosewave.com?token=abc",
      "https://api.moosewave.com#x",
    ]) {
      expect(() => normalizePushServerBaseUrl(value)).toThrow();
    }
  });

  it("refuses plain http except on loopback", () => {
    expect(() => normalizePushServerBaseUrl("http://api.moosewave.com")).toThrow();
    expect(normalizePushServerBaseUrl("http://localhost:8080")).toBe(
      "http://localhost:8080",
    );
    expect(normalizePushServerBaseUrl("http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080",
    );
  });
});

describe("validDeviceKey", () => {
  it("accepts exactly 64 lowercase hex characters", () => {
    expect(validDeviceKey(KEY_A)).toBe(true);
    expect(validDeviceKey("A".repeat(64))).toBe(false);
    expect(validDeviceKey("a".repeat(63))).toBe(false);
    expect(validDeviceKey(null)).toBe(false);
    expect(validDeviceKey(12)).toBe(false);
  });
});

describe("parseRevocationJournal", () => {
  it("keeps a well-formed record and reports no rewrite", () => {
    const parsed = parseRevocationJournal([record()], NOW);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.changed).toBe(false);
  });

  it("upgrades the legacy single-record format", () => {
    const parsed = parseRevocationJournal(record(), NOW);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.deviceKey).toBe(KEY_A);
  });

  it("drops records that can never be acted on, and asks to be rewritten", () => {
    const parsed = parseRevocationJournal(
      [
        record(),
        record({ deviceKey: "nope" }),
        record({ baseUrl: 12 as unknown as string }),
        record({ createdAt: Number.NaN }),
        // A clock jump into the future would otherwise pin an entry forever.
        record({ createdAt: NOW + 10 * 60_000 }),
        // Aged out: the server has long since reaped the row.
        record({ createdAt: NOW - 31 * 24 * 60 * 60 * 1000 }),
        // An origin that violates the transport rule cannot be revoked against.
        record({ baseUrl: "http://api.moosewave.com" }),
        null,
      ],
      NOW,
    );
    expect(parsed.records).toHaveLength(1);
    expect(parsed.changed).toBe(true);
  });

  it("tolerates a device clock that is only slightly ahead", () => {
    const parsed = parseRevocationJournal(
      [record({ createdAt: NOW + 30_000 })],
      NOW,
    );
    expect(parsed.records).toHaveLength(1);
  });

  it("treats an over-long container as corruption", () => {
    const many = Array.from({ length: MAX_PENDING_REVOKES + 1 }, () => record());
    expect(() => parseRevocationJournal(many, NOW)).toThrow();
  });

  it("canonicalises the origin it keeps", () => {
    const parsed = parseRevocationJournal(
      [record({ baseUrl: "https://api.moosewave.com/" })],
      NOW,
    );
    expect(parsed.records[0]?.baseUrl).toBe("https://api.moosewave.com");
  });
});

describe("withQueuedRevocation", () => {
  it("replaces an existing entry for the same origin and device", () => {
    const next = record({ createdAt: NOW });
    const out = withQueuedRevocation([record({ createdAt: NOW - 5_000 })], next);
    expect(out).toHaveLength(1);
    expect(out[0]?.createdAt).toBe(NOW);
  });

  it("keeps a different origin AND a different device separately", () => {
    let out = withQueuedRevocation([record()], record({ deviceKey: KEY_B }));
    expect(out).toHaveLength(2);
    out = withQueuedRevocation(
      [record()],
      record({ baseUrl: "https://eu.moosewave.com" }),
    );
    expect(out).toHaveLength(2);
  });

  it("refuses to evict an older unfulfilled cleanup to make room", () => {
    const full = Array.from({ length: MAX_PENDING_REVOKES }, (_unused, i) =>
      record({ baseUrl: `https://api${i}.moosewave.com` }),
    );
    expect(() =>
      withQueuedRevocation(full, record({ baseUrl: "https://new.moosewave.com" })),
    ).toThrow(/Too many pending/);
    // and the caller still holds every original entry
    expect(full).toHaveLength(MAX_PENDING_REVOKES);
  });
});
