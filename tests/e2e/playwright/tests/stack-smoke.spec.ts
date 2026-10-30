import { expect, test } from '@playwright/test';
import { ApiClient } from '../helpers/api';
import { listMessages } from '../helpers/mailpit';

/**
 * Stack smoke — fastest signal that the docker-compose test stack is up.
 *
 * If this file fails, the more interesting journeys have no hope. We
 * run it first (alphabetically the file sorts after "campaign" /
 * "public" / "signup", so name it z- if first ordering matters, but
 * sequencing isn't required — every test waits on /api/health).
 */
test.describe('stack smoke', () => {
  const api = new ApiClient();

  test('api /api/health returns 200', async () => {
    await api.waitForHealth(30_000);
  });

  test('web base URL responds', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status() ?? 0, 'web should not 5xx').toBeLessThan(500);
  });

  test('mailpit HTTP API is reachable', async () => {
    const inbox = await listMessages();
    expect(typeof inbox.total).toBe('number');
  });
});
