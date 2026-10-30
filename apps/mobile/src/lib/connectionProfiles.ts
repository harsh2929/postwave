/**
 * lib/connectionProfiles.ts — several Moosewave servers on one phone.
 *
 * THE GAP. An agency operator with a staging install and a production one (or
 * two customers' self-hosted servers) had exactly one address on this device:
 * `authPrefs.ts` remembers THE last base URL, the sign-in screen's collapsed
 * API field edits it in place, and Settings' ApiConnectionSection replaces the
 * single api-key connection. Hopping between two servers meant retyping
 * `https://postwave.internal.acme.com` on a phone keyboard every time. Desktop
 * has had named profiles since WorkspaceMenu.tsx:282 (add :392, switch :238,
 * remove :269).
 *
 * WHAT A PROFILE IS — AND WHAT IT DELIBERATELY IS NOT.
 *
 *   { id, name, baseUrl }. A label and an address. NO CREDENTIAL.
 *
 * Desktop stores a per-profile API key in the OS keychain because its native
 * broker can activate a stored credential without ever handing it back to the
 * renderer. This client has no such broker: the api-key path keeps its key
 * under the auth store's own SecureStore namespace, which is wiped on sign-out
 * by design (store/authCleanup.ts). Keeping a SECOND, longer-lived copy of a
 * `pw_…` key per profile would mean a credential that survives sign-out on a
 * shared device — a strictly worse security posture than the one we have, in
 * exchange for saving one paste. So a switch here is an explicit sign-out and
 * sign-in, and this file's job is to make the address half free.
 *
 * That refusal is what makes the switch honest, too. Session cookies are
 * origin-scoped and every cached artifact (query cache, offline queue, vault,
 * widget snapshot, saved list views) belongs to the workspace it came from; a
 * "switch" that swapped the base URL underneath a live session would leave
 * server A's data on screen labelled server B. There is no fake-fast path
 * here: switching profiles tears the session down first.
 *
 * Import discipline: `./config` only (URL policy), which imports nothing that
 * touches react-native — so every rule below runs under node vitest.
 */

import { normalizeApiBaseUrl, validateApiBaseUrl } from "./config";

export interface ConnectionProfile {
  /** Stable local id. Never sent anywhere — it only addresses the record. */
  id: string;
  /** Operator-chosen label, e.g. "Acme production". */
  name: string;
  /** Normalised absolute base URL, validated by the app's own URL policy. */
  baseUrl: string;
}

export interface ConnectionProfilesState {
  profiles: ConnectionProfile[];
  /** The profile this device is signed in to, or null if unknown. */
  activeId: string | null;
}

/**
 * Ceilings. A phone renders these in a sheet and the record lives in device
 * storage, so both the count and each field are bounded — an unbounded parse
 * is an unbounded allocation from a value anything on the device could have
 * written.
 */
export const MAX_CONNECTION_PROFILES = 10;
export const MAX_PROFILE_NAME_CHARS = 60;
const MAX_PROFILE_ID_CHARS = 64;
const MAX_BASE_URL_CHARS = 512;

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export const EMPTY_CONNECTION_PROFILES: ConnectionProfilesState = {
  profiles: [],
  activeId: null,
};

function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) return null;
  if (CONTROL_CHARS_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parse one stored row. The base URL is re-validated against the CURRENT build
 * profile rather than trusted: a record written by a development build (which
 * may hold `http://192.168…`) must not become an origin a production build
 * posts a password to.
 */
export function parseConnectionProfile(raw: unknown): ConnectionProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = boundedString(row.id, MAX_PROFILE_ID_CHARS);
  const name = boundedString(row.name, MAX_PROFILE_NAME_CHARS);
  const rawUrl = boundedString(row.baseUrl, MAX_BASE_URL_CHARS);
  if (!id || !name || !rawUrl) return null;
  const url = validateApiBaseUrl(rawUrl);
  if (!url.ok) return null;
  return { id, name, baseUrl: url.url };
}

/**
 * Parse the stored record. Malformed rows are DROPPED, not repaired: a row we
 * cannot vouch for is one the switcher must never offer. An `activeId` that no
 * surviving row claims collapses to null — "we don't know where we are" is a
 * state this file can express, and pretending otherwise would mark the wrong
 * row "Current".
 */
