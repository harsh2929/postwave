// SPDX-License-Identifier: AGPL-3.0-only
//
// The generated methods issue the request the contract describes.
//
// `operations.test.ts` asks whether the hand-written resources REACH every
// curated route. This asks the other half: that the generated calls are right —
// correct verb, correct path, path parameters encoded rather than interpolated
// raw, and query/body passed through untouched.
//
// A recording transport rather than a network stub, because the thing under
// test is the delegation, not `PostwaveClient`. Retry, idempotency and step-up
// replay all live in `request`, which is exactly why generating these bodies
// reproduces none of it — the generated method's whole job is to call it
// correctly.

import { describe, expect, it } from "vitest";

import { GeneratedOperations, OPERATIONS, type OperationTransport } from "./operations.js";

function recorder() {
  const calls: Array<{ method: string; path: string; opts: unknown }> = [];
  const transport: OperationTransport = {
    async request<T>(method: string, path: string, opts?: unknown): Promise<T> {
      calls.push({ method, path, opts });
      return undefined as T;
    },
  };
  return { calls, ops: new GeneratedOperations(transport) };
}

describe("the generated operation client", () => {
  it("issues the verb and path the contract declares", async () => {
    const { calls, ops } = recorder();
    await ops.listSubscribers();
    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.method).toBe("GET");
    expect(call?.path).toBe("/api/v1/subscribers");
  });

  it("ENCODES path parameters instead of interpolating them raw", async () => {
    const { calls, ops } = recorder();
    // A slash in an id would otherwise change which route the gateway matches —
    // `/api/v1/subscribers/a/b` is a different path, and a caller passing an
    // opaque id has no reason to know that.
    await ops.getSubscriber("a/b?c=d");
    expect(calls[0]?.path).toBe("/api/v1/subscribers/a%2Fb%3Fc%3Dd");
  });

  it("passes query and body through untouched", async () => {
    const { calls, ops } = recorder();
    await ops.listSubscribers({ query: { limit: 10 } as never });
    expect((calls[0]?.opts as { query?: unknown } | undefined)?.query).toEqual({ limit: 10 });
  });

  it("exposes a method for every operation in the table", () => {
    const { ops } = recorder();
    // The table and the class are generated from one list, so a divergence
    // means the generator emitted them inconsistently — which no type check
    // would notice, because both sides would still compile.
    for (const id of Object.keys(OPERATIONS)) {
      expect(
        typeof (ops as unknown as Record<string, unknown>)[id],
        `${id} is in OPERATIONS but has no generated method`,
      ).toBe("function");
    }
  });
});
