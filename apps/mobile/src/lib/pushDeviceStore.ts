/**
 * lib/pushDeviceStore.ts — Keychain storage for the push possession key.
 *
 * A thin adapter over expo-secure-store: every format and entropy rule lives
 * in lib/pushDeviceKey.ts, which imports nothing and is therefore node-tested
 * (NATIVE#54). This file only owns WHERE the key is kept and under what
 * protection class.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` matters: it keeps the key out of iCloud
 * Keychain and encrypted backups, so restoring a backup onto a second handset
 * cannot hand that handset the possession proof for the first one's push row.
 */
import * as SecureStore from "expo-secure-store";

import {
  isPushDeviceKey,
  mintPushDeviceKey,
  type RandomSource,
} from "@/lib/pushDeviceKey";

const SECURE_KEY_DEVICE_KEY = "postwave.push_device_key.v1";
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** The stored possession key, or null when absent/corrupt. */
export async function readPushDeviceKey(): Promise<string | null> {
  const value = await SecureStore.getItemAsync(
    SECURE_KEY_DEVICE_KEY,
    SECURE_OPTIONS,
  );
  return isPushDeviceKey(value) ? value : null;
}

/** The stored possession key, minting and persisting one on first use. */
export async function getOrCreatePushDeviceKey(): Promise<string> {
  const existing = await readPushDeviceKey();
  if (existing) return existing;
  const random = (globalThis as unknown as { crypto?: RandomSource }).crypto;
  const key = mintPushDeviceKey(random);
  await SecureStore.setItemAsync(SECURE_KEY_DEVICE_KEY, key, SECURE_OPTIONS);
  return key;
}
