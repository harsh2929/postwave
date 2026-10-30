import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const SEQUENCE_IDS = {
  draft: "11111111-1111-4111-8111-111111111111",
  legacyActive: "22222222-2222-4222-8222-222222222222",
  archived: "33333333-3333-4333-8333-333333333333",
} as const;

const DRAFT_NAME = "Lifecycle welcome qualification";
const LEGACY_ACTIVE_NAME = "Legacy renewal journey";
const ARCHIVED_NAME =
  "Archived enterprise onboarding journey with deliberately descriptive copy";
const RUNTIME_REASON =
  "Live sequence triggers, enrollment, delivery, and runtime analytics are not available in this build. You can safely design and review drafts, but you cannot activate them.";

interface VisualSequence extends Record<string, unknown> {
  id: string;
  name: string;
  status: string;
  steps: number;
  active_runs: number;
}

const SEQUENCE_ROWS: VisualSequence[] = [
  {
    id: SEQUENCE_IDS.draft,
    name: DRAFT_NAME,
    status: "draft",
    steps: 3,
    active_runs: 0,
  },
  {
    id: SEQUENCE_IDS.legacyActive,
    name: LEGACY_ACTIVE_NAME,
    status: "active",
    steps: 2,
    // Deliberately non-zero: the containment UI must not present this stale
    // server projection as evidence that an execution runtime is operating.
    active_runs: 37,
  },
  {
    id: SEQUENCE_IDS.archived,
    name: ARCHIVED_NAME,
    status: "archived",
    steps: 1,
    active_runs: 0,
  },
];

const DETAILS: Record<string, Record<string, unknown>> = {
  [SEQUENCE_IDS.draft]: {
    id: SEQUENCE_IDS.draft,
    name: DRAFT_NAME,
    description: "A reviewable lifecycle draft.",
    status: "draft",
    version: 7,
    active_runs: 0,
    trigger: null,
    goal: null,
    stuck_after_days: 0,
    steps: [
      {
        type: "email",
        position: 1,
        email: {
          subject: "Welcome to a calmer first week",
          body: "A deterministic qualification message.",
          delay_seconds: 0,
        },
      },
      {
        type: "delay",
        position: 2,
        delay: { seconds: 86_400, value: 1, unit: "days" },
      },
      { type: "exit", position: 3 },
    ],
  },
  [SEQUENCE_IDS.legacyActive]: {
    id: SEQUENCE_IDS.legacyActive,
    name: LEGACY_ACTIVE_NAME,
    description: "A legacy row whose label must not imply live execution.",
    status: "active",
    version: 11,
    active_runs: 37,
    trigger: {
      kind: "custom_event",
      event_name: "subscription.renewal_due",
    },
    goal: { kind: "click", exit_on_goal: true },
    stuck_after_days: 5,
    steps: [
      {
        type: "email",
        position: 1,
        email: {
          subject: "Your renewal is coming up",
          body: "A stored legacy message.",
          delay_seconds: 0,
        },
      },
      { type: "exit", position: 2 },
    ],
  },
  [SEQUENCE_IDS.archived]: {
    id: SEQUENCE_IDS.archived,
    name: ARCHIVED_NAME,
    status: "archived",
    version: 3,
    active_runs: 0,
    trigger: null,
    goal: null,
    stuck_after_days: 0,
    steps: [{ type: "exit", position: 1 }],
  },
};

type ListMode = "good" | "failure";

