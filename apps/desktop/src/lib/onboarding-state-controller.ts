import {
  CHECKLIST_DECISION_STEP_KEY,
  ONBOARDING_DECISION_RESTORE_STATE,
  TOUR_DECISION_STEP_KEY,
  isOnboardingDecisionState,
  type OnboardingDecisionState,
} from "@postwave/onboarding-schema";

import type { OnboardingSurfaceId } from "./onboarding-manifest";
import {
  isTerminalOutcome,
  transitionOnboardingState,
  type OnboardingAction,
  type OnboardingAnalyticsIntent,
  type OnboardingOutcome,
  type OnboardingState,
} from "./onboarding-state-machine";
import {
  loadOnboardingState,
  mergeOnboardingStates,
  onboardingScopeToken,
  parseOnboardingState,
  serializeOnboardingState,
  type OnboardingIdentity,
  type OnboardingStorage,
} from "./onboarding-state-storage";

export type OnboardingAnalyticsSink = (
  intent: OnboardingAnalyticsIntent,
) => void;

/**
 * The durable, cross-device home for onboarding DECISIONS
 * (`GET/PUT /api/v1/onboarding/steps`).
 *
 * Until this port existed, every decision a person made — dismissed, skipped,
 * snoozed — lived only in this device's localStorage. So the same user
 * dismissed the setup checklist on desktop, opened the web app, and it was
 * back; dismissed it there, picked up their phone, and it was back again. The
 * product asked one question on every device until it was answered on every
 * device, and the answer was never a device's to hold.
 *
 * Optional: a controller without a port behaves exactly as before, which keeps
 * the state machine testable without a network and keeps a signed-out or
 * offline window working.
 *
 * DONE-NESS IS NOT SYNCED. Whether a step is complete stays a server-side query
 * over real data, because a stored copy drifts the moment someone deletes the
 * thing that completed it. Only the human decision travels.
 */
export interface OnboardingDecisionPort {
  /** step key → decision state, as recorded for this person. */
  list(): Promise<Record<string, string>>;
  set(stepKey: string, state: string): Promise<void>;
}

interface RemoteDecisionConfig {
  /** The step key this surface's decision is recorded under. */
  stepKey: string;
  /**
   * Whether FINISHING the surface is itself a decision worth recording.
   *
   * True for the tour and false for the checklist, and the asymmetry is not an
   * oversight. Watching the tour through to the end is the strongest possible
   * "do not run this again", and nothing on the server can derive it — there
   * are no rows that say "this person has seen the dashboard tour", so if the
   * decision row does not carry it, the tour re-runs on the next device and
   * asks the person to repeat something they completed.
   *
   * The checklist is the opposite: its completion is DERIVED from real setup
   * rows (`GET /api/v1/onboarding-progress`), so recording a completed
   * checklist as `dismissed` would outlive the thing that completed it — the
   * person deletes their last verified domain, the checklist should come back,
   * and a decision row would suppress it forever.
   */
  publishCompletion?: boolean;
}

/**
 * Surface id → how its decision travels. Only surfaces whose dismissal is a
 * PERSON's decision appear here: the first-run wizard is deliberately absent,
 * because "show me this app's setup wizard once" is reasonably a per-install
 * fact.
 */
const REMOTE_DECISIONS: Readonly<Record<string, RemoteDecisionConfig>> = {
  // The literals used to live here. They now come from
  // @postwave/onboarding-schema because desktop and mobile each carried a
  // private copy of the same string, which is how one shared decision quietly
  // becomes two unshared ones.
  checklist: { stepKey: CHECKLIST_DECISION_STEP_KEY },
  // The tour was the last per-device answer left. All three clients kept their
  // own copy of the dashboard-tour dismissal timestamp in local storage (the
  // literal key belongs to the migration adapter in onboarding-state-storage.ts
  // and is deliberately not repeated here), so a person dismissed the tour on
  // their laptop, opened the phone, and it ran again.
  tour: { stepKey: TOUR_DECISION_STEP_KEY, publishCompletion: true },
};

/**
 * Outcomes worth recording remotely, and the action that reproduces each one
 * locally. Anything else is progress, not a decision — "in-progress" says where
 * someone got to on this machine, which is not a fact about the person.
 */
const REMOTE_DECISION_OUTCOMES: Readonly<
  Record<
    string,
    {
      remote: OnboardingDecisionState;
      action: "dismiss-surface" | "skip-surface";
    }
  >
> = {
  dismissed: { remote: "dismissed", action: "dismiss-surface" },
  skipped: { remote: "skipped", action: "skip-surface" },
};

