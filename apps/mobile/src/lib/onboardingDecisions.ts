/**
 * lib/onboardingDecisions.ts — onboarding decisions that follow the person, not
 * the device.
 *
 * The dismissal flags lived only in AsyncStorage
 * (`postwave_onboarding_checklist_dismissed` and friends). So a user dismissed
 * the setup checklist on their phone, opened the desktop app, and it was back;
 * dismissed it there, came back to the phone after a reinstall, and it was back
 * again. The product asked the same question on every device until it was
 * answered on every device — and the answer was never a device's to hold.
 *
 * `PUT/GET /api/v1/onboarding/steps` is the durable, per-(tenant, user, step)
 * home for those decisions. This module is the seam: the server is
 * authoritative, AsyncStorage becomes a cache so the checklist does not flash
 * back on a cold start or offline.
 *
 * WHAT STAYS LOCAL AND WHY. Nothing about done-ness. Whether a step is complete
 * remains a server-side query over real data (`GET /api/v1/onboarding-progress`)
 * because a stored copy drifts the moment someone deletes the thing that
 * completed it. Only the human decision is synced here.
 *
 * DELIBERATELY FAIL-SOFT. A decision is a preference, not a mutation someone is
 * waiting on. If the network is down, the local write still lands and the user
 * sees what they expect; the server learns on the next successful read/write.
 * The alternative — refusing to dismiss a checklist because a request failed —
 * would be a worse product for a strictly cosmetic guarantee.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

// `@/api/sdkClient`, not the `@/api/client` barrel. That barrel eagerly
// re-exports thirteen resource modules — the SSE transport, the AI streaming
// client, the whole ops surface — so importing it for one symbol puts all of it
// on the critical path to first paint. src/lib/startupImportBudget.test.ts
// guards exactly this, and push.ts made the same move for the same reason.
import {
  CHECKLIST_DECISION_STEP_KEY,
  ONBOARDING_DECISION_RESTORE_STATE,
  TOUR_DECISION_STEP_KEY,
  decisionHidesSurface,
} from "@postwave/onboarding-schema";

import { getClient } from "@/api/sdkClient";

/**
 * The step key the checklist dismissal is recorded under.
 *
 * Re-exported, not redeclared: this literal used to be spelled here AND in
 * apps/desktop/src/lib/onboarding-state-controller.ts, so a rename in one
 * place would have quietly split one shared decision into two unshared ones —
 * each device writing a key the others never read, which is the exact failure
 * this module was written to end.
 */
export const CHECKLIST_STEP_KEY = CHECKLIST_DECISION_STEP_KEY;

/** Legacy per-device key, still written so an offline launch behaves. */
export const CHECKLIST_DISMISSED_KEY =
  "postwave_onboarding_checklist_dismissed";

/**
 * Has this person dismissed the checklist, anywhere?
 *
 * Reads the server first and mirrors the answer locally. On any failure —
 * offline, expired session, server error — falls back to the local cache
 * rather than showing a checklist the user already dismissed on another device,
 * which is the exact annoyance this module exists to remove.
 */
export async function isChecklistDismissed(): Promise<boolean> {
  try {
    const { client } = getClient();
    const decisions = await client.onboarding.listStepDecisions();
    const decided = decisions.steps?.[CHECKLIST_STEP_KEY];
    // Every HIDING state, from the shared contract — not just the two this
    // screen can produce. The vocabulary also carries `inapplicable` ("not
    // us") and `delegated` ("someone else has it"); honouring only
    // `dismissed`/`skipped` meant a step the person had already called
    // impossible came back on this device forever.
    const dismissed = decisionHidesSurface(decided?.state);
    // Mirror so the next cold start does not flash the checklist while the
    // request is in flight.
    // "1", not "true": that is what OnboardingChecklist has always written and
    // what any reader this module does not own still expects. A new spelling
    // would silently un-dismiss the checklist for everyone mid-upgrade.
    if (dismissed) {
      await AsyncStorage.setItem(CHECKLIST_DISMISSED_KEY, "1").catch(
        () => undefined,
      );
    } else {
      await AsyncStorage.removeItem(CHECKLIST_DISMISSED_KEY).catch(
        () => undefined,
      );
    }
    return dismissed;
  } catch {
    const cached = await AsyncStorage.getItem(CHECKLIST_DISMISSED_KEY).catch(
      () => null,
    );
    return cached === "true" || cached === "1";
  }
}

/**
 * Record the dismissal for this person on every device.
 *
 * Local first so the UI is immediate and correct offline; the server call is
 * best-effort for the reason in the module header.
 */
export async function dismissChecklist(): Promise<void> {
  await AsyncStorage.setItem(CHECKLIST_DISMISSED_KEY, "1").catch(
    () => undefined,
  );
  try {
    const { client } = getClient();
    await client.onboarding.setStepDecision(CHECKLIST_STEP_KEY, "dismissed");
  } catch {
    // Swallowed by design — see the module header. The local write already
    // landed, so the user gets what they asked for; the server learns on the
    // next successful call.
  }
}

/**
 * Undo the dismissal — Settings' "Show setup checklist" control.
 *
 * Clears BOTH sides. Clearing only the local key was the old behaviour and
 * would now be worse than before: the server would still say dismissed, so the
 * next read would put the checklist straight back and the control would look
 * broken.
 */
