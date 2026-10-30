import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  appendRowIfAbsent,
  emptySnapshot,
  mergeSnapshots,
  optimisticTriad,
  optimisticUpdateQueries,
  patchRowById,
  removeRowById,
  rollbackQueries,
} from "./optimisticQueries";

interface Row {
  id: string;
  active: boolean;
  label?: string;
}

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

/** Let every pending microtask (cancelQueries, onMutate) settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("patchRowById", () => {
  it("merges into the addressed row only", () => {
    const rows: Row[] = [
      { id: "a", active: true },
      { id: "b", active: true },
    ];
    expect(patchRowById(rows, "b", { active: false })).toEqual([
      { id: "a", active: true },
      { id: "b", active: false },
    ]);
  });

  it("returns the SAME array when the id is not present", () => {
    // A mistargeted key must be a visible no-op, not a silent duplicate.
    const rows: Row[] = [{ id: "a", active: true }];
    expect(patchRowById(rows, "zz", { active: false })).toBe(rows);
  });

  it("never fabricates rows for an unpopulated cache entry", () => {
    expect(patchRowById<Row>(undefined, "a", { active: false })).toBeUndefined();
  });

  it("does not mutate the array it was given", () => {
    const rows: Row[] = [{ id: "a", active: true }];
    patchRowById(rows, "a", { active: false });
    expect(rows[0]?.active).toBe(true);
  });
});

describe("removeRowById", () => {
  it("drops the row", () => {
    const rows: Row[] = [
      { id: "a", active: true },
      { id: "b", active: true },
    ];
    expect(removeRowById(rows, "a")).toEqual([{ id: "b", active: true }]);
  });

  it("returns the same array when nothing matched", () => {
    const rows: Row[] = [{ id: "a", active: true }];
    expect(removeRowById(rows, "b")).toBe(rows);
    expect(removeRowById(undefined, "b")).toBeUndefined();
  });
});

describe("appendRowIfAbsent", () => {
  it("appends a new row", () => {
    const rows: Row[] = [{ id: "a", active: true }];
    expect(appendRowIfAbsent(rows, { id: "b", active: true })).toEqual([
      { id: "a", active: true },
      { id: "b", active: true },
    ]);
  });

  it("is idempotent, matching the ON CONFLICT DO NOTHING write it backs", () => {
    const rows: Row[] = [{ id: "a", active: true }];
    expect(appendRowIfAbsent(rows, { id: "a", active: false })).toBe(rows);
  });

  it("never fabricates a list", () => {
    expect(appendRowIfAbsent(undefined, { id: "a", active: true })).toBeUndefined();
  });
});

describe("optimisticUpdateQueries", () => {
  it("patches EVERY variant under the key prefix", async () => {
    const qc = client();
    qc.setQueryData(["rows", "t1", "all"], [{ id: "a", active: true }]);
    qc.setQueryData(["rows", "t1", "unread"], [{ id: "a", active: true }]);
    qc.setQueryData(["rows", "t2", "all"], [{ id: "a", active: true }]);

    await optimisticUpdateQueries<Row[]>(qc, ["rows", "t1"], (rows) =>
      patchRowById(rows, "a", { active: false }),
    );

    expect(qc.getQueryData(["rows", "t1", "all"])).toEqual([
      { id: "a", active: false },
    ]);
    expect(qc.getQueryData(["rows", "t1", "unread"])).toEqual([
      { id: "a", active: false },
    ]);
    // A different tenant is a different prefix and must be untouched.
    expect(qc.getQueryData(["rows", "t2", "all"])).toEqual([
      { id: "a", active: true },
    ]);
  });

  it("returns a snapshot that rollbackQueries restores verbatim", async () => {
    const qc = client();
    const before: Row[] = [{ id: "a", active: true, label: "keep" }];
    qc.setQueryData(["rows", "t1", "all"], before);

    const snapshot = await optimisticUpdateQueries<Row[]>(
      qc,
      ["rows", "t1"],
      (rows) => patchRowById(rows, "a", { active: false }),
    );
    expect(qc.getQueryData(["rows", "t1", "all"])).toEqual([
      { id: "a", active: false, label: "keep" },
    ]);

    rollbackQueries(qc, snapshot);
    // Deep equality, not identity: TanStack runs `replaceEqualDeep` inside
    // setQueryData, so the restored value is structurally the pre-mutation
    // one rather than the same object reference.
    expect(qc.getQueryData(["rows", "t1", "all"])).toEqual(before);
  });

  it("is a no-op both ways for an unpopulated entry", async () => {
    const qc = client();
    const snapshot = await optimisticUpdateQueries<Row[]>(
      qc,
      ["rows", "t1"],
      (rows) => patchRowById(rows, "a", { active: false }),
    );
    expect(snapshot.previous).toEqual([]);
    rollbackQueries(qc, snapshot);
    expect(qc.getQueryData(["rows", "t1", "all"])).toBeUndefined();
  });

  it("cancels in-flight fetches so a slow response cannot clobber the projection", async () => {
    const qc = client();
    const gate = deferred<Row[]>();
    qc.setQueryData(["rows", "t1", "all"], [{ id: "a", active: true }]);
    const fetching = qc.fetchQuery({
      queryKey: ["rows", "t1", "all"],
      queryFn: () => gate.promise,
    });
    // The in-flight fetch is aborted by cancelQueries; swallow its rejection.
    void fetching.catch(() => undefined);

    await optimisticUpdateQueries<Row[]>(qc, ["rows", "t1"], (rows) =>
      patchRowById(rows, "a", { active: false }),
    );
    // The stale response lands AFTER the projection and must not win.
    gate.resolve([{ id: "a", active: true, label: "stale" }]);
    await Promise.resolve();

    expect(qc.getQueryData(["rows", "t1", "all"])).toEqual([
      { id: "a", active: false },
    ]);
  });
});

describe("rollbackQueries", () => {
  it("tolerates a missing context (a mutation that failed before onMutate)", () => {
    const qc = client();
    expect(() => rollbackQueries(qc, undefined)).not.toThrow();
  });
});

describe("mergeSnapshots", () => {
  it("rolls back every cache a single write touched", async () => {
    const qc = client();
    qc.setQueryData(["detail", "s1"], { status: "enabled" });
    qc.setQueryData(["timeline", "s1"], { current: "enabled" });

    const merged = mergeSnapshots(
      await optimisticUpdateQueries<{ status: string }>(
        qc,
        ["detail", "s1"],
        (d) => (d ? { ...d, status: "blocklisted" } : d),
      ),
      await optimisticUpdateQueries<{ current: string }>(
        qc,
        ["timeline", "s1"],
        (d) => (d ? { ...d, current: "blocklisted" } : d),
      ),
    );
    expect(merged.previous).toHaveLength(2);

    rollbackQueries(qc, merged);
    expect(qc.getQueryData(["detail", "s1"])).toEqual({ status: "enabled" });
    expect(qc.getQueryData(["timeline", "s1"])).toEqual({ current: "enabled" });
  });

  it("emptySnapshot rolls back nothing", () => {
    expect(emptySnapshot()).toEqual({ previous: [] });
  });
});

/**
 * These drive the triad through TanStack's own mutation machinery — the same
 * onMutate → mutationFn → onError/onSettled sequence useMutation runs — so the
 * rollback path is exercised end to end rather than by calling the callbacks
 * by hand in an order the library might not use.
 */
