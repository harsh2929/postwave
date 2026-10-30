/**
 * lib/entityActivityBridge.ts — the NSUserActivity donation surface.
 *
 * There is no new native code here and no new dependency. `expo-router`
 * already ships an `ExpoHead` module (node_modules/expo-router/ios/
 * ExpoHeadModule.swift) that wraps NSUserActivity + CoreSpotlight, and an
 * app-delegate subscriber that converts a continued activity's `userInfo.href`
 * into an `RCTOpenURLNotification` — i.e. straight into the `Linking` "url"
 * event that `useDeepLinkRouting` already listens on. We reach the module
 * DIRECTLY rather than through expo-router's `<Head>` component for two
 * reasons:
 *
 *   - `<Head>` keys activities by ROUTE PATH, so the same campaign opened from
 *     a list, a deep link and a search result registers three activities. We
 *     key by entity+id, which is what the user actually continued.
 *   - `<Head>` never revokes anything. Spotlight entries survive sign-out, so
 *     something has to delete them; `purgeEntityActivities` is wired into
 *     store/authCleanup.ts alongside the widget and share-inbox purges.
 *
 * Android and any build without the module (Expo Go) are silent no-ops — the
 * bridge is optional by construction, and NOT donating is always safe.
 *
 * The only module this file reaches for is AsyncStorage, and only through a
 * dynamic `import()` inside the donation ledger below — so importing the bridge
 * from store/authCleanup.ts still drags no native chain into sign-out, and the
 * whole file remains node-testable.
 */
import type { EntityActivityDescriptor } from "@/lib/entityActivity";

type ExpoHeadModule = {
  createActivity: (options: Record<string, unknown>) => void;
  suspendActivity: (id: string) => void;
  revokeActivity: (id: string) => void;
  clearActivitiesAsync: (ids: string[]) => Promise<void>;
  activities?: { INDEXED_ROUTE?: string };
};

type ExpoGlobal = {
  modules?: { ExpoHead?: ExpoHeadModule; ExpoGo?: unknown };
};

/**
 * Reach the module off the Expo global rather than through `requireOptional-
 * NativeModule`, exactly as expo-router's own ExpoHeadModule.js does. That
 * keeps this file IMPORT-FREE, which matters twice over: it is reachable from
 * store/authCleanup.ts (which must not drag a native chain into the sign-out
 * path) and it is therefore unit-testable in the node environment.
 *
 * Not resolved once at module load: `globalThis.expo` is installed by the
 * runtime and a module imported early can observe it as absent.
 */
function nativeHead(): ExpoHeadModule | null {
  const expo = (globalThis as { expo?: ExpoGlobal }).expo;
  // In Expo Go the host app's modules are not this app's.
  if (!expo?.modules || expo.modules.ExpoGo) return null;
  return expo.modules.ExpoHead ?? null;
}

/**
 * Every indexed id this app has donated and not yet confirmed deleted, oldest
 * first. Needed because CoreSpotlight deletion is BY IDENTIFIER: on sign-out we
 * must be able to name what we indexed, and the native module keeps its own set
 * only for the live NSUserActivity objects.
 */
const donated = new Set<string>();

/**
 * Where those ids are RECORDED so a later launch can still name them.
 *
 * The module exposes no "delete everything this app indexed" call, only
 * `clearActivitiesAsync(ids)`. An in-process Set could therefore name nothing
 * donated before the current launch: campaign and subscriber titles indexed
 * yesterday survived sign-out and stayed searchable in Spotlight for whoever
 * picks the phone up next — while `clearLocalAuthArtifacts` reported the wipe
 * complete, which is the worse half. The ledger is what lets the purge name
 * donations made in a process that has already gone.
 *
 * AsyncStorage rather than SecureStore: these are the app's own synthetic
 * identifiers (`postwave.entity.<type>.<id>`), the Spotlight index they point at
 * is not encrypted either, and SecureStore's small value limit and per-read cost
 * would be paid on a path that runs on every detail-screen open.
 */
const DONATION_LEDGER_KEY = "postwave.spotlight_donations.v1";

type DonationLedger = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

let ledgerPromise: Promise<DonationLedger | null> | null = null;

