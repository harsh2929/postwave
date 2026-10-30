import { expect, test, type Page } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const TEMPLATE_NAME = "Playwright newsletter focus fixture";
const TENANT_HEADERS = { "X-Tenant-Slug": "demo" };

interface SearchResponse {
  items?: Array<{ id: string; name: string }>;
}

async function findFixture(page: Page, name: string) {
  const response = await page.request.get(
    `/api/v1/campaign-templates/search?q=${encodeURIComponent(name)}&source=mine&kind=editable&archived=active&per_page=20`,
    { headers: TENANT_HEADERS },
  );
  if (!response.ok()) {
    throw new Error(
      `Template fixture search failed (${response.status()}): ${await response.text()}`,
    );
  }
  const payload = (await response.json()) as SearchResponse;
  return payload.items?.find((item) => item.name === name);
}

async function ensureFixture(page: Page, name: string, slug: string) {
  const existing = await findFixture(page, name);
  if (existing) return existing;

  const create = (candidateSlug: string) =>
    page.request.post("/api/v1/campaign-templates", {
      headers: TENANT_HEADERS,
      data: {
        slug: candidateSlug,
        name,
        subject: "A focus-safe newsletter subject",
        description: "Deterministic browser fixture for template UX checks.",
        body_html:
          "<!doctype html><html><body><main><h1>Newsletter</h1><p>Accessible fixture.</p></main></body></html>",
        tags: ["playwright"],
      },
    });
  let created = await create(slug);
  if (created.status() === 409 && !(await findFixture(page, name))) {
    const suffix = Date.now().toString(36);
    created = await create(`${slug.slice(0, 79 - suffix.length)}-${suffix}`);
  }
  if (!created.ok() && created.status() !== 409) {
    throw new Error(
      `Template fixture create failed (${created.status()}): ${await created.text()}`,
    );
  }

  await expect
    .poll(async () => findFixture(page, name), {
      message: "template fixture should become searchable",
    })
    .toBeTruthy();
  return (await findFixture(page, name))!;
}

test.describe("newsletter template library", () => {
  test("restores gallery focus and exposes 44px mobile card targets", async ({
    page,
  }, testInfo) => {
    await loginAsDemo(page, { startPath: "/app/templates" });
    const projectSlug = testInfo.project.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    const fixture = await ensureFixture(
      page,
      `${TEMPLATE_NAME} ${testInfo.project.name}`,
      `playwright-newsletter-focus-${projectSlug}`,
    );
    const companion = await ensureFixture(
      page,
      `${TEMPLATE_NAME} ${testInfo.project.name} companion`,
      `playwright-newsletter-focus-${projectSlug}-companion`,
    );
    await page.goto(
      `/app/templates?view=mine&goal=all&source=mine&kind=editable&archived=active&q=${encodeURIComponent(fixture.name)}`,
    );

    const card = page.getByRole("article", {
      name: fixture.name,
      exact: true,
    });
    await expect(card).toBeVisible();

    if (testInfo.project.name.includes("mobile")) {
      const touchTargets = [
        card.getByRole("button", {
          name: new RegExp(`^(Add to|Remove from) favorites: ${fixture.name}$`),
        }),
        card.getByRole("button", {
          name: `Add ${fixture.name} to comparison`,
        }),
        card.getByRole("button", { name: "Use", exact: true }),
        card.getByRole("button", {
          name: `Actions for ${fixture.name}`,
        }),
        card
          .getByRole("checkbox", { name: `Select ${fixture.name}` })
          .locator(".."),
      ];
      for (const target of touchTargets) {
        const box = await target.boundingBox();
        expect(box, "touch target should have a rendered box").not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
    }

    await card.getByRole("link", { name: /view design/i }).click();
    const heading = page.locator("#template-detail-heading");
    await expect(heading).toHaveText(fixture.name);
    await expect(heading).toBeFocused();

    await page.getByRole("link", { name: "Newsletter templates" }).click();
    const restoredCard = page.getByRole("article", {
      name: fixture.name,
      exact: true,
    });
    await expect(restoredCard).toBeVisible();
    await expect(restoredCard).toBeFocused();

    // A second exact card exercises the sticky comparison state, including
    // removal and action targets that previously became too small on phones.
    await page
      .getByPlaceholder("Search by layout, topic, industry, or design style")
      .fill(`${TEMPLATE_NAME} ${testInfo.project.name}`);
    const companionCard = page.getByRole("article", {
      name: companion.name,
      exact: true,
    });
    await expect(companionCard).toBeVisible();
    await restoredCard
      .getByRole("button", { name: `Add ${fixture.name} to comparison` })
      .click();
    await companionCard
      .getByRole("button", { name: `Add ${companion.name} to comparison` })
      .click();

    const comparisonTray = page.getByRole("region", {
      name: "Template comparison tray",
    });
    await expect(comparisonTray).toContainText("2 of 4 ready to compare");
    if (testInfo.project.name.includes("mobile")) {
      const trayTargets = [
        comparisonTray.getByRole("button", {
          name: `Remove ${fixture.name} from comparison`,
        }),
        comparisonTray.getByRole("button", {
          name: `Remove ${companion.name} from comparison`,
        }),
        comparisonTray.getByRole("button", { name: "Clear", exact: true }),
        comparisonTray.getByRole("button", { name: "Compare", exact: true }),
      ];
      for (const target of trayTargets) {
        const box = await target.boundingBox();
        expect(
          box,
          "comparison target should have a rendered box",
        ).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
      }
    }
    await comparisonTray
      .getByRole("button", { name: "Compare", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Compare newsletter designs" }),
    ).toBeVisible();
    await expect(page.locator("table")).toContainText(fixture.name);
    await expect(page.locator("table")).toContainText(companion.name);
  });
});
