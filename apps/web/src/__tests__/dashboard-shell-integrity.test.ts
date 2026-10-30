// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { UserCog } from "lucide-react";

import { DASHBOARD_NAV_ITEMS } from "@/app/(dashboard)/dashboard-nav-shell";
import { DASHBOARD_CREATE_ROUTES } from "@/lib/dashboard-routes";

const ROOT = resolve(process.cwd());
const source = (path: string): string =>
  readFileSync(resolve(ROOT, path), "utf8");

describe("dashboard shell integrity", () => {
  it("maps the Settings route to its declared UserCog icon", () => {
    const settings = DASHBOARD_NAV_ITEMS.find(
      (item) => item.label === "Settings",
    );
    expect(settings?.icon).toBe(UserCog);
  });

  it("opens the real campaign-create dialog from quick create", () => {
    const route = DASHBOARD_CREATE_ROUTES.find(
      (item) => item.label === "New campaign",
    );
    expect(route?.href).toBe("/app/campaigns?create=1");
    const campaignsPage = source(
      "src/app/(dashboard)/app/campaigns/campaigns-client.tsx",
    );
    expect(campaignsPage).toContain('searchParams.get("create") !== "1"');
    expect(campaignsPage).toContain("setOpen(true)");
  });

  it("keeps campaign variants editable behind the lazy detail boundary", () => {
    const detailPage = source(
      "src/app/(dashboard)/app/campaigns/[id]/campaign-detail-client.tsx",
    );
    expect(detailPage).toContain('import("./campaign-variants-section")');
    expect(detailPage).toContain("const setVariants = (");
    expect(detailPage).toContain("const variants = variantsOf(campaign)");
    expect(detailPage).toContain("<CampaignVariantsSection");
    expect(detailPage).toContain("onChange={setVariants}");
  });

  it("advertises only implemented search and tour shortcuts", () => {
    const launcher = source("src/components/tour/TourLauncher.tsx");
    expect(launcher).toContain('["Quick search (in app)", "⌘ K"]');
    expect(launcher).not.toContain('["Quick search (in app)", "/"]');
  });

  it("keeps tour overlay CSS behind the lazy overlay boundary", () => {
    const provider = source("src/components/tour/TourProvider.tsx");
    const launcher = source("src/components/tour/TourLauncher.tsx");
    const overlay = source("src/components/tour/TourOverlay.tsx");
    const tooltip = source("src/components/tour/TourTooltip.tsx");

    expect(provider).toContain('import("./TourOverlay")');
    expect(provider).not.toContain(".module.css");
    expect(launcher).not.toContain(".module.css");
    expect(overlay).toContain('import styles from "./overlay.module.css"');
    expect(tooltip).toContain('import styles from "./overlay.module.css"');
  });

  it("keeps the dashboard tour in a client-only island with event replay", () => {
    const shell = source("src/app/(dashboard)/dashboard-shell.tsx");
    const island = source("src/components/tour/dashboard-tour-island.tsx");
    const settings = source("src/app/(dashboard)/app/settings/page.tsx");
    const marketing = source("src/app/(marketing)/layout.tsx");
    const islandImport = shell.indexOf(
      'import("@/components/tour/dashboard-tour-island")',
    );

    expect(islandImport).toBeGreaterThan(-1);
    expect(shell.slice(islandImport, islandImport + 500)).toContain(
      "ssr: false",
    );
    expect(shell).not.toContain('from "@/components/tour/TourProvider"');
    expect(shell).not.toContain('from "@/components/tour/TourLauncher"');
    expect(island).toContain('from "./TourProvider"');
    expect(island).toContain('from "./TourLauncher"');
    expect(island).toContain(
      "window.addEventListener(DASHBOARD_TOUR_REPLAY_EVENT",
    );
    expect(settings).toContain("onClick={requestDashboardTourReplay}");
    expect(settings).not.toContain("useTour");

    // The public product tour remains intentionally owned by the marketing
    // layout; dashboard bundle isolation must not change that behavior.
    expect(marketing).toContain(
      '<TourProvider tour="marketing" autoStart={false}>',
    );
    expect(marketing).toContain("<TourLauncher />");
  });

  it("shares identity and onboarding requests through TanStack Query keys", () => {
    const layout = source("src/app/(dashboard)/layout.tsx");
    const shell = source("src/app/(dashboard)/dashboard-shell.tsx");
    const provider = source("src/components/query-provider.tsx");
    const tour = source("src/components/tour/TourProvider.tsx");
    const checklist = source(
      "src/components/onboarding/OnboardingChecklist.tsx",
    );
    const authority = source("src/lib/onboarding-authority.ts");

    expect(layout.match(/whoami\(\)/g)).toHaveLength(1);
    expect(shell).not.toContain("whoami()");
    expect(shell).toContain("initialMe={initialMe}");
    expect(provider).toContain(
      "queryClient.setQueryData(qk.authMe(), initialMe)",
    );
    expect(shell).toContain("userId={account?.user_id}");
    expect(shell).toContain("account.effective_role ?? account.role");
    expect(shell).not.toContain(
      'import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api"',
    );
    expect(shell).toContain("viewerMode={account?.viewer_mode === true}");
    expect(tour).toContain("onboardingProgressKey(authority)");
    expect(checklist).toContain("onboardingProgressKey(authority)");
    expect(authority).toContain("...qk.onboardingProgress(authority.tenantId");
    expect(authority).toContain("...onboardingIdentitySuffix(authority)");
  });

  it("keeps pre-hydration controls truthful without creating a dead page", () => {
    const shell = source("src/app/(dashboard)/dashboard-shell.tsx");

    expect(shell).toContain(
      "const handleStepUpReady = useCallback(() => setHydrated(true), [])",
    );
    expect(shell).toContain("<StepUpPrompt onReady={handleStepUpReady} />");
    expect(shell).toContain(
      'data-dashboard-hydrated={hydrated ? "true" : "false"}',
    );
    expect(shell).toContain("inert={hydrated ? undefined : true}");
    expect(shell).toContain("aria-busy={!hydrated}");
    expect(shell).toContain('role="status"');
    expect(shell).toContain('aria-live="polite"');
    expect(shell).toContain("Preparing your workspace…");
    expect(shell).toContain("Reload workspace");
    expect(shell).toContain('href={recoveryHref || "/app"}');
    expect(shell).toContain("`${pathname}?${serializedSearch}`");
    expect(shell).not.toMatch(/role="status"[\s\S]{0,160}aria-busy="true"/);

    // The dashboard root owns the public readiness signal, but only its child
    // application shell is inert. The sibling status/reload fallback therefore
    // remains perceivable and operable if React never hydrates.
    expect(shell).toMatch(
      /data-dashboard-hydrated=\{hydrated \? "true" : "false"\}[\s\S]*?!hydrated && \([\s\S]*?role="status"[\s\S]*?<a[\s\S]*?Reload workspace[\s\S]*?<div[\s\S]*?aria-busy=\{!hydrated\}[\s\S]*?inert=\{hydrated \? undefined : true\}/,
    );
  });

  it("keeps optional header controls behind client-only boundaries", () => {
    const shell = source("src/app/(dashboard)/dashboard-shell.tsx");
    const prompt = source("src/components/auth/step-up-prompt.tsx");

    for (const modulePath of [
      "@/components/presence-indicator",
      "@/components/queue-tray-launcher",
      "@/components/notification-bell",
      "@/components/auth/step-up-prompt",
    ]) {
      const start = shell.indexOf(`import("${modulePath}")`);
      expect(
        start,
        `${modulePath} should be dynamically imported`,
      ).toBeGreaterThan(-1);
      expect(shell.slice(start, start + 500)).toContain("ssr: false");
      expect(shell).not.toContain(`from "${modulePath}"`);
    }

    // Notifications always have a header affordance, so their loading state
    // occupies the same slot and is announced truthfully. Presence and queue
    // are conditional, so inventing a disabled control before their state is
    // known would be misleading.
    expect(shell).toContain(
      '<HeaderControlLoading label="Loading notifications…" />',
    );
    expect(shell).toContain('role="status"');
    expect(shell).toContain('<span className="sr-only">{label}</span>');

    // The readiness callback is declared after listener registration. The
    // shell therefore becomes interactive only once a challenge can be
    // claimed synchronously, not merely once the lazy module was evaluated.
    expect(
      prompt.indexOf("window.addEventListener(STEP_UP_PROMPT_EVENT"),
    ).toBeGreaterThan(-1);
    expect(
      prompt.indexOf("useEffect(() => onReady?.(), [onReady])"),
    ).toBeGreaterThan(
      prompt.indexOf("window.addEventListener(STEP_UP_PROMPT_EVENT"),
    );
  });

  it("defers post-hydration shell data and auth actions", () => {
    const shell = source("src/app/(dashboard)/dashboard-shell.tsx");
    const badges = source("src/lib/use-nav-badges.ts");

    expect(shell).toContain('import("@/lib/auth-api")');
    expect(shell).toContain('import("@/lib/dashboard-shell-routes")');
    expect(shell).not.toContain('from "@/lib/dashboard-shell-routes"');
    expect(shell).not.toMatch(
      /import\s*\{[^}]*\b(?:listWorkspaces|logout)\b[^}]*\}\s*from\s*"@\/lib\/auth-api"/s,
    );
    expect(badges).toContain('import("@/lib/approvals-api")');
    expect(badges).not.toContain('from "@/lib/approvals-api"');
  });
});