/**
 * Remote decision state → the local outcome it means.
 *
 * All four HIDING states are mapped, not just the two this device can produce.
 * Another client (or a future settings screen) can legitimately record
 * `inapplicable` — "we don't do this" — and a desktop that understood only
 * `dismissed` would go on showing a step the person already told the product
 * was impossible for them. `snoozed` is absent on purpose: it means "show me
 * again", which is the absence of a hiding decision, and it is what a client
 * writes to UNDO one.
 */
const REMOTE_TO_LOCAL: Readonly<Record<string, "dismissed" | "skipped">> = {
  dismissed: "dismissed",
  skipped: "skipped",
  // "not us" is a skip; "someone else is doing this" is a dismissal for me.
  inapplicable: "skipped",
  delegated: "dismissed",
};

/**
 * The surface an action targets, or undefined for the whole-state actions
 * (`reset-all`, `sync-goals`) that name no single surface.
 */
function surfaceOfAction(action: OnboardingAction): string | undefined {
  return (action as { surface?: string }).surface;
}

/**
 * The decision a local outcome is worth recording as, or undefined when the
 * outcome says nothing about the person ("in-progress" is where someone got to
 * on this machine, which is not a fact about them).
 */
function remoteDecisionFor(
  config: RemoteDecisionConfig,
  outcome: OnboardingOutcome | undefined,
): OnboardingDecisionState | undefined {
  if (!outcome) return undefined;
  const mapped = REMOTE_DECISION_OUTCOMES[outcome];
  if (mapped) return mapped.remote;
  // There is no "completed" on the wire — the vocabulary is closed at five
  // states — and for a tour there does not need to be: having watched it is
  // "stop showing me this", which is what `dismissed` means to every reader.
  if (outcome === "completed" && config.publishCompletion) return "dismissed";
  return undefined;
}

export interface OnboardingStateControllerOptions {
  storage: OnboardingStorage;
  identity: OnboardingIdentity;
  analytics?: OnboardingAnalyticsSink;
  now?: () => number;
  /** Optional cross-device decision store; omit for local-only behaviour. */
  decisions?: OnboardingDecisionPort;
}

export class OnboardingStateController {
  readonly storageKey: string;
  readonly scopeToken: string;

  private readonly storage: OnboardingStorage;
  private readonly analytics: OnboardingAnalyticsSink;
  private readonly now: () => number;
  private readonly subscribers = new Set<() => void>();
  private state: OnboardingState;
  private initialPersistence: readonly string[] | null;
  private readonly decisions: OnboardingDecisionPort | null;
  private decisionsSettled: boolean;

  constructor(options: OnboardingStateControllerOptions) {
    this.storage = options.storage;
    this.analytics = options.analytics ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.decisions = options.decisions ?? null;
    // Nothing to wait for when no port is configured: a signed-out or
    // local-only window is already holding the only answer that exists.
    this.decisionsSettled = this.decisions == null;
    this.scopeToken = onboardingScopeToken(options.identity);
    const loaded = loadOnboardingState(
      options.storage,
      options.identity,
      this.now(),
    );
    this.storageKey = loaded.storageKey;
    this.state = loaded.state;
    this.initialPersistence =
      loaded.migrated || loaded.corrupt ? loaded.cleanupKeys : null;
  }

  readonly getSnapshot = (): OnboardingState => this.state;

  /**
   * Has this person's cross-device decision been consulted yet?
   *
   * False means "we do not know what they answered", which is NOT the same as
   * "they answered no". A surface that INTERRUPTS — the tour opens a modal over
   * the dashboard — must stay silent while this is false, because the
   * alternative is running the tour for a moment and then yanking it away when
   * the dismissal arrives, which is a worse product than the bug it fixes.
   *
   * It goes true when the decisions arrive AND when the fetch fails: an offline
   * window falls back to the local cache as the best answer available, rather
   * than suppressing onboarding forever behind a request that will never land.
   */
  readonly getDecisionsSettled = (): boolean => this.decisionsSettled;

  /**
   * Record that the decision fetch finished, however it finished.
   *
   * Called by the hydration path's failure branch; the success branch settles
   * through `syncFromRemote`.
   */
  markDecisionsSettled(): void {
    if (this.decisionsSettled) return;
    this.decisionsSettled = true;
    this.emit();
  }

  readonly subscribe = (subscriber: () => void): (() => void) => {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  };

  /** Commit constructor-time migration after React has mounted the owner. */
  activate(): void {
    if (!this.initialPersistence) return;
    const cleanupKeys = this.initialPersistence;
    this.initialPersistence = null;
    if (this.persist()) this.cleanup(cleanupKeys);
  }

