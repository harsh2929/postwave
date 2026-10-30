import { expect, test } from '@playwright/test';
import { loginAsDemo } from '../helpers/auth';
import { seedSampleData } from '../fixtures/test-data';

// The settings surface is a real URL-routed area of apps/web: the left rail is
// a list of <a href> LINKS (see apps/web/src/lib/settings-nav.ts), so every tab
// is reachable by its own route. Names are matched EXACTLY here because the
// dashboard sidebar carries look-alike entries — "Workspace operations",
// "Privacy portal", "Inbound Webhooks", "Developer reference" — that make a
// loose regex ambiguous under strict mode.
const settingsTab = (label: string) => ({ name: label, exact: true }) as const;

test.describe('settings', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await seedSampleData(baseURL!);
    await loginAsDemo(page, { startPath: '/app/settings' });
  });

  test('workspace settings page renders with an enabled save button', async ({ page }) => {
    await page.getByRole('link', settingsTab('Workspace')).click();
    // level 1: the settings shell renders the active tab as the page <h1>.
    // The sidebar's "Workspace" group label is an <h3>, hence the level filter.
    await expect(
      page.getByRole('heading', { name: 'Workspace', exact: true, level: 1 }),
    ).toBeVisible();
    const field = page.getByLabel(/workspace name/i);
    await expect(field).toBeVisible();
    const save = page.getByRole('button', { name: /save/i });
    // Save is dirty-gated by design (UnsavedChangesProvider + `dirty` in
    // settings/page.tsx), so it starts disabled and enables on the first edit.
    await expect(save).toBeDisabled();
    await field.fill(`Demo Workspace ${Date.now()}`);
    await expect(save).toBeEnabled();
  });

  test('saving workspace name persists across reload', async ({ page }) => {
    await page.getByRole('link', settingsTab('Workspace')).click();
    const newName = `Demo Workspace ${Date.now()}`;
    const field = page.getByLabel(/workspace name/i);
    await field.fill(newName);
    await page.getByRole('button', { name: /save/i }).click();
    await expect(page.getByText(/saved|updated/i)).toBeVisible();

    await page.reload();
    await page.getByRole('link', settingsTab('Workspace')).click();
    await expect(page.getByLabel(/workspace name/i)).toHaveValue(newName);
  });

  test('notification preferences toggle persists', async ({ page }) => {
    await page.getByRole('link', settingsTab('Notifications')).click();
    // The preference matrix labels each cell "<category> — <channel>"; the
    // email-on-campaign-completion cell this spec means is "Send completion —
    // Email" (apps/web/.../settings/notifications/page.tsx CATEGORIES/CHANNELS).
    const toggle = page.getByLabel('Send completion — Email', { exact: true });
    await expect(toggle).toBeVisible();
    // `isChecked()` is a single, non-retrying read. The matrix renders
    // immediately from DEFAULT_PREFS (every email_on_* ON) and only adopts the
    // server's answer when GET /api/v1/settings/notifications lands, and every
    // cell is `disabled` until then (notifications/page.tsx `disabled =
    // loading || loadError`). Reading before that resolves compares two
    // defaults instead of two persisted values — which can fail OR pass for
    // the wrong reason. Gate both reads on the same "loaded" signal.
    await expect(toggle).toBeEnabled();
    const before = await toggle.isChecked();
    await toggle.click();
    await page.getByRole('button', { name: /save/i }).click();
    await expect(page.getByText(/saved|updated/i)).toBeVisible();
    await page.reload();
    await page.getByRole('link', settingsTab('Notifications')).click();
    await expect(toggle).toBeEnabled();
    expect(await toggle.isChecked()).toBe(!before);
  });

  test('privacy retention slider persists', async ({ page }) => {
    await page.getByRole('link', settingsTab('Privacy')).click();
    // Three retention fields ship on this page; this spec drives the first of
    // them, named rather than positional so the assertion stays pinned to it.
    const slider = page.getByLabel(/^Audit log retention/i);
    await expect(slider).toBeVisible();
    // Pick a value that is genuinely a change, so Save is armed on a re-run
    // that starts from whatever the previous run persisted.
    const target = (await slider.inputValue()) === '180' ? '365' : '180';
    await slider.fill(target);
    await page.getByRole('button', { name: /save/i }).click();
    await expect(page.getByText(/saved|updated/i)).toBeVisible();
    await page.reload();
    await page.getByRole('link', settingsTab('Privacy')).click();
    await expect(slider).toHaveValue(target);
  });

  test('Slack section shows Connect when disconnected', async ({ page }) => {
    await page.getByRole('link', { name: /integrations|slack/i }).first().click();
    const section = page.getByTestId('slack-section');
    await expect(section).toBeVisible();
    await expect(section.getByRole('button', { name: /connect/i })).toBeVisible();
  });

  test('outbound webhooks list renders and "+ Add" opens the form', async ({ page }) => {
    await page.getByRole('link', settingsTab('Webhooks')).click();
    // level 2: the outbound-webhooks page's own header. (The settings shell
    // also renders an <h1> "Webhooks" for the active tab.)
    await expect(
      page.getByRole('heading', { name: 'Webhooks', exact: true, level: 2 }),
    ).toBeVisible();
    await page.getByRole('button', { name: /^\+ ?add|add webhook/i }).click();
    await expect(page.getByRole('dialog', { name: /webhook/i })).toBeVisible();
  });

  test('sample data section toggles between Load and Remove', async ({ page }) => {
    await page.getByRole('link', settingsTab('Developer')).click();
    const section = page.getByTestId('sample-data-section');
    await expect(section).toBeVisible();
    const button = section.getByRole('button', { name: /load sample|remove sample/i });
    await expect(button).toBeVisible();
    await expect(button).toHaveText(/load|remove/i);
  });

  test('Replay tour button opens the tour', async ({ page }) => {
    // The button is server-rendered, so a click that lands before hydration is
    // swallowed. The workspace-name input is disabled until the client-side
    // load resolves, which makes it a real "this page is interactive" signal.
    await expect(page.getByLabel(/workspace name/i)).toBeEnabled();
    await page.getByRole('button', { name: /replay tour|restart tour/i }).click();
    await expect(page.getByTestId('tour-overlay')).toBeVisible();
  });
});
