import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const CAMPAIGN_IDS = {
  draft: "11111111-1111-4111-8111-111111111111",
  scheduled: "22222222-2222-4222-8222-222222222222",
  sent: "33333333-3333-4333-8333-333333333333",
  created: "44444444-4444-4444-8444-444444444444",
} as const;

interface VisualCampaign extends Record<string, unknown> {
  id: string;
  name: string;
  subject: string;
  status: string;
}

const INITIAL_CAMPAIGNS: VisualCampaign[] = [
  {
    id: CAMPAIGN_IDS.draft,
    name: "Lifecycle welcome series",
    subject: "A better first week with Moosewave",
    status: "draft",
    created_at: "2026-07-19T08:00:00.000Z",
    folder_id: "folder-lifecycle",
    body_html: "<h1>Welcome</h1><p>Your first week starts here.</p>",
    preview_text: "Three steps to a stronger first week",
    delivery_settings: { from_email: "hello@postwave.example" },
  },
  {
    id: CAMPAIGN_IDS.scheduled,
    name: "Customer intelligence briefing",
    subject: "Signals worth acting on this week",
    status: "scheduled",
    created_at: "2026-07-18T09:00:00.000Z",
    scheduled_at: "2026-07-22T09:30:00.000Z",
    folder_id: null,
    body_html: "<h1>Signals</h1><p>Your weekly customer briefing.</p>",
    delivery_settings: { from_email: "briefing@postwave.example" },
  },
  {
    id: CAMPAIGN_IDS.sent,
    name: "July product digest",
    subject: "Everything we shipped in July",
    status: "sent",
    created_at: "2026-07-15T07:00:00.000Z",
    sent_at: "2026-07-18T14:00:00.000Z",
    open_rate: 0.447,
    click_rate: 0.093,
    folder_id: "folder-product",
    body_html: "<h1>July digest</h1><p>See what shipped.</p>",
    delivery_settings: { from_email: "product@postwave.example" },
  },
];

const RECOVERED_CAMPAIGNS: VisualCampaign[] = [
  {
    ...INITIAL_CAMPAIGNS[0],
    name: "Recovered lifecycle launch",
    subject: "The server-confirmed lifecycle plan",
  },
  INITIAL_CAMPAIGNS[1]!,
  INITIAL_CAMPAIGNS[2]!,
];

type UserRole = "admin" | "viewer";
type ListMode = "good" | "failure";

interface Gate {
  promise: Promise<void>;
  release: () => void;
}

interface QueuedListResponse {
  gate: Gate;
  kind: "success" | "failure";
  rows?: VisualCampaign[];
  message?: string;
}

interface CampaignsApiControl {
  createBodies: Array<Record<string, unknown>>;
  enqueueListSuccess: (rows: VisualCampaign[]) => Gate;
  getListRequestCount: () => number;
  getListSettlementCount: () => number;
  pauseNextUpdate: () => Gate;
  setListMode: (mode: ListMode) => void;
  setRows: (rows: VisualCampaign[]) => void;
  updateBodies: Array<Record<string, unknown>>;
}

