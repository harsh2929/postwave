/**
 * Pending-route reader for App Intents (Siri Shortcuts).
 *
 * The App Intents in plugins/PostwaveAppIntents.swift stash a destination
 * route in the shared App Group (key `pw_pending_route`) and foreground the
 * app. We read + clear it on foreground and navigate. Only a fixed allow-list
 * of tab routes is honoured, so a stale/garbage value can never push an
 * arbitrary screen.
 *
 * Guarded like the other App-Group bridges: a no-op before the App Intents
 * ship in the build, or on Android.
 */
import { Platform } from "react-native";
import type { Href } from "expo-router";
import { ExtensionStorage } from "@bacons/apple-targets";

const APP_GROUP = "group.com.moosewave.app";
const ROUTE_KEY = "pw_pending_route";

// Exact routes the App Intents (and the Control Center scan control) are
// allowed to request. Search / Notifications / Scan are here because they are
// the "start a task from the home screen" destinations that carry no arguments
// and no destructive capability — landing on them cold is always safe.
// Everything else stays off the list: this allowlist is the only thing standing
// between a stale App Group value and an arbitrary screen push.
//
// This set is a CONTRACT with the queueRoute() calls in
// plugins/PostwaveAppIntents.swift and targets/widget/ScanControl.swift, and a
// rejection here is silent by design — the intent still foregrounds the app, so
// a route missing from this list looks exactly like "Siri did nothing". That is
// how "Show Moosewave stores" and "Show Moosewave deliverability" shipped dead:
// the intents were added, the allowlist was not. `appIntentsContract.test.ts`
// now reads the route literals out of the Swift and fails if either side moves
// without the other.
const ALLOWED_ROUTES = new Set<string>([
  "/(tabs)/dashboard",
  "/(tabs)/approvals",
  "/(tabs)/campaigns",
  "/(tabs)/subscribers",
  "/(tabs)/commerce",
  "/(tabs)/deliverability",
  "/(tabs)/search",
  "/(tabs)/notifications",
  "/(tabs)/scan",
]);

/** Pure validator — exported for unit testing. */
export function validatePendingRoute(raw: string | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  return ALLOWED_ROUTES.has(raw) ? raw : null;
}

let storage: ExtensionStorage | null = null;
let storageUnavailable = false;
function getStorage(): ExtensionStorage | null {
  if (Platform.OS !== "ios" || storageUnavailable) return null;
  if (storage) return storage;
  try {
    storage = new ExtensionStorage(APP_GROUP);
  } catch {
    storageUnavailable = true;
    storage = null;
  }
  return storage;
}

/** Read + clear the App-Intent route. Returns a valid Href or null. */
export function takePendingRoute(): Href | null {
  const st = getStorage();
  if (!st) return null;
  try {
    const raw = st.get(ROUTE_KEY);
    const valid = validatePendingRoute(raw);
    if (raw !== null && raw !== undefined) {
      st.remove(ROUTE_KEY);
    }
    if (valid) {
      return valid as unknown as Href;
    }
    return null;
  } catch {
    storageUnavailable = true;
    return null;
  }
}
