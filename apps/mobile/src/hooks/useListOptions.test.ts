import { describe, expect, it, vi } from "vitest";

// useListOptions imports the RN-bound SDK client factory; only the pure
// normalizer and lookup are exercised here.
vi.mock("@/api/client", () => ({ getClient: vi.fn() }));
vi.mock("@/hooks/useOnlineQueryGate", () => ({ useOnlineQueryGate: vi.fn() }));
// The offline-snapshot layer reaches connectivity → netinfo → react-native,
// none of which the node environment can transform. Its own rules are tested
// in lib/deliverabilitySnapshotKeys.test.ts, where they are import-free.
vi.mock("@/lib/deliverabilitySnapshots", () => ({
  REFERENCE_SNAPSHOT_MAX_BYTES: 18_000,
  capRowsForVault: (rows: unknown[]) => ({ rows, truncated: false }),
  loadSnapshotBacked: vi.fn(),
  snapshotScope: vi.fn(),
}));

// eslint-disable-next-line import/first
import {
  findListOption,
  listCatalogueKey,
  normalizeLists,
} from "./useListOptions";

describe("normalizeLists", () => {
  it("flattens a bare array", () => {
    expect(
      normalizeLists([
        { id: 1, name: "Newsletter" },
        { id: 2, name: "Beta" },
      ]),
    ).toEqual([
      { id: "1", name: "Newsletter" },
      { id: "2", name: "Beta" },
    ]);
  });

  it("flattens the Listmonk { data: { results } } envelope", () => {
    expect(
      normalizeLists({ data: { results: [{ id: 7, name: "VIPs" }] } }),
    ).toEqual([{ id: "7", name: "VIPs" }]);
  });

  it("flattens a { data: [...] } envelope", () => {
    expect(normalizeLists({ data: [{ id: 4, name: "Ops" }] })).toEqual([
      { id: "4", name: "Ops" },
    ]);
  });

  it("flattens an { items } page", () => {
    expect(normalizeLists({ items: [{ id: 5, name: "Leads" }] })).toEqual([
      { id: "5", name: "Leads" },
    ]);
  });

  it("falls back to the id when name is missing or blank", () => {
    expect(normalizeLists([{ id: 9 }])).toEqual([{ id: "9", name: "9" }]);
    expect(normalizeLists([{ id: 9, name: "   " }])).toEqual([
      { id: "9", name: "9" },
    ]);
  });

  it("skips rows without an id and non-object rows", () => {
    // A row with no id cannot be routed to or added to — rendering it
    // would be a dead tap target.
    expect(
      normalizeLists([{ name: "no id" }, null, 5, { id: 3, name: "ok" }]),
    ).toEqual([{ id: "3", name: "ok" }]);
  });

  it("returns [] for unexpected shapes", () => {
    expect(normalizeLists(null)).toEqual([]);
    expect(normalizeLists(undefined)).toEqual([]);
    expect(normalizeLists({})).toEqual([]);
    expect(normalizeLists("nope")).toEqual([]);
  });

  it("carries the catalogue fields the detail header needs", () => {
    expect(
      normalizeLists([
        {
          id: 1,
          name: "Newsletter",
          type: "public",
          optin: "double",
          description: "Weekly",
          subscriber_count: 1200,
        },
      ]),
    ).toEqual([
      {
        id: "1",
        name: "Newsletter",
        type: "public",
        optin: "double",
        description: "Weekly",
        count: 1200,
      },
    ]);
  });

  it("prefers `count` over `subscriber_count` and omits a non-numeric one", () => {
    expect(normalizeLists([{ id: 1, name: "a", count: 3, subscriber_count: 9 }])[0])
      .toHaveProperty("count", 3);
    // exactOptionalPropertyTypes: the key must be ABSENT, not undefined.
    expect(
      Object.prototype.hasOwnProperty.call(
        normalizeLists([{ id: 1, name: "a", count: "many" }])[0]!,
        "count",
      ),
    ).toBe(false);
  });
});

describe("findListOption", () => {
  const rows = normalizeLists([
    { id: 1, name: "Newsletter" },
    { id: 22, name: "Beta" },
  ]);

  it("finds by string id", () => {
    expect(findListOption(rows, "22")?.name).toBe("Beta");
  });

  it("returns null rather than undefined for a miss", () => {
    expect(findListOption(rows, "999")).toBeNull();
    expect(findListOption(rows, undefined)).toBeNull();
    expect(findListOption(undefined, "1")).toBeNull();
  });
});

describe("listCatalogueKey", () => {
  it("lives under the 'lists' root so reconnect + membership writes refresh it", () => {
    expect(listCatalogueKey("t1")).toEqual(["lists", "t1"]);
  });

  it("normalises a missing tenant to null", () => {
    expect(listCatalogueKey(undefined)).toEqual(["lists", null]);
  });
});
