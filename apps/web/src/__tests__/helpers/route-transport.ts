// SPDX-License-Identifier: AGPL-3.0-only
//
// A route-table sibling to pages/_harness.tsx's stubFixtureTransport().
//
// WHY NOT JUST stubFixtureTransport(). That stub serves the 47 RECORDED
// fixtures and 404s everything else. Nothing under /api/v1/crm,
// /api/v1/integration-writeback or /api/v1/conversions/keys was ever recorded,
// so every one of those panels would render its error branch and the test
// would prove only that the error branch exists — the list rendering, the
// per-item lifecycle buttons and the admin gate would all stay unexercised.
//
// This serves a caller-supplied table of paths (query string stripped, exactly
// as the fixture index does) and 404s the rest, so a panel renders REAL rows
// while any endpoint the test did not think about still fails the way the app
// genuinely sees it.
import { act } from "react";
import { vi } from "vitest";

/**
 * Returns the stub so a test can assert on what was REQUESTED, not only on
 * what was rendered. A lazily-`enabled` query is invisible in the DOM either
 * way — the component still hides the section — so "it does not fetch until
 * you ask" is only checkable against the call log.
 */
export function stubRouteTransport(
  routes: Record<string, unknown>,
): { requested: (fragment: string) => number } {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      seen.push(url);
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      const body = routes[path];
      if (body === undefined) {
        return new Response(
          JSON.stringify({ error: { code: "not_found", message: "" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return {
    requested: (fragment: string) =>
      seen.filter((url) => url.includes(fragment)).length,
  };
}

/**
 * Drains pending microtasks/timers until the DOM stops changing.
 *
 * renderPage() does this once on mount; a test that CLICKS something which
 * enables a lazy query (write-back's run history) needs it again afterwards,
 * or it asserts on the loading branch.
 */
export async function flush(container: HTMLElement): Promise<void> {
  let previous = "";
  for (let turn = 0; turn < 12; turn += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const current = container.textContent ?? "";
    if (current !== "" && current === previous) return;
    previous = current;
  }
}
