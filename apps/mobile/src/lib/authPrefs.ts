/**
 * authPrefs — the one non-secret preference the sign-in screen should
 * remember: which API server this device talks to.
 *
 * `sign-in.tsx` seeded its base-URL state from the build-time default on every
 * mount, and `SECURE_KEY_BASE` is a member of the sign-out wipe list, so a
 * self-hosted operator retyped `https://postwave.internal.acme.com` on a phone
 * keyboard after every sign-out and every session expiry.
 *
 * The server address is NOT a credential — desktop shows it in plain text in
 * the workspace menu — so it lives in AsyncStorage under its own key, and
 * deliberately OUTSIDE the auth store's `LOCAL_AUTH_STORAGE_KEYS` wipe set:
 * signing out must clear credentials, not the address of the server.
 *
 * It is still validated on read. A corrupted or hostile stored value must
 * never become the origin a password is posted to, so the caller re-runs
 * `validateApiBaseUrl` and this module refuses anything that is not a bounded,
 * http(s) absolute URL.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

export const LAST_BASE_URL_KEY = "postwave.last_base_url";

const MAX_BASE_URL_CHARS = 512;

/** Shape check only — the caller still runs the app's own URL policy. */
export function isStorableBaseUrl(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || trimmed.length > MAX_BASE_URL_CHARS) {
    return false;
  }
  // Escaped, not literal. This class previously held RAW control bytes, which
  // render as nothing in an editor and made the class read as `[\s -]` — a
  // space-and-hyphen range. A security reviewer read it that way and filed a
  // finding that ordinary hyphenated hosts were being refused. They are not;
  // the class is whitespace plus C0/DEL. Spelled out so it cannot mislead again.
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    return Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** Never throws: a storage failure just means "no remembered server". */
export async function readLastBaseUrl(): Promise<string | null> {
  try {
    const stored = await AsyncStorage.getItem(LAST_BASE_URL_KEY);
    return isStorableBaseUrl(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Never throws: remembering the server is a convenience, not a guarantee. */
export async function rememberLastBaseUrl(value: string): Promise<void> {
  if (!isStorableBaseUrl(value)) return;
  try {
    await AsyncStorage.setItem(LAST_BASE_URL_KEY, value);
  } catch {
    /* best effort */
  }
}