function gate(): Gate {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function jsonAfterPotentialAbort(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  try {
    await json(route, body, status);
  } catch {
    // A newer Campaigns load deliberately aborts the superseded fetch. The
    // route still settles its gate so the test can prove that a late server
    // response cannot overwrite the newer request's state.
  }
}

function cloneCampaigns(rows: VisualCampaign[]): VisualCampaign[] {
  return rows.map((row) => ({ ...row }));
}

function failureBody(message: string): Record<string, unknown> {
  return {
    error: {
      code: "fixture_campaigns_unavailable",
      message,
    },
  };
}

async function installCampaignsApi(
  page: Page,
  options: {
    role?: UserRole;
    initialMode?: ListMode;
    initialRows?: VisualCampaign[];
  } = {},
): Promise<CampaignsApiControl> {
  const role = options.role ?? "admin";
  let listMode = options.initialMode ?? "good";
  let rows = cloneCampaigns(options.initialRows ?? INITIAL_CAMPAIGNS);
  let listRequestCount = 0;
  let listSettlementCount = 0;
  let updateGate: Gate | null = null;
  const queuedListResponses: QueuedListResponse[] = [];
  const createBodies: Array<Record<string, unknown>> = [];
  const updateBodies: Array<Record<string, unknown>> = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;

    if (pathname === "/api/v1/auth/me" && request.method() === "GET") {
      await json(route, {
        user_id: `visual-${role}`,
        tenant_id: "campaigns-test-tenant",
        email: `${role}@campaigns.example.invalid`,
        role,
        effective_role: role,
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Campaign qualification",
        workspace_slug: "campaigns-test-tenant",
      });
      return;
    }

    if (pathname === "/api/v1/me" && request.method() === "GET") {
      await json(route, {
        user: `${role}@campaigns.example.invalid`,
        tenant: "Campaign qualification",
      });
      return;
    }

    if (
      pathname === "/api/v1/feature-flags/subject_lab/resolve" &&
      request.method() === "GET"
    ) {
      await json(route, {
        key: "subject_lab",
        value: "false",
        source: "default",
      });
      return;
    }

    if (pathname === "/api/v1/a11y/check" && request.method() === "POST") {
      await json(route, {
        findings: [],
        counts: { info: 0, warn: 0, error: 0 },
        score: 100,
      });
      return;
    }

    if (
      pathname === "/api/v1/send-window/check" &&
      request.method() === "POST"
    ) {
      await json(route, {
        inside_window: true,
        enforcement: "allow",
        should: "allow",
        reason: "The deterministic qualification clock is in the send window.",
      });
      return;
    }

    if (
      pathname === "/api/v1/campaigns/folders" &&
      request.method() === "GET"
    ) {
      await json(route, {
        items: [
          {
            id: "folder-lifecycle",
            name: "Lifecycle",
            campaign_count: 1,
          },
          {
            id: "folder-product",
            name: "Product",
            campaign_count: 1,
          },
        ],
      });
      return;
    }

    if (pathname === "/api/v1/campaigns/count" && request.method() === "GET") {
      const byStatus = rows.reduce<Record<string, number>>((counts, row) => {
        counts[row.status] = (counts[row.status] ?? 0) + 1;
        return counts;
      }, {});
      await json(route, { total: rows.length, by_status: byStatus });
      return;
    }

    if (pathname === "/api/v1/campaigns" && request.method() === "GET") {
      listRequestCount += 1;
      const queued = queuedListResponses.shift();
      try {
        if (queued) {
          await queued.gate.promise;
          if (queued.kind === "failure") {
            await jsonAfterPotentialAbort(
              route,
              failureBody(queued.message ?? "Fixture campaign refresh failed."),
              503,
            );
          } else {
            const responseRows = cloneCampaigns(queued.rows ?? []);
            await jsonAfterPotentialAbort(route, {
              items: responseRows,
              total: responseRows.length,
              page: 1,
              per_page: 100,
            });
          }
          return;
        }
        if (listMode === "failure") {
          await json(
            route,
            failureBody("Fixture campaign refresh failed."),
            503,
          );
          return;
        }
        await json(route, {
          items: cloneCampaigns(rows),
          total: rows.length,
          page: 1,
          per_page: 100,
        });
      } finally {
        listSettlementCount += 1;
      }
      return;
    }

    if (pathname === "/api/v1/campaigns" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      createBodies.push(body);
      const deliverySettings = body.delivery_settings as
        | { from_email?: unknown }
        | undefined;
      const created: VisualCampaign = {
        id: CAMPAIGN_IDS.created,
        name: String(body.name ?? ""),
        subject: String(body.subject ?? ""),
        status: "draft",
        created_at: "2026-07-20T10:00:00.000Z",
        body_html: String(body.body_html ?? ""),
        preview_text:
          typeof body.preview_text === "string" ? body.preview_text : "",
        delivery_settings: {
          from_email:
            typeof deliverySettings?.from_email === "string"
              ? deliverySettings.from_email
              : "",
        },
      };
      rows = [created, ...rows];
      await json(route, created, 201);
      return;
    }

    const reportMatch = pathname.match(
      /^\/api\/v1\/campaigns\/([^/]+)\/report$/,
    );
    if (reportMatch && request.method() === "GET") {
      const campaignId = decodeURIComponent(reportMatch[1]!);
      const source = rows.find((row) => row.id === campaignId);
      const sent = source?.status === "sent";
      await json(route, {
        campaign_id: campaignId,
        sent: sent ? 2_400 : 0,
        delivered: sent ? 2_352 : 0,
        opens: sent ? 1_051 : 0,
        clicks: sent ? 219 : 0,
        bounces: sent ? 48 : 0,
        complaints: sent ? 2 : 0,
        unsubscribes: sent ? 8 : 0,
        open_rate: sent ? 0.447 : 0,
        click_rate: sent ? 0.093 : 0,
        human_opens: sent ? 920 : 0,
        human_open_rate: sent ? 0.391 : 0,
        human_click_rate: sent ? 0.087 : 0,
        top_links: [],
        human_top_links: [],
        bot_signatures_applied: sent ? ["apple_mpp"] : [],
      });
      return;
    }

    const checklistMatch = pathname.match(
      /^\/api\/v1\/campaigns\/([^/]+)\/checklist$/,
    );
    if (checklistMatch && request.method() === "GET") {
      await json(route, {
        campaign_id: decodeURIComponent(checklistMatch[1]!),
        ready: true,
        checks: [
          {
            key: "subject",
            label: "Subject line",
            status: "pass",
            detail: "A subject line is present.",
          },
          {
            key: "from_domain",
            label: "Sending domain",
            status: "pass",
            detail: "The campaign From domain is verified.",
          },
        ],
      });
      return;
    }

    if (
      /^\/api\/v1\/campaigns\/[^/]+\/check-links$/.test(pathname) &&
      request.method() === "POST"
    ) {
      await json(route, []);
      return;
    }

    if (
      /^\/api\/v1\/campaigns\/[^/]+\/content-optimizer$/.test(pathname) &&
      request.method() === "GET"
    ) {
      await json(
        route,
        { error: { code: "not_found", message: "No optimizer run exists." } },
        404,
      );
      return;
    }

    const sendPreviewMatch = pathname.match(
      /^\/api\/v1\/campaigns\/([^/]+)\/send-preview$/,
    );
    if (sendPreviewMatch && request.method() === "GET") {
      await json(route, {
        campaign_id: decodeURIComponent(sendPreviewMatch[1]!),
        audience_kind: "list",
        segment_label: "Lifecycle members",
        recipients: 1_284,
        suppressed_excluded: 14,
        deliverable: 1_270,
        tier_cap_today: 10_000,
        tier_cap_remaining: 8_600,
        tier_cap_remaining_after: 7_330,
        over_cap: false,
        counted_at: "2026-07-20T10:00:00.000Z",
      });
      return;
    }

    if (
      /^\/api\/v1\/campaigns\/[^/]+\/feedback$/.test(pathname) &&
      request.method() === "GET"
    ) {
      await json(route, { items: [] });
      return;
    }

    const repliesMatch = pathname.match(
      /^\/api\/v1\/campaigns\/([^/]+)\/replies$/,
    );
    if (repliesMatch && request.method() === "GET") {
      await json(route, {
        campaign_id: decodeURIComponent(repliesMatch[1]!),
        count: 0,
        intent_counts: {},
        replies: [],
      });
      return;
    }

    const translationsMatch = pathname.match(
      /^\/api\/v1\/campaigns\/([^/]+)\/translations$/,
    );
    if (translationsMatch && request.method() === "GET") {
      await json(route, {
        campaign_id: decodeURIComponent(translationsMatch[1]!),
        translations: [],
      });
      return;
    }

    const regionsMatch = pathname.match(
      /^\/api\/v1\/campaigns\/([^/]+)\/regions$/,
    );
    if (regionsMatch && request.method() === "GET") {
      await json(route, {
        campaign_id: decodeURIComponent(regionsMatch[1]!),
        regions: [],
      });
      return;
    }

    if (
      /^\/api\/v1\/campaigns\/[^/]+\/(?:holdout(?:\/lift)?|summary)$/.test(
        pathname,
      ) &&
      request.method() === "GET"
    ) {
      await json(
        route,
        { error: { code: "not_found", message: "Not configured." } },
        404,
      );
      return;
    }

    const detailMatch = pathname.match(/^\/api\/v1\/campaigns\/([^/]+)$/);
    if (detailMatch && request.method() === "PATCH") {
      const campaignId = decodeURIComponent(detailMatch[1]!);
      const body = request.postDataJSON() as Record<string, unknown>;
      updateBodies.push(body);
      const pending = updateGate;
      updateGate = null;
      if (pending) await pending.promise;
      const source = rows.find((row) => row.id === campaignId);
      if (!source) {
        await json(
          route,
          { error: { code: "not_found", message: "Campaign not found." } },
          404,
        );
        return;
      }
      const updated: VisualCampaign = { ...source, ...body };
      rows = rows.map((row) => (row.id === campaignId ? updated : row));
      await json(route, updated);
      return;
    }
    if (detailMatch && request.method() === "GET") {
      const campaignId = decodeURIComponent(detailMatch[1]!);
      const source = rows.find((row) => row.id === campaignId);
      if (!source) {
        await json(
          route,
          { error: { code: "not_found", message: "Campaign not found." } },
          404,
        );
        return;
      }
      const deliverySettings = source.delivery_settings as
        | { from_email?: string }
        | undefined;
      await json(route, {
        ...source,
        from_email: deliverySettings?.from_email ?? "hello@postwave.example",
        updated_at: "2026-07-20T09:45:00.000Z",
      });
      return;
    }

    await route.fallback();
  });

  return {
    createBodies,
    enqueueListSuccess: (nextRows) => {
      const responseGate = gate();
      queuedListResponses.push({
        gate: responseGate,
        kind: "success",
        rows: cloneCampaigns(nextRows),
      });
      return responseGate;
    },
    getListRequestCount: () => listRequestCount,
    getListSettlementCount: () => listSettlementCount,
    pauseNextUpdate: () => {
      const pending = gate();
      updateGate = pending;
      return pending;
    },
    setListMode: (nextMode) => {
      listMode = nextMode;
    },
    setRows: (nextRows) => {
      rows = cloneCampaigns(nextRows);
    },
    updateBodies,
  };
}

