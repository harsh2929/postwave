// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// A lean environment doesn't run every backend. The API answers a read of a
// missing one with 503 {"error":{"code":"service_not_deployed",
// "retryable":false}} — a fact about the deployment, not a failure.
//
// On staging, four pages treated it as an outage anyway: /app/migrations and
// /app/pilot said "request failed" with a Retry and kept "Start a migration"
// clickable; /app/voice-labels said "temporarily unavailable" with a Retry and
// a live submit form; /app/sequences said the service "may be down" and
// "will return" beside an active "Generate your first sequence". A Retry that
// can never succeed is a lie, and so is an action that can only fail.
//
// This is the guard. Each surface that reads a service a lean environment
// may not run is mounted against the server's exact not-deployed envelope,
// through the real transport, and must:
//   - say so with the one shared notice (ServiceNotDeployedNotice),
//   - render no Retry / Try again and no error alert,
//   - keep the actions that need the service visible but disabled, each
//     described by the notice.
// And the last block keeps the list honest: every dashboard route that
// imports a client for one of those services is either exercised here or
// named, with its reason, as not yet converted.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { OperationsFailure } from "@/components/operations/operations-surface";
import { QueryError } from "@/components/integrations/data-surface";

import {
  NOT_DEPLOYED_BODY,
  renderPage,
  stubNotDeployedTransport,
  stubTransport,
  unmount,
  WHOAMI,
} from "./pages/_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

const { whoamiMock } = vi.hoisted(() => ({ whoamiMock: vi.fn() }));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: whoamiMock,
}));

beforeEach(() => {
  whoamiMock.mockReset().mockResolvedValue(WHOAMI);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const NOT_DEPLOYED = (): ApiError =>
  new ApiError(NOT_DEPLOYED_BODY.error.message, 503, NOT_DEPLOYED_BODY, {
    code: NOT_DEPLOYED_BODY.error.code,
  });

const RETRY = /\b(retry|retrying|try again)\b/i;

function buttons(container: ParentNode): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      "button, a[role='button'], [data-slot='button']",
    ),
  ];
}

function retryButtons(container: ParentNode): string[] {
  return buttons(container)
    .map((el) => el.textContent?.trim() ?? "")
    .filter((text) => RETRY.test(text));
}

function control(container: ParentNode, name: string): HTMLElement {
  const found = buttons(container).find(
    (el) => el.textContent?.replace(/\s+/g, " ").trim() === name,
  );
  if (!found) {
    throw new Error(
      `no control named "${name}" among: ${buttons(container)
        .map((el) => JSON.stringify(el.textContent?.trim()))
        .join(", ")}`,
    );
  }
  return found;
}

/** Off by its own attribute, aria-disabled, or a disabled fieldset around it. */
function isDisabled(el: HTMLElement): boolean {
  return (
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute("aria-disabled") === "true" ||
    el.closest("fieldset[disabled]") !== null
  );
}

/** The notice this control's aria-describedby (or its fieldset's) points at. */
function describedByNotice(el: HTMLElement): Element | null {
  const ids = [
    el.getAttribute("aria-describedby"),
    el.closest("fieldset[disabled]")?.getAttribute("aria-describedby"),
  ]
    .filter((v): v is string => Boolean(v))
    .flatMap((v) => v.split(/\s+/));
  for (const id of ids) {
    const target = document.getElementById(id);
    if (target?.matches("[data-state='service-not-deployed']")) return target;
  }
  return null;
}

function expectNotDeployedState(
  container: HTMLElement,
  title: string,
  actions: string[],
): void {
  // The staging symptoms first, so a regression names itself.
  expect(retryButtons(container)).toEqual([]);
  // Outage language describes a failure that will pass; this won't.
  expect(container.textContent).not.toMatch(
    /temporarily unavailable|may be down|will return|request failed/i,
  );
  expect(container.querySelector("[role='alert']")).toBeNull();
  const notices = container.querySelectorAll(
    "[data-state='service-not-deployed']",
  );
  expect(notices.length).toBe(1);
  expect(notices[0].getAttribute("role")).toBe("status");
  expect(notices[0].textContent).toContain(title);
  for (const name of actions) {
    const el = control(container, name);
    expect(isDisabled(el), `${name} should be disabled`).toBe(true);
    expect(describedByNotice(el), `${name} should cite the notice`).toBe(
      notices[0],
    );
  }
}

