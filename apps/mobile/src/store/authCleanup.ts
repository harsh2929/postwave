/**
 * store/authCleanup.ts
 *
 * Sign-out orchestration: the local artifact wipe, its retry, and the
 * server-side session revocation. Extracted from store/auth.ts (AUTH#60).
 *
 * The ordering contract, which is what makes a shared device safe:
 *
 *   1. Write the cleanup marker FIRST. If the app dies mid-wipe, the next
 *      launch sees the marker and refuses to restore the half-deleted identity.
 *   2. Run every task, then RETRY only the failures. A single transient
 *      keychain error must not leave one artifact behind silently.
 *   3. Delete the marker only when every task succeeded. If the marker itself
 *      cannot be deleted, report incomplete rather than claim success.
 *   4. ...unless the device held NOTHING to wipe, in which case a failing task
 *      is a build problem, not this user's problem. See
 *      deviceHoldsAuthArtifacts for the invariant that makes that safe.
 *
 * Failure is reported by AREA, not as a boolean, so the UI can tell the user
 * which surface still holds data and the caller can decide whether the
 * remaining state is safe to reuse. cleanupWarning() SPENDS that detail: the
 * area names go into the sentence the user reads and into a console.warn, so
 * "cleanup is incomplete" never again means "somewhere, somehow".
 */
// Direct, NOT via the eager "@/api/client" barrel — see startupImportBudget.
import { clearClient } from "@/api/sdkClient";
import { createAuthClient } from "@/api/auth";
import { purgeEntityActivities } from "@/lib/entityActivityBridge";
import { clearListPreferences } from "@/lib/listPreferences";
import { clearPendingAuthLinkStates } from "@/lib/magicLinkState";
import { queryClient, queryPersister } from "@/lib/queryClient";
import { clearSecret } from "@/lib/revealOnceSecret";
import { purgeLocalTransfers } from "@/lib/transferCenter";
import { vaultClear } from "@/lib/secureVault";
import { clearSharedInbox, clearSharedInboxStrict } from "@/lib/sharedInbox";
import {
  clearWidgetSnapshot,
  clearWidgetSnapshotStrict,
} from "@/lib/widgetData";

import {
  LOCAL_AUTH_STORAGE_KEYS,
  SECURE_KEY_CLEANUP_PENDING,
  retryStorageOperation,
  retryStorageRead,
  secureDelete,
  secureGet,
  secureSet,
} from "./authSecureStorage";

export type LocalAuthCleanupResult = {
  complete: boolean;
  failedAreas: string[];
};

/**
 * What a caller may assert about the device it is asking to wipe.
 *
 * `identityPresent: true` is the caller's PROOF that this device held an
 * identity — a live `mode` in the store, a session the server just accepted, a
 * credential blob that survived storage but not parsing. It forces the
 * fail-closed report even when the durable probe below finds nothing, which is
 * exactly the state a half-completed teardown leaves behind.
 *
 * Omitting it is never proof of the opposite. It only means the caller does
 * not know, and the probe decides.
 */
export type LocalCleanupOptions = { identityPresent?: boolean };

type CleanupTask = { name: string; run: () => Promise<void> };

function localCleanupTasks(): CleanupTask[] {
  return [
    ...LOCAL_AUTH_STORAGE_KEYS.map((key) => ({
      name: `secure_store:${key}`,
      run: () => secureDelete(key),
    })),
    { name: "vault", run: () => vaultClear() },
    { name: "query_cache", run: () => queryPersister.removeClient() },
    { name: "shared_inbox", run: () => clearSharedInboxStrict() },
    { name: "widget_snapshot", run: () => clearWidgetSnapshotStrict() },
    // Donated NSUserActivities (SHELL#31). Handoff advertisements die with the
    // process, but a Spotlight entry is written to the on-device index and
    // survives sign-out — a campaign title left searchable by the next person
    // to hold the phone is the same class of leak as a stale widget snapshot.
    { name: "spotlight_index", run: () => purgeEntityActivities() },
    { name: "auth_link_states", run: () => clearPendingAuthLinkStates() },
    // Saved list views (sort/filter) are workspace-shaped: a filter like
    // "only my drafts" or a remembered search term must not carry into the
    // next account on a shared device.
    { name: "list_preferences", run: () => clearListPreferences() },
  ];
}

