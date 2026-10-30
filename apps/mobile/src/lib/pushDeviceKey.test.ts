import { describe, expect, it } from "vitest";

import {
  encodePushDeviceKey,
  isPushDeviceKey,
  mintPushDeviceKey,
  PUSH_DEVICE_KEY_BYTES,
} from "./pushDeviceKey";

function fixedRandom(fill: (index: number) => number) {
  return {
    getRandomValues: (array: Uint8Array) => {
      for (let i = 0; i < array.length; i += 1) array[i] = fill(i);
      return array;
    },
  };
}

describe("isPushDeviceKey", () => {
  it("accepts exactly 64 lowercase hex characters", () => {
    expect(isPushDeviceKey("a".repeat(64))).toBe(true);
    expect(isPushDeviceKey("0123456789abcdef".repeat(4))).toBe(true);
  });

  it("rejects everything a corrupt Keychain entry could look like", () => {
    // Each of these must read as ABSENT so a fresh key is minted, rather than
    // being sent as a possession claim the server will reject forever.
    for (const value of [
      "",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64), // uppercase hex
      `${"a".repeat(63)}g`,
      `${"a".repeat(62)}\n\n`,
      null,
      undefined,
      42,
      { key: "a".repeat(64) },
    ]) {
      expect(isPushDeviceKey(value)).toBe(false);
    }
  });
});

describe("encodePushDeviceKey", () => {
  it("zero-pads every byte so length is always twice the buffer", () => {
    const encoded = encodePushDeviceKey(new Uint8Array([0, 1, 15, 16, 255]));
    expect(encoded).toBe("00010f10ff");
  });
});

describe("mintPushDeviceKey", () => {
  it("produces a well-formed key from 32 bytes of entropy", () => {
    let requested = 0;
    const key = mintPushDeviceKey({
      getRandomValues: (array) => {
        requested = array.length;
        for (let i = 0; i < array.length; i += 1) array[i] = i;
        return array;
      },
    });

    expect(requested).toBe(PUSH_DEVICE_KEY_BYTES);
    expect(isPushDeviceKey(key)).toBe(true);
    expect(key.startsWith("000102030405")).toBe(true);
  });

  it("refuses to mint without a secure random source", () => {
    // The alternative — silently falling back to Math.random — would make the
    // possession key guessable, and the possession key is the ONLY thing
    // authorising a signed-out revoke of this device's push row.
    expect(() => mintPushDeviceKey(undefined)).toThrow(/secure random/i);
    expect(() =>
      mintPushDeviceKey({} as unknown as Parameters<typeof mintPushDeviceKey>[0]),
    ).toThrow(/secure random/i);
  });

  it("still yields 64 hex characters when the source returns all zeroes", () => {
    // A degenerate-but-present source is a different failure from an absent
    // one; the format must hold so the server sees a parseable claim.
    expect(mintPushDeviceKey(fixedRandom(() => 0))).toBe("0".repeat(64));
  });
});