async function openCampaigns(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  options: {
    role?: UserRole;
    initialMode?: ListMode;
    initialRows?: VisualCampaign[];
    waitForRows?: boolean;
  } = {},
): Promise<CampaignsApiControl> {
  await bootApp(page);
  await page.clock.setFixedTime(new Date("2026-07-20T10:00:00.000Z"));
  const control = await installCampaignsApi(page, options);
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await expect
    .poll(
      () => control.getListRequestCount() - control.getListSettlementCount(),
    )
    .toBe(0);
  const preNavigationRequests = control.getListRequestCount();
  await page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="campaigns"]')
    .click();
  await expect(
    page.getByRole("heading", { name: "Campaigns", exact: true }).first(),
  ).toBeVisible();
  await expect
    .poll(() => control.getListRequestCount())
    .toBeGreaterThan(preNavigationRequests);
  await expect
    .poll(
      () => control.getListRequestCount() - control.getListSettlementCount(),
    )
    .toBe(0);
  if (options.waitForRows !== false && options.initialMode !== "failure") {
    const firstName = (options.initialRows ?? INITIAL_CAMPAIGNS)[0]?.name;
    if (firstName) {
      await expect(page.getByText(firstName, { exact: true })).toBeVisible();
    }
  }
  return control;
}

async function assertNoSeriousAxeViolations(
  page: Page,
  options: { disableColorContrast?: boolean } = {},
): Promise<void> {
  await page.addScriptTag({ content: AXE_SOURCE });
  const violations = await page.evaluate(async (disableColorContrast) => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Document,
            options: {
              runOnly: { type: "tag"; values: string[] };
              rules?: Record<string, { enabled: boolean }>;
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
      ...(disableColorContrast
        ? { rules: { "color-contrast": { enabled: false } } }
        : {}),
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
  }, options.disableColorContrast ?? false);
  expect(violations).toEqual([]);
}

