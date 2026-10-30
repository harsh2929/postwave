// SPDX-License-Identifier: AGPL-3.0-only
//
// Regression: paginated/filtered lists loaded via `useCallback` + `useEffect`
// wrote state unconditionally after the await. Responses are not ordered, so a
// slower EARLIER request could resolve last and overwrite the newer one — the
// table then showed rows for a page or filter the user had already left, with
// no error and nothing to retry.
//
// Reproduced here at the level the bug actually lives: two overlapping loads
// resolving out of order.
import { describe, expect, it } from "vitest";

import { createLatestRequestGate } from "@/lib/latest-request";

/** A list loader shaped like the real ones, driven by an injected fetch. */
function makeLoader(guarded: boolean) {
  const gate = createLatestRequestGate();
  const state = { items: [] as string[], writes: 0 };
  return {
    state,
    async load(fetcher: () => Promise<string[]>) {
      const isCurrent = gate.begin();
      const items = await fetcher();
      if (guarded && !isCurrent()) return;
      state.items = items;
      state.writes += 1;
    },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createLatestRequestGate", () => {
  it("keeps the newest result when an older request resolves last", async () => {
    const loader = makeLoader(true);
    const first = deferred<string[]>();
    const second = deferred<string[]>();

    // Page 1 starts, then page 2 starts before page 1 has answered.
    const p1 = loader.load(() => first.promise);
    const p2 = loader.load(() => second.promise);

    // Page 2 answers first…
    second.resolve(["page-2"]);
    await p2;
    expect(loader.state.items).toEqual(["page-2"]);

    // …then the stale page 1 answers. It must be ignored.
    first.resolve(["page-1"]);
    await p1;

    expect(loader.state.items).toEqual(["page-2"]);
    expect(loader.state.writes).toBe(1);
  });

  it("without the guard, the stale response wins — the original bug", async () => {
    const loader = makeLoader(false);
    const first = deferred<string[]>();
    const second = deferred<string[]>();

    const p1 = loader.load(() => first.promise);
    const p2 = loader.load(() => second.promise);

    second.resolve(["page-2"]);
    await p2;
    first.resolve(["page-1"]);
    await p1;

    // Demonstrates what the guard prevents.
    expect(loader.state.items).toEqual(["page-1"]);
  });

  it("in-order responses still write", async () => {
    const loader = makeLoader(true);
    await loader.load(async () => ["a"]);
    expect(loader.state.items).toEqual(["a"]);
    await loader.load(async () => ["b"]);
    expect(loader.state.items).toEqual(["b"]);
    expect(loader.state.writes).toBe(2);
  });

  it("a single request is always current", async () => {
    const gate = createLatestRequestGate();
    const isCurrent = gate.begin();
    expect(isCurrent()).toBe(true);
  });

  it("only the newest of several concurrent starts is current", () => {
    const gate = createLatestRequestGate();
    const a = gate.begin();
    const b = gate.begin();
    const c = gate.begin();
    expect(a()).toBe(false);
    expect(b()).toBe(false);
    expect(c()).toBe(true);
  });
});
