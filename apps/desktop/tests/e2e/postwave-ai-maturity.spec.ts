import type { Locator, Page } from "@playwright/test";

import {
  auditPostwaveAIA11y,
  capturePostwaveAIEvidence,
  expectNoPostwaveAIOverflow,
  expectPostwaveAIForcedColors,
  expectPostwaveAIReducedMotion,
  expectPostwaveAISafety,
  openPostwaveAI,
  resetPostwaveAIScroll,
  scrollPostwaveAITargetIntoFrame,
  selectPostwaveAIMode,
  type PostwaveAIMode,
} from "./postwave-ai-evidence-harness";
import { expect, test } from "../visual/fixture";

test.describe.configure({ timeout: 300_000 });

const MODES: PostwaveAIMode[] = [
  "chat",
  "compose",
  "subject",
  "presend",
  "agent",
  "routines",
];

function composeBrief(page: Page): Locator {
  return page.locator(".ai-compose-textarea");
}

async function fillPresendDraft(page: Page): Promise<void> {
  await page
    .getByRole("textbox", { name: "Subject Required", exact: true })
    .fill("A calmer final review before launch");
  await page
    .getByRole("textbox", { name: "Sender email Required", exact: true })
    .fill("hello@example.invalid");
  await page
    .getByRole("textbox", { name: "Message body Required", exact: true })
    .fill(
      "Review readiness, voice alignment, and placement before choosing the final send moment.",
    );
}

async function expectModeSurface(
  page: Page,
  mode: PostwaveAIMode,
): Promise<void> {
  switch (mode) {
    case "chat":
      await expect(
        page.getByText("Moosewave's AI copilot, in your workspace.", {
          exact: true,
        }),
      ).toBeVisible();
      break;
    case "compose":
      await expect(
        page.getByText("Compose broadcast", { exact: true }),
      ).toBeVisible();
      break;
    case "subject":
      await expect(
        page.getByText("Subject Lab", { exact: true }).first(),
      ).toBeVisible();
      break;
    case "presend":
      await expect(
        page.getByRole("heading", { name: "Pre-send check", level: 2 }),
      ).toBeVisible();
      break;
    case "agent":
      await expect(
        page.getByText("Connect an external AI agent", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("table", {
          name: "Most recent verified MCP execution records",
        }),
      ).toBeVisible();
      break;
    case "routines":
      await expect(
        page.getByRole("heading", { name: "Routines", level: 3 }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", {
          name: /^Weekly product digest/u,
          level: 4,
        }),
      ).toBeVisible();
      break;
  }
}

test("all six modes expose one keyboard-owned workspace and populated desktop evidence", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openPostwaveAI(page, bootApp, setTheme);
  const chatTab = page.getByRole("tab", { name: /^Chat:/u });
  const composeTab = page.getByRole("tab", { name: /^Compose:/u });

  await chatTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(composeTab).toBeFocused();
  await expect(chatTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Space");
  await expect(composeTab).toHaveAttribute("aria-selected", "true");

  const violations: unknown[] = [];
  for (const mode of MODES) {
    await selectPostwaveAIMode(page, mode);
    await expectModeSurface(page, mode);
    await resetPostwaveAIScroll(page);
    await expectNoPostwaveAIOverflow(page);
    violations.push(
      ...(await auditPostwaveAIA11y(page, harness, `mode-${mode}`)),
    );
    await capturePostwaveAIEvidence(
      page,
      testInfo,
      `postwave-ai-mode-${mode}-desktop-dark`,
      harness,
    );
  }

  expect(violations).toEqual([]);
  await expectPostwaveAISafety(page, harness);
});

test("chat covers command and context discovery, one in-flight generation, completion, and contained failure", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openPostwaveAI(page, bootApp, setTheme);
  const input = page.getByRole("combobox", { name: "Ask Moosewave AI" });

  await input.fill("/");
  const slashMenu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(slashMenu).toBeVisible();
  await expect(slashMenu.getByRole("option")).toHaveCount(6);
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-chat-slash-command-menu",
    harness,
  );
  await page.keyboard.press("Escape");

  await input.fill("@");
  const mentionMenu = page.getByRole("listbox", { name: "Mention picker" });
  await expect(mentionMenu).toBeVisible();
  await expect(mentionMenu.getByRole("option")).toHaveCount(4);
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-chat-context-picker",
    harness,
  );
  await page.keyboard.press("Escape");

  await input.fill("Draft a practical launch update for the product team.");
  harness.setEndpointMode("/api/v1/voice/generate", "deferred");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Cancel generation" }),
  ).toBeVisible();
  await expect(
    page.locator('.ai-msg-assistant[aria-busy="true"]'),
  ).toBeVisible();
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-chat-generating",
    harness,
  );

  harness.releaseEndpoint("/api/v1/voice/generate");
  await expect(
    page.getByText(
      "Your next launch can move quickly without hiding the final checks.",
      {
        exact: false,
      },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use as draft" }),
  ).toBeVisible();
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-chat-generated-draft",
    harness,
  );

  harness.setEndpointMode("/api/v1/voice/generate", "error");
  await input.fill("Draft another launch message.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("alert").last()).toContainText(
    "AI service error (503)",
  );
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  const chatErrorViolations = await auditPostwaveAIA11y(
    page,
    harness,
    "chat-error",
  );
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-chat-contained-error",
    harness,
  );

  expect(chatErrorViolations).toEqual([]);
  await expectNoPostwaveAIOverflow(page);
  await expectPostwaveAISafety(page, harness);
});

