// SPDX-License-Identifier: AGPL-3.0-only
//
// Every hosted form page load on staging produced GET
// /api/public/forms/offline → 404 (user agent "node": the web server
// rendering a form page for the slug "offline").
//
// The chain: the service worker is registered on every page, hosted forms
// included, and its install precaches /offline. On forms.<domain> the
// short-link rule turned any one-segment path into /forms/<slug>, so the
// precache fetch of /offline was redirected to /forms/offline, which asked
// the API for a form called "offline". The precache failed, the install was
// abandoned, and the next form load tried again.
//
// Driven through the real middleware, not a copy of its predicate.
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/middleware", () => ({
  default: () => () => new Response(null),
}));

import { middleware } from "@/middleware";

function get(url: string): Response {
  // The middleware reads the Host header, as behind the load balancer.
  return middleware(
    new NextRequest(url, {
      headers: { accept: "text/html", host: new URL(url).host },
    }),
  );
}

describe("forms.* host", () => {
  it("serves the app's offline page instead of treating it as a form slug", () => {
    const response = get("https://forms.example.test/offline");
    expect(response.headers.get("location")).toBeNull();
    expect(response.status).not.toBe(307);
    expect(response.status).not.toBe(308);
  });

  it("still redirects a hosted-form short link to its canonical route", () => {
    const response = get("https://forms.example.test/newsletter");
    expect([307, 308]).toContain(response.status);
    expect(response.headers.get("location")).toBe(
      "https://forms.example.test/forms/newsletter",
    );
  });
});