function ledger(): Promise<DonationLedger | null> {
  ledgerPromise ??= import("@react-native-async-storage/async-storage")
    .then((mod) => (mod.default ?? null) as DonationLedger | null)
    .catch(() => null);
  return ledgerPromise;
}

/**
 * How many entities stay searchable at once. A donation is one screen open, so
 * an unbounded ledger would grow for the life of the install.
 *
 * The cap USED to be enforced by silently declining to remember the id, which
 * meant every entity past the 200th was indexed by iOS and unnameable by the
 * purge. Overflow is now evicted by DELETING the oldest index entries
 * (`evictOldestDonations`), so an id only ever leaves the ledger once the
 * platform has confirmed the entry it names is gone.
 */
const MAX_TRACKED_ACTIVITIES = 200;

/** A ledger write is in flight or scheduled; it will observe the newest set. */
let ledgerWriteQueued = false;
let ledgerChain: Promise<void> = Promise.resolve();
let ledgerAdopted = false;

/**
 * Take ownership of what a previous launch recorded, before writing over it.
 *
 * The ledger is written as a WHOLE SET (see `recordDonations`), so the first
 * write of a process would otherwise erase exactly the ids this ledger exists
 * to preserve — the leak would survive the fix, one launch removed. Adopting
 * them also means eviction and purge treat old and new donations alike.
 *
 * Returns false when the previous record could not be read or understood: the
 * caller must then leave it alone rather than replace names it never learned.
 */
async function adoptRecordedDonations(store: DonationLedger): Promise<boolean> {
  if (ledgerAdopted) return true;
  let previous: string[] | null;
  try {
    previous = parseLedger(await store.getItem(DONATION_LEDGER_KEY));
  } catch {
    return false;
  }
  if (previous === null) return false;
  const mine = [...donated];
  donated.clear();
  // Previous-launch ids first: eviction is by age and they are the oldest.
  for (const id of [...previous, ...mine]) donated.add(id);
  ledgerAdopted = true;
  return true;
}

/**
 * Persist the whole set rather than a delta. A failed write is therefore
 * repaired by the NEXT donation instead of leaving a permanent hole, and two
 * donations racing cannot interleave into a half-written ledger.
 */
function recordDonations(): void {
  if (ledgerWriteQueued) return;
  ledgerWriteQueued = true;
  ledgerChain = ledgerChain.then(async () => {
    ledgerWriteQueued = false;
    const store = await ledger();
    if (!store) return;
    if (!(await adoptRecordedDonations(store))) return;
    try {
      await store.setItem(DONATION_LEDGER_KEY, JSON.stringify([...donated]));
    } catch {
      // The id is still named in memory, so THIS session's sign-out covers it;
      // the next donation rewrites the full set and repairs the record.
    }
  });
}

/**
 * `null` means the record exists but could not be understood — which is not the
 * same as "nothing was donated" and must not be treated as one.
 */
function parseLedger(raw: string | null): string[] | null {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === "string" && v !== "");
  } catch {
    return null;
  }
}

/**
 * Keep the ledger bounded by deleting the least recently donated entries from
 * the index, never by forgetting them. Best effort: if the delete fails the ids
 * stay tracked, so the sign-out purge still names them.
 */
function evictOldestDonations(head: ExpoHeadModule): void {
  if (donated.size <= MAX_TRACKED_ACTIVITIES) return;
  const overflow = [...donated].slice(0, donated.size - MAX_TRACKED_ACTIVITIES);
  for (const id of overflow) {
    try {
      head.revokeActivity(id);
    } catch {
      /* the index delete below is the authoritative removal */
    }
  }
  void head
    .clearActivitiesAsync(overflow)
    .then(() => {
      for (const id of overflow) donated.delete(id);
      recordDonations();
    })
    .catch(() => {
      /* still ours to delete at sign-out */
    });
}

function activityType(head: ExpoHeadModule): string {
  return head.activities?.INDEXED_ROUTE ?? "postwave.entity";
}

/**
 * Donate one activity. Returns whether the platform accepted it, so callers
 * can tell "not donated" from "donated and iOS is showing it".
 */
