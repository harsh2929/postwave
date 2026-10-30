import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const NOW = "2026-07-21T10:00:00.000Z";
const FORM_ID = "11111111-1111-4111-8111-111111111111";
const PRIVATE_RESPONSE_CANARY = "private-response@forms.example.invalid";

const FORM_ROWS = [
  {
    id: FORM_ID,
    name: "Lifecycle launch list",
    slug: "lifecycle-launch",
    status: "published",
    optInMode: "double",
    submissions30d: 128,
    visits30d: 640,
    conversionRate: 20,
    createdAt: "2026-06-01T09:00:00.000Z",
    updatedAt: NOW,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Research waitlist",
    slug: "research-waitlist",
    status: "draft",
    optInMode: "single",
    submissions30d: 24,
    visits30d: 200,
    conversionRate: 12,
    createdAt: "2026-06-18T09:00:00.000Z",
    updatedAt: "2026-07-19T10:00:00.000Z",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Spring event archive",
    slug: "spring-event-archive",
    status: "archived",
    optInMode: "double",
    submissions30d: 0,
    visits30d: 0,
    conversionRate: 0,
    createdAt: "2026-03-03T09:00:00.000Z",
    updatedAt: "2026-06-30T10:00:00.000Z",
  },
] as const;

const LANDING_PAGE = {
  id: "44444444-4444-4444-8444-444444444444",
  tenant_id: "forms-test-tenant",
  slug: "summer-product-story",
  name: "Summer product story",
  status: "published",
  domain: "launch.example.test",
  template: "editorial-product",
  blocks: [{ type: "hero" }, { type: "signup" }],
  seo: {},
  tracking: {},
  metrics: {},
  created_at: "2026-06-14T09:00:00.000Z",
  updated_at: NOW,
};

interface DeferredRequest {
  promise: Promise<void>;
  release: () => void;
}

interface FormsApiControl {
  deferNextCreate: () => () => void;
  deferNextUpdate: () => () => void;
  failNextFormsList: () => void;
  getCreateCount: () => number;
  getFormsListCount: () => number;
  getLandingListCount: () => number;
  getMutationCount: () => number;
  getPrivateResponseRequestCount: () => number;
  getUnsafeRequestPaths: () => string[];
}

function deferredRequest(): DeferredRequest {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function formDetail(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const summary = FORM_ROWS.find((row) => row.id === id) ?? FORM_ROWS[0];
  return {
    ...summary,
    id,
    structure: {
      fields: [
        {
          id: "email",
          kind: "email",
          label: "Work email",
          required: true,
        },
        { id: "submit", kind: "submit", label: "Join the list" },
      ],
    },
    settings: {
      successMessage: "Check your inbox to confirm your place.",
      honeypotEnabled: true,
    },
    ...overrides,
  };
}

function embedContract(
  id: string,
  flavor: string,
): Record<string, unknown> {
  const slug = String(formDetail(id).slug);
  const publicUrl = `https://forms.example.test/forms/${slug}`;
  const snippets: Record<string, string> = {
    iframe: `<iframe src="${publicUrl}" title="Subscribe"></iframe>`,
    script: `<script async src="https://forms.example.test/embed.js" data-form="${id}"></script>`,
    react: `<PostwaveForm formId="${id}" />`,
  };
  return {
    flavor,
    snippet: snippets[flavor] ?? snippets.iframe,
    language: flavor === "react" ? "tsx" : "html",
    instructions: "Use only on a trusted customer-facing property.",
    public_host: "https://forms.example.test",
    public_url: publicUrl,
  };
}

async function json(
  route: Route,
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body),
  });
}

function isWithheldFormsPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/v1/social-capture") ||
    pathname.startsWith("/api/v1/onsite-growth") ||
    pathname.startsWith("/api/v1/tap-to-text") ||
    pathname.startsWith("/api/v1/sms-links") ||
    /^\/api\/v1\/forms\/[^/]+\/variants(?:\/|$)/u.test(pathname)
  );
}

