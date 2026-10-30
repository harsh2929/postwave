import { beforeEach, describe, expect, it, vi } from "vitest";

const secureState = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureState.set(key, value);
  }),
  getItemAsync: vi.fn(async (key: string) => secureState.get(key) ?? null),
  deleteItemAsync: vi.fn(async (key: string) => {
    secureState.delete(key);
  }),
}));

// eslint-disable-next-line import/first
import {
  conflictFieldRows,
  conflictResolveHref,
  conflictVerdict,
  firstConflictOperationId,
  isConflictFailure,
  isConflictJournalRow,
  mergeConflictFields,
  recordHrefForQueuedPath,
  serverCopyPath,
  unwrapServerCopy,
  valueText,
} from "./offlineConflict";
// eslint-disable-next-line import/first
import type { OfflineMutationAuthScope } from "./offlineMutationContract";
// eslint-disable-next-line import/first
import {
  listOfflineMutationFailures,
  recordOfflineMutationFailure,
} from "./offlineMutationFailures";

function auth(): OfflineMutationAuthScope {
  const now = Date.now();
  return {
    baseUrl: "https://api.moosewave.com",
    tenantId: "tenant_1",
    principalId: "user_1",
    role: "editor",
    queuedAt: now,
    expiresAt: now + 2 * 60 * 60 * 1000,
  };
}

describe("isConflictJournalRow — pinned against the journal's own writer", () => {
  beforeEach(() => secureState.clear());

  it("recognises the row the journal writes for a 409/412 and for a sequence reload", async () => {
    const scope = auth();
    await recordOfflineMutationFailure({
      auth: scope,
      kind: "entity_write",
      label: "Rename tag",
      operationId: "operation-00000001",
      error: Object.assign(new Error("conflict"), { status: 409 }),
    });
    await recordOfflineMutationFailure({
      auth: scope,
      kind: "sequence_save",
      label: "Sequence changes",
      operationId: "operation-00000002",
      error: Object.assign(new Error("reload"), { code: "sequence_save_requires_reload" }),
    });
    await recordOfflineMutationFailure({
      auth: scope,
      kind: "entity_write",
      label: "Rename tag",
      operationId: "operation-00000003",
      error: Object.assign(new Error("boom"), { status: 500 }),
    });
    const rows = await listOfflineMutationFailures(scope);
    const byOp = new Map(rows.map((row) => [row.operationId, row]));
    expect(isConflictJournalRow(byOp.get("operation-00000001")!)).toBe(true);
    expect(isConflictJournalRow(byOp.get("operation-00000002")!)).toBe(true);
    expect(isConflictJournalRow(byOp.get("operation-00000003")!)).toBe(false);
    // Newest first in the journal; the banner hands over the first conflict it finds.
    expect(firstConflictOperationId(rows)).toBe("operation-00000002");
    expect(firstConflictOperationId([byOp.get("operation-00000003")!])).toBeNull();
  });
});