export function donateEntityActivity(
  descriptor: EntityActivityDescriptor,
): boolean {
  const head = nativeHead();
  if (!head) return false;
  try {
    head.createActivity({
      activityType: activityType(head),
      id: descriptor.id,
      title: descriptor.title,
      webpageURL: descriptor.webpageURL,
      keywords: descriptor.keywords,
      isEligibleForHandoff: descriptor.isEligibleForHandoff,
      isEligibleForSearch: descriptor.isEligibleForSearch,
      // Never public: a workspace's campaign names are not web content and
      // must not be offered to Apple's server-side index.
      isEligibleForPublicIndexing: false,
      // Siri suggestion prediction is a third disclosure surface with its own
      // retention; the finding asked for Handoff and Spotlight, not for the
      // app to start proposing entities on the lock screen.
      isEligibleForPrediction: false,
      ...(descriptor.description
        ? { description: descriptor.description }
        : {}),
      // `href` is the app's OWN canonical deep link, so a continued activity
      // re-enters through the parser that is already tested for it, rather
      // than through a synthesised route path.
      userInfo: { href: descriptor.href },
    });
    if (descriptor.isEligibleForSearch) {
      // Re-inserting refreshes recency: a Set keeps its original position for
      // an id that is merely re-added, and eviction is by age.
      donated.delete(descriptor.id);
      donated.add(descriptor.id);
      recordDonations();
      evictOldestDonations(head);
    }
    return true;
  } catch {
    // A donation is a nicety. Never let one break a detail screen.
    return false;
  }
}

/** Stop advertising an activity when its screen goes away. */
export function suspendEntityActivity(id: string): void {
  const head = nativeHead();
  if (!head) return;
  try {
    head.suspendActivity(id);
  } catch {
    /* ignore */
  }
}

/**
 * Delete every indexed activity this install donated — INCLUDING the ones
 * donated by a previous run of the app.
 *
 * Called from the sign-out artifact wipe. Rejects on failure rather than
 * reporting success, so `clearLocalAuthArtifacts` retries and, if it still
 * fails, names `spotlight_index` as an area that still holds workspace data.
 *
 * "Failure" includes not being able to READ the ledger. A purge that deletes
 * only what this process happens to remember, and returns as though the index
 * were empty, is exactly the false all-clear this function exists to avoid:
 * the person is told their data is gone while yesterday's campaign titles are
 * still one Spotlight search away.
 */
export async function purgeEntityActivities(): Promise<void> {
  const head = nativeHead();
  // No module means no donation was ever possible on this build/platform, so
  // there is genuinely nothing indexed and nothing to read a ledger for.
  if (!head) {
    donated.clear();
    return;
  }

  const store = await ledger();
  let recorded: string[] | null = null;
  if (store) {
    try {
      recorded = parseLedger(await store.getItem(DONATION_LEDGER_KEY));
    } catch {
      recorded = null;
    }
  }

  const ids = [...new Set([...(recorded ?? []), ...donated])];
  // Invalidate the live NSUserActivity objects first: an activity still
  // advertising for Handoff is not covered by the CoreSpotlight delete.
  for (const id of ids) {
    try {
      head.revokeActivity(id);
    } catch {
      /* the index delete below is the authoritative removal */
    }
  }
  // A rejection here leaves `donated` intact so the retry deletes the same ids
  // rather than forgetting them.
  if (ids.length > 0) await head.clearActivitiesAsync(ids);
  donated.clear();

  if (!store || recorded === null) {
    throw new Error(
      "spotlight donation ledger unreadable: activities donated before this launch cannot be named",
    );
  }
  try {
    await store.removeItem(DONATION_LEDGER_KEY);
  } catch {
    // The index entries are already gone; a surviving ledger only costs the
    // next purge a repeat delete of ids that no longer exist.
  }
}

/** Test/diagnostic view of what this process can name. */
export function trackedEntityActivityIds(): string[] {
  return [...donated];
}

/** Forget the tracked set without touching the platform (tests only). */
export function resetTrackedEntityActivities(): void {
  donated.clear();
  ledgerWriteQueued = false;
  ledgerAdopted = false;
  ledgerChain = Promise.resolve();
  ledgerPromise = null;
}
