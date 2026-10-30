/**
 * lib/pushDeviceKey.ts — the possession key format, with no storage attached.
 *
 * WHAT THE KEY IS. A 32-byte random value minted once per installation and
 * kept in the Keychain. It is the ONLY thing that proves "this handset owns
 * that push registration", which is what lets a signed-out app still revoke
 * its own device row (see lib/pushRevocationJournal.ts) without carrying a
 * session credential around. It deliberately contains no user, tenant or
 * device identifier.
 *
 * WHY IT IS ITS OWN MODULE (NATIVE#54). The format rules are the security
 * boundary — 256 bits of real entropy, lowercase hex, exact length — and while
 * they lived inside `push.ts` they could only be reached through
 * expo-secure-store and expo-notifications, so none of them had a direct test.
 * Nothing here imports anything, so all of it is node-tested.
 */

/** 256 bits. Anything less is guessable at fleet scale. */
export const PUSH_DEVICE_KEY_BYTES = 32;

/** The `crypto.getRandomValues` surface, injectable so tests can pin bytes. */
export interface RandomSource {
  getRandomValues: (array: Uint8Array) => Uint8Array;
}

/**
 * Exactly 64 lowercase hex characters.
 *
 * Strict on purpose: a stored value that fails this is treated as absent, so a
 * corrupted or half-written Keychain entry mints a fresh key instead of sending
 * a malformed possession claim the server would reject forever.
 */
export function isPushDeviceKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Lowercase hex encoding, zero-padded per byte. */
export function encodePushDeviceKey(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Mint a new possession key, or throw.
 *
 * Throwing is the point: a runtime with no secure random source must NOT fall
 * back to `Math.random`, because a predictable possession key would let anyone
 * who can guess it revoke another installation's push registration.
 */
export function mintPushDeviceKey(random: RandomSource | undefined): string {
  if (!random?.getRandomValues) {
    throw new Error("Secure random source unavailable for push registration.");
  }
  const bytes = new Uint8Array(PUSH_DEVICE_KEY_BYTES);
  random.getRandomValues(bytes);
  const key = encodePushDeviceKey(bytes);
  if (!isPushDeviceKey(key)) {
    // A random source that returned a short or unfilled buffer is a broken
    // one; a truncated key is worse than no push at all.
    throw new Error("Secure random source produced an invalid device key.");
  }
  return key;
}
