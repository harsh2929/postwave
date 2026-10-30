import { expect, test } from '@playwright/test';
import { loginAsDemo } from '../helpers/auth';
import { seedSampleData } from '../fixtures/test-data';

test.describe('subscriber drilldown', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await seedSampleData(baseURL!);

    // Drill into a real seeded subscriber.
    //
    // The list page cannot be the entry point in this build. apps/web is
    // compiled with NEXT_PUBLIC_USE_MOCKS=1 (apps/web/.env.local), so
    // subscribers-api.ts serves listSubscribers() from
    // src/lib/subscribers-mocks.ts, while getSubscriber() and the timeline
    // reader have no mock branch and still call the API. Clicking the first
    // row therefore lands on /app/subscribers/sub_demo_1 and the page renders
    // "Could not load subscriber: subscriber not found" — the trace shows
    // GET /api/v1/subscribers/sub_demo_1 returning 404 while the same request
    // for a seeded id returns 200. That half-wired mock mode is an app defect
    // reported separately; it is not what this spec is about, so open the
    // detail route directly on a subscriber the API actually has.
    const listed = await fetch(`${baseURL}/api/v1/subscribers?per_page=1`, {
      headers: { 'X-Tenant-Slug': 'demo' },
    });
    expect(listed.ok).toBe(true);
    const { items } = (await listed.json()) as { items: Array<{ id: string }> };
    expect(items.length).toBeGreaterThan(0);

    // Attach the dev-auth cookies, then navigate by hand: the helper's own
    // goto() waits for `load`, and this dev server keeps compiling chunks well
    // past DOMContentLoaded, which burns the 60s test budget before the first
    // assertion runs. The assertions below do their own waiting.
    await loginAsDemo(page, { navigate: false });
    await page.goto(`/app/subscribers/${encodeURIComponent(items[0].id)}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForURL(/\/app\/subscribers\/[^/]+$/);
  });

  test('subscriber detail page renders avatar, status, and engagement score', async ({ page }) => {
    await expect(page.getByTestId('subscriber-avatar')).toBeVisible();
    await expect(page.getByTestId('subscriber-status')).toBeVisible();
    const score = page.getByTestId('subscriber-engagement-score');
    await expect(score).toBeVisible();
    const value = (await score.textContent())?.trim() ?? '';
    expect(value.length).toBeGreaterThan(0);
  });

  test('timeline tab shows events in reverse chronological order', async ({ page }) => {
    await page.getByRole('tab', { name: /timeline/i }).click();
    // The detail page renders the same timeline twice: once in the desktop
    // tab panel and once in the `md:hidden` mobile accordion (which opens
    // Timeline by default). Both are in the DOM at every width, so pin the
    // assertion to the one this viewport actually shows.
    const timeline = page.getByTestId('subscriber-timeline').filter({ visible: true });
    await expect(timeline).toBeVisible();

    const events = timeline.getByTestId('timeline-event');
    await expect(events.first()).toBeVisible();
    const count = await events.count();
    expect(count).toBeGreaterThan(0);

    // Read the data-timestamp attribute from each event. The timeline lists
    // newest first, so timestamps should be monotonically non-increasing.
    const timestamps: number[] = [];
    for (let i = 0; i < count; i++) {
      const ts = await events.nth(i).getAttribute('data-timestamp');
      if (ts) timestamps.push(Date.parse(ts));
    }
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeLessThanOrEqual(timestamps[i - 1]);
    }
  });

  test('lists & tags tab renders chips', async ({ page }) => {
    await page.getByRole('tab', { name: /lists.*tags|tags.*lists/i }).click();
    const chips = page.getByTestId('subscriber-chip');
    await expect(chips.first()).toBeVisible();
    expect(await chips.count()).toBeGreaterThan(0);
  });

  test('engagement sparkline SVG renders with paths', async ({ page }) => {
    // The sparkline lives behind the "Engagement" tab on the detail page, so
    // reach it the way a user does rather than expecting it on first paint.
    await page.getByRole('tab', { name: /^engagement$/i }).click();
    const sparkline = page.getByTestId('engagement-sparkline');
    await expect(sparkline).toBeVisible();
    const paths = sparkline.locator('path');
    expect(await paths.count()).toBeGreaterThan(0);
  });
});
