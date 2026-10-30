import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

import type { Route } from "@playwright/test";

import {
  expect,
  test as visualTest,
  waitForPrimaryNavigation,
} from "./fixture";

export const HELPDESK_OPTIMIZED_DIST =
  process.env.POSTWAVE_HELPDESK_OPTIMIZED_DIST === "1";

const DIST_ROOT = resolve(process.cwd(), "dist");
const MIME = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function safeDistFile(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const candidate = resolve(DIST_ROOT, `.${decoded}`);
  if (candidate !== DIST_ROOT && !candidate.startsWith(`${DIST_ROOT}${sep}`)) {
    return null;
  }
  return candidate;
}

async function fulfillBuiltRenderer(route: Route): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const candidate = safeDistFile(url.pathname);
  if (candidate && existsSync(candidate) && statSync(candidate).isFile()) {
    await route.fulfill({
      status: 200,
      contentType:
        MIME.get(extname(candidate).toLowerCase()) ??
        "application/octet-stream",
      headers: { "cache-control": "no-store" },
      body: readFileSync(candidate),
    });
    return;
  }
  if (request.resourceType() === "document") {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "cache-control": "no-store" },
      body: readFileSync(resolve(DIST_ROOT, "index.html")),
    });
    return;
  }
  await route.fulfill({ status: 404, body: "not found" });
}

export const test = visualTest.extend({
  page: async ({ page }, use) => {
    if (HELPDESK_OPTIMIZED_DIST) {
      await page.route("http://localhost:1421/**", fulfillBuiltRenderer);
    }
    await use(page);
  },
});

export { expect, waitForPrimaryNavigation };