async function runCleanupTasks(tasks: CleanupTask[]): Promise<CleanupTask[]> {
  const results = await Promise.allSettled(tasks.map((task) => task.run()));
  return tasks.filter((_, index) => results[index]?.status === "rejected");
}

const CLEANUP_MARKER_AREA = "secure_store:cleanup_marker";

/**
 * Does this device hold anything a wipe could remove?
 *
 * WHY THIS EXISTS. Three of the tasks above clear surfaces OUTSIDE the app
 * sandbox — two App Group containers (`shared_inbox`, `widget_snapshot`) and
 * the on-device Spotlight index. They fail whenever the container is not
 * provisioned, and a build signed with no development team has no App Group at
 * all, so the clear can only fail. That failure was reported as an incomplete
 * SIGN-OUT on a device that had never been signed IN: the report sets the
 * durable marker, the marker refuses every later sign-in, and the marker lives
 * in the keychain, which SURVIVES DELETING THE APP. A first-run user was told
 * "You are signed out, but secure local cleanup is incomplete", both sign-in
 * buttons were disabled, and neither the retry, nor a relaunch, nor a
 * reinstall cleared it — only erasing the device did. Observed by driving a
 * simulator, 2026-09-04.
 *
 * THE INVARIANT THAT MAKES SILENCE SAFE. The marker is part of the probe set,
 * and a wipe deletes the marker only when every task succeeded — which
 * includes the VERIFIED App Group purges. So "no auth key present AND no
 * marker present" means the last wipe finished and left those containers
 * verifiably empty, and nothing since could have refilled them, because
 * writing to them requires a session and a session requires the very keys this
 * probe just found absent. Nothing to wipe, so nothing to leak, so nothing to
 * latch shut over.
 *
 * It fails CLOSED: a probe that cannot read answers "occupied". Proving the
 * device is empty is the only thing that buys silence, and a broken keychain
 * proves nothing.
 */
async function deviceHoldsAuthArtifacts(): Promise<boolean> {
  try {
    const values = await Promise.all(
      [...LOCAL_AUTH_STORAGE_KEYS, SECURE_KEY_CLEANUP_PENDING].map((key) =>
        retryStorageRead(() => secureGet(key)),
      ),
    );
    return values.some((value) => value !== null);
  } catch {
    return true;
  }
}

/**
 * AREA NAMES ONLY — never a value. A value out of any of these areas is a
 * credential; the name is a symptom, and the symptom is the whole point.
 */
function shortArea(area: string): string {
  const prefix = "secure_store:postwave.";
  return area.startsWith(prefix)
    ? `secure_store:${area.slice(prefix.length)}`
    : area;
}

const MAX_REPORTED_AREAS = 4;

function describeAreas(areas: string[]): string {
  const unique = [...new Set(areas)].map(shortArea);
  const shown = unique.slice(0, MAX_REPORTED_AREAS);
  const hidden = unique.length - shown.length;
  return hidden > 0 ? `${shown.join(", ")} and ${hidden} more` : shown.join(", ");
}

/**
 * The operator's copy of the same fact. It is logged HERE, at the point of
 * failure, rather than left to whichever caller happens to render the warning:
 * three call sites drop the result on the floor, and the one that took a
 * simulator session to diagnose was one of them.
 */
function warnCleanupAreas(context: string, areas: string[]): void {
  console.warn(
    `[postwave-mobile] secure local cleanup incomplete (${context}):`,
    [...new Set(areas)].join(", "),
  );
}