export async function restoreChecklist(): Promise<void> {
  await AsyncStorage.removeItem(CHECKLIST_DISMISSED_KEY).catch(() => undefined);
  try {
    const { client } = getClient();
    // There is no "undecided" state in the vocabulary, and inventing one would
    // mean a fourth meaning for an absent row. `snoozed` is the honest fit:
    // the person wants to see it again now. Sourced from the shared contract
    // so web's "Show checklist" control cannot drift onto a different state.
    await client.onboarding.setStepDecision(
      CHECKLIST_STEP_KEY,
      ONBOARDING_DECISION_RESTORE_STATE,
    );
  } catch {
    // Same fail-soft posture as dismissChecklist.
  }
}

// ─────────────────────────── THE DASHBOARD TOUR ───────────────────────────
//
// The tour was the last per-device answer left. Every client kept its own
// `postwave_tour_dashboard_dismissed_at`, so someone skipped the tour on their
// laptop, opened the phone, and it ran again — the product asking a question
// that had already been answered, once per device.
//
// It rides the SAME mechanism as the checklist above, deliberately: one
// endpoint, one vocabulary, one fail-soft posture. A second mechanism for the
// second surface is how "shared decision" quietly becomes two unshared ones.

/**
 * The step key the tour dismissal is recorded under.
 *
 * Re-exported from the shared contract for the reason CHECKLIST_STEP_KEY is:
 * three clients spelling one literal is three chances to rename it into a key
 * nobody else reads.
 */
export const TOUR_STEP_KEY = TOUR_DECISION_STEP_KEY;

/**
 * Legacy per-device key. Still read AND written — see `isTourDismissed`.
 *
 * TourProvider's TOUR_STORAGE_KEYS.dismissedAt is this constant, not a second
 * copy of the literal.
 */
export const TOUR_DISMISSED_AT_KEY = "postwave_tour_dashboard_dismissed_at";

/**
 * Has this person put the dashboard tour away, on ANY of their devices?
 *
 * Server first, local cache as the fallback — the checklist's shape. The one
 * thing this adds is RECONCILIATION, and it is not decoration:
 *
 *   server says hidden          → hidden, and mirror it locally
 *   server has NO decision, but this device has one
 *                               → hidden, and push the device's decision UP
 *   server has a non-hiding decision (`snoozed` — "show me again")
 *                               → shown, and drop the stale local copy
 *
 * The middle case is the one that matters twice over. It is a person who
 * dismissed the tour BEFORE this shipped — their answer predates the server
 * ever hearing about it, and deleting the local key would have made the tour
 * come back for every existing user on upgrade. It is also a dismissal taken
 * OFFLINE, whose `PUT` never landed. Both look identical from here, and both
 * deserve the same answer: honour it, then teach the server, so the next
 * device asks nobody.
 *
 * Clearing the local key on "no server decision" — which is what a naive
 * server-wins mirror does — would have thrown away exactly those two.
 */
export async function isTourDismissed(): Promise<boolean> {
  // Started before the request so the offline path does not pay two serial
  // waits; awaited only where the answer is actually needed.
  const cachedPromise = AsyncStorage.getItem(TOUR_DISMISSED_AT_KEY).catch(
    () => null,
  );
  try {
    const { client } = getClient();
    const decisions = await client.onboarding.listStepDecisions();
    const decided = decisions.steps?.[TOUR_STEP_KEY];
    const cached = await cachedPromise;

    // Every HIDING state from the shared contract, not just the one this
    // surface can produce: `inapplicable` / `delegated` can arrive from
    // another client, and re-running a tour someone already called
    // inapplicable is the same defect wearing a different state.
    if (decisionHidesSurface(decided?.state)) {
      if (cached == null) {
        // Mirror so a cold start (or an offline one) does not auto-launch a
        // tour this person already put away.
        await AsyncStorage.setItem(
          TOUR_DISMISSED_AT_KEY,
          new Date().toISOString(),
        ).catch(() => undefined);
      }
      // An existing timestamp is left alone: it records WHEN they decided,
      // and overwriting it with "now" on every read would erase that.
      return true;
    }

    if (decided == null && cached != null) {
      // Legacy or offline dismissal — see the doc comment. Fire-and-forget:
      // the answer is already known, and the person is waiting on a render,
      // not on this write. It is idempotent, so a retry next launch is free.
      void Promise.resolve(
        client.onboarding.setStepDecision(TOUR_STEP_KEY, "dismissed"),
      ).catch(() => undefined);
      return true;
    }

    if (cached != null) {
      // The server carries a real, non-hiding decision — someone asked to see
      // the tour again. Drop the stale local copy or the next cold start
      // would re-hide it before the server could be asked.
      await AsyncStorage.removeItem(TOUR_DISMISSED_AT_KEY).catch(
        () => undefined,
      );
    }
    return false;
  } catch {
    // Offline / expired session / older API. The local cache is the best
    // answer available, and showing a tour someone already dismissed is worse
    // than not showing one they have not seen yet.
    return (await cachedPromise) != null;
  }
}

/**
 * Record that this person put the tour away — on every device.
 *
 * Local first so the overlay closes instantly and the decision survives a
 * cold start with no network; the server call is best-effort for the reason in
 * the module header. If it fails, `isTourDismissed` backfills it on the next
 * successful read, so an offline dismissal is deferred, never lost.
 */
export async function dismissTour(): Promise<void> {
  await AsyncStorage.setItem(
    TOUR_DISMISSED_AT_KEY,
    new Date().toISOString(),
  ).catch(() => undefined);
  try {
    const { client } = getClient();
    await client.onboarding.setStepDecision(TOUR_STEP_KEY, "dismissed");
  } catch {
    // Swallowed by design — see the module header and the backfill above.
  }
}