export function parseConnectionProfiles(raw: unknown): ConnectionProfilesState {
  if (!raw || typeof raw !== "object") return EMPTY_CONNECTION_PROFILES;
  const record = raw as { profiles?: unknown; activeId?: unknown };
  if (!Array.isArray(record.profiles)) return EMPTY_CONNECTION_PROFILES;
  const profiles: ConnectionProfile[] = [];
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  for (const entry of record.profiles) {
    if (profiles.length >= MAX_CONNECTION_PROFILES) break;
    const profile = parseConnectionProfile(entry);
    if (!profile) continue;
    if (seenIds.has(profile.id) || seenUrls.has(profile.baseUrl)) continue;
    seenIds.add(profile.id);
    seenUrls.add(profile.baseUrl);
    profiles.push(profile);
  }
  const activeId = boundedString(record.activeId, MAX_PROFILE_ID_CHARS);
  return {
    profiles,
    activeId: activeId && seenIds.has(activeId) ? activeId : null,
  };
}

/** The host, for a subtitle or an auto-suggested name. Never invented. */
export function connectionHostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * A first name for a server the user is adding. Just the host: it is the one
 * thing we actually know, it is what desktop shows under the profile name, and
 * a user who wants "Acme production" will type it.
 */
export function suggestConnectionName(baseUrl: string): string {
  const host = connectionHostLabel(normalizeApiBaseUrl(baseUrl));
  return host.slice(0, MAX_PROFILE_NAME_CHARS);
}

export interface ConnectionProfileProblem {
  field: "name" | "baseUrl" | "form";
  message: string;
}

/**
 * Everything that stops a draft from becoming a profile, in the order the user
 * can act on it: the field they are looking at first, then the address policy,
 * then the two collection-level refusals.
 *
 * The duplicate check is on the NORMALISED url, so "https://x.com/" and
 * "https://x.com" are the same server — two rows for one address would give
 * the switcher two identical buttons and make "Current" ambiguous.
 */
export function connectionProfileProblem(
  draft: { name: string; baseUrl: string },
  state: ConnectionProfilesState,
): ConnectionProfileProblem | null {
  const name = draft.name.trim();
  if (!name) return { field: "name", message: "Name this connection." };
  if (name.length > MAX_PROFILE_NAME_CHARS) {
    return {
      field: "name",
      message: `Keep the name to ${MAX_PROFILE_NAME_CHARS} characters or fewer.`,
    };
  }
  if (CONTROL_CHARS_RE.test(name)) {
    return { field: "name", message: "Name contains characters we can't store." };
  }
  const url = validateApiBaseUrl(draft.baseUrl);
  if (!url.ok) return { field: "baseUrl", message: url.message };
  const clash = state.profiles.find((profile) => profile.baseUrl === url.url);
  if (clash) {
    return {
      field: "baseUrl",
      message: `That server is already saved as “${clash.name}”.`,
    };
  }
  if (state.profiles.length >= MAX_CONNECTION_PROFILES) {
    return {
      field: "form",
      message: `This device can hold ${MAX_CONNECTION_PROFILES} connections. Remove one first.`,
    };
  }
  return null;
}

export type AddConnectionResult =
  | { ok: true; state: ConnectionProfilesState; profile: ConnectionProfile }
  | { ok: false; problem: ConnectionProfileProblem };

/**
 * Add a profile. It does NOT become active: adding a server and signing in to
 * it are separate acts, and silently repointing the app at a freshly typed URL
 * is exactly the kind of surprise a credential-bearing client must not spring.
 */
export function addConnectionProfile(
  state: ConnectionProfilesState,
  input: { id: string; name: string; baseUrl: string },
): AddConnectionResult {
  const problem = connectionProfileProblem(input, state);
  if (problem) return { ok: false, problem };
  const id = boundedString(input.id, MAX_PROFILE_ID_CHARS);
  if (!id || state.profiles.some((profile) => profile.id === id)) {
    return {
      ok: false,
      problem: { field: "form", message: "Couldn't save this connection." },
    };
  }
  const url = validateApiBaseUrl(input.baseUrl);
  /* Unreachable — connectionProfileProblem already refused an invalid URL —
   * but expressed rather than cast, so a future edit to the order of those
   * checks cannot smuggle an unvalidated origin into storage. */
  if (!url.ok) return { ok: false, problem: { field: "baseUrl", message: url.message } };
  const profile: ConnectionProfile = {
    id,
    name: input.name.trim(),
    baseUrl: url.url,
  };
  return {
    ok: true,
    profile,
    state: { profiles: [...state.profiles, profile], activeId: state.activeId },
  };
}

export type RemoveConnectionResult =
  | { ok: true; state: ConnectionProfilesState }
  | { ok: false; message: string };

/**
 * Remove a profile.
 *
 * The ACTIVE one is refused, matching desktop (which hides the × on the active
 * row): removing the connection you are signed in to would leave the app in a
 * session whose server is no longer listed, so the switcher would show a
 * "Current" of nothing. Sign in elsewhere first.
 */
