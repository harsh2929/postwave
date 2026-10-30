import { expect, test } from '@playwright/test';

test.describe('public status page', () => {
  test('loads without auth', async ({ page, context }) => {
    // Clear any auth state to confirm the page is genuinely public.
    await context.clearCookies();
    await page.goto('/status');
    await expect(page).toHaveURL(/\/status/);
    await expect(page.getByRole('heading', { name: /status|system status/i })).toBeVisible();
  });

  test('service grid renders per-service status', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/status');

    const grid = page.getByTestId('status-service-grid');
    await expect(grid).toBeVisible();
    const services = grid.getByTestId('status-service');
    await expect(services.first()).toBeVisible();
    expect(await services.count()).toBeGreaterThanOrEqual(3);

    for (let i = 0; i < (await services.count()); i++) {
      const indicator = services.nth(i).getByTestId('status-indicator');
      await expect(indicator).toBeVisible();
    }
  });

  test('90-day history chart renders SVG squares', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/status');

    const chart = page.getByTestId('status-history-chart');
    await expect(chart).toBeVisible();
    const cells = chart.locator('svg rect');
    expect(await cells.count()).toBeGreaterThanOrEqual(60);
  });
});