async function installFormsApi(
  page: Page,
  role: "admin" | "viewer" = "admin",
): Promise<FormsApiControl> {
  let createCount = 0;
  let formsListCount = 0;
  let landingListCount = 0;
  let mutationCount = 0;
  let privateResponseRequestCount = 0;
  let listFailuresRemaining = 0;
  let nextCreateGate: DeferredRequest | null = null;
  let nextUpdateGate: DeferredRequest | null = null;
  const unsafeRequestPaths: string[] = [];
  const details = new Map<string, Record<string, unknown>>(
    FORM_ROWS.map((row) => [row.id, formDetail(row.id)]),
  );

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();

    if (pathname === "/api/v1/auth/me") {
      await json(route, {
        user_id: `forms-${role}`,
        tenant_id: "forms-test-tenant",
        email: `${role}@forms.example.invalid`,
        role,
        effective_role: role,
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Forms qualification",
        workspace_slug: "forms-test-tenant",
      });
      return;
    }

    // The shell resolves the saved Dashboard layout even when another
    // destination is active. Keep that unrelated global preference healthy so
    // Forms screenshots and assertions are not obscured by a harness-only
    // fallback toast.
    if (pathname === "/api/v1/dashboard/layout" && method === "GET") {
      await json(route, {
        order: [
          "subs",
          "opens",
          "clicks",
          "bounces",
          "forecast",
          "anomalies",
          "goals",
          "benchmarks",
          "engagement",
          "parity",
          "inbox-health",
          "clv",
        ],
      });
      return;
    }

    if (isWithheldFormsPath(pathname)) {
      unsafeRequestPaths.push(`${method} ${pathname}`);
      if (method !== "GET") mutationCount += 1;
      await json(
        route,
        { error: { code: "withheld_surface_requested" } },
        409,
      );
      return;
    }

    if (pathname === "/api/v1/forms") {
      if (method === "GET") {
        formsListCount += 1;
        if (listFailuresRemaining > 0) {
          listFailuresRemaining -= 1;
          await json(
            route,
            { error: { code: "forms_refresh_failed", message: "Gateway unavailable" } },
            503,
          );
          return;
        }
        await json(route, FORM_ROWS);
        return;
      }
      if (method === "POST") {
        createCount += 1;
        mutationCount += 1;
        const input = request.postDataJSON() as Record<string, unknown>;
        const id = `created-form-${createCount}`;
        const created = formDetail(id, {
          name: input.name,
          slug: input.slug,
          optInMode: input.optInMode,
          status: "draft",
          settings: { successMessage: input.successMessage ?? "" },
        });
        details.set(id, created);
        const gate = nextCreateGate;
        nextCreateGate = null;
        if (gate) await gate.promise;
        await json(route, created, 201);
        return;
      }
    }

    const submissionsMatch = pathname.match(
      /^\/api\/v1\/forms\/([^/]+)\/submissions$/u,
    );
    if (submissionsMatch) {
      privateResponseRequestCount += 1;
      await json(route, [
        {
          id: "response-1",
          formId: submissionsMatch[1],
          email: PRIVATE_RESPONSE_CANARY,
          customFields: { company: "Private response canary" },
          status: "confirmed",
          ip: "192.0.2.8",
          userAgent: "Forms maturity browser",
          submittedAt: NOW,
          confirmedAt: NOW,
        },
      ]);
      return;
    }

    const analyticsMatch = pathname.match(
      /^\/api\/v1\/forms\/([^/]+)\/analytics$/u,
    );
    if (analyticsMatch) {
      await json(route, {
        form_id: analyticsMatch[1],
        days: 30,
        visits: [{ date: "2026-07-21", count: 12 }],
        visits_total: 64,
      });
      return;
    }

    const embedMatch = pathname.match(
      /^\/api\/v1\/forms\/([^/]+)\/embed\/([^/]+)$/u,
    );
    if (embedMatch) {
      await json(route, embedContract(embedMatch[1]!, embedMatch[2]!));
      return;
    }

    const formMatch = pathname.match(/^\/api\/v1\/forms\/([^/]+)$/u);
    if (formMatch) {
      const id = decodeURIComponent(formMatch[1]!);
      if (method === "GET") {
        await json(route, details.get(id) ?? formDetail(id), 200, {
          "Access-Control-Expose-Headers": "ETag",
          ETag: '"forms-v1"',
        });
        return;
      }
      if (method === "PATCH") {
        mutationCount += 1;
        const patch = request.postDataJSON() as Record<string, unknown>;
        const current = details.get(id) ?? formDetail(id);
        const updated = { ...current, ...patch, updatedAt: NOW };
        details.set(id, updated);
        const gate = nextUpdateGate;
        nextUpdateGate = null;
        if (gate) await gate.promise;
        await json(route, updated, 200, {
          "Access-Control-Expose-Headers": "ETag",
          ETag: '"forms-v2"',
        });
        return;
      }
      if (method === "DELETE") {
        mutationCount += 1;
        details.delete(id);
        await json(route, { ok: true });
        return;
      }
    }

    if (pathname === "/api/v1/landing-pages") {
      if (method === "GET") {
        landingListCount += 1;
        await json(route, [LANDING_PAGE]);
        return;
      }
      mutationCount += 1;
      await json(route, LANDING_PAGE, 201);
      return;
    }

    if (pathname.startsWith("/api/v1/landing-pages/")) {
      if (method === "GET") await json(route, LANDING_PAGE);
      else {
        mutationCount += 1;
        await json(
          route,
          method === "DELETE" ? { ok: true } : LANDING_PAGE,
        );
      }
      return;
    }

    await route.fallback();
  });

  return {
    deferNextCreate: () => {
      const gate = deferredRequest();
      nextCreateGate = gate;
      return gate.release;
    },
    deferNextUpdate: () => {
      const gate = deferredRequest();
      nextUpdateGate = gate;
      return gate.release;
    },
    failNextFormsList: () => {
      // The shared GET transport makes up to three attempts on a retryable
      // 5xx. Fail the complete user-initiated refresh, not only its first
      // wire attempt, so this exercises the route's durable stale-data state.
      listFailuresRemaining = 3;
    },
    getCreateCount: () => createCount,
    getFormsListCount: () => formsListCount,
    getLandingListCount: () => landingListCount,
    getMutationCount: () => mutationCount,
    getPrivateResponseRequestCount: () => privateResponseRequestCount,
    getUnsafeRequestPaths: () => [...unsafeRequestPaths],
  };
}

