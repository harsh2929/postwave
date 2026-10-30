import { expect, test } from '@playwright/test';

test.describe('docs site', () => {
  test('/docs landing renders', async ({ page }) => {
    await page.goto('/docs');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('navigation', { name: /docs|sidebar/i })).toBeVisible();
  });

  test('/docs/api page lists endpoint operations', async ({ page }) => {
    await page.goto('/docs/api');
    await expect(page.getByRole('heading', { name: /api reference/i })).toBeVisible();

    const operations = page.getByTestId('api-operation');
    await expect(operations.first()).toBeVisible();
    expect(await operations.count()).toBeGreaterThanOrEqual(5);
  });

  test('Cmd+K opens the search modal and finds results', async ({ page }) => {
    await page.goto('/docs');

    // SearchBar picks the modifier from navigator.platform, and the Playwright
    // device profiles emulate that (Desktop Chrome reports Win32 even on a Mac
    // host), so derive it from the page rather than from process.platform.
    const isMac = await page.evaluate(() =>
      navigator.platform.toLowerCase().includes('mac'),
    );
    // The shortcut listener is attached in a client effect (SearchBar.tsx).
    // The trigger button is server-rendered, so its visibility says nothing
    // about hydration; wait until React has attached props to it (the same
    // signal marketing-surfaces.spec uses), allowing for a cold dev-server
    // compile of /docs under load.
    const trigger = page.getByRole('button', { name: /search docs/i });
    await expect(trigger).toBeVisible({ timeout: 90_000 });
    await expect
      .poll(
        () =>
          trigger.evaluate((node) =>
            Object.getOwnPropertyNames(node).some((key) => key.startsWith('__reactProps$')),
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    // Props attach at commit; the keydown listener attaches in an effect a
    // beat later. Press, give the dialog a real chance to appear, and only
    // then press again (the shortcut toggles, so rapid re-presses would close
    // what the previous press opened).
    const search = page.getByRole('dialog', { name: /search/i });
    for (let attempt = 0; attempt < 6 && (await search.count()) === 0; attempt += 1) {
      await page.waitForTimeout(500);
      await page.keyboard.press(`${isMac ? 'Meta' : 'Control'}+k`);
      await search.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    }
    await expect(search).toBeVisible();

    // The docs search field is an ARIA 1.2 combobox — `role="combobox"` with
    // aria-controls/aria-activedescendant pointing at the results listbox
    // (components/docs/SearchBar.tsx). That is the deliberate pattern for a
    // typeahead that drives a highlighted option list, so `searchbox` never
    // matched anything.
    await search.getByRole('combobox').fill('migration');
    const results = search.getByTestId('search-result');
    await expect(results.first()).toBeVisible({ timeout: 8_000 });
    expect(await results.count()).toBeGreaterThan(0);
  });

  test('/docs/migrations/mailchimp renders the migration guide', async ({ page }) => {
    await page.goto('/docs/migrations/mailchimp');
    await expect(page.getByRole('heading', { name: /mailchimp/i })).toBeVisible();
    // Migration guides should include at least one code block and a callout.
    await expect(page.locator('pre code').first()).toBeVisible();
  });
});
