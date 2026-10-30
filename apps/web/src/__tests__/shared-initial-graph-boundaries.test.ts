import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(resolve(process.cwd(), "src", path), "utf8");

describe("shared initial graph boundaries", () => {
  it("keeps transport and offline replay code out of the dashboard shell", () => {
    const shell = source("app/(dashboard)/dashboard-shell.tsx");
    const provider = source("components/query-provider.tsx");
    const queryClient = source("lib/query-client.ts");
    const api = source("lib/api.ts");

    expect(shell).toContain('from "@/lib/auth-session-events"');
    expect(shell).toContain('from "@/lib/offline-storage-identity"');
    expect(shell).not.toContain('from "@/lib/api"');
    expect(shell).not.toContain('from "@/lib/offline-store"');

    expect(provider).toContain('import("@/lib/tanstack-online-bridge")');
    expect(provider).toContain('from "@/lib/offline-storage-identity"');
    expect(provider).not.toContain('from "@/lib/online-manager"');
    expect(provider).not.toContain('from "@/lib/offline-store"');

    expect(queryClient).not.toContain('from "./online-manager"');
    expect(queryClient).not.toContain('from "./outbox-query-defaults"');
    expect(queryClient).not.toContain('from "./outbox"');
    expect(api).toContain(
      'export { AUTH_SESSION_EXPIRED_EVENT } from "./auth-session-events"',
    );
  });

  it("uses the minimal shell route projection on the persistent rail", () => {
    const shell = source("app/(dashboard)/dashboard-shell.tsx");
    const nav = source("lib/dashboard-nav.ts");

    expect(shell).toContain('import("@/lib/dashboard-shell-routes")');
    expect(shell).not.toContain('from "@/lib/dashboard-shell-routes"');
    expect(shell).not.toContain('from "@/lib/dashboard-shell-nav-routes"');
    expect(shell).not.toContain('from "@/lib/dashboard-routes"');
    expect(nav).toMatch(
      /import\s*\{[^}]*\bDASHBOARD_SHELL_NAV_ROUTES\b[^}]*\}\s*from\s*"\.\/dashboard-shell-nav-routes"/s,
    );
    expect(nav).not.toMatch(
      /import\s*\{[^}]*DASHBOARD_NAV_ROUTES[^}]*\}\s*from\s*"\.\/dashboard-routes"/s,
    );
  });

  it("preloads interactive account menus outside the render-blocking shell graph", () => {
    const shell = source("app/(dashboard)/dashboard-shell.tsx");
    const controls = source("app/(dashboard)/dashboard-header-controls.tsx");

    expect(shell).toContain('import("./dashboard-header-controls")');
    expect(shell).not.toContain('from "./dashboard-header-controls"');
    expect(shell).toContain("dashboardHeaderControlsPromise.then");
    expect(shell).toContain("<Suspense");
    expect(shell).toContain("Loading workspace actions…");
    expect(shell).toContain("Loading account actions…");
    expect(controls).toContain('import("@/lib/auth-api")');
    expect(controls).toContain("await clearQueryState()");
    expect(controls).toContain("switchingWorkspaceRef.current");
    expect(controls).toContain("<HeaderMenu");
  });
});
