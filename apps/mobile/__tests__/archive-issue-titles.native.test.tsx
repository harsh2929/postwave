/**
 * useArchiveIssueTitles — the campaignId → subject lookup the archive-comment
 * moderation queue labels its rows with.
 *
 * It walks the ARCHIVE INDEX, whose first page is served out of the offline
 * vault when the network is gone. `loadSnapshotBacked` checks only that the
 * stored envelope carries a numeric `capturedAt` before casting `value` to an
 * ArchivePage (deliverabilitySnapshots `isStored`), so a snapshot written by
 * an earlier build reaches this hook as a page whose `items` is not a list —
 * and the hook's `for (const issue of page.items)` throws inside a render, in
 * a hook that reports no error state of its own.
 *
 * `pages ?? []` is a NULLISH guard: it catches neither `{}` nor an absent
 * `items` key. Array.isArray does.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { renderHook } from "@testing-library/react-native";

const mockIssues: { data: unknown } = { data: undefined };

jest.mock("@/hooks/useArchiveOps", () => ({
  useArchiveIssues: () => mockIssues,
}));

// eslint-disable-next-line import/first
import { useArchiveIssueTitles } from "@/hooks/useArchiveComments";

describe("useArchiveIssueTitles tolerates a malformed restored index", () => {
  it("reads the titles out of a well-formed index", async () => {
    mockIssues.data = {
      pages: [
        {
          items: [{ campaignId: "c1", subject: "June digest" }],
          nextCursor: null,
        },
      ],
    };

    const { result } = await renderHook(() => useArchiveIssueTitles());

    expect(result.current.titles.get("c1")).toBe("June digest");
    expect(result.current.hasIndex).toBe(true);
  });

  it("does not throw when a page's items is not a list", async () => {
    mockIssues.data = { pages: [{ items: {}, nextCursor: null }] };

    const { result } = await renderHook(() => useArchiveIssueTitles());

    expect(result.current.titles.size).toBe(0);
    // A page IS present, so the screen must not claim the index never loaded —
    // it just has no usable titles in it.
    expect(result.current.hasIndex).toBe(true);
  });

  it("does not throw when the pages envelope itself is not a list", async () => {
    mockIssues.data = { pages: {} };

    const { result } = await renderHook(() => useArchiveIssueTitles());

    expect(result.current.titles.size).toBe(0);
    expect(result.current.hasIndex).toBe(false);
  });
});