describe("optimisticTriad, driven by a real MutationObserver", () => {
  it("projects on mutate and keeps the projection when the write succeeds", async () => {
    const qc = client();
    qc.setQueryData(["rows", "t1", "all"], [{ id: "a", active: true }]);
    const gate = deferred<void>();

    const observer = new MutationObserver(qc, {
      mutationFn: () => gate.promise,
      ...optimisticTriad<Row[], { id: string; active: boolean }>(
        qc,
        ["rows", "t1"],
        (rows, vars) => patchRowById(rows, vars.id, { active: vars.active }),
      ),
    });

    const inFlight = observer.mutate({ id: "a", active: false });
    // onMutate awaits cancelQueries, so let the microtask queue drain before
    // asserting that the projection is already visible.
    await flush();
    // Projected while the request is still open — this is the whole point.
    expect(qc.getQueryData(["rows", "t1", "all"])).toEqual([
      { id: "a", active: false },
    ]);

    gate.resolve();
    await inFlight;
    expect(qc.getQueryData(["rows", "t1", "all"])).toEqual([
      { id: "a", active: false },
    ]);
  });

  it("ROLLS BACK when the write fails", async () => {
    const qc = client();
    const before = [{ id: "a", active: true, label: "keep" }];
    qc.setQueryData(["rows", "t1", "all"], before);

    const observer = new MutationObserver(qc, {
      mutationFn: async () => {
        throw new Error("network is down");
      },
      ...optimisticTriad<Row[], { id: string; active: boolean }>(
        qc,
        ["rows", "t1"],
        (rows, vars) => patchRowById(rows, vars.id, { active: vars.active }),
      ),
    });

    await expect(observer.mutate({ id: "a", active: false })).rejects.toThrow(
      "network is down",
    );
    expect(qc.getQueryData(["rows", "t1", "all"])).toEqual(before);
  });

  it("resolves a per-variable key so one row's failure cannot restore another's", async () => {
    const qc = client();
    qc.setQueryData(["detail", "a"], { id: "a", active: true });
    qc.setQueryData(["detail", "b"], { id: "b", active: true });

    const observer = new MutationObserver(qc, {
      mutationFn: async () => {
        throw new Error("nope");
      },
      ...optimisticTriad<Row, { id: string }>(
        qc,
        (vars) => ["detail", vars.id],
        (row) => (row ? { ...row, active: false } : row),
      ),
    });

    await expect(observer.mutate({ id: "a" })).rejects.toThrow("nope");
    expect(qc.getQueryData(["detail", "a"])).toEqual({ id: "a", active: true });
    expect(qc.getQueryData(["detail", "b"])).toEqual({ id: "b", active: true });
  });
});
