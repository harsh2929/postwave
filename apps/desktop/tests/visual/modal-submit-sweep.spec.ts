/**
 * Modal form-submission sweep. Opens each new-feature create modal, fills
 * every visible field (text/number/checkbox/select/textarea), submits, and
 * verifies the submit handler doesn't crash. Runs each modal twice: once
 * with the POST stubbed to 200-success, once to a 422-error, so both the
 * success transition and the error-rendering path are exercised.
 *
 *   pnpm exec playwright test modal-submit-sweep.spec.ts --reporter=line
 */
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { test, expect, waitForPrimaryNavigation } from "./fixture";
import type { Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reportDir = path.resolve(
  __dirname,
  "..",
  "..",
  "tests",
  "visual",
  "__report__",
);

interface Finding {
  area: string;
  kind: string;
  detail: string;
}
const findings: Finding[] = [];
const coverage: string[] = [];
const NOISE = [
  "unstubbed Tauri command",
  "Failed to load resource",
  "favicon",
  "Download the React DevTools",
  "MIME type",
  "controlled input",
];
const isNoise = (s: string) => NOISE.some((n) => s.includes(n));

function collect(page: Page, area: string): () => void {
  const onErr = (e: Error) =>
    findings.push({
      area,
      kind: "pageerror",
      detail: `${e.name}: ${e.message}`.slice(0, 320),
    });
  const onCon = (m: { type(): string; text(): string }) => {
    const t = m.text();
    if (
      (m.type() === "error" ||
        (m.type() === "warning" &&
          /is not a function|is not iterable|Cannot read prop|TypeError/.test(
            t,
          ))) &&
      !isNoise(t)
    )
      findings.push({ area, kind: "console", detail: t.slice(0, 320) });
  };
  page.on("pageerror", onErr);
  page.on("console", onCon as never);
  return () => {
    page.off("pageerror", onErr);
    page.off("console", onCon as never);
  };
}

const BOOT = ["/api/v1/auth/me", "/api/v1/dashboard/stats", "/api/v1/health"];
const EMPTY = { items: [], data: [], total: 0, results: [] };
const TEST_UUID = "00000000-0000-4000-8000-000000000001";
const OMNI_CATALOG = {
  schema_version: "1",
  channels: [
    {
      key: "email",
      label: "Email",
      runtime_status: "ready",
      fields: [],
    },
  ],
  send_strategies: [],
  recipient_snapshot_modes: [],
  path_statuses: ["draft"],
};

async function boot(
  page: Page,
  bootApp: (p: Page) => Promise<void>,
  mutationMode: "ok" | "err",
): Promise<() => number> {
  let mutationRequests = 0;
  await page.setViewportSize({ width: 1440, height: 1100 });
  await bootApp(page);
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (BOOT.includes(p)) return route.fallback();
    const m = req.method();
    if (m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE") {
      mutationRequests += 1;
      if (mutationMode === "err") {
        return route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "validation_failed",
              message: "Simulated server error for test.",
            },
          }),
        });
      }
      if (p === "/api/v1/omnichannel/validate") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            valid: true,
            errors: [],
            warnings: [],
            supported_paths: 1,
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "new-1",
          ok: true,
          status: "draft",
          run_id: "r1",
          data: { id: "new-1" },
        }),
      });
    }
    if (p === "/api/v1/sms/lists") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            { id: TEST_UUID, name: "Renderer SMS list", keyword: "RENDER" },
          ],
        }),
      });
    }
    if (p === "/api/v1/omnichannel/catalog") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(OMNI_CATALOG),
      });
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(EMPTY),
    });
  });
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  return () => mutationRequests;
}
async function nav(page: Page, sectionId: string): Promise<void> {
  const item = page
    .getByRole("navigation", { name: "Primary" })
    .locator(`button[data-section="${sectionId}"]`);
  await expect(
    item,
    `Missing navigation destination: ${sectionId}`,
  ).toBeVisible();
  await item.click({ timeout: 8000 });
  await expect(item).toHaveAttribute("aria-current", "page");
  await page.waitForTimeout(700);
}
async function crashed(page: Page): Promise<boolean> {
  return (
    (await page
      .locator('.pw-screen[role="alert"]', { hasText: "Something went wrong" })
      .count()) > 0
  );
}
/** Fill every visible form control inside the open dialog. */
async function fillDialog(page: Page): Promise<void> {
  const dlg = page.locator(".modal-card, [role=dialog]").first();
  await expect(dlg).toBeVisible();
  const texts = dlg.locator(
    "input[type=text]:not([disabled]):not([readonly]), input:not([type]):not([disabled]):not([readonly]), input[type=email]:not([disabled]):not([readonly]), input[type=url]:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly])",
  );
  for (let i = 0; i < (await texts.count()); i++) {
    const input = texts.nth(i);
    if (!(await input.isVisible())) continue;
    const type = await input.getAttribute("type");
    const inputMode = await input.getAttribute("inputmode");
    const semanticHint = [
      await input.getAttribute("id"),
      await input.getAttribute("name"),
      await input.getAttribute("placeholder"),
      await input.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const value =
      type === "email"
        ? "renderer@example.com"
        : type === "url" || /\burl\b|https?:\/\//.test(semanticHint)
          ? "https://example.com/test"
          : inputMode === "numeric" || inputMode === "decimal"
            ? "5"
            : "test value";
    await input.fill(value);
  }
  const nums = dlg.locator(
    "input[type=number]:not([disabled]):not([readonly])",
  );
  for (let i = 0; i < (await nums.count()); i++) {
    const input = nums.nth(i);
    if (!(await input.isVisible())) continue;
    const min = Number.parseFloat((await input.getAttribute("min")) ?? "");
    const max = Number.parseFloat((await input.getAttribute("max")) ?? "");
    let value = Number.isFinite(min) ? min : 5;
    if (Number.isFinite(max)) value = Math.min(value, max);
    await input.fill(String(value));
  }
  const checks = dlg.locator("input[type=checkbox]:not([disabled])");
  for (let i = 0; i < (await checks.count()); i++) {
    const input = checks.nth(i);
    if (await input.isVisible()) await input.check();
  }
  const sels = dlg.locator("select:not([disabled])");
  for (let i = 0; i < (await sels.count()); i++) {
    if (!(await sels.nth(i).isVisible())) continue;
    const opts = sels.nth(i).locator("option");
    if ((await opts.count()) > 1) await sels.nth(i).selectOption({ index: 1 });
  }
}
/** Click the dialog's primary/submit button. */
async function submitDialog(page: Page, area: string): Promise<void> {
  const dlg = page.locator(".modal-card, [role=dialog]").first();
  const submit = dlg
    .getByRole("button", {
      name: /save|create|add|generate|send|run|submit|confirm|schedule|apply|mint/i,
    })
    .last();
  await expect(submit, `${area}: missing submit button`).toBeVisible();
  await expect(
    submit,
    `${area}: submit remained disabled after valid form fill`,
  ).toBeEnabled();
  await submit.scrollIntoViewIfNeeded();
  await submit.click({ timeout: 5000 });
  await page.waitForTimeout(900);
}

interface Flow {
  id: string;
  open: (p: Page) => Promise<boolean>;
}
const FLOWS: Flow[] = [
  {
    id: "sms-broadcast",
    open: async (p) => {
      await nav(p, "smsInbox");
      await p
        .getByRole("tab", { name: /Broadcasts/i })
        .first()
        .click();
      await p.waitForTimeout(500);
      return openByName(p, /New broadcast|Compose/i);
    },
  },
  {
    id: "automations-trigger",
    open: async (p) => {
      await nav(p, "automations");
      return openByName(p, /New trigger/i);
    },
  },
  {
    id: "templates-ai",
    open: async (p) => {
      await nav(p, "templates");
      return openByName(p, /Generate with AI/i);
    },
  },
  {
    id: "ai-routine",
    open: async (p) => {
      await nav(p, "ai");
      await p
        .getByRole("tab", { name: /Routines/i })
        .first()
        .click();
      await p.waitForTimeout(400);
      return openByName(p, /New routine/i);
    },
  },
  {
    id: "campaign",
    open: async (p) => {
      await nav(p, "campaigns");
      return openByName(p, /New campaign/i);
    },
  },
  {
    id: "sequence",
    open: async (p) => {
      await nav(p, "sequences");
      return openByName(p, /New sequence/i);
    },
  },
  {
    id: "feed-source",
    open: async (p) => {
      await nav(p, "campaigns");
      await p
        .getByRole("button", { name: /Recurring \(RSS\)/i })
        .first()
        .click();
      await p.waitForTimeout(400);
      return openByName(p, /Add (feed|source)|New (feed|source)/i);
    },
  },
  {
    id: "goal",
    open: async (p) => {
      return openByName(p, /New goal|Add goal|Set a goal/i);
    },
  },
];
async function openByName(p: Page, re: RegExp): Promise<boolean> {
  const b = p.getByRole("button", { name: re }).first();
  try {
    await b.waitFor({ state: "visible", timeout: 5_000 });
    await b.click({ force: true, timeout: 4_000 });
  } catch {
    return false;
  }
  await p.waitForTimeout(600);
  return (await p.locator(".modal-card, [role=dialog]").count()) > 0;
}

for (const mode of ["ok", "err"] as const) {
  for (const flow of FLOWS) {
    test(`submit:${flow.id}:${mode}`, async ({ page, bootApp }) => {
      const area = `${flow.id}:${mode}`;
      const findingStart = findings.length;
      const flush = collect(page, area);
      const mutationRequests = await boot(page, bootApp, mode);
      const opened = await flow.open(page).catch(() => false);
      if (!opened) {
        coverage.push(`${area}: modal did not open`);
        findings.push({
          area,
          kind: "coverage",
          detail: "expected modal did not open",
        });
        flush();
        const testFindings = findings.slice(findingStart);
        expect(
          testFindings,
          `Failures while submitting ${area}:\n${JSON.stringify(testFindings, null, 2)}`,
        ).toEqual([]);
        return;
      }
      coverage.push(`${area}: opened`);
      await fillDialog(page);
      if (await crashed(page))
        findings.push({
          area,
          kind: "error-boundary",
          detail: "crash while filling",
        });
      const mutationCountBeforeSubmit = mutationRequests();
      await submitDialog(page, area);
      expect(
        mutationRequests(),
        `${area}: submit did not reach a mutation handler`,
      ).toBeGreaterThan(mutationCountBeforeSubmit);
      if (mode === "err") {
        await expect(
          page.getByText(/Simulated server error for test/i).first(),
          `${area}: server validation error was not exposed to the operator`,
        ).toBeVisible({ timeout: 4_000 });
      }
      if (await crashed(page))
        findings.push({
          area,
          kind: "error-boundary",
          detail: `crash on submit (${mode})`,
        });
      flush();
      const testFindings = findings.slice(findingStart);
      expect(
        testFindings,
        `Failures while submitting ${area}:\n${JSON.stringify(testFindings, null, 2)}`,
      ).toEqual([]);
    });
  }
}

test.afterAll(async () => {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(
    path.join(reportDir, "modal-submit-sweep.json"),
    JSON.stringify({ total: findings.length, findings, coverage }, null, 2),
  );
});
