/**
 * lib/whatsNewStore.ts — where a dismissed announcement is remembered.
 *
 * AsyncStorage, one JSON array of feature keys, NOT identity-scoped and NOT in
 * the sign-out wipe set. Two deliberate choices:
 *
 *   - A dismissal is a fact about the PERSON holding the phone ("I have read
 *     that"), not about the workspace, so scoping it to a tenant would re-show
 *     the same card to the same person after every workspace switch. It is the
 *     same reasoning `authPrefs.ts` uses for the server address.
 *   - It is not a secret and carries no tenant data — the keys are the names of
 *     shipped Moosewave features, identical on every install — so it is not
 *     something a sign-out has to erase. (This is the ONLY reason it may skip
 *     the wipe list; anything workspace-shaped belongs in listPreferences.)
 *
 * Nothing here throws. A storage failure means "nothing dismissed", which
 * re-shows one card — the safe direction. Failing the other way (treating an
 * unreadable record as "everything dismissed") would silently disable the
 * announcement mechanism on a device whose storage is misbehaving.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { parseDismissedAnnouncements, withDismissal } from "./whatsNew";

export const WHATS_NEW_DISMISSED_KEY = "postwave.whatsnew.dismissed.v1";

/** Bounded so a corrupted value can never be parsed into memory wholesale. */
const MAX_RECORD_CHARS = 4096;

export async function readDismissedAnnouncements(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(WHATS_NEW_DISMISSED_KEY);
    if (typeof raw !== "string" || raw.length > MAX_RECORD_CHARS) return [];
    return parseDismissedAnnouncements(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Records one dismissal and answers the NEW list, so a caller can set state
 * from the same value that was written rather than re-reading storage (and
 * still shows the next card if the write itself failed).
 */
export async function dismissAnnouncement(
  featureKey: string,
): Promise<string[]> {
  const next = withDismissal(await readDismissedAnnouncements(), featureKey);
  try {
    await AsyncStorage.setItem(WHATS_NEW_DISMISSED_KEY, JSON.stringify(next));
  } catch {
    /* best effort: the card stays down for this session either way */
  }
  return next;
}
