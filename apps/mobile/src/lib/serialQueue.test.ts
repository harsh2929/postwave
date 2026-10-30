import { describe, expect, it } from "vitest";

import {
  createSerialQueue,
  subscriberWriteKey,
} from "./serialQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSerialQueue", () => {
  it("never runs two same-key tasks concurrently", async () => {
    const enqueue = createSerialQueue();
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];

    const task = (name: string) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      order.push(name);
      inFlight -= 1;
      return name;
    };

    await Promise.all([
      enqueue("sub:1", task("a")),
      enqueue("sub:1", task("b")),
      enqueue("sub:1", task("c")),
    ]);

    expect(maxInFlight).toBe(1);
    // Submission order is preserved — this is the property that stops a
    // full-array tag PATCH from landing out of order and wiping a tag.
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("serialises the exact tag-add race: the last write wins", async () => {
    const enqueue = createSerialQueue();
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    let committed: string[] = [];

    const write = (d: ReturnType<typeof deferred<string[]>>) => async () => {
      const tags = await d.promise;
      committed = tags;
      return tags;
    };

    const p1 = enqueue("sub:1", write(first));
    const p2 = enqueue("sub:1", write(second));

    // The server answers the SECOND request first — the classic reorder.
    second.resolve(["a", "b"]);
    await Promise.resolve();
    first.resolve(["a"]);

    await Promise.all([p1, p2]);

    // Without the queue, `committed` would be ["a"] (the stale base).
    expect(committed).toEqual(["a", "b"]);
  });

  it("does not poison the chain when a task rejects", async () => {
    const enqueue = createSerialQueue();
    const ran: string[] = [];

    const failing = enqueue("sub:1", async () => {
      ran.push("boom");
      throw new Error("nope");
    });
    const following = enqueue("sub:1", async () => {
      ran.push("after");
      return "after";
    });

    await expect(failing).rejects.toThrow("nope");
    await expect(following).resolves.toBe("after");
    expect(ran).toEqual(["boom", "after"]);
  });

  it("lets different keys overlap", async () => {
    const enqueue = createSerialQueue();
    const a = deferred<string>();
    const b = deferred<string>();
    let started = 0;

    const p1 = enqueue("sub:1", async () => {
      started += 1;
      return a.promise;
    });
    const p2 = enqueue("sub:2", async () => {
      started += 1;
      return b.promise;
    });

    await Promise.resolve();
    expect(started).toBe(2);

    a.resolve("a");
    b.resolve("b");
    await expect(Promise.all([p1, p2])).resolves.toEqual(["a", "b"]);
  });

  it("propagates the resolved value to the original caller", async () => {
    const enqueue = createSerialQueue();
    await expect(enqueue("k", async () => 42)).resolves.toBe(42);
  });

  it("releases its bookkeeping once a chain drains", async () => {
    const enqueue = createSerialQueue();
    await enqueue("sub:1", async () => "done");
    // Nothing observable to assert without exposing internals; re-running
    // after the drain must still work and still serialise.
    const order: number[] = [];
    await Promise.all([
      enqueue("sub:1", async () => {
        order.push(1);
      }),
      enqueue("sub:1", async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});

describe("subscriberWriteKey", () => {
  it("namespaces the id so it cannot collide with another resource", () => {
    expect(subscriberWriteKey("abc")).toBe("subscriber:abc");
    expect(subscriberWriteKey("abc")).not.toBe("abc");
  });
});