interface SequencesApiControl {
  detailRequests: string[];
  getFunnelRequestCount: () => number;
  getListRequestCount: () => number;
  getMutationRequestCount: () => number;
  getParticipantRequestCount: () => number;
  setListMode: (mode: ListMode) => void;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installSequencesApi(
  page: Page,
  options: { initialMode?: ListMode } = {},
): Promise<SequencesApiControl> {
  let listMode = options.initialMode ?? "good";
  let listRequestCount = 0;
  let funnelRequestCount = 0;
  let participantRequestCount = 0;
  let mutationRequestCount = 0;
  const detailRequests: string[] = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    if (
      pathname !== "/api/v1/voice/sequences" &&
      !pathname.startsWith("/api/v1/voice/sequences/")
    ) {
      await route.fallback();
      return;
    }

    if (pathname === "/api/v1/voice/sequences" && request.method() === "GET") {
      listRequestCount += 1;
      if (listMode === "failure") {
        await json(
          route,
          {
            error: {
              code: "fixture_sequence_library_unavailable",
              message: "Fixture sequence library refresh failed.",
            },
          },
          503,
        );
        return;
      }
      await json(route, {
        items: SEQUENCE_ROWS.map((row) => ({ ...row })),
        total: SEQUENCE_ROWS.length,
      });
      return;
    }

    const funnelMatch = pathname.match(
      /^\/api\/v1\/voice\/sequences\/([^/]+)\/funnel$/,
    );
    if (funnelMatch && request.method() === "GET") {
      funnelRequestCount += 1;
      await json(route, { sequence_id: funnelMatch[1], steps: [] });
      return;
    }

    const participantsMatch = pathname.match(
      /^\/api\/v1\/voice\/sequences\/([^/]+)\/participants$/,
    );
    if (participantsMatch && request.method() === "GET") {
      participantRequestCount += 1;
      await json(route, { items: [], total: 0, page: 1, per_page: 50 });
      return;
    }

    const detailMatch = pathname.match(
      /^\/api\/v1\/voice\/sequences\/([^/]+)$/,
    );
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]!);
      if (request.method() === "GET") {
        detailRequests.push(id);
        const detail = DETAILS[id];
        if (!detail) {
          await json(
            route,
            { error: { code: "not_found", message: "Sequence not found." } },
            404,
          );
          return;
        }
        await json(route, { ...detail });
        return;
      }
      mutationRequestCount += 1;
      await json(
        route,
        {
          error: {
            code: "fixture_unexpected_sequence_mutation",
            message: "The evidence fixture does not permit sequence writes.",
          },
        },
        409,
      );
      return;
    }

    if (request.method() !== "GET") mutationRequestCount += 1;
    await json(
      route,
      {
        error: {
          code: "fixture_unhandled_sequence_route",
          message: `${request.method()} ${pathname}`,
        },
      },
      501,
    );
  });

  return {
    detailRequests,
    getFunnelRequestCount: () => funnelRequestCount,
    getListRequestCount: () => listRequestCount,
    getMutationRequestCount: () => mutationRequestCount,
    getParticipantRequestCount: () => participantRequestCount,
    setListMode: (mode) => {
      listMode = mode;
    },
  };
}

async function openSequences(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  options: { initialMode?: ListMode; waitForRows?: boolean } = {},
): Promise<SequencesApiControl> {
  await bootApp(page);
  const control = await installSequencesApi(page, options);
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  const requestsBeforeNavigation = control.getListRequestCount();
  await page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="sequences"]')
    .click();
  await expect(
    page.getByRole("heading", { name: "Sequences", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() => control.getListRequestCount())
    .toBeGreaterThan(requestsBeforeNavigation);
  if (options.waitForRows !== false && options.initialMode !== "failure") {
    await expect(
      page.getByRole("button", {
        name: `Open ${DRAFT_NAME} in the draft builder`,
        exact: true,
      }),
    ).toBeVisible();
  }
  return control;
}

async function openSequenceResource(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  id: keyof typeof DETAILS,
): Promise<SequencesApiControl> {
  await bootApp(page);
  const control = await installSequencesApi(page);
  await page.goto(`/app/sequences/${encodeURIComponent(id)}`);
  await waitForPrimaryNavigation(page);
  const detail = DETAILS[id]!;
  await expect(
    page.getByRole("heading", { name: String(detail.name), exact: true }),
  ).toBeVisible();
  await expect.poll(() => control.detailRequests).toContain(id);
  return control;
}

async function assertNoSeriousAxeViolations(page: Page): Promise<void> {
  await page.addScriptTag({ content: AXE_SOURCE });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Document,
            options: {
              runOnly: { type: "tag"; values: string[] };
            },
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[]; failureSummary?: string }>;
            }>;
          }>;
        };
      }
    ).axe;
    const result = await axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    return result.violations
      .filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      )
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failure: node.failureSummary,
        })),
      }));
  });
  expect(violations).toEqual([]);
}

