import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSecret,
  peekSecret,
  REVEAL_ONCE_TTL_MS,
  secretTimeLeftMs,
  stashSecret,
} from "./revealOnceSecret";

const T0 = 1_800_000_000_000;

beforeEach(() => {
  clearSecret();
});

describe("revealOnceSecret", () => {
  it("survives a component unmount — the whole point of the module", () => {
    // Simulates: create webhook -> navigate away (component unmounts, its
    // useState is gone) -> come back and read the value again.
    stashSecret("wh_1", "whsec_abc", T0);
    expect(peekSecret(T0 + 5_000)?.value).toBe("whsec_abc");
    expect(peekSecret(T0 + 60_000)?.value).toBe("whsec_abc");
  });

  it("returns null before anything has been stashed", () => {
    expect(peekSecret(T0)).toBeNull();
    expect(secretTimeLeftMs(T0)).toBe(0);
  });

  it("evicts itself once the TTL elapses", () => {
    stashSecret("wh_1", "whsec_abc", T0);
    expect(peekSecret(T0 + REVEAL_ONCE_TTL_MS - 1)).not.toBeNull();
    expect(peekSecret(T0 + REVEAL_ONCE_TTL_MS)).toBeNull();
    // And the eviction is permanent — an earlier clock cannot resurrect it.
    expect(peekSecret(T0 + 1_000)).toBeNull();
  });

  it("counts down the remaining window", () => {
    stashSecret("wh_1", "whsec_abc", T0);
    expect(secretTimeLeftMs(T0)).toBe(REVEAL_ONCE_TTL_MS);
    expect(secretTimeLeftMs(T0 + 60_000)).toBe(REVEAL_ONCE_TTL_MS - 60_000);
    expect(secretTimeLeftMs(T0 + REVEAL_ONCE_TTL_MS + 1)).toBe(0);
  });

  it("keeps only the most recent secret — a second create replaces the first", () => {
    stashSecret("wh_1", "one", T0);
    stashSecret("wh_2", "two", T0 + 1_000);
    const live = peekSecret(T0 + 2_000);
    expect(live?.id).toBe("wh_2");
    expect(live?.value).toBe("two");
  });

  it("refuses to stash a blank id or value rather than showing an empty card", () => {
    expect(stashSecret("wh_1", "   ", T0)).toBeNull();
    expect(peekSecret(T0)).toBeNull();
    expect(stashSecret("  ", "whsec_abc", T0)).toBeNull();
    expect(peekSecret(T0)).toBeNull();
  });

  it("clears on explicit dismissal", () => {
    stashSecret("wh_1", "whsec_abc", T0);
    clearSecret();
    expect(peekSecret(T0 + 1)).toBeNull();
  });
});
