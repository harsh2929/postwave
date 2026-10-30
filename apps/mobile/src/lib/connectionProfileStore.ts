/**
 * lib/connectionProfileStore.ts — where the connection list lives.
 *
 * AsyncStorage, one JSON record, deliberately OUTSIDE the auth store's
 * `LOCAL_AUTH_STORAGE_KEYS` wipe set — for the same reason `authPrefs.ts`
 * keeps the last base URL out of it: signing out must clear credentials, not
 * the addresses of the servers this device talks to. There is nothing secret
 * in the record (see connectionProfiles.ts: names and URLs only, never a key),
 * and a profile list that vanished on sign-out would be erased by the very act
 * it exists to make cheap.
 *
 * Every read runs the record back through `parseConnectionProfiles`, so a
 * value written by an older build — or by anything else on the device — is
 * re-validated against the CURRENT URL policy before a profile can become an
 * origin the app signs in to.
 *
 * Nothing here throws. A storage failure degrades to "no saved connections",
 * which shows the sheet's empty state; it never throws inside a More-screen
 * render path.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  EMPTY_CONNECTION_PROFILES,
  parseConnectionProfiles,
  type ConnectionProfilesState,
} from "./connectionProfiles";

export const CONNECTION_PROFILES_KEY = "postwave.connections.v1";

/**
 * Ten profiles of bounded fields cannot approach this; anything that does is
 * not our record, and parsing it would be an unbounded allocation from device
 * storage.
 */
const MAX_RECORD_CHARS = 16_384;

export async function readConnectionProfiles(): Promise<ConnectionProfilesState> {
  try {
    const raw = await AsyncStorage.getItem(CONNECTION_PROFILES_KEY);
    if (typeof raw !== "string" || raw.length > MAX_RECORD_CHARS) {
      return EMPTY_CONNECTION_PROFILES;
    }
    return parseConnectionProfiles(JSON.parse(raw));
  } catch {
    return EMPTY_CONNECTION_PROFILES;
  }
}

/**
 * Persist. Answers whether the write landed, because the two callers differ:
 * adding a connection must SAY it failed (the user typed a URL and would
 * otherwise think it was saved), while marking the active profile after a
 * switch is a best-effort annotation on top of a sign-out that already
 * happened.
 */
export async function writeConnectionProfiles(
  state: ConnectionProfilesState,
): Promise<boolean> {
  try {
    await AsyncStorage.setItem(
      CONNECTION_PROFILES_KEY,
      JSON.stringify({ profiles: state.profiles, activeId: state.activeId }),
    );
    return true;
  } catch {
    return false;
  }
}
