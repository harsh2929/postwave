import { expect, test } from '@playwright/test';

test.describe('public localized pages', () => {
  test('set the document language from the locale route segment', async ({
    page,
    context,
  }) => {
    await context.clearCookies();

    await page.goto('/es/forms/success');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');

    await page.goto('/ja/preferences/expired');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  });
});