async function openForms(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  role: "admin" | "viewer" = "admin",
): Promise<FormsApiControl> {
  await bootApp(page);
  const control = await installFormsApi(page, role);
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="forms"]')
    .click();
  await expect(
    page.getByRole("heading", { name: "Capture studio", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Lifecycle launch list", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
  return control;
}

async function seriousAxeViolations(
  page: Page,
  options: { disableColorContrast?: boolean } = {},
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async (disableColorContrast) => {
    const result = await (
      window as unknown as {
        axe: {
          run: (
            root: Document | Element,
            options?: Record<string, unknown>,
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[]; failureSummary?: string }>;
            }>;
          }>;
        };
      }
    ).axe.run(document.querySelector(".forms-page") ?? document, {
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
}

for (const theme of ["dark", "light"] as const) {
  test(`Forms is populated, axe-clean, and visually contained in ${theme} theme`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1_000 });
    await setTheme(page, theme);
    await openForms(page, bootApp);

    await expect(page.getByText("Know what reaches a customer")).toBeVisible();
    await expect(page.getByText("3 forms in this workspace")).toBeVisible();
    await expect(page.getByText("Lifecycle launch list")).toBeVisible();
    await expect(page.getByText("Research waitlist")).toBeVisible();
    await expect(page.getByText("Spring event archive")).toBeVisible();
    const optInContrast = await page
      .locator(".form-tile .badge.accent")
      .first()
      .evaluate((element) => {
        type Rgba = [number, number, number, number];
        const parse = (value: string): Rgba => {
          const channels = value.match(/[\d.]+/gu)?.map(Number);
          if (!channels || channels.length < 3) {
            throw new Error(`Unsupported computed color: ${value}`);
          }
          const srgbFunction = value.startsWith("color(srgb");
          return [
            srgbFunction ? channels[0]! * 255 : channels[0]!,
            srgbFunction ? channels[1]! * 255 : channels[1]!,
            srgbFunction ? channels[2]! * 255 : channels[2]!,
            channels[3] ?? 1,
          ];
        };
        const composite = (foreground: Rgba, background: Rgba): Rgba => {
          const alpha =
            foreground[3] + background[3] * (1 - foreground[3]);
          if (alpha === 0) return [0, 0, 0, 0];
          return [
            (foreground[0] * foreground[3] +
              background[0] * background[3] * (1 - foreground[3])) /
              alpha,
            (foreground[1] * foreground[3] +
              background[1] * background[3] * (1 - foreground[3])) /
              alpha,
            (foreground[2] * foreground[3] +
              background[2] * background[3] * (1 - foreground[3])) /
              alpha,
            alpha,
          ];
        };
        const luminance = (channels: Rgba): number => {
          const linear = channels.slice(0, 3).map((channel) => {
            const normalized = channel / 255;
            return normalized <= 0.04045
              ? normalized / 12.92
              : ((normalized + 0.055) / 1.055) ** 2.4;
          });
          return (
            0.2126 * linear[0]! +
            0.7152 * linear[1]! +
            0.0722 * linear[2]!
          );
        };
        const style = getComputedStyle(element);
        const foreground = style.color;
        const background = style.backgroundColor;
        let effectiveBackground = parse(background);
        let ancestor = element.parentElement;
        while (effectiveBackground[3] < 0.999 && ancestor) {
          effectiveBackground = composite(
            effectiveBackground,
            parse(getComputedStyle(ancestor).backgroundColor),
          );
          ancestor = ancestor.parentElement;
        }
        const effectiveForeground = composite(
          parse(foreground),
          effectiveBackground,
        );
        const lighter = Math.max(
          luminance(effectiveForeground),
          luminance(effectiveBackground),
        );
        const darker = Math.min(
          luminance(effectiveForeground),
          luminance(effectiveBackground),
        );
        return {
          background,
          effectiveBackground,
          foreground,
          ratio: (lighter + 0.05) / (darker + 0.05),
        };
      });
    expect(optInContrast.ratio).toBeGreaterThanOrEqual(4.5);
    await testInfo.attach(`forms-${theme}-measurements.json`, {
      body: JSON.stringify({ optInContrast }, null, 2),
      contentType: "application/json",
    });
    // eslint-disable-next-line no-console -- qualification evidence in CI output
    console.info(`[forms-measurement:${theme}] ${JSON.stringify(optInContrast)}`);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`forms-${theme}.png`),
      fullPage: true,
    });
  });
}

