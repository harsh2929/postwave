import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const rel = relative(SRC, path);
    if (rel.startsWith("__tests__")) continue;
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) files.push(path);
  }
  return files;
}

function read(relativePath: string): string {
  return readFileSync(resolve(SRC, relativePath), "utf8");
}

describe("DUX-034 source ownership contract", () => {
  it("keeps every legacy persistence key inside the one migration adapter", () => {
    const legacy =
      /postwave_(?:onboarded|onboarding_dismissed_at|tour_dashboard|onboarding_skipped_|onboarding_checklist_dismissed|onboarding_cache_v2)/u;
    const offenders = sourceFiles(SRC)
      .filter((path) => legacy.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual(["lib/onboarding-state-storage.ts"]);
  });

  it("removes independent visibility and task-handoff stores", () => {
    const production = sourceFiles(SRC)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(production).not.toContain("useOnboardingMode");
    expect(production).not.toContain("setOnboardingMode");
    expect(production).not.toContain("subscriber-onboarding-handoff");
    expect(production).not.toContain("setPendingOnboardingModal");
    expect(read("components/onboarding/StepSubscribers.tsx")).toContain(
      "overlay: { name: modal }",
    );
    expect(
      read("pages/subscribers/useSubscriberDetailRouteNavigation.ts"),
    ).toContain("useDesktopRouteSnapshot");
  });

  it("routes every onboarding destination through the canonical router", () => {
    const owners = [
      "components/OnboardingWizard.tsx",
      "components/onboarding/StepDomain.tsx",
      "components/onboarding/StepSubscribers.tsx",
      "components/onboarding/StepCampaign.tsx",
      "components/onboarding/StepDone.tsx",
      "components/tour/TourProvider.tsx",
      "hooks/useOnboardingProgress.ts",
    ];
    for (const owner of owners) {
      const source = read(owner);
      expect(source).not.toMatch(/\bsetSection\s*\(/u);
    }
    expect(
      owners.some((owner) => read(owner).includes("navigateDesktopRoute")),
    ).toBe(true);
  });

  it("has one analytics emitter and blocker inputs for dialogs, lifecycle, errors", () => {
    const production = sourceFiles(SRC);
    const emitters = production
      .filter((path) =>
        readFileSync(path, "utf8").includes(
          "function emitOnboardingAnalyticsIntent",
        ),
      )
      .map((path) => relative(SRC, path));
    expect(emitters).toEqual(["lib/onboarding-analytics.ts"]);

    const blockers = read("hooks/useOnboardingState.ts");
    expect(blockers).toContain("subscribeDialogStack");
    expect(blockers).toContain("useLifecycleDecisionState");
    expect(blockers).toContain("hasCriticalToast");
    expect(blockers).toContain("visibilitychange");
    expect(read("components/OnboardingWizard.tsx")).toContain(
      "progress.liveConfirmed",
    );
    expect(read("components/tour/TourProvider.tsx")).toContain(
      "progress.liveConfirmed",
    );
  });

  it("pins validated versioning, opaque identity, bounded state, and sync", () => {
    const storage = read("lib/onboarding-state-storage.ts");
    const controller = read("lib/onboarding-state-controller.ts");
    expect(storage).toContain("ONBOARDING_STATE_VERSION");
    expect(storage).toContain("MAX_STATE_BYTES");
    expect(storage).toContain("hasOnlyKeys");
    expect(storage).toContain("onboardingScopeToken");
    expect(storage).not.toContain("apiKey:");
    expect(controller).toContain("syncFromStorage");
    expect(controller).toContain("mergeOnboardingStates");
    expect(read("hooks/useOnboardingState.ts")).toContain(
      'window.addEventListener("storage"',
    );
  });
});
