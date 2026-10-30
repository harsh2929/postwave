// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { get } }));
import { listRfmSegments } from "@/lib/predictive-api";
beforeEach(() => get.mockReset());
describe("RFM server projection", () => {
  it("maps the repository's segment_key and profiles into readable labels and counts", async () => {
    get.mockResolvedValue({
      items: [
        {
          segment_key: "insufficient_data",
          profiles: 51,
          avg_monetary_cents: 0,
        },
        { segment_key: "champions", profiles: 3, avg_monetary_cents: 4500 },
      ],
    });
    await expect(listRfmSegments()).resolves.toEqual([
      { key: "insufficient_data", label: "Insufficient data", count: 51 },
      { key: "champions", label: "Champions", count: 3 },
    ]);
  });
  it.each([
    { items: null },
    { items: [{}] },
    { items: [{ segment_key: "champions", profiles: -1 }] },
    { items: [{ segment_key: "champions", profiles: "3" }] },
  ])(
    "rejects invalid segment evidence instead of inventing an unnamed population",
    async (body) => {
      get.mockResolvedValue(body);
      await expect(listRfmSegments()).rejects.toThrow();
    },
  );
});