test("capture surfaces use APG keyboard tabs, lazy-load Landing once, and keep Social side-effect free", async ({
  page,
  bootApp,
}) => {
  const control = await openForms(page, bootApp);
  expect(control.getLandingListCount()).toBe(0);

  const tabs = page.getByRole("tablist", { name: "Capture studio sections" });
  const library = tabs.getByRole("tab", { name: /Forms library/u });
  const landing = tabs.getByRole("tab", { name: /Landing pages/u });
  const social = tabs.getByRole("tab", { name: /Social capture/u });
  await library.focus();
  await library.press("ArrowRight");
  await expect(landing).toBeFocused();
  await expect(landing).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Landing pages" })).toBeVisible();
  await expect(page.getByText("Summer product story")).toBeVisible();
  expect(control.getLandingListCount()).toBe(1);

  await landing.press("End");
  await expect(social).toBeFocused();
  await expect(social).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Social capture is staged, not live." }),
  ).toBeVisible();
  await expect(page.getByText("No hidden side effects")).toBeVisible();
  expect(control.getUnsafeRequestPaths()).toEqual([]);

  await social.press("Home");
  await expect(library).toHaveAttribute("aria-selected", "true");
  await library.press("ArrowRight");
  await expect(landing).toHaveAttribute("aria-selected", "true");
  expect(control.getLandingListCount()).toBe(1);
});