describe("shared failure primitives", () => {
  for (const [name, Failure] of [
    ["OperationsFailure", OperationsFailure],
    ["QueryError", QueryError],
  ] as const) {
    it(`${name} renders the notice, not a retry, for a not-deployed answer`, async () => {
      const onRetry = vi.fn();
      const { container, root } = await renderPage(() =>
        createElement(Failure, {
          title: "Could not load",
          description: "The request failed.",
          error: NOT_DEPLOYED(),
          onRetry,
        }),
      );
      try {
        expectNotDeployedState(
          container,
          "isn't set up in this environment",
          [],
        );
        expect(container.textContent).not.toContain("The request failed.");
      } finally {
        unmount(root);
      }
    });

    it(`${name} still offers a retry for a real failure`, async () => {
      // Non-vacuity: the same probe must see a retry when one is honest.
      const { container, root } = await renderPage(() =>
        createElement(Failure, {
          title: "Could not load",
          description: "The request failed.",
          error: new ApiError("upstream did not respond", 502, undefined, {
            code: "bad_gateway",
          }),
          onRetry: vi.fn(),
        }),
      );
      try {
        expect(retryButtons(container)).toEqual(["Try again"]);
        expect(
          container.querySelector("[data-state='service-not-deployed']"),
        ).toBeNull();
      } finally {
        unmount(root);
      }
    });
  }
});

interface Surface {
  /** Route directory under src/app/(dashboard)/app. */
  route: string;
  /** API prefixes this environment doesn't run. */
  missing: string[];
  load: () => Promise<() => ReactElement>;
  title: string;
  /** Visible actions that need the missing service. */
  actions: string[];
}

async function clientPage(
  mod: Promise<{ default: () => ReactElement | JSX.Element }>,
): Promise<() => ReactElement> {
  return (await mod).default as () => ReactElement;
}

async function serverPage(
  mod: Promise<{ default: () => Promise<ReactElement | JSX.Element> }>,
): Promise<() => ReactElement> {
  // An async server component: resolve its data on the way in, then mount
  // the tree it returned, client components included.
  const tree = (await (await mod).default()) as ReactElement;
  return function ServerRenderedTree() {
    return tree;
  };
}

const SURFACES: Surface[] = [
  {
    route: "migrations",
    missing: ["/api/v1/migrations"],
    load: () => clientPage(import("@/app/(dashboard)/app/migrations/page")),
    title: "Migrations aren't set up in this environment",
    actions: ["Start a migration"],
  },
  {
    route: "pilot",
    missing: ["/api/v1/migrations"],
    load: () => clientPage(import("@/app/(dashboard)/app/pilot/page")),
    title: "Pilot readiness isn't set up in this environment",
    actions: ["Refresh"],
  },
  {
    route: "voice-labels",
    missing: ["/api/v1/voice"],
    load: () => clientPage(import("@/app/(dashboard)/app/voice-labels/page")),
    title: "Voice labeling isn't set up in this environment",
    actions: ["Import JSON", "Save label", "Coverage", "Export all (JSON)"],
  },
  {
    route: "sequences",
    missing: ["/api/v1/voice"],
    load: () => serverPage(import("@/app/(dashboard)/app/sequences/page")),
    title: "Sequences aren't set up in this environment",
    actions: [
      "New sequence",
      "Generate your first sequence",
      "Preview a template",
    ],
  },
  {
    route: "sequence-templates",
    missing: ["/api/v1/voice"],
    load: () =>
      serverPage(import("@/app/(dashboard)/app/sequence-templates/page")),
    title: "Sequence templates aren't set up in this environment",
    actions: ["New template"],
  },
];

