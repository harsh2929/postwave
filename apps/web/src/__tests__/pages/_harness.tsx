// SPDX-License-Identifier: AGPL-3.0-only
//
// Mounts a dashboard page for real, serving RECORDED API responses.
//
// WHY THIS EXISTS. 56 pages shipped in the recent sweep — 10,501 lines of
// "use client" React — and v8 coverage reported 0 of 2,062 branches and 0 of
// 882 lines. Nothing imported any of their modules. A crash on mount, a wrong
// variable in a loading/error/empty chain, or a per-tenant query-key mistake
// was invisible.
//
// Two defects proved it while this harness was being written: a duplicate
// aria-labelledby id that silenced a heading, and a rename that left a section
// guarding on one query while rendering another's data. Both were in a page I
// had read line by line minutes earlier. Neither is visible without mounting.
//
// WHY ONE HARNESS INSTEAD OF PER-PAGE MOCKS. The existing template
// (components/analytics-page-query.test.tsx) hand-mocks every @/lib/*-api
// module a page imports, which does not scale to 56 pages and rots the moment
// a page adds a client. Every client instead funnels through ONE transport —
// api.ts calls httpFetch exactly once, which calls global fetch — so stubbing
// fetch covers all of them at a single point.
//
// Responses come from src/__tests__/fixtures/api, recorded off the live API.
// A page therefore renders against the shapes the server really sends, not a
// literal someone wrote next to the client. Unrecorded paths resolve to an
// empty object, which is itself worth exercising: that is the shape every
// `?? []` guard has to survive.
import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { vi, expect, TestRunner } from "vitest";

import { testTimeoutCap, WAIT_DEADLINE_MS } from "./_wait";
import { openStreamGateForTests } from "@/lib/realtime/stream-gate";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const FIXTURES = resolve(process.cwd(), "src/__tests__/fixtures/api");

let INDEX: Record<string, string> = {};
try {
  INDEX = JSON.parse(readFileSync(resolve(FIXTURES, "index.json"), "utf8"));
} catch {
  INDEX = {};
}

/** The recorded body for a path, or null when nothing was recorded. */
function bodyFor(url: string): unknown | null {
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const file = INDEX[path];
  if (file) {
    const full = resolve(FIXTURES, file);
    if (existsSync(full)) return JSON.parse(readFileSync(full, "utf8"));
  }
  return null;
}

/**
 * Serves each request from a recorded fixture, or 404 when none was recorded.
 *
 * THE 404 IS DELIBERATE AND WAS A CORRECTION. An earlier version answered `{}`
 * for unrecorded paths, which INVENTED a shape production never produces: a
 * truthy-but-empty object. Two pages then "crashed" on
 * `workbench?.streams.length` and `usage.filter` — not because they are
 * broken, but because `{}` is neither the real payload nor absent, so the
 * optional chain did not short-circuit and the array was not an array. Both
 * were artefacts of the harness, and chasing them as page bugs would have
 * hardened code against a state it cannot reach.
 *
 * A 404 is a state the app genuinely sees, and every page now has an error
 * branch for it (the query-error sweep put one there), so unrecorded
 * endpoints exercise real code instead of a fiction.
 */
export function stubFixtureTransport(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const body = bodyFor(url);
      if (body === null) {
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
}

export const WHOAMI = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "qa@postwave.test",
  role: "owner" as const,
  effective_role: "owner" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "QA workspace",
  workspace_slug: "qa-workspace",
};

/**
 * Mounts a page and returns its rendered text.
 *
 * `props` exists for Next 15 dynamic routes: those pages receive `params` as a
 * PROMISE and unwrap it with React's `use()`. Rendering them with no props
 * throws "An unsupported type was passed to use(): undefined" — which looks
 * like a page bug and is a harness one.
 *
 * Throws if the component throws — which is the entire point. A page that
 * cannot mount fails here rather than in someone's browser.
 */
