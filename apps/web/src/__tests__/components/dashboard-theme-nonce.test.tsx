// SPDX-License-Identifier: AGPL-3.0-only
//
// Dashboard documents carry a nonce + 'strict-dynamic' script policy. The
// next-themes provider renders an inline script that applies the saved theme
// before first paint; it had no nonce and its body is not one of the
// allow-listed root-layout hashes, so the browser blocked it on every
// dashboard load (a CSP violation per page, and a flash of the light theme for
// dark-theme users). The layout now hands the request's nonce to the provider.
import { createHash } from "node:crypto";
import type { ReactElement, ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@/components/theme-provider";
import { ROOT_LAYOUT_SCRIPT_HASHES } from "@/lib/root-layout-scripts";

const NONCE = "6b1f0d2e-9c7a-4e35-8f41-2a0c5d7e9b13";

const request = vi.hoisted(() => ({
  headers: new Headers(),
}));

vi.mock("next/headers", () => ({
  headers: async () => request.headers,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
}));
vi.mock("@/lib/auth-api", () => ({
  whoami: async () => ({
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "owner@example.test",
    role: "owner",
    mfa_required: false,
    mfa_satisfied: true,
  }),
}));
// The shell itself is a large client tree; the layout's job is only to hand
// it the nonce, which is what this stub records.
vi.mock("@/app/(dashboard)/dashboard-shell", () => ({
  DashboardShell: (props: { children?: ReactNode; nonce?: string }) =>
    props.children ?? null,
}));

function inlineScripts(html: string): Array<{ tag: string; body: string }> {
  return Array.from(html.matchAll(/(<script[^>]*>)([\s\S]*?)<\/script>/g)).map(
    (match) => ({ tag: match[1] ?? "", body: match[2] ?? "" }),
  );
}

function decodeHtml(body: string): string {
  return body
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("dashboard theme script under the strict CSP", () => {
  it("passes the middleware's nonce from the request to the dashboard shell", async () => {
    request.headers = new Headers({ "x-nonce": NONCE });
    const { default: DashboardLayout } = await import("@/app/(dashboard)/layout");

    const element = (await DashboardLayout({ children: null })) as ReactElement<{
      nonce?: string;
    }>;

    expect(element.props.nonce).toBe(NONCE);
  });

  it("renders the provider's pre-paint script with that nonce", () => {
    const html = renderToString(
      <ThemeProvider
        attribute="class"
        nonce={NONCE}
        defaultTheme="light"
        enableSystem
        disableTransitionOnChange
      >
        <main />
      </ThemeProvider>,
    );

    const scripts = inlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script.tag).toContain(`nonce="${NONCE}"`);
      // The nonce is the only thing that can authorise it: its body is not
      // one of the hashes the policy allow-lists.
      const hash = `'sha256-${createHash("sha256")
        .update(decodeHtml(script.body))
        .digest("base64")}'`;
      expect(ROOT_LAYOUT_SCRIPT_HASHES).not.toContain(hash);
    }
  });
});