test("keyboard form creation validates input, single-flights submit, and locks dismissal while pending", async ({
  page,
  bootApp,
}) => {
  const control = await openForms(page, bootApp);
  await page.getByRole("button", { name: "New form", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New form" });
  await expect(dialog).toBeVisible();

  const name = dialog.getByLabel("Name");
  await name.press("Enter");
  await expect(name).toHaveAttribute("required", "");
  const requiredValidity = await name.evaluate((input: HTMLInputElement) => ({
    message: input.validationMessage,
    valid: input.validity.valid,
  }));
  expect(requiredValidity.valid).toBe(false);
  expect(requiredValidity.message.length).toBeGreaterThan(0);
  expect(control.getCreateCount()).toBe(0);
  await name.fill("Lifecycle expansion");
  await expect(dialog.getByLabel("Slug")).toHaveValue("lifecycle-expansion");
  await dialog.getByLabel("Slug").fill("invalid slug");
  await dialog.getByLabel("Slug").press("Enter");
  await expect(
    dialog.getByText(
      "Slug can only contain lowercase letters, numbers, and -._~ characters.",
    ),
  ).toBeVisible();

  await dialog.getByLabel("Slug").fill("lifecycle-expansion");
  const releaseCreate = control.deferNextCreate();
  await dialog.getByLabel("Slug").press("Enter");
  await expect(dialog.getByRole("button", { name: "Creating…" })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Enter");
  expect(control.getCreateCount()).toBe(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  releaseCreate();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("dialog", { name: "Lifecycle expansion" }),
  ).toBeVisible();
  expect(control.getCreateCount()).toBe(1);
});

test("a failed refresh retains the last confirmed form inventory", async ({
  page,
  bootApp,
}) => {
  const control = await openForms(page, bootApp);
  control.failNextFormsList();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();

  await expect.poll(control.getFormsListCount).toBe(4);
  await expect(page.getByText("Couldn’t refresh Forms")).toBeVisible();
  await expect(
    page.getByText("The last confirmed inventory remains available below."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Lifecycle launch list", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Turn visitors into subscribers.")).toHaveCount(0);
  expect(control.getFormsListCount()).toBe(4);
});

test("detail workspace exposes APG tabs, canonical sharing, admin PII boundaries, dirty discard, and busy close lock", async ({
  page,
  bootApp,
}) => {
  const control = await openForms(page, bootApp);
  await page.getByRole("button", { name: "Manage" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Lifecycle launch list" });
  await expect(dialog).toBeVisible();

  const tabs = dialog.getByRole("tablist", { name: "Form detail sections" });
  const overview = tabs.getByRole("tab", { name: "Overview" });
  const share = tabs.getByRole("tab", { name: "Share" });
  const responses = tabs.getByRole("tab", { name: "Responses" });
  const settings = tabs.getByRole("tab", { name: "Settings" });
  await overview.focus();
  await overview.press("ArrowRight");
  await expect(share).toBeFocused();
  await expect(share).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByLabel("Iframe embed")).toHaveValue(
    /https:\/\/forms\.example\.test\/forms\/lifecycle-launch/u,
  );

  await share.press("ArrowRight");
  await expect(responses).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByText("Confidential admin workspace")).toBeVisible();
  await expect(dialog.getByText(PRIVATE_RESPONSE_CANARY)).toBeVisible();
  await expect(dialog.getByText(/at most the 1,000 most recent response rows/u)).toBeVisible();

  await responses.press("ArrowRight");
  await expect(settings).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByText("Field structure is read-only")).toBeVisible();
  const name = dialog.getByLabel("Name");
  await name.fill("Lifecycle launch list revised");
  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", {
    name: "Discard unsaved form changes?",
  });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeVisible();

  const releaseUpdate = control.deferNextUpdate();
  await dialog.getByRole("button", { name: "Save settings" }).click();
  await expect(dialog.getByRole("button", { name: "Saving…" })).toBeDisabled();
  const close = dialog.getByRole("button", { name: "Close form details" });
  await expect(close).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByTestId("form-detail-backdrop").click({ force: true });
  await expect(dialog).toBeVisible();

  releaseUpdate();
  await expect(dialog.getByRole("button", { name: "Save settings" })).toBeVisible();
  await name.fill("Unsaved close check");
  await page.keyboard.press("Escape");
  await page
    .getByRole("alertdialog", { name: "Discard unsaved form changes?" })
    .getByRole("button", { name: "Discard changes" })
    .click();
  await expect(dialog).toBeHidden();
  expect(control.getMutationCount()).toBe(1);
});