for (const theme of ["dark", "light"] as const) {
  test(`Campaigns populated list is semantic and axe-clean in ${theme} theme`, async ({
    page,
    bootApp,
    setTheme,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await setTheme(page, theme);
    await openCampaigns(page, bootApp);

    await expect(page.locator(".page-header .page-subtitle")).toHaveText(
      "3 campaigns · complete workspace snapshot",
    );
    await expect(
      page.getByText("Lifecycle welcome series", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Customer intelligence briefing", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("July product digest", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Open rate: 44.7%", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Click rate: 9.3%", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New campaign", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("checkbox", { name: "Select all on page" }),
    ).not.toBeChecked();
    await assertNoSeriousAxeViolations(page);
  });
}

test("an initial Campaigns failure is unavailable, never a verified empty state", async ({
  page,
  bootApp,
}) => {
  await openCampaigns(page, bootApp, {
    initialMode: "failure",
    waitForRows: false,
  });

  await expect(page.locator(".page-header .page-subtitle")).toHaveText(
    "Unavailable",
  );
  await expect(
    page.getByText("Campaigns are unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No verified campaign snapshot is available.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Campaign data unavailable",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Ship campaigns that land — and prove it.", {
      exact: true,
    }),
  ).toBeHidden();
  await expect(page.getByText("0 campaigns", { exact: true })).toBeHidden();
});

test("a failed refresh retains the last-confirmed rows and a retry reconciles fresh truth", async ({
  page,
  bootApp,
}) => {
  const control = await openCampaigns(page, bootApp);
  control.setListMode("failure");

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("Showing last-confirmed campaigns", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".page-header .page-subtitle")).toContainText(
    "3 campaigns · complete last-confirmed snapshot",
  );
  await expect(
    page.getByText("Lifecycle welcome series", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Refresh failed\. The retained snapshot contains 3 loaded campaigns/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Ship campaigns that land — and prove it.", {
      exact: true,
    }),
  ).toBeHidden();

  control.setRows(RECOVERED_CAMPAIGNS);
  control.setListMode("good");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByText("Recovered lifecycle launch", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Showing last-confirmed campaigns", { exact: true }),
  ).toBeHidden();
  await expect(page.locator(".page-header .page-subtitle")).toHaveText(
    "3 campaigns · complete workspace snapshot",
  );
});

