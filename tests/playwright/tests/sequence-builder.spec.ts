import { expect, test } from '@playwright/test';
import { loginAsDemo } from '../helpers/auth';

test.describe('sequence builder', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsDemo(page, { startPath: '/app/sequences/new' });
  });

  test('empty canvas shows the drag-step prompt', async ({ page }) => {
    const canvas = page.getByTestId('sequence-canvas');
    await expect(canvas).toBeVisible();
    await expect(canvas.getByText(/drag a step from the palette/i)).toBeVisible();
  });

  test('drag Email step from palette onto canvas', async ({ page }) => {
    const emailStep = page.getByTestId('palette-step-email');
    const canvas = page.getByTestId('sequence-canvas');

    await expect(emailStep).toBeVisible();
    await expect(canvas).toBeVisible();

    await emailStep.dragTo(canvas);

    await expect(canvas.getByTestId('canvas-step-email').first()).toBeVisible();
  });

  test('clicking a step opens the editor slideover', async ({ page }) => {
    const emailStep = page.getByTestId('palette-step-email');
    const canvas = page.getByTestId('sequence-canvas');
    await emailStep.dragTo(canvas);

    await canvas.getByTestId('canvas-step-email').first().click();

    const editor = page.getByTestId('step-editor');
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel(/subject|step name/i).first()).toBeVisible();
  });

  test('save persists changes', async ({ page }) => {
    const emailStep = page.getByTestId('palette-step-email');
    const canvas = page.getByTestId('sequence-canvas');
    await emailStep.dragTo(canvas);

    await canvas.getByTestId('canvas-step-email').first().click();

    const editor = page.getByTestId('step-editor');
    const subject = editor.getByLabel(/subject/i);
    await subject.fill('Hello from Playwright');

    await page.getByRole('button', { name: 'Save sequence', exact: true }).click();
    // The builder's success toast is "Sequence draft created." — the old
    // /saved|sequence saved/i pattern also matched the builder's own
    // "Unsaved changes" dirty indicator, so this test used to go green even
    // when the save had failed outright. Assert the real success message.
    await expect(page.getByText('Sequence draft created.')).toBeVisible();

    // On success the builder does `router.push('/app/sequences/<id>')`, so the
    // reload lands on the sequence detail page, not back on the builder canvas
    // (sequence-builder.tsx:228). Re-point the persistence check there, as the
    // note that used to sit here asked for: the detail page binds its Subject
    // input to the stored email, so the same expectation — the subject typed
    // into the step editor survived the round-trip to the backend — is asserted
    // against the surface the app actually navigates to.
    await page.waitForURL(/\/app\/sequences\/[^/]+$/);
    await page.reload();
    await expect(page.getByLabel('Subject')).toHaveValue('Hello from Playwright');
  });

  // NOTE: this test asserts a limitation the product deliberately removed.
  // sequence-builder.tsx now states "The backend now accepts the v0.3 sequence
  // step union, so the web palette mirrors the desktop canvas", and PALETTE
  // ships condition / tag_add / tag_remove / exit as fully working tiles with
  // no gating tooltip (and no `palette-step-tag` id — tags are split in two).
  // Left failing on purpose: making it green would mean asserting something
  // the spec never intended.
  test('Conditions / Tags / Exit show "Requires API v0.3" tooltips', async ({ page }) => {
    for (const stepName of ['condition', 'tag', 'exit'] as const) {
      const tile = page.getByTestId(`palette-step-${stepName}`);
      await expect(tile).toBeVisible();
      await tile.hover();
      const tooltip = page.getByRole('tooltip').filter({ hasText: /requires api v0\.3/i });
      await expect(tooltip).toBeVisible();
      // Move focus away so the next iteration sees a fresh tooltip.
      await page.mouse.move(0, 0);
    }
  });
});