describe("conflictVerdict", () => {
  it("never offers keep-mine or edit for a sequence save", () => {
    const verdict = conflictVerdict({ status: 412, code: null, kind: "sequence_save" });
    expect(verdict).toMatchObject({ kind: "reload-required", canKeepMine: false, canEdit: false });
    expect(verdict.detail).toContain("Open the sequence");
    expect(
      conflictVerdict({ status: 0, code: "sequence_save_requires_reload", kind: "entity_write" }).kind,
    ).toBe("reload-required");
  });

  it("locks a campaign that started sending and quotes the server", () => {
    const verdict = conflictVerdict({
      status: 409,
      code: "campaign_dispatching",
      kind: "campaign_update",
      serverMessage: "this campaign has started sending; duplicate it",
    });
    expect(verdict).toMatchObject({ kind: "locked", canKeepMine: false, canEdit: false });
    expect(verdict.detail).toBe("this campaign has started sending; duplicate it");
  });

  it("routes a name/slug collision to the editor, not to a verbatim retry", () => {
    for (const code of ["slug_taken", "public_slug_taken", "name_taken", "tag_taken"]) {
      const verdict = conflictVerdict({ status: 409, code, kind: "entity_write" });
      expect(verdict).toMatchObject({ kind: "needs-edit", canKeepMine: false, canEdit: true });
    }
    expect(
      conflictVerdict({ status: 409, code: "slug_taken", kind: "entity_write", serverMessage: "  " })
        .detail,
    ).toContain("already exists");
  });

  it("refuses keep-mine when the route demands a version token (428)", () => {
    expect(conflictVerdict({ status: 428, code: null, kind: "entity_write" })).toMatchObject({
      kind: "token-required",
      canKeepMine: false,
      canEdit: false,
    });
  });

  it("treats a plain 409 or 412 as stale: keep mine, take theirs, or mix", () => {
    for (const status of [409, 412]) {
      expect(conflictVerdict({ status, code: null, kind: "entity_write" })).toMatchObject({
        kind: "stale",
        canKeepMine: true,
        canEdit: true,
      });
    }
  });
});

describe("isConflictFailure", () => {
  it("is exactly the three precondition statuses plus the sequence reload code", () => {
    expect(isConflictFailure({ status: 409, code: null })).toBe(true);
    expect(isConflictFailure({ status: 412, code: null })).toBe(true);
    expect(isConflictFailure({ status: 428, code: null })).toBe(true);
    expect(isConflictFailure({ status: 500, code: null })).toBe(false);
    expect(isConflictFailure({ status: 0, code: "sequence_save_requires_reload" })).toBe(true);
    expect(isConflictFailure({ status: 0, code: "other" })).toBe(false);
  });
});

describe("conflictFieldRows / mergeConflictFields", () => {
  const mine = { name: "VIP", color: "#fff", description: "" };
  const server = { id: "12", name: "VIP customers", color: "#fff", version: 4 };

  it("compares only the fields I queued, in the order I queued them", () => {
    expect(conflictFieldRows(mine, server)).toEqual([
      { key: "name", mine: "VIP", server: "VIP customers", differs: true, serverHas: true },
      { key: "color", mine: "#fff", server: "#fff", differs: false, serverHas: true },
      { key: "description", mine: "(empty)", server: "(not set)", differs: true, serverHas: false },
    ]);
    expect(conflictFieldRows("nope", server)).toEqual([]);
    expect(conflictFieldRows(mine, null)).toHaveLength(3);
  });

  it("merges no wider than my body: kept fields stay mine, the rest take the server's", () => {
    expect(mergeConflictFields(mine, server, new Set(["name"]))).toEqual({
      name: "VIP",
      color: "#fff",
      // The server has no description, so it is dropped rather than sent blank.
    });
    expect(mergeConflictFields(mine, server, new Set())).toEqual({
      name: "VIP customers",
      color: "#fff",
    });
    expect(mergeConflictFields(mine, server, new Set(["name", "color", "description"]))).toEqual(mine);
    expect(mergeConflictFields([], server, new Set())).toBeNull();
  });

  it("prints values for the two columns without hiding empties or nulls", () => {
    expect(valueText(undefined)).toBe("(not set)");
    expect(valueText(null)).toBe("null");
    expect(valueText("")).toBe("(empty)");
    expect(valueText({ a: 1 })).toBe('{"a":1}');
    expect(valueText(3)).toBe("3");
  });
});

