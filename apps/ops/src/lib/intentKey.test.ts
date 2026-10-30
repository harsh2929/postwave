import { describe, expect, it } from "vitest";

import { bindPayloadIntent, shouldRetireIntent } from "./intentKey";

describe("payload-bound operator intents", () => {
  it("reuses one key for the exact payload and rotates it only when the payload changes", () => {
    const keys = ["key-a", "key-b"];
    const create = () => keys.shift() ?? "unexpected";
    const first = bindPayloadIntent(null, '{"check":"x","duration":"24h","reason":"vendor"}', create);
    const replay = bindPayloadIntent(first, first.fingerprint, create);
    const changed = bindPayloadIntent(first, '{"check":"x","duration":"24h","reason":"new"}', create);

    expect(replay).toBe(first);
    expect(replay.key).toBe("key-a");
    expect(changed.key).toBe("key-b");
  });

  it("retains the key for running replays and ambiguous transport outcomes", () => {
    expect(shouldRetireIntent({ kind: "operation", status: "running" })).toBe(false);
    expect(shouldRetireIntent({ kind: "network-error" })).toBe(false);
    expect(shouldRetireIntent({ kind: "http-error", status: 500 })).toBe(false);
    expect(shouldRetireIntent({ kind: "http-error", status: 502 })).toBe(false);
  });

  it("keeps failed snooze keys but retires definitive refusals and successes", () => {
    expect(shouldRetireIntent({ kind: "operation", status: "failed" }, true)).toBe(false);
    expect(shouldRetireIntent({ kind: "operation", status: "failed" })).toBe(true);
    expect(shouldRetireIntent({ kind: "operation", status: "succeeded" }, true)).toBe(true);
    expect(shouldRetireIntent({ kind: "http-error", status: 409 }, true)).toBe(true);
  });
});