export async function renderPage<P extends object = Record<string, never>>(
  // Deliberately permissive in the component's own prop type: a Next 15
  // dynamic page is typed `({ params }: { params: Promise<{ id: string }> })`,
  // which is NOT assignable to ComponentType<Record<string, unknown>>. Naming
  // the props as a generic keeps each call site type-checked against the page
  // it actually renders instead of pushing an `as never` cast into 19 files.
  Page: ComponentType<P>,
  props: P = {} as P,
): Promise<{ text: string; container: HTMLElement; root: Root }> {
  // A page that renders here is a page that has finished loading, so the gate
  // that defers a stream's first open until load + idle
  // (lib/realtime/stream-gate.ts) is open. Page tests assert what a stream
  // does; realtime-stream-gate.test.ts asserts when it opens.
  openStreamGateForTests();
  const container = document.createElement("div");
  document.body.appendChild(container);

  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Page as ComponentType<object>, props),
      ),
    );
  });

  // Let the queries settle so the loading branch is not what we assert on.
  //
  // Several pages CHAIN queries — billing gates its overview fetch on
  // `enabled: meQuery.isFetched` — so a single macrotask resolves the first
  // and leaves the second still pending, and the page renders nothing. Flush
  // repeatedly until the DOM stops changing, with a bounded number of turns so
  // a genuinely stuck page fails rather than hanging.
  // "Stable" is NOT the same as "settled", and assuming so was a real bug: a
  // page showing "Loading…" is perfectly stable, so the loop exited on turn 2
  // and every error-state render was captured mid-flight. The 500 had not
  // propagated yet, so a page with correct error handling looked like it had
  // none.
  //
  // So: keep flushing while anything still reads as loading, require a
  // minimum number of turns, and only then accept stability. Bounded, so a
  // genuinely stuck page fails instead of hanging.
  //
  // Lazily loaded route chunks (next/dynamic) add a third shape: the fallback
  // stays up until vitest has transformed and imported the module, which is
  // wall-clock work (hundreds of ms for a large module the first time), not a
  // fixed number of event-loop turns. So once the turn budget is spent, keep
  // flushing only while a deferred boundary's fallback is still mounted, up to
  // a short deadline. The deadline is deliberately small: the page sweeps
  // render dozens of pages per test, and a page whose status region is
  // permanent (a disabled query's placeholder) must cost a second, not a
  // test timeout. A page that never leaves its fallback still fails on content.
  //
  // A React.lazy section is the fourth shape, and the one a DOM check cannot
  // see. Its Suspense fallback is usually a bare skeleton with no role and no
  // text, so the loop took the page for settled while the section's chunk was
  // still on its way. The test then ended with the chunk in flight, and when
  // it landed React logged "A suspended resource finished loading" into a
  // later test, or after the file had finished through a worker that may
  // already be closed, which fails the run. So the loop also asks React
  // whether any Suspense boundary is still showing its fallback, and keeps
  // flushing until none is. A chunk always lands or fails, so this wait is
  // bounded by the shared wait deadline and by the time the test has left,
  // and it fails loudly rather than return a page that is still loading.
  const MIN_TURNS = 6;
  const MAX_TURNS = 30;
  const LOADING_DEADLINE_MS = 1_500;
  const startedAt = Date.now();
  const cap = testTimeoutCap(TestRunner.getCurrentTest());
  const suspenseDeadline = Math.min(
    startedAt + WAIT_DEADLINE_MS,
    cap?.deadline ?? Number.POSITIVE_INFINITY,
  );
  let previous = "";
  let stableFor = 0;
  for (let turn = 0; ; turn += 1) {
    if (turn >= MAX_TURNS) {
      const suspended = suspendedBoundaries(root);
      if (suspended > 0) {
        if (Date.now() >= suspenseDeadline) {
          // The caller never receives this root, so unmount it here.
          unmount(root);
          throw new Error(
            `renderPage: ${suspended} Suspense boundar${suspended === 1 ? "y was" : "ies were"} still showing a fallback after ${Date.now() - startedAt} ms. A lazily loaded section never arrived.`,
          );
        }
      } else {
        const fallbackMounted =
          container.querySelector(
            '[role="status"][aria-label^="Loading" i], [aria-busy="true"]',
          ) !== null;
        if (!fallbackMounted || Date.now() - startedAt >= LOADING_DEADLINE_MS) {
          break;
        }
      }
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, turn < MAX_TURNS ? 0 : 10));
    });
    const current = container.textContent ?? "";
    const stillLoading =
      /loading|…/i.test(current) ||
      // Deferred route panels commonly expose loading state through an
      // accessible label while their skeletons intentionally contain no text.
      // Treat those boundaries as unsettled so smoke/click tests exercise the
      // real controls rather than racing past the fallback.
      container.querySelector(
        '[role="status"][aria-label^="Loading" i], [aria-busy="true"]',
      ) !== null ||
      suspendedBoundaries(root) > 0;
    stableFor = current !== "" && current === previous ? stableFor + 1 : 0;
    previous = current;
    if (turn + 1 >= MIN_TURNS && stableFor >= 2 && !stillLoading) break;
  }

  return { text: container.textContent ?? "", container, root };
}

/** The part of a React fiber that suspendedBoundaries() walks. */
interface Fiber {
  tag: number;
  memoizedState: unknown;
  child: Fiber | null;
  sibling: Fiber | null;
}