describe("serverCopyPath / unwrapServerCopy", () => {
  it("GETs the same single-record path for PATCH/PUT and nothing for a create", () => {
    expect(serverCopyPath({ method: "PATCH", path: "/api/v1/campaigns/c1" })).toBe(
      "/api/v1/campaigns/c1",
    );
    expect(serverCopyPath({ method: "PATCH", path: "/api/v1/voice/sequences/s1" })).toBe(
      "/api/v1/voice/sequences/s1",
    );
    expect(serverCopyPath({ method: "PUT", path: "/api/v1/forms/f1" })).toBe("/api/v1/forms/f1");
    expect(serverCopyPath({ method: "PATCH", path: "/api/v1/segments/s1" })).toBe(
      "/api/v1/segments/s1",
    );
    expect(serverCopyPath({ method: "PATCH", path: "/api/v1/subscribers/9" })).toBe(
      "/api/v1/subscribers/9",
    );
    expect(serverCopyPath({ method: "POST", path: "/api/v1/tags" })).toBeNull();
    expect(serverCopyPath({ method: "PATCH", path: "/api/v1/a/b/c/d" })).toBeNull();
    // A membership path is a list of members, not the record.
    expect(serverCopyPath({ method: "PATCH", path: "/api/v1/lists/1/subscribers" })).toBeNull();
  });

  it("returns null for the queueable entities the manifest mounts no GET /{id} for", () => {
    // routeauth/manifest.json: /tags/{id}/history and the list sub-resources
    // exist; the bare records do not. A GET here would be a 404, not a copy.
    expect(serverCopyPath({ method: "PATCH", path: "/api/v1/tags/12" })).toBeNull();
    expect(serverCopyPath({ method: "PATCH", path: "/api/v1/lists/3" })).toBeNull();
    expect(serverCopyPath({ method: "PATCH", path: "/api/v1/campaigns/c1/x" })).toBeNull();
  });

  it("unwraps a { data } envelope and leaves anything else alone", () => {
    expect(unwrapServerCopy({ data: { id: "1" } })).toEqual({ id: "1" });
    expect(unwrapServerCopy({ data: { id: "1" }, meta: {} })).toEqual({ id: "1" });
    expect(unwrapServerCopy({ data: { id: "1" }, total: 2 })).toEqual({ data: { id: "1" }, total: 2 });
    expect(unwrapServerCopy({ data: [1] })).toEqual({ data: [1] });
    expect(unwrapServerCopy({ id: "1" })).toEqual({ id: "1" });
    expect(unwrapServerCopy("text")).toBe("text");
  });
});

describe("recordHrefForQueuedPath", () => {
  it("routes the record's own screen through the shared route map", () => {
    expect(recordHrefForQueuedPath("/api/v1/campaigns/c1")).toBe("/(tabs)/campaigns/c1");
    expect(recordHrefForQueuedPath("/api/v1/voice/sequences/s1")).toBe("/(tabs)/sequences/s1");
    expect(recordHrefForQueuedPath("/api/v1/forms/f1")).toBe("/(tabs)/forms/f1");
    expect(recordHrefForQueuedPath("/api/v1/subscribers/9")).toBe("/(tabs)/subscribers/9");
    expect(recordHrefForQueuedPath("/api/v1/lists/3")).toBe("/(tabs)/lists/3");
  });

  it("returns null for a create, a sub-resource, a tag, and an id the router refuses", () => {
    expect(recordHrefForQueuedPath("/api/v1/tags/12")).toBeNull();
    expect(recordHrefForQueuedPath("/api/v1/tags")).toBeNull();
    expect(recordHrefForQueuedPath("/api/v1/lists/1/subscribers")).toBeNull();
    // A percent-encoded space decodes to an id route-map will not accept.
    expect(recordHrefForQueuedPath("/api/v1/campaigns/c%201")).toBeNull();
    expect(recordHrefForQueuedPath("/api/v1/campaigns/%E0%A4%A")).toBeNull();
  });
});

describe("conflictResolveHref", () => {
  it("carries the operation id as a route param and falls back to the plain screen", () => {
    expect(conflictResolveHref("op-1")).toEqual({
      pathname: "/(tabs)/diagnostics",
      params: { resolve: "op-1" },
    });
    expect(conflictResolveHref(null)).toEqual({
      pathname: "/(tabs)/diagnostics",
      params: {},
    });
  });
});