test("a viewer receives read-only Forms without raw response reads or any mutation", async ({
  page,
  bootApp,
}) => {
  const control = await openForms(page, bootApp, "viewer");
  await expect(page.getByText("Read-only access")).toBeVisible();
  await expect(page.getByText(/require an editor or admin role/u)).toBeVisible();
  await page.getByRole("button", { name: "Use template" }).first().click({
    force: true,
  });
  await expect(page.getByRole("dialog", { name: "New form" })).toHaveCount(0);

  await page.getByRole("button", { name: "Manage" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Lifecycle launch list" });
  await dialog.getByRole("tab", { name: "Responses" }).click();
  await expect(dialog.getByText("Response details are admin-only")).toBeVisible();
  await expect(dialog.getByText(PRIVATE_RESPONSE_CANARY)).toHaveCount(0);
  expect(control.getPrivateResponseRequestCount()).toBe(0);
  expect(control.getMutationCount()).toBe(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
});

test("withheld duplicate, Growth, Variants, and Social actions cannot issue hidden requests", async ({
  page,
  bootApp,
}) => {
  const control = await openForms(page, bootApp);
  await expect(
    page.getByRole("button", { name: "Duplicate", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Growth", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Variants", exact: true }),
  ).toHaveCount(0);

  await page
    .getByRole("checkbox", {
      name: "Select Lifecycle launch list for bulk action",
    })
    .check();
  const selectionToolbar = page.locator(".forms-selection-toolbar");
  await expect(selectionToolbar.getByText("1 selected")).toBeVisible();
  await expect(
    selectionToolbar.getByRole("button", { name: "Delete", exact: true }),
  ).toHaveCount(0);

  await page.getByRole("tab", { name: /Social capture/u }).click();
  await expect(
    page.getByRole("button", { name: /auto.?reply/iu }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /tap.?to.?text/iu }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /variant|experiment/iu }),
  ).toHaveCount(0);
  expect(control.getUnsafeRequestPaths()).toEqual([]);
  expect(control.getMutationCount()).toBe(0);
});

test("Forms contains the 320px layout and exposes its wide landing table as a focusable scroll region", async ({
  page,
  bootApp,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await openForms(page, bootApp);
  await page.getByRole("tab", { name: /Landing pages/u }).click();
  const tableRegion = page.getByRole("region", { name: "Landing pages table" });
  await expect(tableRegion).toBeVisible();
  await tableRegion.focus();
  await expect(tableRegion).toBeFocused();
  const containment = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".forms-page");
    const table = document.querySelector<HTMLElement>(".forms-table-scroll");
    const tableList = table?.querySelector<HTMLElement>(".list");
    return {
      pageContained: Boolean(root && root.scrollWidth <= root.clientWidth + 1),
      pageClientWidth: root?.clientWidth ?? null,
      pageScrollWidth: root?.scrollWidth ?? null,
      tableScrollable: Boolean(table && table.scrollWidth > table.clientWidth),
      tableClientWidth: table?.clientWidth ?? null,
      tableScrollWidth: table?.scrollWidth ?? null,
      tableListWidth: tableList?.getBoundingClientRect().width ?? null,
    };
  });
  expect(containment.pageContained).toBe(true);
  expect(containment.tableScrollable).toBe(true);
  await testInfo.attach("forms-narrow-measurements.json", {
    body: JSON.stringify(containment, null, 2),
    contentType: "application/json",
  });
  // eslint-disable-next-line no-console -- qualification evidence in CI output
  console.info(`[forms-measurement:narrow] ${JSON.stringify(containment)}`);
  expect(await seriousAxeViolations(page)).toEqual([]);
  const dashboardToastDismiss = page.getByRole("button", {
    name: /Dismiss notification: Couldn't load your saved Dashboard layout/u,
  });
  if (await dashboardToastDismiss.isVisible()) {
    await dashboardToastDismiss.click();
  }
  await tableRegion.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("forms-narrow.png"),
  });
  await tableRegion.screenshot({
    path: testInfo.outputPath("forms-narrow-table.png"),
  });
});

test("Forms preserves boundaries in forced colors and removes route transitions for reduced motion", async ({
  page,
  bootApp,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await openForms(page, bootApp);
  const media = await page.evaluate(() => {
    const activeTab = document.querySelector<HTMLElement>(
      '.forms-surface-tab[data-active="true"]',
    );
    const inactiveTab = document.querySelector<HTMLElement>(
      ".forms-surface-tab:not([data-active])",
    );
    const readiness = document.querySelector<HTMLElement>(".forms-readiness");
    return {
      forced: window.matchMedia("(forced-colors: active)").matches,
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      activeTabBorder: activeTab
        ? getComputedStyle(activeTab).borderTopColor
        : "",
      inactiveTabBorder: inactiveTab
        ? getComputedStyle(inactiveTab).borderTopColor
        : "",
      readinessBorder: readiness
        ? getComputedStyle(readiness).borderTopStyle
        : "",
      transitionDuration: activeTab
        ? getComputedStyle(activeTab).transitionDuration
        : "",
    };
  });
  expect(media.forced).toBe(true);
  expect(media.reduced).toBe(true);
  expect(media.activeTabBorder).not.toBe(media.inactiveTabBorder);
  expect(media.readinessBorder).toBe("solid");
  expect(Number.parseFloat(media.transitionDuration)).toBeLessThanOrEqual(0.01);
  expect(
    await seriousAxeViolations(page, { disableColorContrast: true }),
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("forms-forced-colors-reduced-motion.png"),
    fullPage: true,
  });
});