  dispatch(action: OnboardingAction): OnboardingState {
    this.activate();
    this.reconcileStoredState();
    // Captured AFTER reconcile, so it reflects what a sibling window may have
    // already written, and BEFORE the transition, because `publishDecision`
    // cannot tell a restore ("was dismissed, now is not") from a surface
    // nobody ever decided about without knowing where it came from.
    const previousOutcome = surfaceOfAction(action)
      ? this.state.surfaces[surfaceOfAction(action) as OnboardingSurfaceId]
          ?.outcome
      : undefined;
    const transition = transitionOnboardingState(this.state, action);
    if (!transition.changed) return this.state;
    this.state = transition.state;
    this.persist();
    this.publishDecision(action, previousOutcome);
    this.emit();
    for (const intent of transition.intents) {
      try {
        this.analytics(intent);
      } catch {
        // Analytics is observational and must never roll back product state.
      }
    }
    return this.state;
  }

  /** Apply a sibling-window storage event without producing analytics. */
  syncFromStorage(raw: string | null): boolean {
    if (!raw) return false;
    const incoming = parseOnboardingState(raw, this.scopeToken, this.now());
    if (!incoming) return false;
    const merged = mergeOnboardingStates(this.state, incoming);
    if (serializeOnboardingState(merged) === serializeOnboardingState(this.state)) {
      return false;
    }
    this.state = merged;
    this.emit();
    return true;
  }

  /**
   * Apply the decisions this person made on their other devices.
   *
   * Merged exactly as a sibling window's storage event is (`syncFromStorage`):
   * a decision recorded elsewhere is not different in kind from one recorded in
   * another tab, and the state machine already knows how to reconcile those.
   * Returns whether anything changed, so a caller can skip a re-render.
   *
   * BOTH DIRECTIONS ARRIVE. An undo is a decision too. Applying only the
   * hiding states meant a restore made on the phone reached every device that
   * had never seen the dismissal and no device that had — the laptop with
   * `dismissed` in its own storage read `snoozed`, found no hiding outcome to
   * apply, and stayed hidden forever.
   */
  syncFromRemote(decisions: Readonly<Record<string, string>>): boolean {
    let changed = false;
    for (const [surfaceKey, config] of Object.entries(REMOTE_DECISIONS)) {
      const surface = surfaceKey as OnboardingSurfaceId;
      const remoteState = decisions[config.stepKey];
      // An ABSENT key means "never decided", which is emphatically not
      // "restore me": a device that dismissed locally before this port
      // existed must keep its dismissal rather than have it silently undone
      // by a server that has simply never heard of it.
      if (!remoteState) continue;
      const outcome = REMOTE_TO_LOCAL[remoteState];
      if (!outcome) {
        // A recognized NON-hiding state — `snoozed`, the restore state every
        // client writes to undo. Only meaningful if this device is currently
        // hiding the surface; otherwise there is nothing to undo.
        if (!isOnboardingDecisionState(remoteState)) continue;
        const current = this.state.surfaces[surface]?.outcome;
        if (!current || !REMOTE_DECISION_OUTCOMES[current]) continue;
        const restored = transitionOnboardingState(this.state, {
          type: "reset-surface",
          surface,
          now: this.now(),
        });
        if (!restored.changed) continue;
        this.state = restored.state;
        changed = true;
        continue;
      }
      const current = this.state.surfaces[surface]?.outcome;
      if (current === outcome) continue;
      // For a surface whose COMPLETION is published (the tour), every terminal
      // outcome means the same thing to the person — finished, skipped and
      // dismissed all say "do not run this again". Rewriting one as another on
      // arrival would churn storage and quietly turn "you finished the tour"
      // into "you threw the tour away". The checklist is excluded on purpose:
      // its completion is derived from setup rows that can be undone, so a
      // remote dismissal still has something to say there.
      if (config.publishCompletion && current && isTerminalOutcome(current)) {
        continue;
      }
      // A TOUR SOMEONE IS WALKING THROUGH RIGHT NOW IS NOT DISMISSED.
      //
      // "in-progress" is not terminal, so the guard above lets a remote
      // `dismissed` through — and the person who just clicked Start watches the
      // tour open, paint, and vanish under them. That is the failure this whole
      // change is meant to avoid, arriving from the far side: the opening gate
      // exempts a hand start, and nothing was protecting it afterwards.
      //
      // The remote answer is not wrong, it is just OLDER than what the person is
      // doing at this moment. It is not dropped either — they are inside the
      // tour, and when they leave it they publish a terminal outcome of their
      // own, which is a better-sourced answer than the one being ignored here.
      if (current === "in-progress") {
        continue;
      }
      const transition = transitionOnboardingState(this.state, {
        type: REMOTE_DECISION_OUTCOMES[outcome].action,
        surface,
        now: this.now(),
      });
      if (!transition.changed) continue;
      this.state = transition.state;
      changed = true;
    }
    if (changed) this.persist();
    this.backfillDecisions(decisions);
    const settled = !this.decisionsSettled;
    this.decisionsSettled = true;
    if (changed || settled) this.emit();
    return changed;
  }

