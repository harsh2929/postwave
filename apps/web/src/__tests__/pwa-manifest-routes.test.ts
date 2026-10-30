import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DASHBOARD_CREATE_ROUTES,
  DASHBOARD_ROUTES,
} from "../lib/dashboard-routes";

interface WebManifest {
  start_url?: string;
  icons?: Array<{ src?: string; sizes?: string; type?: string }>;
  shortcuts?: Array<{ name?: string; url?: string }>;
}

function dashboardRouteFile(url: string): string | null {
  const pathname = new URL(url, "https://app.postwave.test").pathname;
  if (pathname === "/app") {
    return path.join(process.cwd(), "src/app/(dashboard)/app/page.tsx");
  }
  if (!pathname.startsWith("/app/")) return null;
  const rest = pathname.slice("/app/".length);
  return path.join(
    process.cwd(),
    "src/app/(dashboard)/app",
    ...rest.split("/"),
    "page.tsx",
  );
}

describe("PWA manifest route targets", () => {
  it("ships every install and notification bitmap at its declared dimensions", () => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "public/manifest.webmanifest"),
        "utf8",
      ),
    ) as WebManifest;
    const expected = new Map([
      ["/icons/icon-192.png", [192, 192]],
      ["/icons/icon-192-maskable.png", [192, 192]],
      ["/icons/icon-512.png", [512, 512]],
      ["/icons/icon-512-maskable.png", [512, 512]],
      ["/icons/badge-72.png", [72, 72]],
    ]);

    for (const [src, [width, height]] of expected) {
      const bytes = readFileSync(
        path.join(process.cwd(), "public", src.slice(1)),
      );
      expect(bytes.subarray(1, 4).toString("ascii"), src).toBe("PNG");
      expect(bytes.readUInt32BE(16), src).toBe(width);
      expect(bytes.readUInt32BE(20), src).toBe(height);
    }

    expect(
      (manifest.icons ?? []).map((icon) => [icon.src, icon.sizes, icon.type]),
    ).toEqual([
      ["/icons/icon-192.png", "192x192", "image/png"],
      ["/icons/icon-192-maskable.png", "192x192", "image/png"],
      ["/icons/icon-512.png", "512x512", "image/png"],
      ["/icons/icon-512-maskable.png", "512x512", "image/png"],
    ]);

    const worker = readFileSync(
      path.join(process.cwd(), "src/app/sw.ts"),
      "utf8",
    );
    expect(worker).toContain('"/icons/icon-192.png"');
    expect(worker).toContain('badge: "/icons/badge-72.png"');
  });

  it("points shortcuts at existing dashboard pages", () => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "public/manifest.webmanifest"),
        "utf8",
      ),
    ) as WebManifest;

    const missing = (manifest.shortcuts ?? [])
      .map((shortcut) => ({
        name: shortcut.name ?? "(unnamed)",
        url: shortcut.url ?? "",
        file: shortcut.url ? dashboardRouteFile(shortcut.url) : null,
      }))
      .filter((shortcut) => !shortcut.file || !existsSync(shortcut.file));

    expect(
      missing.map((shortcut) => `${shortcut.name}: ${shortcut.url}`),
    ).toEqual([]);
  });

  it("keeps launch and shortcut URLs in the shared dashboard route manifest", () => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "public/manifest.webmanifest"),
        "utf8",
      ),
    ) as WebManifest;
    const knownRoutes = new Set<string>(
      DASHBOARD_ROUTES.map((route) => route.href),
    );
    const launchUrls = [
      manifest.start_url,
      ...(manifest.shortcuts ?? []).map((s) => s.url),
    ]
      .filter((url): url is string => Boolean(url))
      .map((url) => new URL(url, "https://app.postwave.test").pathname);

    const unmanaged = launchUrls.filter((url) => !knownRoutes.has(url));

    expect(
      unmanaged,
      "PWA manifest URLs must use shared dashboard route facts.",
    ).toEqual([]);
  });

  it("keeps the campaign create shortcut aligned with quick-create routes", () => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "public/manifest.webmanifest"),
        "utf8",
      ),
    ) as WebManifest;
    const manifestShortcut = (manifest.shortcuts ?? []).find(
      (shortcut) => shortcut.name === "New campaign",
    );
    const createRoute = DASHBOARD_CREATE_ROUTES.find(
      (route) => route.label === "New campaign",
    );

    expect(createRoute?.href).toBeTruthy();
    expect(manifestShortcut?.url).toBe(createRoute?.href);
  });
});
