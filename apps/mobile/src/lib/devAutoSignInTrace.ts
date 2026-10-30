/**
 * lib/devAutoSignInTrace.ts — a readable record of what auto sign-in actually
 * did, for builds that have it enabled.
 *
 * Auto sign-in happens before anyone can watch it: it fires on first paint of
 * a Release build on a physical device, where there is no Metro console, no
 * debugger and no `console.log` to read. When it silently does nothing, the
 * only evidence available is a screen someone has to be holding.
 *
 * So the attempt writes its own trail to AsyncStorage, which can be pulled off
 * the device with `xcrun devicectl device copy from`. It is a NO-OP unless the
 * build carries auto sign-in credentials, so it cannot run in a shipped app.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { DEV_AUTO_SIGN_IN } from "./devAutoSignIn";

/** Where the trail lands inside RCTAsyncLocalStorage_V1. */
export const DEV_AUTO_SIGN_IN_TRACE_KEY = "postwave.dev.autoSignInTrace";

/** Keep the tail only — this is a breadcrumb trail, not a log file. */
const MAX_ENTRIES = 25;

/**
 * Append one step. Never throws and never blocks the caller: a diagnostic that
 * can break the sign-in screen is worse than no diagnostic.
 */
/**
 * The trail so far, held in memory.
 *
 * Deliberately NOT re-read from storage per call. A read-modify-write loses
 * entries whenever two steps land in the same tick — which is precisely when
 * this is most interesting, because "effect ran" and "submitted" and "it
 * failed" all happen within a few frames of each other. That race cost a whole
 * diagnostic cycle: only the last writer's snapshot survived, so the run
 * looked like it had never submitted at all.
 */
const entries: Record<string, unknown>[] = [];

/** Serialises the writes so the newest snapshot is always the last one out. */
let writeQueue: Promise<void> = Promise.resolve();

export function traceAutoSignIn(
  step: string,
  detail: Record<string, unknown> = {},
): void {
  if (!DEV_AUTO_SIGN_IN) return;
  entries.push({ step, at: new Date().toISOString(), ...detail });
  const snapshot = JSON.stringify(entries.slice(-MAX_ENTRIES));
  writeQueue = writeQueue
    .then(() => AsyncStorage.setItem(DEV_AUTO_SIGN_IN_TRACE_KEY, snapshot))
    .catch(() => {
      // Storage unavailable is itself uninteresting; losing the breadcrumb is
      // strictly better than failing the screen it is describing.
    });
}
