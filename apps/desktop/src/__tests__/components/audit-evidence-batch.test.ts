/**
 * audit-evidence-batch — chunking logic behind the investigation
 * timeline's batch lookup (GET /audit/events?ids=…, ≤100 ids per
 * call). A wrong chunking either trips the server's 400 (oversized
 * batch) or silently drops citations (lost ids between chunks).
 */

import { describe, expect, it } from "vitest";

import { chunkEvidenceIds } from "../../components/audit/evidenceBatch";

describe("chunkEvidenceIds", () => {
  it("empty input → no chunks", () => {
    expect(chunkEvidenceIds([])).toEqual([]);
  });

  it("≤100 ids fit in a single chunk", () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    const chunks = chunkEvidenceIds(ids);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(100);
  });

  it("splits >100 ids into ≤100-id chunks without losing any", () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const chunks = chunkEvidenceIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(chunks.flat().sort((a, b) => a - b)).toEqual(ids);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
  });

  it("deduplicates ids before chunking", () => {
    expect(chunkEvidenceIds([7, 7, 8, 7])).toEqual([[7, 8]]);
  });

  it("respects a custom chunk size", () => {
    expect(chunkEvidenceIds([1, 2, 3, 4, 5], 2)).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
  });
});