test("compose preserves loading truth, generated review, selected-subject state, stale evidence, and retryable failure", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openPostwaveAI(page, bootApp, setTheme, {
    mode: "compose",
    theme: "light",
  });
  await composeBrief(page).fill(
    "Announce a calmer final review workflow for product launches.",
  );
  await page
    .locator(".ai-compose-input")
    .fill("Product leaders preparing a customer launch");
  harness.setEndpointMode("/api/v1/ai/compose/broadcast", "deferred");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  await expect(page.getByRole("button", { name: "Composing…" })).toBeVisible();
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-compose-loading-light",
    harness,
  );

  harness.releaseEndpoint("/api/v1/ai/compose/broadcast");
  const result = page.getByRole("region", {
    name: "Generated broadcast draft",
  });
  await expect(result).toBeVisible();
  await expect(result).toContainText("Review before using");
  await result
    .getByRole("button", { name: "Three signals before your next send" })
    .click();
  await expect(
    result.getByRole("button", { name: "Three signals before your next send" }),
  ).toHaveAttribute("aria-pressed", "true");
  await scrollPostwaveAITargetIntoFrame(page, result);
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-compose-generated-review-light",
    harness,
  );

  await page
    .locator(".ai-compose-input")
    .fill("Product leaders and customer-success teams");
  await expect(result).toContainText("Earlier inputs");
  await expect(
    result.getByRole("button", { name: "Use as draft → Campaigns" }),
  ).toBeDisabled();
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-compose-stale-result",
    harness,
  );

  await page.getByRole("button", { name: "Reset" }).click();
  harness.setEndpointMode("/api/v1/ai/compose/broadcast", "error");
  await page.getByRole("button", { name: "Compose", exact: true }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("AI operation failed");
  await expect(alert).not.toContainText("provider-secret");
  const composeErrorViolations = await auditPostwaveAIA11y(
    page,
    harness,
    "compose-error",
  );
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-compose-retryable-error",
    harness,
  );

  expect(composeErrorViolations).toEqual([]);
  await expectNoPostwaveAIOverflow(page);
  await expectPostwaveAISafety(page, harness);
});

test("subject lab carries seed context through analyzer loading, scored variants, and an explicit staged handoff", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openPostwaveAI(page, bootApp, setTheme, {
    mode: "subject",
  });
  await page
    .getByLabel("Seed subject")
    .fill("Make launch readiness easier to trust");
  await page
    .getByLabel("Campaign body context (optional)")
    .fill(
      "A final review workspace that keeps readiness evidence and human approval visible.",
    );
  await page.getByRole("button", { name: "Open confidence lab" }).click();
  const dialog = page.getByRole("dialog", { name: "Subject Lab" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Subject analyzer");

  harness.setEndpointMode("/api/v1/subject-lab/variants", "deferred");
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Generating…" }),
  ).toBeVisible();
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-subject-lab-generating",
    harness,
  );

  harness.releaseEndpoint("/api/v1/subject-lab/variants");
  const variants = dialog.getByRole("table", {
    name: "Generated subject variants and predicted performance",
  });
  await expect(variants).toBeVisible();
  await expect(variants.getByRole("row")).toHaveCount(7);
  await expect(dialog).toContainText("Tenant baseline open rate: 39.1%");
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-subject-lab-scored-results",
    harness,
  );
  expect(
    await auditPostwaveAIA11y(
      page,
      harness,
      "subject-results-dialog",
      '[role="dialog"]',
    ),
  ).toEqual([]);

  await dialog
    .getByRole("button", { name: "Stage top 3 for campaign review" })
    .click();
  await expect(dialog).toHaveCount(0);
  const staged = page.locator(".ai-subject-candidates");
  await expect(staged).toContainText("Top candidates staged for review");
  await expect(staged.getByRole("radio")).toHaveCount(3);
  await scrollPostwaveAITargetIntoFrame(page, staged);
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-subject-lab-staged-review",
    harness,
  );

  await expectNoPostwaveAIOverflow(page);
  await expectPostwaveAISafety(page, harness);
});