test("the populated library presents confirmed draft truth and an explicit runtime boundary", async ({
  page,
  bootApp,
}) => {
  await openSequences(page, bootApp);

  await expect(page.locator(".page-header .page-subtitle")).toHaveText(
    "Multi-step journey drafts · live runtime unavailable",
  );
  const boundary = page.locator(".seq-library-boundary");
  await expect(
    boundary.getByText("Runtime off", { exact: true }),
  ).toBeVisible();
  await expect(boundary).toContainText(RUNTIME_REASON);

  const rows = page.locator("article.seq-library-row");
  await expect(rows).toHaveCount(SEQUENCE_ROWS.length);
  const draftRow = rows.filter({ hasText: DRAFT_NAME });
  await expect(draftRow.getByText("Draft", { exact: true })).toBeVisible();
  await expect(draftRow).toContainText(
    "3 draft steps · Design and review only",
  );
  const activeRow = rows.filter({ hasText: LEGACY_ACTIVE_NAME });
  await expect(
    activeRow.getByText("Legacy active label", { exact: true }),
  ).toBeVisible();
  await expect(activeRow).toContainText("Design and review only");
  await expect(activeRow).not.toContainText(/37 active runs/i);
  await expect(
    page.getByRole("button", { name: "New draft", exact: true }),
  ).toBeEnabled();
  await assertNoSeriousAxeViolations(page);
});

