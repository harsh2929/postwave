import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAGIC_AUTH_STATE_TTL_MS,
  RESET_AUTH_STATE_TTL_MS,
  beginMagicAuthReturnFlow,
  beginPasswordResetReturnFlow,
  clearPendingMagicAuthReturnState,
  clearPendingPasswordResetReturnState,
  consumeMagicAuthReturnState,
  consumePasswordResetReturnState,
  desktopMagicAuthReturnUrl,
} from "../../lib/auth-flow-state";

function makeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("magic auth return state", () => {
  let randomSeed = 0;

  beforeEach(() => {
    randomSeed = 0;
    const sessionStorage = makeStorage();
    const localStorage = makeStorage();
    vi.stubGlobal("window", { sessionStorage, localStorage });
    vi.stubGlobal("crypto", {
      getRandomValues(values: Uint8Array): Uint8Array {
        randomSeed += 1;
        values.fill(randomSeed);
        return values;
      },
    });
    clearPendingMagicAuthReturnState();
    clearPendingPasswordResetReturnState();
  });

  afterEach(() => {
    clearPendingMagicAuthReturnState();
    clearPendingPasswordResetReturnState();
    vi.unstubAllGlobals();
  });

  it("creates a return URL and consumes the matching state once", () => {
    const state = beginMagicAuthReturnFlow(1000);
    expect(state).toMatch(/^[a-f0-9]{48}$/);
    expect(desktopMagicAuthReturnUrl(state)).toBe(
      `moosewave://auth/magic?state=${state}`,
    );
    expect(consumeMagicAuthReturnState(state, 1001)).toEqual({ ok: true });
    expect(consumeMagicAuthReturnState(state, 1002)).toEqual({
      ok: false,
      reason: "missing_pending",
    });
  });

  it("rejects missing, mismatched, and expired returns", () => {
    const state = beginMagicAuthReturnFlow(1000);
    expect(consumeMagicAuthReturnState(undefined, 1001)).toEqual({
      ok: false,
      reason: "missing_state",
    });

    const current = beginMagicAuthReturnFlow(2000);
    expect(consumeMagicAuthReturnState(state, 2001)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    // An unsolicited mismatch does not erase the legitimate pending request.
    expect(consumeMagicAuthReturnState(current, 2002)).toEqual({ ok: true });

    const fresh = beginMagicAuthReturnFlow(3000);
    expect(
      consumeMagicAuthReturnState(fresh, 3000 + MAGIC_AUTH_STATE_TTL_MS + 1),
    ).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("keeps password-reset state independent and applies the reset TTL", () => {
    const magic = beginMagicAuthReturnFlow(1000);
    const reset = beginPasswordResetReturnFlow(1000);

    expect(consumePasswordResetReturnState(magic, 1001)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(consumeMagicAuthReturnState(magic, 1001)).toEqual({ ok: true });
    expect(consumePasswordResetReturnState(reset, 1002)).toEqual({ ok: true });

    const expired = beginPasswordResetReturnFlow(3000);
    expect(
      consumePasswordResetReturnState(
        expired,
        3000 + RESET_AUTH_STATE_TTL_MS + 1,
      ),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("requires a secure random source", () => {
    vi.stubGlobal("crypto", {});
    expect(() => beginMagicAuthReturnFlow()).toThrow(/secure random/);
  });
});