test("pre-send distinguishes empty, loading, complete, stale, and unavailable evidence", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openPostwaveAI(page, bootApp, setTheme, {
    mode: "presend",
  });
  await expect(
    page.getByText("No advisory result yet", { exact: true }),
  ).toBeVisible();
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-presend-empty",
    harness,
  );

  await fillPresendDraft(page);
  harness.setEndpointMode("/api/v1/presend/verdict", "deferred");
  await page.getByRole("button", { name: "Run pre-send check" }).click();
  await expect(
    page.getByText("Reviewing this draft", { exact: true }),
  ).toBeVisible();
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-presend-loading",
    harness,
  );

  harness.releaseEndpoint("/api/v1/presend/verdict");
  const result = page.locator(".presend-check__result");
  await expect(
    result.getByRole("heading", { name: "Checks completed" }),
  ).toBeVisible();
  await expect(result).toContainText("3 of 3 checks completed");
  await scrollPostwaveAITargetIntoFrame(page, result);
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-presend-complete",
    harness,
  );

  await page
    .getByRole("textbox", { name: "Subject Required", exact: true })
    .fill("Updated launch readiness review");
  await expect(result).toContainText("Previous result");
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-presend-stale",
    harness,
  );

  harness.setEndpointMode("/api/v1/presend/verdict", "error");
  await page.getByRole("button", { name: "Run pre-send check" }).click();
  await expect(page.getByRole("alert")).toContainText("Review unavailable");
  await expect(result).toContainText("Previous result");
  const presendErrorViolations = await auditPostwaveAIA11y(
    page,
    harness,
    "presend-error",
  );
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-presend-unavailable-with-prior-evidence",
    harness,
  );

  expect(presendErrorViolations).toEqual([]);
  await expectNoPostwaveAIOverflow(page);
  await expectPostwaveAISafety(page, harness);
});

test("routines expose bounded loading, populated scheduling truth, run receipts, editor context, and a true empty state", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openPostwaveAI(page, bootApp, setTheme, {
    deferredEndpoints: ["/api/v1/agent-routines"],
    mode: "routines",
    theme: "light",
  });
  await expect(
    page.getByText("Loading routines…", { exact: true }),
  ).toBeVisible();
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-routines-loading-light",
    harness,
  );

  harness.releaseEndpoint("/api/v1/agent-routines");
  await expect(
    page.getByRole("heading", {
      name: /^Weekly product digest/u,
      level: 4,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: /^Paused win-back sequence/u,
      level: 4,
    }),
  ).toBeVisible();
  const weeklyActions = page.getByRole("group", {
    name: "Actions for Weekly product digest",
  });
  await expect(
    page.getByText("Draft in progress", { exact: true }),
  ).toBeVisible();
  await expect(
    weeklyActions.getByRole("button", { name: "Run now" }),
  ).toBeDisabled();
  await expect(
    weeklyActions.getByRole("button", { name: "Edit" }),
  ).toBeDisabled();
  await expect(
    weeklyActions.getByRole("button", { name: "Delete" }),
  ).toBeDisabled();
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-routines-populated-light",
    harness,
  );

  await weeklyActions.getByRole("button", { name: "Run history" }).click();
  const history = page.getByRole("region", {
    name: "Run history for Weekly product digest",
  });
  await expect(history).toBeVisible();
  await expect(history).toContainText("Draft created");
  await history.getByRole("button", { name: "Why & preview" }).click();
  await expect(history).toContainText(
    "I led with the highest-impact release and kept one review CTA.",
  );
  await scrollPostwaveAITargetIntoFrame(page, history);
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-routines-run-trust-receipt",
    harness,
  );

  await page.getByRole("button", { name: "+ New routine" }).click();
  const editor = page.getByRole("dialog", { name: "New routine" });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Target segment (optional)")).toBeVisible();
  await expect(editor.getByLabel("Name")).toBeFocused();
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-routines-editor",
    harness,
  );
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);

  harness.setEndpointPayload("/api/v1/agent-routines", { items: [] });
  await page.reload();
  await expect(
    page.getByText("No routines yet", { exact: true }),
  ).toBeVisible();
  const routineEmptyViolations = await auditPostwaveAIA11y(
    page,
    harness,
    "routines-empty",
  );
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-routines-empty",
    harness,
  );

  expect(routineEmptyViolations).toEqual([]);
  await expectNoPostwaveAIOverflow(page);
  await expectPostwaveAISafety(page, harness);
});

