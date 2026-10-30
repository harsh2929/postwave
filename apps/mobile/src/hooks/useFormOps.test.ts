import { describe, expect, it, vi } from "vitest";

vi.mock("@/api/forms", async (importOriginal) => {
  // The api module is node-clean (it imports only ./request, mocked below),
  // so the REAL body/path builders run — the queue-record test below is
  // asserting against what production enqueues, not against a copy.
  return await importOriginal();
});
vi.mock("@/api/request", () => ({
  rawRequest: vi.fn(),
  sdkResource: vi.fn(),
  checkedApiResult: vi.fn(),
}));
vi.mock("@/hooks/useOnlineQueryGate", () => ({ useOnlineQueryGate: vi.fn() }));
vi.mock("@/lib/connectivity", () => ({ isProbablyOnline: () => true }));
vi.mock("@/lib/offlineEntityWrite", () => ({ executeEntityWrite: vi.fn() }));
vi.mock("@/lib/offlineMutations", () => ({
  newOfflineMutationMetadata: vi.fn(),
}));
vi.mock("@/lib/queryClient", () => ({
  offlineSafeMutationMeta: { offlineSafe: true },
}));

// eslint-disable-next-line import/first
import {
  buildCreateFormVars,
  deletedFormQueryKeys,
  formWriteInvalidations,
} from "./useFormOps";
// eslint-disable-next-line import/first
import { isQueueableMutation } from "@/lib/offlineQueueSafety";

const META = { auth: { fake: true } as never, operationId: "op-1" };

describe("buildCreateFormVars", () => {
  it("enqueues POST /api/v1/forms with the trimmed CreateInput body", () => {
    const vars = buildCreateFormVars(META, {
      name: " Spring popup ",
      slug: " spring-popup ",
      optInMode: "double",
      successMessage: " Thanks! ",
    });
    expect(vars.method).toBe("POST");
    expect(vars.path).toBe("/api/v1/forms");
    expect(vars.body).toEqual({
      name: "Spring popup",
      slug: "spring-popup",
      optInMode: "double",
      successMessage: "Thanks!",
    });
    expect(vars.operationId).toBe("op-1");
    expect(vars.invalidateRoots).toEqual(["forms"]);
    expect(typeof vars.queuedAt).toBe("string");
  });

  it("builds a record the REPLAY-TIME gate accepts", () => {
    // The executor re-checks isQueueableMutation before sending. If this
    // record were refused there, the create would queue at the screen and
    // then fail visibly on reconnect — the exact half-wiring the contract
    // forbids. Asserted against the REAL policy module (it is import-free).
    const vars = buildCreateFormVars(META, {
      name: "N",
      slug: "n",
      optInMode: "single",
      successMessage: "",
    });
    expect(isQueueableMutation(vars.method, vars.path, vars.body)).toBe(true);
  });

  it("never smuggles a status into the queued body", () => {
    const vars = buildCreateFormVars(META, {
      name: "N",
      slug: "n",
      optInMode: "single",
      successMessage: "",
    });
    expect(
      Object.keys(vars.body as Record<string, unknown>),
    ).not.toContain("status");
  });
});

describe("invalidation contracts", () => {
  it("a status write dirties exactly the list and this detail", () => {
    expect(formWriteInvalidations("t-1", "f-1")).toEqual([
      ["forms", "t-1"],
      ["form", "t-1", "f-1"],
    ]);
  });

  it("a delete removes every per-form read — each would 404 if refetched", () => {
    const keys = deletedFormQueryKeys("t-1", "f-1");
    expect(keys).toContainEqual(["form", "t-1", "f-1"]);
    expect(keys).toContainEqual(["form-analytics", "t-1", "f-1"]);
    expect(keys).toContainEqual(["form-submissions", "t-1", "f-1"]);
    expect(keys).toContainEqual(["form-embed", "t-1", "f-1"]);
    expect(keys).toContainEqual(["form-variants", "t-1", "f-1"]);
    expect(keys).toContainEqual(["form-variant-promotions", "t-1", "f-1"]);
  });
});
