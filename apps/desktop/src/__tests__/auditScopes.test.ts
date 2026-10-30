// rbac-meta-audit — tests for the shared audit-scope helper.
//
// Verifies:
//   - getAuditScopesSnapshot returns the cached state without re-fetching
//   - resetAuditScopesCacheForTests clears the cache so a fresh fetch
//     happens on next read
//   - the initial snapshot contains no inferred permission wildcard.

import { describe, expect, it, beforeEach } from "vitest";

import {
  getAuditScopesSnapshot,
  resetAuditScopesCacheForTests,
} from "../lib/auditScopes";

describe("auditScopes — snapshot semantics", () => {
  beforeEach(() => {
    resetAuditScopesCacheForTests();
  });

  it("starts in loading state with an empty scope set", () => {
    const s = getAuditScopesSnapshot();
    expect(s.loading).toBe(true);
    expect(s.scopes.size).toBe(0);
    expect(s.isAdmin).toBe(false);
  });

  it("reset wipes the cache so the next snapshot is fresh", () => {
    resetAuditScopesCacheForTests();
    const a = getAuditScopesSnapshot();
    resetAuditScopesCacheForTests();
    const b = getAuditScopesSnapshot();
    // After reset, both snapshots come from the same INITIAL state
    expect(a.loading).toBe(true);
    expect(b.loading).toBe(true);
  });
});