test("viewer permissions remain explicit across every mode and never imply an authorized AI mutation", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openPostwaveAI(page, bootApp, setTheme, {
    role: "viewer",
  });
  const captures: Array<[PostwaveAIMode, string]> = [
    ["chat", "postwave-ai-viewer-chat"],
    ["compose", "postwave-ai-viewer-compose"],
    ["subject", "postwave-ai-viewer-subject"],
    ["presend", "postwave-ai-viewer-presend"],
    ["agent", "postwave-ai-viewer-agent"],
    ["routines", "postwave-ai-viewer-routines"],
  ];
  let viewerViolations: unknown[] = [];

  for (const [mode, name] of captures) {
    await selectPostwaveAIMode(page, mode);
    if (mode === "chat") {
      await expect(
        page.getByText(/View-only · ask an editor or admin/u),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Send", exact: true }),
      ).toBeDisabled();
    } else if (mode === "compose") {
      await expect(page.locator(".ai-compose-status")).toContainText(
        "View-only access",
      );
      await expect(
        page.getByRole("button", { name: "Compose" }),
      ).toBeDisabled();
    } else if (mode === "subject") {
      await expect(
        page.getByText(/only editors and admins can generate/u),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Open confidence lab" }),
      ).toBeDisabled();
    } else if (mode === "presend") {
      await fillPresendDraft(page);
      await expect(
        page.getByRole("button", { name: "Run pre-send check" }),
      ).toBeDisabled();
    } else if (mode === "agent") {
      await expect(
        page.getByText("Your current role can't view MCP execution activity.", {
          exact: true,
        }),
      ).toBeVisible();
    } else {
      await expect(
        page.getByText("Read-only viewer", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "+ New routine" }),
      ).toBeDisabled();
      viewerViolations = await auditPostwaveAIA11y(
        page,
        harness,
        "viewer-routines",
      );
    }
    await resetPostwaveAIScroll(page);
    await expectNoPostwaveAIOverflow(page);
    await capturePostwaveAIEvidence(page, testInfo, name, harness);
  }

  expect(viewerViolations).toEqual([]);
  await expectPostwaveAISafety(page, harness);
});

test("the route reflows without page overflow from wide desktop through narrow and a 200 percent proxy", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openPostwaveAI(page, bootApp, setTheme, {
    mode: "compose",
    theme: "light",
  });
  const viewports = [
    { name: "wide-1440-light", width: 1_440, height: 1_000 },
    { name: "compact-720-dark", width: 720, height: 900 },
    { name: "narrow-400-light", width: 400, height: 800 },
    { name: "minimum-360-dark", width: 360, height: 800 },
    // Chromium has no stable cross-platform browser-zoom API. 440 CSS px
    // models an 880 CSS-pixel app window at 200% zoom.
    { name: "zoom-200-proxy", width: 440, height: 560 },
  ];
  let responsiveViolations: unknown[] = [];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate((name) => {
      const theme = name.includes("dark") ? "dark" : "light";
      document.documentElement.dataset.theme = theme;
    }, viewport.name);
    await resetPostwaveAIScroll(page);
    await expectNoPostwaveAIOverflow(page);
    if (viewport.name === "zoom-200-proxy") {
      responsiveViolations = await auditPostwaveAIA11y(
        page,
        harness,
        "responsive-200-proxy",
      );
    }
    await capturePostwaveAIEvidence(
      page,
      testInfo,
      `postwave-ai-responsive-${viewport.name}`,
      harness,
    );
  }

  expect(responsiveViolations).toEqual([]);
  await expectPostwaveAISafety(page, harness);
});

test("forced colors and reduced motion preserve selected-state, focus, semantics, and calm rendering", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({
    colorScheme: "dark",
    forcedColors: "active",
    reducedMotion: "reduce",
  });
  const harness = await openPostwaveAI(page, bootApp, setTheme, {
    theme: "system",
  });
  await expectPostwaveAIForcedColors(page);
  await expectPostwaveAIReducedMotion(page);

  const toggle = page.locator(".ai-inspector-toggle");
  await expect(toggle).toHaveAccessibleName("Hide context");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAccessibleName("Show context");
  await expect(page.locator("#postwave-ai-inspector")).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(page.locator("#postwave-ai-inspector")).toBeVisible();
  await expectNoPostwaveAIOverflow(page);
  const forcedColorsViolations = await auditPostwaveAIA11y(
    page,
    harness,
    "forced-colors",
    ".ai-shell",
    { includeColorContrast: false },
  );
  await capturePostwaveAIEvidence(
    page,
    testInfo,
    "postwave-ai-forced-colors-reduced-motion",
    harness,
  );

  expect(forcedColorsViolations).toEqual([]);
  await expectPostwaveAISafety(page, harness);
});