export function removeConnectionProfile(
  state: ConnectionProfilesState,
  id: string,
): RemoveConnectionResult {
  const profile = state.profiles.find((row) => row.id === id);
  if (!profile) return { ok: false, message: "That connection is already gone." };
  if (state.activeId === id) {
    return {
      ok: false,
      message: "You're signed in to this connection. Switch to another one first.",
    };
  }
  return {
    ok: true,
    state: {
      profiles: state.profiles.filter((row) => row.id !== id),
      activeId: state.activeId,
    },
  };
}

/**
 * Reconcile the stored record with the address the app is ACTUALLY talking to.
 *
 * Two cases, both of which happen on a device that has never opened this
 * sheet:
 *   - no profiles at all (every existing install) → the live server becomes
 *     the first profile, so the list never opens empty while the user is
 *     plainly connected to something;
 *   - a live address nobody has saved (typed into the sign-in screen's API
 *     field) → it is adopted, because a switcher that omits where you are is
 *     lying by omission.
 *
 * A live URL that fails the app's URL policy is ignored rather than adopted,
 * and so is an unusable id: a row nothing can address is worse than no row,
 * because it cannot be switched away from or removed.
 * Returns the same object when nothing changed, so callers can skip a write.
 */
export function reconcileActiveProfile(
  state: ConnectionProfilesState,
  liveBaseUrl: string | null | undefined,
  newId: string,
): ConnectionProfilesState {
  if (!liveBaseUrl) return state;
  const url = validateApiBaseUrl(liveBaseUrl);
  if (!url.ok) return state;
  const existing = state.profiles.find((row) => row.baseUrl === url.url);
  if (existing) {
    return state.activeId === existing.id
      ? state
      : { profiles: state.profiles, activeId: existing.id };
  }
  if (state.profiles.length >= MAX_CONNECTION_PROFILES) return state;
  const id = boundedString(newId, MAX_PROFILE_ID_CHARS);
  if (!id || state.profiles.some((row) => row.id === id)) return state;
  const profile: ConnectionProfile = {
    id,
    name: suggestConnectionName(url.url),
    baseUrl: url.url,
  };
  return { profiles: [...state.profiles, profile], activeId: profile.id };
}

/** Active first, then alphabetical by the name the user reads. */
export function sortConnectionProfiles(
  state: ConnectionProfilesState,
): ConnectionProfile[] {
  return [...state.profiles].sort((a, b) => {
    const activeA = a.id === state.activeId;
    const activeB = b.id === state.activeId;
    if (activeA !== activeB) return activeA ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export type ConnectionSwitchDecision =
  /** Already signed in to this server; the row is not a button. */
  | { kind: "current" }
  /**
   * Refused: signing in to the other server needs the network, and a switch
   * that signed you out first would strand you signed out of both.
   */
  | { kind: "offline"; message: string }
  | { kind: "sign-out"; title: string; message: string; confirmLabel: string };

/**
 * What tapping a connection does.
 *
 * The copy states the whole transaction because the user is about to lose a
 * session: this device signs out of the current server, then signs in to the
 * chosen one. There is no partial state to describe and no "peek".
 */
export function connectionSwitchDecision(input: {
  profile: ConnectionProfile;
  activeId: string | null;
  online: boolean;
}): ConnectionSwitchDecision {
  if (input.profile.id === input.activeId) return { kind: "current" };
  if (!input.online) {
    return {
      kind: "offline",
      message:
        "You're offline. Signing in to another server needs a connection.",
    };
  }
  return {
    kind: "sign-out",
    title: `Switch to ${input.profile.name}?`,
    message: `This device signs out of the current server and opens sign-in for ${connectionHostLabel(
      input.profile.baseUrl,
    )}.`,
    confirmLabel: "Sign out and switch",
  };
}

/**
 * The consequence line on that confirmation.
 *
 * Sign-out clears every cached artifact of the current workspace, so anything
 * queued offline is discarded — the user has to hear that before, not after.
 * Mirrors `workspaceSwitchConsequence`, with the server-level fact that the
 * old session ends rather than being exchanged for a new one.
 */
export function connectionSwitchConsequence(pendingMutations: number): string {
  if (pendingMutations > 0) {
    return pendingMutations === 1
      ? "1 change waiting to sync will be discarded, and this session ends."
      : `${pendingMutations} changes waiting to sync will be discarded, and this session ends.`;
  }
  return "This session ends and offline data for it is cleared from this device.";
}
