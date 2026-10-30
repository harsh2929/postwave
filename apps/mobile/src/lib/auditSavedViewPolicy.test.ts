import { describe, expect, it } from "vitest";

import {
  savedViewWriteAccess,
  type AuditViewScopeSet,
} from "@/lib/auditSavedViewPolicy";

const scopeSet = (over: Partial<AuditViewScopeSet> = {}): AuditViewScopeSet => ({
  scopes: [],
  auditScopes: [],
  isAdmin: false,
  ...over,
});

describe("savedViewWriteAccess", () => {
  it("renders no verdict at all until the scope probe answers", () => {
    for (const scopes of [null, undefined]) {
      const out = savedViewWriteAccess({ scopes, mode: "session" });
      expect(out.known).toBe(false);
      expect(out.allowed).toBe(false);
      // A denial the server has not issued must not be shown.
      expect(out.notice).toBeNull();
    }
  });

  describe("session", () => {
    it("allows owners and admins — the set routeauth's admin floor accepts", () => {
      const out = savedViewWriteAccess({
        scopes: scopeSet({ isAdmin: true, auditScopes: ["audit:read"] }),
        mode: "session",
      });
      expect(out).toEqual({ allowed: true, known: true, notice: null });
    });

    it("refuses a reader holding audit:read — the mount gate passes, the manifest does not", () => {
      // The exact regression: `audit:read` satisfies
      // RequireScope(ScopeAuditRead) at the mount site, so the first cut of
      // this screen offered Save and Delete to an editor. POST/DELETE carry
      // `session_minimum_role: admin`, so the server could only answer 403.
      const out = savedViewWriteAccess({
        scopes: scopeSet({
          auditScopes: ["audit:read", "audit:read_pii"],
          scopes: ["audit:read", "audit:read_pii"],
        }),
        mode: "session",
      });
      expect(out.allowed).toBe(false);
      expect(out.known).toBe(true);
      expect(out.notice).toContain("owners and admins");
      // It must not read as a dead end: reading views still works.
      expect(out.notice).toContain("open any view");
    });

    it("ignores an api-key-shaped scope on the session path", () => {
      // routeauth never consults api_key_scopes for a session principal, so
      // holding the scope name changes nothing about the role floor.
      const out = savedViewWriteAccess({
        scopes: scopeSet({
          scopes: ["audit:execute_actions"],
          auditScopes: ["audit:execute_actions"],
        }),
        mode: "session",
      });
      expect(out.allowed).toBe(false);
    });
  });

  describe("api key", () => {
    it("allows a key holding audit:execute_actions without any role", () => {
      const out = savedViewWriteAccess({
        scopes: scopeSet({
          scopes: ["audit:read", "audit:execute_actions"],
          auditScopes: ["audit:read", "audit:execute_actions"],
        }),
        mode: "api_key",
      });
      expect(out).toEqual({ allowed: true, known: true, notice: null });
    });

    it("allows the admin scope, which HasScope treats as a wildcard", () => {
      const out = savedViewWriteAccess({
        scopes: scopeSet({ isAdmin: true, scopes: ["admin"] }),
        mode: "api_key",
      });
      expect(out.allowed).toBe(true);
    });

    it("refuses a read-only key and names the scope it is missing", () => {
      const out = savedViewWriteAccess({
        scopes: scopeSet({
          scopes: ["audit:read"],
          auditScopes: ["audit:read"],
        }),
        mode: "api_key",
      });
      expect(out.allowed).toBe(false);
      expect(out.notice).toContain("audit:execute_actions");
    });

    it("does not apply the session admin-role test to a key", () => {
      // A key is never owner/admin in the ROLE sense; testing it that way
      // would refuse a key the server accepts.
      const out = savedViewWriteAccess({
        scopes: scopeSet({ scopes: ["audit:execute_actions"] }),
        mode: "api_key",
      });
      expect(out.allowed).toBe(true);
    });
  });

  it("treats an unknown auth mode as a session — the stricter of the two", () => {
    for (const mode of [null, undefined] as const) {
      expect(
        savedViewWriteAccess({
          scopes: scopeSet({ scopes: ["audit:execute_actions"] }),
          mode,
        }).allowed,
      ).toBe(false);
    }
  });
});
