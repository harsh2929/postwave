import { describe, expect, it, vi } from "vitest";

import {
  CHECKLIST_STEPS,
  ONBOARDING_SURFACE_IDS,
  ONBOARDING_SURFACES,
  TOUR_STEPS,
  WIZARD_STEPS,
} from "../../lib/onboarding-manifest";
import { OnboardingStateController } from "../../lib/onboarding-state-controller";
import {
  createOnboardingState,
  shouldAutoOpenOnboardingSurface,
  transitionOnboardingState,
  type OnboardingAnalyticsIntent,
} from "../../lib/onboarding-state-machine";
import {
  onboardingScopeToken,
  onboardingStorageKey,
  mergeOnboardingStates,
  parseOnboardingState,
  type OnboardingIdentity,
  type OnboardingStorage,
} from "../../lib/onboarding-state-storage";

class MemoryStorage implements OnboardingStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const identity: OnboardingIdentity = {
  workspaceId: "workspace-sensitive-name",
  userId: "operator@example.test",
  role: "admin",
};

function controller(options: {
  storage?: MemoryStorage;
  analytics?: (intent: OnboardingAnalyticsIntent) => void;
} = {}): OnboardingStateController {
  const instance = new OnboardingStateController({
    identity,
    storage: options.storage ?? new MemoryStorage(),
    analytics: options.analytics,
    now: () => 10_000,
  });
  instance.activate();
  return instance;
}