export async function clearLocalAuthArtifacts(
  options: LocalCleanupOptions = {},
): Promise<LocalAuthCleanupResult> {
  // Probed BEFORE the marker is written, because the marker is part of the
  // evidence. Nothing has been deleted yet, so a crash in here leaves the
  // device exactly as it was found.
  const occupied =
    options.identityPresent === true || (await deviceHoldsAuthArtifacts());

  let markerAvailable = true;
  try {
    await retryStorageOperation(() =>
      secureSet(SECURE_KEY_CLEANUP_PENDING, "1"),
    );
  } catch {
    markerAvailable = false;
  }

  let failed = await runCleanupTasks(localCleanupTasks());
  if (failed.length > 0) failed = await runCleanupTasks(failed);

  const failedAreas = failed.map((task) => task.name);
  if (!markerAvailable) failedAreas.push(CLEANUP_MARKER_AREA);

  if (failedAreas.length > 0 && !occupied) {
    // Still logged. An unprovisioned App Group is a real build problem — it is
    // just not a reason to lock a first-run user out of the sign-in screen.
    warnCleanupAreas(
      "device held no auth artifacts, so sign-in is not latched",
      failedAreas,
    );
  }

  if (failed.length === 0 || !occupied) {
    try {
      await retryStorageOperation(() =>
        secureDelete(SECURE_KEY_CLEANUP_PENDING),
      );
    } catch {
      // The marker outlives this call and will latch the next launch, so say
      // so rather than claim success — including on the nothing-to-wipe path,
      // where leaving it silent would produce a banner with no explanation.
      warnCleanupAreas("the cleanup marker could not be removed", [
        CLEANUP_MARKER_AREA,
      ]);
      return { complete: false, failedAreas: [CLEANUP_MARKER_AREA] };
    }
    return { complete: true, failedAreas: [] };
  }

  warnCleanupAreas("sign-in stays blocked until these clear", failedAreas);
  return { complete: false, failedAreas };
}

/**
 * The sentence the sign-in screen shows while the latch is closed.
 *
 * IT NAMES THE AREAS. This function used to receive `failedAreas` and throw it
 * away for one fixed sentence, so neither the user nor any log ever learned
 * which surface had failed — which is why a deterministic App Group failure
 * took a simulator session to identify. Names, never values (see shortArea).
 *
 * AND THE ADVICE IS TRUE. It used to read "Restart the app while the device is
 * unlocked to retry before signing in again". Restarting does re-run the wipe
 * — hydrate() sees the marker and calls back in here — but that was read as a
 * promise that restarting would CLEAR it, and for a deterministic failure it
 * never can. Nor can reinstalling: the marker is a keychain item and outlives
 * app deletion on iOS. Say that, so nobody spends an evening erasing a device
 * to find out.
 */
export function cleanupWarning(result: LocalAuthCleanupResult): string | null {
  if (result.complete) return null;
  const areas = describeAreas(result.failedAreas);
  return [
    `You are signed out, but secure local cleanup is incomplete${areas ? `: ${areas}` : ""}.`,
    "Unlock this device and tap Retry secure cleanup.",
    "It also runs again on every launch, so restarting or reinstalling the app will not clear this on its own.",
  ].join(" ");
}

/**
 * A 401 means the server-side record is already gone, so it counts as revoked.
 * Anything else (network, 5xx) leaves an orphan cookie session that must be
 * journaled for a later retry rather than forgotten.
 */
export async function revokeServerSession(baseUrl: string): Promise<boolean> {
  try {
    const result = await createAuthClient(baseUrl).logoutSession();
    return !result.error || result.error.status === 401;
  } catch {
    return false;
  }
}

export function clearInMemoryClientState(): void {
  clearClient();
  queryClient.clear();
  clearWidgetSnapshot();
  // Another person's share history must not outlive their sign-in; the
  // registry documents this boundary and had no caller enforcing it.
  purgeLocalTransfers();
  clearSharedInbox();
  // The reveal-once webhook signing secret lives in module state in
  // lib/revealOnceSecret — deliberately never persisted, but equally never
  // scoped to a session. It outlived sign-out, and OutboundWebhooksSection
  // seeds its state from peekSecret() ON MOUNT, so whoever signed in next on
  // the same device saw the previous session's signing secret rendered for the
  // remainder of its ten-minute TTL. This function's whole job is wiping
  // in-memory client state, and this file's own header calls the ordering
  // contract "what makes a shared device safe".
  clearSecret();
}