/** React's work tag for a <Suspense> boundary (stable since React 16). */
const SUSPENSE_COMPONENT_TAG = 13;

/**
 * How many <Suspense> boundaries in `root` are showing their fallback. A
 * boundary's fiber carries non-null memoizedState exactly while it is
 * suspended.
 *
 * This reads react-dom internals, because nothing public says whether a
 * boundary is suspended. If a React upgrade moves them, this throws instead
 * of reporting zero, so renderPage cannot quietly go back to returning pages
 * that are still loading. suspense-boundaries.test.tsx pins the behaviour.
 */
export function suspendedBoundaries(root: Root): number {
  const fiberRoot = (root as unknown as { _internalRoot?: unknown })
    ._internalRoot;
  if (fiberRoot === null) return 0; // unmounted
  const current = (fiberRoot as { current?: Fiber } | undefined)?.current;
  if (!current || typeof current.tag !== "number") {
    throw new Error(
      "suspendedBoundaries: this react-dom no longer exposes root._internalRoot.current; update the fiber walk in pages/_harness.tsx.",
    );
  }
  let suspended = 0;
  const pending: Fiber[] = [current];
  while (pending.length > 0) {
    const fiber = pending.pop()!;
    if (fiber.tag === SUSPENSE_COMPONENT_TAG && fiber.memoizedState !== null) {
      suspended += 1;
    }
    if (fiber.child) pending.push(fiber.child);
    if (fiber.sibling) pending.push(fiber.sibling);
  }
  return suspended;
}

export function unmount(root: Root): void {
  act(() => {
    root.unmount();
  });
}

/**
 * The assertion every smoke test shares.
 *
 * A page that mounts but renders nothing is not passing — that is exactly the
 * silently-empty failure this suite exists to catch — so the text must be
 * substantive and must not contain a React error boundary's output.
 */
export function expectRendered(text: string, mustContain: string): void {
  expect(text.length).toBeGreaterThan(40);
  expect(text).toContain(mustContain);
  expect(text).not.toMatch(/something went wrong/i);
}

/**
 * The weaker assertion, for pages with no stable literal heading.
 *
 * Nineteen pages build their title from data or render only cards, and the
 * strings a scan can find in them are conditional dialog titles or empty-state
 * copy — asserting those would produce a test that fails when the fixture
 * changes rather than when the page breaks.
 *
 * Mounting is still the thing worth proving: it catches a crash on mount, a
 * hook-order violation, and a render that silently produces nothing. It does
 * NOT prove the page shows the right content, and it is deliberately not
 * presented as if it does.
 */
export function expectMounted(text: string): void {
  expect(text.length).toBeGreaterThan(40);
  expect(text).not.toMatch(/something went wrong/i);
}

/**
 * Clicks every enabled control on a mounted page and reports what broke.
 *
 * WHY. The mount suite proved 123 pages RENDER. It clicked nothing. The app
 * carries 1,147 onClick handlers, 66 onSubmit and 40 useMutation calls, and
 * only 35% of those handlers live in a file any clicking test references — so
 * roughly 740 were never exercised by anything.
 *
 * A page that mounts and then throws the moment someone presses a button is
 * indistinguishable, to the mount suite, from one that works.
 *
 * SAFE TO RUN because the transport is stubbed: every request resolves from a
 * recorded fixture or 404s, so a click that would delete something in
 * production performs no network write here. That is also the limit of what
 * this proves — it asserts the handler does not EXPLODE, not that it does the
 * right thing.
 *
 * Errors are collected rather than thrown at the first failure, so one bad
 * button does not hide the other twelve on the same page.
 */