describe("DUX-034 onboarding state machine", () => {
  it("defines exactly four ordered, role-applicable presentation systems", () => {
    expect(ONBOARDING_SURFACE_IDS).toEqual([
      "wizard",
      "checklist",
      "tour",
      "catalog",
    ]);
    expect(WIZARD_STEPS.map((step) => step.id)).toEqual([
      "domain",
      "subscribers",
      "campaign",
      "done",
    ]);
    expect(CHECKLIST_STEPS).toHaveLength(5);
    expect(TOUR_STEPS).toHaveLength(10);
    expect(
      ONBOARDING_SURFACE_IDS.every(
        (surface) => ONBOARDING_SURFACES[surface].steps.length > 0,
      ),
    ).toBe(true);
    expect(ONBOARDING_SURFACES.wizard.roles).not.toContain("viewer");
    expect(ONBOARDING_SURFACES.tour.roles).toContain("viewer");
  });

  it("keeps completion, skip, and dismissal distinct and resumes by step id", () => {
    const storage = new MemoryStorage();
    const first = controller({ storage });
    first.dispatch({
      type: "open",
      surface: "wizard",
      trigger: "auto",
      stepId: "domain",
      now: 1_000,
    });
    first.dispatch({
      type: "skip-step",
      surface: "wizard",
      stepId: "domain",
      nextStepId: "subscribers",
      now: 2_000,
    });

    const reloaded = controller({ storage });
    expect(reloaded.getSnapshot().surfaces.wizard).toMatchObject({
      outcome: "in-progress",
      currentStepId: "subscribers",
      skippedStepIds: ["domain"],
    });

    reloaded.dispatch({
      type: "dismiss-surface",
      surface: "wizard",
      stepId: "subscribers",
      now: 3_000,
    });
    expect(reloaded.getSnapshot().surfaces.wizard.outcome).toBe("dismissed");
    reloaded.dispatch({ type: "reset-surface", surface: "wizard", now: 4_000 });
    reloaded.dispatch({
      type: "open",
      surface: "wizard",
      trigger: "manual",
      stepId: "domain",
      now: 5_000,
    });
    reloaded.dispatch({
      type: "skip-surface",
      surface: "wizard",
      stepId: "domain",
      now: 6_000,
    });
    expect(reloaded.getSnapshot().surfaces.wizard.outcome).toBe("skipped");
    reloaded.dispatch({ type: "reset-surface", surface: "wizard", now: 7_000 });
    reloaded.dispatch({
      type: "complete-surface",
      surface: "wizard",
      now: 8_000,
    });
    expect(reloaded.getSnapshot().surfaces.wizard.outcome).toBe("completed");
  });

  it("emits typed analytics once per committed transition, never hydration", () => {
    const storage = new MemoryStorage();
    const intents: OnboardingAnalyticsIntent[] = [];
    const first = controller({
      storage,
      analytics: (intent) => intents.push(intent),
    });
    const open = {
      type: "open" as const,
      surface: "tour" as const,
      trigger: "manual" as const,
      stepId: "welcome" as const,
      stepCount: 10,
      stepIndex: 0,
      now: 1_000,
    };
    first.dispatch(open);
    first.dispatch(open);
    expect(intents.map((intent) => intent.name)).toEqual([
      "onboarding.tour_started",
      "onboarding.tour_step_viewed",
    ]);

    const hydratedIntents = vi.fn();
    const reloaded = controller({ storage, analytics: hydratedIntents });
    expect(reloaded.getSnapshot().surfaces.tour.currentStepId).toBe("welcome");
    expect(hydratedIntents).not.toHaveBeenCalled();
    reloaded.syncFromStorage(storage.getItem(reloaded.storageKey));
    expect(hydratedIntents).not.toHaveBeenCalled();
  });

  it("opens the full workspace walkthrough instead of silently rejecting it", () => {
    const state = controller();
    state.dispatch({
      type: "open",
      surface: "tour",
      trigger: "manual",
      stepId: "workspace-welcome",
      stepCount: 56,
      stepIndex: 0,
      now: 1_000,
    });

    expect(state.getSnapshot().surfaces.tour).toMatchObject({
      outcome: "in-progress",
      currentStepId: "workspace-welcome",
    });
  });

  it("routes the manual catalog through the same typed analytics boundary", () => {
    const intents: OnboardingAnalyticsIntent[] = [];
    const state = controller({ analytics: (intent) => intents.push(intent) });
    state.dispatch({
      type: "open",
      surface: "catalog",
      trigger: "manual",
      stepId: "lists",
      stepCount: 5,
      now: 1_000,
    });
    state.dispatch({
      type: "complete-surface",
      surface: "catalog",
      now: 2_000,
    });
    expect(intents).toMatchObject([
      {
        name: "onboarding.tour_started",
        props: { tourId: "catalog", stepCount: 5, trigger: "manual" },
      },
      {
        name: "onboarding.tour_completed",
        props: { tourId: "catalog", totalMs: 1_000 },
      },
    ]);
  });

  it("migrates scoped/unscoped legacy state once and removes old keys", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "postwave_onboarding_dismissed_at:" + identity.workspaceId,
      "2026-07-01T00:00:00.000Z",
    );
    storage.setItem("postwave_tour_dashboard_step", "4");
    storage.setItem("postwave_onboarding_skipped_connect-events", "1");
    storage.setItem(
      "postwave_onboarding_cache_v2:" + identity.workspaceId,
      JSON.stringify({
        at: 9_000,
        flags: {
          domain: true,
          subscribers: true,
          campaign: false,
          events: false,
          deliverability: false,
        },
      }),
    );

    const migrated = controller({ storage }).getSnapshot();
    expect(migrated.surfaces.wizard.outcome).toBe("dismissed");
    expect(migrated.surfaces.tour).toMatchObject({
      outcome: "in-progress",
      currentStepId: TOUR_STEPS[4]!.id,
    });
    expect(migrated.surfaces.checklist.skippedStepIds).toContain(
      "connect-events",
    );
    expect(migrated.goals.completedStepIds).toEqual([
      "verify-domain",
      "import-subscribers",
    ]);
    expect(
      storage.getItem(
        "postwave_onboarding_dismissed_at:" + identity.workspaceId,
      ),
    ).toBeNull();
    expect(storage.getItem("postwave_tour_dashboard_step")).toBeNull();
    expect(storage.getItem(onboardingStorageKey(identity))).toBeTruthy();
  });

  it("migrates a bounded v2 envelope and drops unknown task payloads", () => {
    const storage = new MemoryStorage();
    const scope = onboardingScopeToken(identity);
    storage.setItem(
      "postwave.desktop.onboarding.v2:" + scope,
      JSON.stringify({
        version: 2,
        scopeToken: scope,
        surfaces: {
          wizard: {
            status: "in-progress",
            step: "campaign",
            completedSteps: ["domain"],
            taskPayload: { apiKey: "must-not-survive" },
          },
        },
      }),
    );
    const migrated = controller({ storage });
    expect(migrated.getSnapshot().surfaces.wizard.currentStepId).toBe(
      "campaign",
    );
    expect(storage.getItem(migrated.storageKey)).not.toContain(
      "must-not-survive",
    );
  });

  it("expires and removes stale legacy progress instead of refreshing it", () => {
    const storage = new MemoryStorage();
    const legacyKey =
      "postwave_onboarding_cache_v2:" + identity.workspaceId;
    storage.setItem(
      legacyKey,
      JSON.stringify({
        at: 10_000 - 31 * 60_000,
        flags: { domain: true, secret: "must-not-survive" },
      }),
    );
    const migrated = controller({ storage });
    expect(migrated.getSnapshot().goals.completedStepIds).toEqual([]);
    expect(storage.getItem(legacyKey)).toBeNull();
    expect(storage.getItem(migrated.storageKey)).not.toContain(
      "must-not-survive",
    );
  });

  it("rejects corrupt/oversized or payload-bearing current state safely", () => {
    const storage = new MemoryStorage();
    const key = onboardingStorageKey(identity);
    storage.setItem(
      key,
      JSON.stringify({
        version: 3,
        scopeToken: onboardingScopeToken(identity),
        secret: "pw_live_should_not_survive",
      }),
    );
    const recovered = controller({ storage });
    expect(recovered.getSnapshot().revision).toBe(0);
    expect(storage.getItem(key)).not.toContain("pw_live_should_not_survive");
    expect(
      parseOnboardingState("x".repeat(33 * 1024), onboardingScopeToken(identity)),
    ).toBeNull();
    const impossible = createOnboardingState(onboardingScopeToken(identity));
    impossible.surfaces.wizard.outcome = "in-progress";
    expect(
      parseOnboardingState(
        JSON.stringify(impossible),
        onboardingScopeToken(identity),
      ),
    ).toBeNull();
  });

  it("scopes storage to opaque workspace+user identity without collisions", () => {
    const second = { ...identity, userId: "second@example.test" };
    const third = { ...identity, workspaceId: "other-workspace" };
    const keys = [
      onboardingStorageKey(identity),
      onboardingStorageKey(second),
      onboardingStorageKey(third),
    ];
    expect(new Set(keys).size).toBe(3);
    expect(keys.join(" ")).not.toContain(identity.workspaceId);
    expect(keys.join(" ")).not.toContain(identity.userId);
  });

  it("merges sibling-window updates without replaying analytics", () => {
    const storage = new MemoryStorage();
    const leftAnalytics = vi.fn();
    const rightAnalytics = vi.fn();
    const left = controller({ storage, analytics: leftAnalytics });
    const right = controller({ storage, analytics: rightAnalytics });
    left.dispatch({
      type: "open",
      surface: "wizard",
      trigger: "auto",
      stepId: "domain",
      now: 1_000,
    });
    expect(right.syncFromStorage(storage.getItem(left.storageKey))).toBe(true);
    expect(right.getSnapshot().surfaces.wizard.currentStepId).toBe("domain");
    expect(rightAnalytics).not.toHaveBeenCalled();

    right.dispatch({
      type: "dismiss-surface",
      surface: "checklist",
      now: 2_000,
    });
    left.dispatch({
      type: "complete-step",
      surface: "wizard",
      stepId: "domain",
      nextStepId: "subscribers",
      now: 3_000,
    });
    expect(left.getSnapshot().surfaces.checklist.outcome).toBe("dismissed");
  });

  it("converges deterministic same-millisecond sibling writes", () => {
    const base = createOnboardingState("scope");
    const wizard = transitionOnboardingState(base, {
      type: "open",
      surface: "wizard",
      trigger: "auto",
      stepId: "domain",
      now: 1_000,
    }).state;
    const checklist = transitionOnboardingState(base, {
      type: "dismiss-surface",
      surface: "checklist",
      now: 1_000,
    }).state;
    const leftToRight = mergeOnboardingStates(wizard, checklist);
    const rightToLeft = mergeOnboardingStates(checklist, wizard);
    expect(leftToRight).toEqual(rightToLeft);
    expect(leftToRight.surfaces.wizard.outcome).toBe("in-progress");
    expect(leftToRight.surfaces.checklist.outcome).toBe("dismissed");
  });

  it("does not replay cached goal history but emits subsequent milestones", () => {
    const intents: OnboardingAnalyticsIntent[] = [];
    let state = createOnboardingState("scope");
    let result = transitionOnboardingState(state, {
      type: "sync-goals",
      completedStepIds: ["verify-domain"],
      fetchedAt: 1_000,
      announceChanges: false,
      now: 1_000,
    });
    expect(result.intents).toEqual([]);
    state = result.state;
    result = transitionOnboardingState(state, {
      type: "sync-goals",
      completedStepIds: CHECKLIST_STEPS.map((step) => step.id),
      fetchedAt: 2_000,
      announceChanges: true,
      now: 2_000,
    });
    intents.push(...result.intents);
    expect(intents.map((intent) => intent.name)).toContain(
      "onboarding.checklist_completed",
    );
    expect(intents.map((intent) => intent.name)).toContain(
      "onboarding.milestone_celebrated",
    );
  });

  it("centralizes modal eligibility and never auto-opens behind blockers", () => {
    const state = createOnboardingState("scope");
    expect(
      shouldAutoOpenOnboardingSurface(state, "wizard", {
        role: "admin",
        blocked: false,
        workspaceNeedsSetup: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoOpenOnboardingSurface(state, "wizard", {
        role: "admin",
        blocked: true,
        workspaceNeedsSetup: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoOpenOnboardingSurface(state, "wizard", {
        role: "viewer",
        blocked: false,
        workspaceNeedsSetup: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoOpenOnboardingSurface(state, "tour", {
        role: "viewer",
        blocked: false,
        workspaceNeedsSetup: false,
      }),
    ).toBe(true);
  });
});
