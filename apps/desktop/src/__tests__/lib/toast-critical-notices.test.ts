// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPersistedCriticalNoticesForTests,
  criticalNoticeStorageKeyForTests,
  getCriticalNoticeCopy,
  hasPersistedCriticalNotices,
  loadPersistedCriticalNotices,
  persistCriticalNotice,
  removePersistedCriticalNotice,
} from "../../lib/toast-critical-notices";

const NOW = Date.UTC(2026, 6, 16, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  clearPersistedCriticalNoticesForTests();
});

afterEach(() => {
  clearPersistedCriticalNoticesForTests();
  vi.useRealTimers();
});

describe("critical toast persistence boundary", () => {
  it("stores only a catalog code and timestamp", () => {
    persistCriticalNotice("campaign-draft-recovery-unavailable");

    const raw = window.localStorage.getItem(criticalNoticeStorageKeyForTests);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? "null")).toEqual({
      version: 1,
      notices: [
        {
          code: "campaign-draft-recovery-unavailable",
          raisedAt: NOW,
        },
      ],
    });
    const copy = getCriticalNoticeCopy(
      "campaign-draft-recovery-unavailable",
    );
    expect(raw).not.toContain(copy.message);
    expect(raw).not.toContain(copy.detail);
  });

  it("rejects unknown, stale, future, duplicated, and malformed records", () => {
    window.localStorage.setItem(
      criticalNoticeStorageKeyForTests,
      JSON.stringify({
        version: 1,
        notices: [
          { code: "unknown-code", raisedAt: NOW },
          {
            code: "campaign-draft-recovery-unavailable",
            raisedAt: NOW - 31 * 24 * 60 * 60 * 1_000,
          },
          {
            code: "campaign-draft-recovery-unavailable",
            raisedAt: NOW + 6 * 60 * 1_000,
          },
          { code: "campaign-draft-recovery-unavailable", raisedAt: NOW - 2 },
          { code: "campaign-draft-recovery-unavailable", raisedAt: NOW - 1 },
          null,
        ],
      }),
    );

    expect(loadPersistedCriticalNotices()).toEqual([
      {
        code: "campaign-draft-recovery-unavailable",
        raisedAt: NOW - 1,
      },
    ]);
    expect(
      JSON.parse(
        window.localStorage.getItem(criticalNoticeStorageKeyForTests) ??
          "null",
      ),
    ).toEqual({
      version: 1,
      notices: [
        {
          code: "campaign-draft-recovery-unavailable",
          raisedAt: NOW - 1,
        },
      ],
    });
  });

  it("fails closed on corrupt envelopes and supports explicit resolution", () => {
    window.localStorage.setItem(criticalNoticeStorageKeyForTests, "private");
    expect(loadPersistedCriticalNotices()).toEqual([]);
    expect(window.localStorage.getItem(criticalNoticeStorageKeyForTests)).toBe(
      null,
    );

    persistCriticalNotice("campaign-draft-recovery-unavailable");
    removePersistedCriticalNotice("campaign-draft-recovery-unavailable");
    expect(loadPersistedCriticalNotices()).toEqual([]);
  });

  it("provides a pure critical-presence probe for UI priority policies", () => {
    window.localStorage.setItem(criticalNoticeStorageKeyForTests, "corrupt");
    expect(hasPersistedCriticalNotices()).toBe(false);
    expect(window.localStorage.getItem(criticalNoticeStorageKeyForTests)).toBe(
      "corrupt",
    );

    persistCriticalNotice("campaign-draft-recovery-unavailable");
    expect(hasPersistedCriticalNotices()).toBe(true);
    removePersistedCriticalNotice("campaign-draft-recovery-unavailable");
    expect(hasPersistedCriticalNotices()).toBe(false);
  });
});
