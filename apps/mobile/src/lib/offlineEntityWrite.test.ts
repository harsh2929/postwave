import { beforeEach, describe, expect, it, vi } from "vitest";

const { request } = vi.hoisted(() => ({
  request: vi.fn(async (method: string, path: string, options: unknown) => ({
    method,
    path,
    options,
  })),
}));
const track = vi.hoisted(() => vi.fn());
const recordOfflineMutationFailure = vi.hoisted(() => vi.fn(async () => undefined));

const currentClient = {
  baseUrl: "https://api.moosewave.com",
  tenantId: "tenant_1",
};

vi.mock("@/api/sdkClient", () => ({
  getClient: () => ({ ...currentClient, client: { request } }),
}));

vi.mock("@/store/auth", () => ({
  useAuthStore: {
    getState: () => ({
      mode: "session",
      apiKey: null,
      session: { userId: "user_1", effectiveRole: "editor" },
    }),
  },
}));

vi.mock("./offlineMutationFailures", () => ({ recordOfflineMutationFailure }));
vi.mock("./telemetry", () => ({ track }));

// eslint-disable-next-line import/first
import { QueryClient } from "@tanstack/react-query";
// eslint-disable-next-line import/first
import {
  entityWriteLabel,
  executeEntityWrite,
  registerEntityWriteMutationDefaults,
  safeInvalidateRoots,
  type EntityWriteVars,
} from "./offlineEntityWrite";
// eslint-disable-next-line import/first
import { OFFLINE_MUTATION_KEYS } from "./offlineMutationContract";

const OPERATION_ID = "00000000-0000-4000-8000-000000000001";

function scope(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    ...currentClient,
    principalId: "user_1",
    role: "editor",
    queuedAt: now,
    expiresAt: now + 60 * 60 * 1000,
    ...overrides,
  };
}

function vars(overrides: Partial<EntityWriteVars> = {}): EntityWriteVars {
  return {
    auth: scope(),
    operationId: OPERATION_ID,
    method: "PATCH",
    path: "/api/v1/segments/12",
    body: { name: "Renamed" },
    ...overrides,
  } as EntityWriteVars;
}

beforeEach(() => {
  request.mockClear();
  track.mockClear();
  recordOfflineMutationFailure.mockClear();
});

describe("executeEntityWrite", () => {
  it("replays an allowlisted write with the operation id as the idempotency key", async () => {
    await executeEntityWrite(vars());
    expect(request).toHaveBeenCalledWith("PATCH", "/api/v1/segments/12", {
      body: { name: "Renamed" },
      idempotencyKey: OPERATION_ID,
    });
  });

  it("omits an absent body rather than sending undefined", async () => {
    await executeEntityWrite(
      vars({ method: "POST", path: "/api/v1/lists", body: undefined }),
    );
    expect(request).toHaveBeenCalledWith("POST", "/api/v1/lists", {
      idempotencyKey: OPERATION_ID,
    });
  });

  it("re-checks the route allowlist at REPLAY time, not just at enqueue", async () => {
    // A record that a newer/older build queued against a route this build no
    // longer considers safe must not be replayed.
    await expect(
      executeEntityWrite(
        vars({ method: "POST", path: "/api/v1/campaigns/abc/send", body: {} }),
      ),
    ).rejects.toMatchObject({ code: "not_queueable" });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a consent change smuggled into a subscriber profile patch", async () => {
    await expect(
      executeEntityWrite(
        vars({
          path: "/api/v1/subscribers/abc",
          body: { status: "unsubscribed" },
        }),
      ),
    ).rejects.toMatchObject({ code: "not_queueable" });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a subscriber or tag PATCH it could never replay without If-Match", async () => {
    // A record another build queued against either route must be refused here:
    // the replay sends only { body, idempotencyKey }, and both handlers answer
    // that with 428 precondition_required.
    await expect(
      executeEntityWrite(
        vars({ path: "/api/v1/subscribers/abc", body: { first_name: "Ada" } }),
      ),
    ).rejects.toMatchObject({ code: "not_queueable" });
    await expect(
      executeEntityWrite(vars({ path: "/api/v1/tags/12", body: { name: "VIP" } })),
    ).rejects.toMatchObject({ code: "not_queueable" });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a record whose identity no longer matches the session", async () => {
    await expect(
      executeEntityWrite(vars({ auth: scope({ role: "admin" }) })),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses an expired record", async () => {
    await expect(
      executeEntityWrite(
        vars({ auth: scope({ expiresAt: Date.now() - 1_000 }) }),
      ),
    ).rejects.toMatchObject({ code: "expired" });
  });

  it("refuses a record with an unusable operation id", async () => {
    await expect(
      executeEntityWrite(vars({ operationId: "short" })),
    ).rejects.toMatchObject({ code: "missing_scope" });
  });

  it("refuses an off-origin path", async () => {
    await expect(
      executeEntityWrite(vars({ path: "https://evil.example/api/v1/tags/1" })),
    ).rejects.toMatchObject({ code: "not_queueable" });
  });
});

describe("registerEntityWriteMutationDefaults", () => {
  it("gives the rehydrated key a mutationFn so a resumed write is not lost", async () => {
    const qc = new QueryClient();
    registerEntityWriteMutationDefaults(qc);
    const defaults = qc.getMutationDefaults(OFFLINE_MUTATION_KEYS.entityWrite);
    expect(typeof defaults.mutationFn).toBe("function");

    // Prove the registered fn is the real executor by driving it.
    await (defaults.mutationFn as (v: EntityWriteVars) => Promise<unknown>)(
      vars(),
    );
    expect(request).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/segments/12",
      expect.objectContaining({ idempotencyKey: OPERATION_ID }),
    );
  });

  it("invalidates only well-formed roots on success", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries").mockReturnValue(
      Promise.resolve(),
    );
    registerEntityWriteMutationDefaults(qc);
    const defaults = qc.getMutationDefaults(OFFLINE_MUTATION_KEYS.entityWrite);
    (
      defaults.onSuccess as (d: unknown, v: EntityWriteVars) => void
    )(null, vars({ invalidateRoots: ["tags", "BAD ROOT", "lists"] }));
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tags"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["lists"] });
  });

  it("records a failure so a rejected replay is visible, not silent", () => {
    const qc = new QueryClient();
    registerEntityWriteMutationDefaults(qc);
    const defaults = qc.getMutationDefaults(OFFLINE_MUTATION_KEYS.entityWrite);
    (defaults.onError as (e: unknown, v: EntityWriteVars) => void)(
      new Error("nope"),
      vars({ label: "Tag rename" }),
    );
    expect(recordOfflineMutationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "entity_write", label: "Tag rename" }),
    );
    expect(track).toHaveBeenCalled();
  });
});

describe("label and root sanitisation", () => {
  it("falls back to a generic label for unusable input", () => {
    expect(entityWriteLabel({ label: "Tag rename" })).toBe("Tag rename");
    expect(entityWriteLabel({ label: "a".repeat(80), method: "POST" })).toBe(
      "Queued creation",
    );
    expect(entityWriteLabel({ label: "<script>", method: "PATCH" })).toBe(
      "Queued edit",
    );
    expect(entityWriteLabel({})).toBe("Queued edit");
  });

  it("drops malformed or excessive invalidation roots", () => {
    expect(safeInvalidateRoots(["tags", 3, "Bad", "lists"])).toEqual([
      "tags",
      "lists",
    ]);
    expect(safeInvalidateRoots("tags")).toEqual([]);
    expect(
      safeInvalidateRoots(Array.from({ length: 20 }, () => "tags")).length,
    ).toBe(8);
  });
});