test("an initial library failure is unavailable and never masquerades as a verified empty workspace", async ({
  page,
  bootApp,
}) => {
  const control = await openSequences(page, bootApp, {
    initialMode: "failure",
    waitForRows: false,
  });

  const failure = page.getByRole("alert").filter({
    has: page.getByRole("heading", {
      name: "Sequence library unavailable",
      exact: true,
    }),
  });
  await expect(failure).toBeVisible();
  await expect(failure).toContainText(
    "No empty-state or deletion claim is being inferred.",
  );
  await expect(failure).toContainText("Server error. Please try again.");
  await expect(
    page.getByText(
      "Design the welcome, the win-back, and everything between.",
      { exact: true },
    ),
  ).toBeHidden();

  control.setListMode("good");
  await failure.getByRole("button", { name: "Retry library" }).click();
  await expect(
    page.getByRole("button", {
      name: `Open ${DRAFT_NAME} in the draft builder`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(failure).toBeHidden();
});

test("a failed refresh keeps the last-confirmed rows and explains the retained snapshot", async ({
  page,
  bootApp,
}) => {
  const control = await openSequences(page, bootApp);
  control.setListMode("failure");

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const retained = page.getByRole("alert").filter({
    hasText: "Showing the last confirmed sequence library.",
  });
  await expect(retained).toBeVisible();
  await expect(retained).toContainText("Server error. Please try again.");
  await expect(
    page.getByRole("button", {
      name: `Open ${DRAFT_NAME} in the draft builder`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: `Open ${LEGACY_ACTIVE_NAME} in the draft builder`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Design the welcome, the win-back, and everything between.",
      { exact: true },
    ),
  ).toBeHidden();

  control.setListMode("good");
  await retained.getByRole("button", { name: "Retry refresh" }).click();
  await expect(retained).toBeHidden();
  await expect(
    page.getByRole("button", {
      name: `Open ${DRAFT_NAME} in the draft builder`,
      exact: true,
    }),
  ).toBeVisible();
});

test("one full-row button opens the canonical resource route by keyboard and hands focus to main content", async ({
  page,
  bootApp,
}) => {
  const control = await openSequences(page, bootApp);
  const row = page
    .locator("article.seq-library-row")
    .filter({ hasText: DRAFT_NAME });
  const opener = row.getByRole("button", {
    name: `Open ${DRAFT_NAME} in the draft builder`,
    exact: true,
  });

  await expect(row.locator("button, a, input, select, textarea")).toHaveCount(
    1,
  );
  const hitTarget = await row.evaluate((element) => {
    const button = element.querySelector("button");
    const rowRect = element.getBoundingClientRect();
    const buttonRect = button?.getBoundingClientRect();
    return {
      rowWidth: rowRect.width,
      rowHeight: rowRect.height,
      buttonWidth: buttonRect?.width ?? 0,
      buttonHeight: buttonRect?.height ?? 0,
    };
  });
  expect(hitTarget.buttonWidth).toBeGreaterThanOrEqual(hitTarget.rowWidth - 2);
  expect(hitTarget.buttonHeight).toBeGreaterThanOrEqual(
    hitTarget.rowHeight - 2,
  );

  await page.keyboard.press("Tab");
  await opener.focus();
  await expect(opener).toBeFocused();
  expect(
    await opener.evaluate((element) => element.matches(":focus-visible")),
  ).toBe(true);
  await opener.press("Enter");

  await expect(page).toHaveURL(
    new RegExp(`/app/sequences/${SEQUENCE_IDS.draft}$`),
  );
  await expect(
    page.getByRole("heading", { name: DRAFT_NAME, exact: true }),
  ).toBeVisible();
  await expect.poll(() => control.detailRequests).toContain(SEQUENCE_IDS.draft);
  await expect(
    page.getByRole("main", { name: "Sequences content" }),
  ).toBeFocused();
  await assertNoSeriousAxeViolations(page);
});

test("a direct canonical draft route preserves identity and keeps every live-operation affordance inert", async ({
  page,
  bootApp,
}) => {
  const control = await openSequenceResource(page, bootApp, SEQUENCE_IDS.draft);

  expect(new URL(page.url()).pathname).toBe(
    `/app/sequences/${SEQUENCE_IDS.draft}`,
  );
  expect(control.detailRequests).toEqual([SEQUENCE_IDS.draft]);
  const runtimeBoundary = page.getByRole("region", {
    name: "Design the journey here. Keep live delivery off.",
  });
  await expect(runtimeBoundary).toContainText(RUNTIME_REASON);
  const readiness = runtimeBoundary.getByRole("list", {
    name: "Sequence readiness",
  });
  await expect(readiness.getByRole("listitem")).toHaveCount(3);
  await expect(readiness.getByRole("listitem").nth(0)).toContainText(
    "Draft & review",
  );
  await expect(readiness.getByRole("listitem").nth(0)).toContainText(
    "Available now",
  );
  await expect(readiness.getByRole("listitem").nth(1)).toContainText(
    "Entry & enrollment",
  );
  await expect(readiness.getByRole("listitem").nth(1)).toContainText(
    "Runtime required",
  );
  await expect(readiness.getByRole("listitem").nth(2)).toContainText(
    "Delivery & analytics",
  );
  await expect(readiness.getByRole("listitem").nth(2)).toContainText(
    "Runtime required",
  );

  await expect(page.locator(".seq-canvas-toolbar .badge")).toHaveText("Draft");
  const subscribers = page
    .getByRole("main", { name: "Sequences content" })
    .getByRole("button", {
      name: "Subscribers",
      exact: true,
    });
  const metrics = page.getByRole("button", {
    name: "Refresh metrics",
    exact: true,
  });
  const trigger = page
    .getByRole("region", { name: "Sequence entry trigger" })
    .getByRole("button", { name: "Runtime required", exact: true });
  await expect(subscribers).toBeDisabled();
  await expect(metrics).toBeDisabled();
  await expect(trigger).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Add Email step at the end" }),
  ).not.toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByRole("button", { name: "Edit step 1", exact: true }),
  ).toBeEnabled();

  await subscribers.evaluate((button) => (button as HTMLButtonElement).click());
  await metrics.evaluate((button) => (button as HTMLButtonElement).click());
  await trigger.evaluate((button) => (button as HTMLButtonElement).click());
  expect(control.getFunnelRequestCount()).toBe(0);
  expect(control.getParticipantRequestCount()).toBe(0);
  expect(control.getMutationRequestCount()).toBe(0);
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("a legacy active label is explicit and the non-draft canvas is structurally read-only", async ({
  page,
  bootApp,
}) => {
  const control = await openSequenceResource(
    page,
    bootApp,
    SEQUENCE_IDS.legacyActive,
  );

  await expect(page.locator(".seq-canvas-toolbar .badge")).toHaveText(
    "Legacy active label",
  );
  const runtimeBoundary = page.getByRole("region", {
    name: "Design the journey here. Keep live delivery off.",
  });
  await expect(runtimeBoundary).toContainText(
    "Stored state: Legacy active label",
  );
  await expect(runtimeBoundary).toContainText(
    "this build has no qualified sequence runtime",
  );
  await expect(
    page
      .getByRole("region", { name: "Sequence step canvas" })
      .getByText(
        "Only confirmed drafts are editable. Stored state: Legacy active label.",
        { exact: true },
      ),
  ).toBeVisible();
  const paletteButtons = page
    .getByRole("complementary", { name: "Step palette" })
    .getByRole("button");
  await expect(paletteButtons).toHaveCount(6);
  for (let index = 0; index < 6; index += 1) {
    await expect(paletteButtons.nth(index)).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  }
  await expect(
    page.getByRole("button", { name: "Edit step 1", exact: true }),
  ).toBeDisabled();
  await expect(
    page
      .getByRole("main", { name: "Sequences content" })
      .getByRole("button", { name: "Subscribers", exact: true }),
  ).toBeDisabled();
  expect(control.getFunnelRequestCount()).toBe(0);
  expect(control.getParticipantRequestCount()).toBe(0);
  expect(control.getMutationRequestCount()).toBe(0);
});

test("the compact detail layout stacks capability and authoring controls without page-level overflow", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.setViewportSize({ width: 560, height: 820 });
  await setTheme(page, "light");
  await openSequenceResource(page, bootApp, SEQUENCE_IDS.draft);

  const layout = await page.evaluate(() => {
    const runtime = document.querySelector<HTMLElement>(
      ".seq-runtime-capability-map",
    );
    const shell = document.querySelector<HTMLElement>(".step-canvas-shell");
    const palette = document.querySelector<HTMLElement>(".step-palette-tiles");
    return {
      viewport: window.innerWidth,
      rootWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      pageScroll: window.scrollX,
      runtimeColumns: runtime
        ? getComputedStyle(runtime).gridTemplateColumns.split(" ").length
        : 0,
      shellDirection: shell ? getComputedStyle(shell).flexDirection : "",
      paletteColumns: palette
        ? getComputedStyle(palette).gridTemplateColumns.split(" ").length
        : 0,
    };
  });
  expect(layout.rootWidth).toBeLessThanOrEqual(layout.viewport + 1);
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport + 1);
  expect(layout.pageScroll).toBe(0);
  expect(layout.runtimeColumns).toBe(1);
  expect(layout.shellDirection).toBe("column");
  expect(layout.paletteColumns).toBe(1);

  const triggerAction = page
    .getByRole("region", { name: "Sequence entry trigger" })
    .getByRole("button", { name: "Runtime required" });
  await triggerAction.scrollIntoViewIfNeeded();
  const actionBox = await triggerAction.boundingBox();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.x).toBeGreaterThanOrEqual(0);
  expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(560);
});