test("the newest Campaigns request wins when a superseded refresh responds late", async ({
  page,
  bootApp,
}) => {
  const control = await openCampaigns(page, bootApp);
  const baselineRequests = control.getListRequestCount();
  const baselineSettlements = control.getListSettlementCount();
  const oldResponse = control.enqueueListSuccess([
    {
      ...INITIAL_CAMPAIGNS[0],
      name: "Superseded server snapshot",
    },
  ]);
  const newestResponse = control.enqueueListSuccess([
    {
      ...INITIAL_CAMPAIGNS[0],
      name: "Newest confirmed snapshot",
    },
    INITIAL_CAMPAIGNS[1]!,
    INITIAL_CAMPAIGNS[2]!,
    {
      id: CAMPAIGN_IDS.created,
      name: "Concurrent mutation draft",
      subject: "A mutation-triggered reconciliation",
      status: "draft",
      created_at: "2026-07-20T10:00:00.000Z",
      body_html: "",
      delivery_settings: {
        from_email: "campaigns@postwave.example",
      },
    },
  ]);
  const refresh = page.getByRole("button", {
    name: /^Refresh(?:ing…)?$/,
  });

  try {
    await refresh.click();
    await expect
      .poll(() => control.getListRequestCount())
      .toBe(baselineRequests + 1);
    const create = page.getByRole("button", {
      name: "New campaign",
      exact: true,
    });
    await create.click();
    const dialog = page.getByRole("dialog", { name: "New campaign" });
    await dialog.locator("#cam-name").fill("Concurrent mutation draft");
    await dialog
      .locator("#cam-subject")
      .fill("A mutation-triggered reconciliation");
    await dialog.locator("#cam-from").fill("campaigns@postwave.example");
    await dialog.getByRole("button", { name: "Create draft" }).click();
    await expect
      .poll(() => control.getListRequestCount())
      .toBe(baselineRequests + 2);

    newestResponse.release();
    await expect(
      page.getByText("Newest confirmed snapshot", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Superseded server snapshot", { exact: true }),
    ).toBeHidden();

    oldResponse.release();
    await expect
      .poll(() => control.getListSettlementCount())
      .toBe(baselineSettlements + 2);
    await expect(
      page.getByText("Newest confirmed snapshot", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Superseded server snapshot", { exact: true }),
    ).toBeHidden();
  } finally {
    newestResponse.release();
    oldResponse.release();
  }
});

test("viewer Move controls are natively unavailable to pointer, keyboard, and assistive technology", async ({
  page,
  bootApp,
}) => {
  await openCampaigns(page, bootApp, { role: "viewer" });

  const rowMoves = page.getByRole("button", { name: "Move", exact: true });
  await expect(rowMoves).toHaveCount(INITIAL_CAMPAIGNS.length);
  for (let index = 0; index < INITIAL_CAMPAIGNS.length; index += 1) {
    const move = rowMoves.nth(index);
    await expect(move).toBeDisabled();
    await expect(move).toHaveAttribute("aria-disabled", "true");
    await expect(move).toHaveAccessibleDescription(/edit access/i);
  }

  const programmaticResult = await rowMoves.first().evaluate((button) => {
    const nativeButton = button as HTMLButtonElement;
    nativeButton.click();
    nativeButton.focus();
    return document.activeElement === button;
  });
  expect(programmaticResult).toBe(false);
  await expect(page.getByRole("dialog", { name: /^Move / })).toBeHidden();

  await page
    .getByRole("checkbox", { name: "Select Lifecycle welcome series" })
    .check();
  const bulkMove = page.getByRole("button", {
    name: "Move to folder",
    exact: true,
  });
  await expect(bulkMove).toBeDisabled();
  await expect(bulkMove).toHaveAccessibleDescription(/edit access/i);
  await expect(
    page.getByText(
      "Viewer access is read-only; an editor or admin can create campaigns.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("list search, status filtering, and calendar switching preserve the same campaign set", async ({
  page,
  bootApp,
}) => {
  await openCampaigns(page, bootApp);
  const search = page.getByPlaceholder("Search campaigns…");

  await search.fill("intelligence");
  await expect(
    page.getByText("Customer intelligence briefing", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Lifecycle welcome series", { exact: true }),
  ).toBeHidden();
  await search.clear();

  const sentChoice = page.getByRole("radio", { name: "Sent", exact: true });
  await sentChoice.locator("..").click();
  await expect(sentChoice).toBeChecked();
  await expect(
    page.getByText("July product digest", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Customer intelligence briefing", { exact: true }),
  ).toBeHidden();
  const allChoice = page.getByRole("radio", { name: "All", exact: true });
  await allChoice.locator("..").click();
  await expect(allChoice).toBeChecked();

  const calendarChoice = page.getByRole("radio", {
    name: "Calendar",
    exact: true,
  });
  await calendarChoice.locator("..").click();
  await expect(calendarChoice).toBeChecked();
  const calendar = page.getByRole("grid", {
    name: "July 2026 campaign schedule",
  });
  await expect(calendar).toBeVisible();
  await expect(
    calendar.getByRole("button", {
      name: "Open Customer intelligence briefing, scheduled",
    }),
  ).toBeVisible();
  await expect(
    calendar.getByRole("button", {
      name: "Open July product digest, sent",
    }),
  ).toBeVisible();

  const listChoice = page.getByRole("radio", { name: "List", exact: true });
  await listChoice.locator("..").click();
  await expect(listChoice).toBeChecked();
  await expect(page.locator('[data-tour="campaigns-list"]')).toBeVisible();
  await expect(calendar).toBeHidden();
});

test("admin create owns focus and validation and posts only the strict backend contract", async ({
  page,
  bootApp,
}) => {
  const control = await openCampaigns(page, bootApp);
  const trigger = page.getByRole("button", {
    name: "New campaign",
    exact: true,
  });

  await trigger.click();
  let dialog = page.getByRole("dialog", { name: "New campaign" });
  let name = dialog.locator("#cam-name");
  await expect(name).toBeFocused();
  await name.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Create draft" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  dialog = page.getByRole("dialog", { name: "New campaign" });
  name = dialog.locator("#cam-name");
  await dialog.getByRole("button", { name: "Create draft" }).click();
  await expect(
    dialog.getByText("Name is required.", { exact: true }),
  ).toBeVisible();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  expect(control.createBodies).toHaveLength(0);

  await name.fill("Retention intelligence brief");
  await dialog.locator("#cam-subject").fill("What your customers need next");
  await dialog.locator("#cam-from").fill("not-an-email");
  await dialog.getByRole("button", { name: "Create draft" }).click();
  await expect(
    dialog.getByText("Enter a valid From address.", { exact: true }),
  ).toBeVisible();
  expect(control.createBodies).toHaveLength(0);

  await dialog.locator("#cam-from").fill("campaigns@postwave.example");
  await dialog
    .locator("#cam-preview-text")
    .fill("Three signals to act on today");
  await dialog
    .locator("#cam-body")
    .fill("<h1>Retention signals</h1><p>Act on these three changes.</p>");
  await dialog.getByRole("button", { name: "Create draft" }).click();

  await expect.poll(() => control.createBodies.length).toBe(1);
  expect(control.createBodies[0]).toEqual({
    name: "Retention intelligence brief",
    subject: "What your customers need next",
    body_html: "<h1>Retention signals</h1><p>Act on these three changes.</p>",
    preview_text: "Three signals to act on today",
    delivery_settings: { from_email: "campaigns@postwave.example" },
  });
  expect(control.createBodies[0]).not.toHaveProperty("status");
  expect(control.createBodies[0]).not.toHaveProperty("body");
  expect(control.createBodies[0]).not.toHaveProperty("from_email");
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Retention intelligence brief", { exact: true }),
  ).toBeVisible();
});

test("a populated campaign detail opens as a modal slideover and restores its row action focus", async ({
  page,
  bootApp,
}) => {
  await openCampaigns(page, bootApp);
  const opener = page.getByRole("button", {
    name: "Open Lifecycle welcome series",
    exact: true,
  });
  await opener.click();

  const detail = page.getByRole("dialog", {
    name: "Lifecycle welcome series",
  });
  await expect(detail).toBeVisible();
  await expect(
    detail.getByText("Draft", { exact: true }).first(),
  ).toBeVisible();
  await expect(detail).toContainText("A better first week with Moosewave");
  await expect(detail).toContainText(
    "Performance metrics appear after the campaign sends.",
  );
  await expect(detail.getByRole("button", { name: "Edit" })).toBeEnabled();

  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(opener).toBeFocused();
});

test("every dirty detail exit asks for discard, preserves kept edits, and applies the requested discard scope", async ({
  page,
  bootApp,
}) => {
  await openCampaigns(page, bootApp);
  const opener = page.getByRole("button", {
    name: "Open Lifecycle welcome series",
    exact: true,
  });
  await opener.click();
  const detail = page.getByRole("dialog", {
    name: "Lifecycle welcome series",
  });
  await detail.getByRole("button", { name: "Edit", exact: true }).click();
  let subject = detail.locator("#cam-edit-subject");
  const unsavedSubject = "Unsaved lifecycle subject";
  await subject.fill(unsavedSubject);

  const cancelEdit = detail.getByRole("button", {
    name: "Cancel",
    exact: true,
  });
  await cancelEdit.click();
  let ceremony = page.getByRole("alertdialog", {
    name: "Discard campaign changes?",
  });
  await expect(ceremony).toBeVisible();
  await ceremony
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(ceremony).toBeHidden();
  await expect(subject).toHaveValue(unsavedSubject);
  await expect(cancelEdit).toBeFocused();

  const chromeClose = detail.getByRole("button", {
    name: "Close",
    exact: true,
  });
  await chromeClose.click();
  ceremony = page.getByRole("alertdialog", {
    name: "Discard changes and close?",
  });
  await expect(ceremony).toBeVisible();
  await ceremony
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(ceremony).toBeHidden();
  await expect(subject).toHaveValue(unsavedSubject);
  await expect(chromeClose).toBeFocused();

  await subject.focus();
  await page.locator(".slideover-overlay").click({ position: { x: 8, y: 8 } });
  ceremony = page.getByRole("alertdialog", {
    name: "Discard changes and close?",
  });
  await expect(ceremony).toBeVisible();
  await ceremony
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(ceremony).toBeHidden();
  await expect(subject).toHaveValue(unsavedSubject);
  await expect(subject).toBeFocused();

  await subject.focus();
  await page.keyboard.press("Escape");
  ceremony = page.getByRole("alertdialog", {
    name: "Discard changes and close?",
  });
  await expect(ceremony).toBeVisible();
  await ceremony
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(ceremony).toBeHidden();
  await expect(subject).toHaveValue(unsavedSubject);
  await expect(subject).toBeFocused();

  await cancelEdit.click();
  ceremony = page.getByRole("alertdialog", {
    name: "Discard campaign changes?",
  });
  await ceremony
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(ceremony).toBeHidden();
  await expect(detail).toBeVisible();
  await expect(subject).toBeHidden();
  await expect(
    detail.getByRole("button", { name: "Edit", exact: true }),
  ).toBeVisible();

  await detail.getByRole("button", { name: "Edit", exact: true }).click();
  subject = detail.locator("#cam-edit-subject");
  await subject.fill("Discard this close-scoped edit");
  await detail.getByRole("button", { name: "Close", exact: true }).click();
  ceremony = page.getByRole("alertdialog", {
    name: "Discard changes and close?",
  });
  await ceremony
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(detail).toBeHidden();
  await expect(opener).toBeFocused();
});

test("saving a campaign detail blocks close, backdrop, Cancel, and Escape until settlement", async ({
  page,
  bootApp,
}) => {
  const control = await openCampaigns(page, bootApp);
  const opener = page.getByRole("button", {
    name: "Open Lifecycle welcome series",
    exact: true,
  });
  await opener.click();
  const detail = page.getByRole("dialog", {
    name: "Lifecycle welcome series",
  });
  await detail.getByRole("button", { name: "Edit", exact: true }).click();
  await detail.locator("#cam-edit-subject").fill("Settled subject update");
  const releaseUpdate = control.pauseNextUpdate();

  try {
    await detail
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect.poll(() => control.updateBodies.length).toBe(1);
    await expect(
      detail.getByRole("button", { name: "Saving…", exact: true }),
    ).toBeDisabled();
    const close = detail.getByRole("button", {
      name: "Close",
      exact: true,
    });
    await expect(close).toBeDisabled();
    await expect(
      detail.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeDisabled();

    await page.keyboard.press("Escape");
    await expect(detail).toBeVisible();
    await expect(
      page.getByRole("alertdialog", { name: /Discard campaign changes/ }),
    ).toBeHidden();
    await page
      .locator(".slideover-overlay")
      .click({ position: { x: 8, y: 8 } });
    await expect(detail).toBeVisible();
    await expect(
      page.getByRole("alertdialog", { name: /Discard changes and close/ }),
    ).toBeHidden();

    expect(control.updateBodies[0]).toMatchObject({
      subject: "Settled subject update",
    });
    releaseUpdate.release();
    await expect(
      detail.getByRole("button", { name: "Edit", exact: true }),
    ).toBeVisible();
    await expect(close).toBeEnabled();
    await close.click();
    await expect(detail).toBeHidden();
    await expect(opener).toBeFocused();
  } finally {
    releaseUpdate.release();
  }
});

test("narrow Campaigns layout contains page overflow while retaining horizontal list access", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await setTheme(page, "light");
  await openCampaigns(page, bootApp);

  const search = page.getByPlaceholder("Search campaigns…");
  await search.scrollIntoViewIfNeeded();
  await expect(search).toBeVisible();
  await search.fill("lifecycle");
  await expect(
    page.getByText("Lifecycle welcome series", { exact: true }),
  ).toBeVisible();

  const list = page.locator('[data-tour="campaigns-list"]');
  const containment = await page.evaluate(() => {
    const campaignList = document.querySelector<HTMLElement>(
      '[data-tour="campaigns-list"]',
    );
    return {
      viewport: window.innerWidth,
      rootWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      pageScroll: window.scrollX,
      listClientWidth: campaignList?.clientWidth ?? 0,
      listScrollWidth: campaignList?.scrollWidth ?? 0,
    };
  });
  expect(containment.rootWidth).toBeLessThanOrEqual(containment.viewport + 1);
  expect(containment.bodyWidth).toBeLessThanOrEqual(containment.viewport + 1);
  expect(containment.pageScroll).toBe(0);
  expect(containment.listScrollWidth).toBeGreaterThan(
    containment.listClientWidth,
  );
  await list.evaluate((element) => element.scrollTo({ left: 10_000 }));
  await expect
    .poll(() => list.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
});

test("forced colours, reduced motion, and keyboard view switching preserve Campaigns semantics", async ({
  page,
  bootApp,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await openCampaigns(page, bootApp);

  const listChoice = page.getByRole("radio", { name: "List", exact: true });
  await listChoice.focus();
  await expect(listChoice).toBeFocused();
  await listChoice.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: "Calendar", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("grid", { name: "July 2026 campaign schedule" }),
  ).toBeVisible();

  const media = await page.evaluate(() => ({
    forced: window.matchMedia("(forced-colors: active)").matches,
    reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  expect(media).toEqual({ forced: true, reduced: true });
  await assertNoSeriousAxeViolations(page, { disableColorContrast: true });
});