export async function clickEveryControl(
  container: HTMLElement,
): Promise<{ clicked: number; failures: string[] }> {
  const failures: string[] = [];
  let clicked = 0;

  // Snapshot up front: clicking can add or remove controls, and a live
  // NodeList would make the walk order depend on what each click renders.
  const controls = [
    ...container.querySelectorAll<HTMLElement>("button, [role='button']"),
  ].filter((el) => !(el as HTMLButtonElement).disabled);

  for (const el of controls) {
    const label =
      el.getAttribute("aria-label") ??
      el.textContent?.trim().slice(0, 40) ??
      "<unlabelled>";
    try {
      await act(async () => {
        el.click();
        await new Promise((r) => setTimeout(r, 0));
      });
      clicked += 1;
    } catch (err) {
      failures.push(
        `${label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // A thrown render surfaces as the error boundary's text rather than an
  // exception, so check for that too.
  if (/something went wrong/i.test(container.textContent ?? "")) {
    failures.push("an error boundary rendered after clicking");
  }

  return { clicked, failures };
}

/* ------------------------------------------------------------------ *
 * Behaviour helpers.
 *
 * The click sweep above proves a handler does not EXPLODE. It asserts
 * nothing about what the click did, types nothing, presses no keys, and
 * skips disabled controls — so "123 pages pass" was never a statement
 * about behaviour. These close the specific gaps that measurement showed:
 * 204 form controls across 47 pages that no page test had ever typed into,
 * and zero post-click state assertions.
 * ------------------------------------------------------------------ */

/** How the stubbed transport should answer, so a page's three states are testable. */
export type TransportMode = "loaded" | "empty" | "error";

/**
 * Serves recorded fixtures, deliberately-emptied fixtures, or failures.
 *
 * "empty" is not the same as "error", and telling them apart is the whole
 * point of the query-error work: a page must not render a failed request as a
 * legitimate zero. Testing only the loaded path leaves exactly the confusion
 * that shipped — assets printing "0 folder(s)" for a 500.
 */
export function stubTransport(mode: TransportMode = "loaded"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (mode === "error") {
        // 400, NOT 500, and the reason matters. http-fetch.ts:97 retries every
        // 5xx with decorrelated jitter (base 200ms, cap 10s) — correctly — so
        // a stubbed 500 leaves the query in `isLoading` for the whole retry
        // window and the page renders a spinner, not its error branch. My
        // first attempt asserted against that and concluded six pages had no
        // error handling when they all do.
        //
        // A 400 is a genuine failure the client does not retry, so the page
        // reaches the state under test immediately. Retry behaviour itself is
        // http-fetch's own concern and is tested there.
        return new Response(
          JSON.stringify({ error: { code: "bad_request", message: "" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const body = bodyFor(url);
      if (body === null) {
        return new Response(
          JSON.stringify({ error: { code: "not_found", message: "" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify(mode === "empty" ? emptied(body) : body),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }),
  );
}

/**
 * The exact answer the API gives for a service this environment doesn't run
 * (serviceproxy.notDeployed → httperror.WriteUnavailable): 503 with
 * retryable: false. Kept byte-for-byte with the server's envelope so a page
 * is tested against what staging really sends.
 */
export const NOT_DEPLOYED_BODY = {
  error: {
    code: "service_not_deployed",
    message: "This feature isn't available in this environment.",
    retryable: false,
  },
} as const;

/**
 * Answers every request under one of `prefixes` (e.g. "/api/v1/migrations")
 * with the not-deployed 503, and everything else from the recorded fixtures
 * (404 when none was recorded), as a lean environment does.
 */
export function stubNotDeployedTransport(prefixes: readonly string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      if (
        prefixes.some(
          (prefix) => path === prefix || path.startsWith(`${prefix}/`),
        )
      ) {
        return new Response(JSON.stringify(NOT_DEPLOYED_BODY), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const body = bodyFor(url);
      if (body === null) {
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
}

/**
 * A recorded body with every collection emptied and every count zeroed,
 * preserving the SHAPE.
 *
 * Replacing the body with `{}` would test a payload the server never sends —
 * that mistake already cost two false "crashes" in this harness. An emptied
 * fixture is a state the server genuinely produces for a new workspace.
 */
function emptied(value: unknown): unknown {
  if (Array.isArray(value)) return [];
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = typeof v === "number" ? 0 : emptied(v);
    }
    return out;
  }
  return value;
}

/**
 * Types a realistic value into every text control and reports what it filled.
 *
 * Uses the native value setter before dispatching `input`, because React
 * installs its own setter on the element and assigning `.value` directly is
 * swallowed — the handler never sees the change and the test silently proves
 * nothing.
 */
export async function fillEveryInput(
  container: HTMLElement,
  value = "postwave-qa",
): Promise<{ filled: number }> {
  const nodes = [
    ...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "input, textarea",
    ),
  ].filter(
    (el) =>
      !el.disabled &&
      !["checkbox", "radio", "file", "hidden", "submit", "button"].includes(
        (el as HTMLInputElement).type,
      ),
  );

  let filled = 0;
  for (const el of nodes) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const next =
      (el as HTMLInputElement).type === "email"
        ? "qa@postwave.test"
        : (el as HTMLInputElement).type === "number"
          ? "1"
          : (el as HTMLInputElement).type === "url"
            ? "https://example.com"
            : value;
    await act(async () => {
      setter?.call(el, next);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
    });
    filled += 1;
  }
  return { filled };
}

/** Controls that are disabled right now — the set the click sweep skips. */
export function disabledControls(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .filter((b) => b.disabled)
    .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "?");
}

/** Presses a key on an element, for the keyboard paths clicking never reaches. */
export async function pressKey(el: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
    el.dispatchEvent(
      new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
  });
}