  /**
   * Send up the decisions this device is holding that the person's account has
   * never heard of.
   *
   * Every device that dismissed a surface BEFORE this port existed holds a real
   * decision in local storage and nowhere else. The absent-row rule above
   * correctly refuses to undo it here — but on its own that leaves the person's
   * other devices asking a question this one already answered, forever, because
   * nothing would ever write the row. This is the one direction that closes it.
   *
   * Strictly a backfill: only when the server has NO row for the step, so it can
   * never overwrite a decision made somewhere else — including a restore, which
   * arrives as a present `snoozed` row and is applied above before this runs.
   */
  private backfillDecisions(
    decisions: Readonly<Record<string, string>>,
  ): void {
    const port = this.decisions;
    if (!port) return;
    for (const [surfaceKey, config] of Object.entries(REMOTE_DECISIONS)) {
      if (decisions[config.stepKey]) continue;
      const remote = remoteDecisionFor(
        config,
        this.state.surfaces[surfaceKey as OnboardingSurfaceId]?.outcome,
      );
      if (!remote) continue;
      void port.set(config.stepKey, remote).catch(() => undefined);
    }
  }

  /**
   * Record a decision for this person, not just this device.
   *
   * Best-effort and un-awaited: a preference is not a mutation anyone is
   * waiting on, and refusing to dismiss a checklist because a request failed
   * would be a worse product for a strictly cosmetic guarantee. The local write
   * has already landed, so the user gets what they asked for and the server
   * learns on the next successful call.
   *
   * BOTH DIRECTIONS TRAVEL. Publishing only the dismissal was worse than
   * publishing nothing: desktop's "Restore" button reset the surface locally
   * and told the server nothing, so the row still said `dismissed` and the very
   * next mount hydrated it straight back — the card the person had just asked
   * to see disappeared again, and the button looked broken. Mobile's "Show
   * setup checklist" and web's "Show checklist" already wrote the restore
   * state; desktop was the one surface whose undo stopped at the device.
   */
  private publishDecision(
    action: OnboardingAction,
    previousOutcome: string | undefined,
  ): void {
    if (!this.decisions) return;
    const surfaceKey = surfaceOfAction(action);
    if (!surfaceKey) return;
    const config = REMOTE_DECISIONS[surfaceKey];
    if (!config) return;
    const decision = remoteDecisionFor(
      config,
      this.state.surfaces[surfaceKey as OnboardingSurfaceId]?.outcome,
    );
    if (decision) {
      void this.decisions
        .set(config.stepKey, decision)
        .catch(() => undefined);
      return;
    }
    // No hiding decision now. That is only newsworthy if there WAS one — a
    // reset of a surface nobody ever put away is not a choice, and writing
    // `snoozed` for it would answer a question the person was never asked and
    // would overwrite a genuine dismissal made on another device.
    //
    // Replaying the tour goes down this branch, and it has to: the row still
    // says `dismissed`, and the next hydration — a route change mid-tour is
    // enough to trigger one — would read that row and close the tour the person
    // is watching. Publishing the undo is what stops this device's own replay
    // from being cancelled by its own history.
    const undone = remoteDecisionFor(
      config,
      previousOutcome as OnboardingOutcome | undefined,
    );
    if (!undone) return;
    void this.decisions
      .set(config.stepKey, ONBOARDING_DECISION_RESTORE_STATE)
      .catch(() => undefined);
  }

  private reconcileStoredState(): void {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const stored = parseOnboardingState(raw, this.scopeToken, this.now());
      if (stored) this.state = mergeOnboardingStates(this.state, stored);
    } catch {
      // In-memory state remains authoritative when local storage is denied.
    }
  }

  private persist(): boolean {
    try {
      this.storage.setItem(this.storageKey, serializeOnboardingState(this.state));
      return true;
    } catch {
      return false;
    }
  }

  private cleanup(keys: readonly string[]): void {
    for (const key of keys) {
      if (key === this.storageKey && !this.state.updatedAt) continue;
      try {
        this.storage.removeItem(key);
      } catch {
        // A failed cleanup is harmless; validation prevents stale payload use.
      }
    }
  }

  private emit(): void {
    for (const subscriber of this.subscribers) subscriber();
  }
}