describe("surfaces reading a service this environment doesn't run", () => {
  for (const surface of SURFACES) {
    it(`/app/${surface.route} says it isn't set up here, with no retry and its actions off`, async () => {
      stubNotDeployedTransport(surface.missing);
      const Page = await surface.load();
      const { container, root } = await renderPage(Page);
      try {
        expectNotDeployedState(container, surface.title, surface.actions);
      } finally {
        unmount(root);
      }
    });
  }

  it("still offers a retry when a deployed service really fails", async () => {
    // Non-vacuity for the page probe: the migrations page must keep its
    // retry for a genuine failure, and must not claim "not set up".
    stubTransport("error");
    const Page = await clientPage(
      import("@/app/(dashboard)/app/migrations/page"),
    );
    const { container, root } = await renderPage(Page);
    try {
      expect(retryButtons(container).length).toBeGreaterThan(0);
      expect(
        container.querySelector("[data-state='service-not-deployed']"),
      ).toBeNull();
      expect(isDisabled(control(container, "Start a migration"))).toBe(false);
    } finally {
      unmount(root);
    }
  });
});

// ── Completeness ─────────────────────────────────────────────────────────────

const APP = resolve(process.cwd(), "src/app/(dashboard)/app");

/**
 * Clients for the services a lean environment may not deploy (the API's
 * serviceproxy routes: /api/v1/migrations/*, /api/v1/voice/*).
 */
const OPTIONAL_SERVICE_CLIENT =
  /(?:from\s+|import\(\s*)["']@\/lib\/(?:migration-api|voice-api|voice-labels-api)["']/;

/**
 * Routes that read one of those services but are not converted yet. Each
 * entry says what still happens there; converting a route means adding it to
 * SURFACES above and deleting it here. Stale entries fail the last test.
 */
const NOT_YET_CONVERTED: Record<string, string> = {
  campaigns:
    "voice drift check beside a campaign; a not-deployed answer surfaces as that check's error",
  "landing-pages/[id]":
    "voice tools in the landing page editor; not-deployed surfaces as a generic failure",
  "migrations/[jobId]":
    "job detail; unreachable without a job, which a not-deployed environment cannot list",
  "migrations/new/[source]":
    "wizard entry; reached by direct URL only once the index disables Start",
  "migrations/oauth/callback":
    "OAuth return leg; unreachable without starting a migration",
  "sequence-templates/[id]":
    "template preview; unreachable once the templates index renders the notice",
  "sequence-templates/new":
    "template editor; its entry button is disabled on the index when not deployed",
  "sequences/[id]": "sequence detail; unreachable without a listed sequence",
  "sequences/new":
    "builder and AI brief stay enabled by direct URL; template picker shows Try again",
  "sequences/new/[templateId]":
    "template-seeded builder; unreachable once templates render the notice",
  "sequences/voice-profile":
    "voice profile page; not-deployed surfaces as a generic load failure",
};

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      // A nested page.tsx is its own route, scanned on its own.
      if (existsSync(join(p, "page.tsx"))) continue;
      out.push(...routeFiles(p));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

function routes(dir: string, acc: string[] = []): string[] {
  if (existsSync(join(dir, "page.tsx"))) acc.push(dir);
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) routes(p, acc);
  }
  return acc;
}

function routesReadingOptionalServices(): string[] {
  return routes(APP)
    .filter((dir) =>
      routeFiles(dir).some((file) =>
        OPTIONAL_SERVICE_CLIENT.test(readFileSync(file, "utf8")),
      ),
    )
    .map((dir) => relative(APP, dir))
    .sort();
}

describe("every route that reads an optional service is accounted for", () => {
  const found = routesReadingOptionalServices();
  const covered = new Set(SURFACES.map((s) => s.route));

  it("scans a non-trivial corpus", () => {
    // Vacuity floor: a broken walk would pass the checks below for free.
    expect(found.length).toBeGreaterThanOrEqual(covered.size);
    for (const route of covered) expect(found).toContain(route);
  });

  it("names no route twice", () => {
    for (const route of covered) {
      expect(NOT_YET_CONVERTED[route], route).toBeUndefined();
    }
  });

  it("has no unaccounted route", () => {
    const unaccounted = found.filter(
      (route) => !covered.has(route) && NOT_YET_CONVERTED[route] === undefined,
    );
    expect(unaccounted).toEqual([]);
  });

  it("keeps every not-yet-converted entry real", () => {
    const stale = Object.keys(NOT_YET_CONVERTED).filter(
      (route) => !found.includes(route),
    );
    expect(stale).toEqual([]);
  });
});
