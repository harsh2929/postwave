/**
 * Regression guard for the app-shell scroll bug.
 *
 * `.app-shell` is a CSS grid. Without `grid-template-rows: minmax(0, 1fr)`
 * its single row auto-sizes to content, so on any page taller than the
 * window `.main` / `.content` inflate past the viewport and `.content`'s
 * `overflow-y: auto` scroller never engages — `body { overflow: hidden }`
 * then silently clips everything below the fold (the "can't scroll down"
 * complaint). This test pins the invariant: when a page exceeds the
 * viewport, `.content` is the scroller and neither the shell nor the body
 * overflows.
 */

import { expect } from "@playwright/test";

import { test } from "./fixture";

test("app content area scrolls when a page exceeds the viewport", async ({
  page,
  bootApp,
}) => {
  await bootApp(page);
  // A short viewport guarantees real content overflows it.
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.goto("/");
  await page.waitForSelector(".content", { timeout: 8000 });

  // Force tall content so the measurement doesn't depend on stubbed data.
  await page.evaluate(() => {
    const c = document.querySelector<HTMLElement>(".content");
    if (!c) throw new Error("no .content element");
    const spacer = document.createElement("div");
    spacer.style.height = "3000px";
    spacer.setAttribute("data-test-spacer", "1");
    c.appendChild(spacer);
  });

  const m = await page.evaluate(() => {
    const q = (s: string) => document.querySelector<HTMLElement>(s)!;
    const content = q(".content");
    const shell = q(".app-shell");
    const body = document.body;
    return {
      contentScrolls: content.scrollHeight > content.clientHeight + 4,
      contentClient: content.clientHeight,
      innerH: window.innerHeight,
      // The shell + body must NOT themselves overflow — `.content` owns scroll.
      shellOverflow: shell.scrollHeight - shell.clientHeight,
      bodyOverflow: body.scrollHeight - body.clientHeight,
    };
  });

  // `.content` is the scroll container...
  expect(m.contentScrolls).toBe(true);
  // ...bounded to roughly the viewport (not inflated to content height)...
  expect(m.contentClient).toBeLessThanOrEqual(m.innerH);
  // ...while the shell and body do not overflow (nothing clipped below fold).
  expect(m.shellOverflow).toBeLessThanOrEqual(2);
  expect(m.bodyOverflow).toBeLessThanOrEqual(2);

  // And the scroller actually moves (scroll-behavior: smooth → poll).
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".content")!.scrollTop = 1200;
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.querySelector<HTMLElement>(".content")!.scrollTop,
        ),
      { timeout: 2000 },
    )
    .toBeGreaterThan(500);
});

test("native minimum window keeps the shell bounded and the task pane usable", async ({
  page,
  bootApp,
}) => {
  await page.setViewportSize({ width: 880, height: 560 });
  await bootApp(page);
  await page.goto("/");
  await page.waitForSelector(".content", { timeout: 8000 });

  const metrics = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    const main = document.querySelector<HTMLElement>(".main");
    if (!content || !shell || !sidebar || !main) {
      throw new Error("desktop shell did not mount");
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      shellOverflowX: shell.scrollWidth - shell.clientWidth,
      shellOverflowY: shell.scrollHeight - shell.clientHeight,
      bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
      bodyOverflowY: document.body.scrollHeight - document.body.clientHeight,
      sidebarWidth: sidebar.getBoundingClientRect().width,
      mainWidth: main.getBoundingClientRect().width,
      contentCanScroll: getComputedStyle(content).overflowY,
    };
  });

  expect(metrics.viewport).toEqual({ width: 880, height: 560 });
  expect(metrics.shellOverflowX).toBeLessThanOrEqual(2);
  expect(metrics.shellOverflowY).toBeLessThanOrEqual(2);
  expect(metrics.bodyOverflowX).toBeLessThanOrEqual(2);
  expect(metrics.bodyOverflowY).toBeLessThanOrEqual(2);
  expect(metrics.sidebarWidth).toBeLessThanOrEqual(65);
  expect(metrics.mainWidth).toBeGreaterThan(700);
  expect(metrics.contentCanScroll).toBe("auto");
});

test("200 percent layout proxy preserves shell ownership without page clipping", async ({
  page,
  bootApp,
}) => {
  // Browser zoom changes the CSS-pixel viewport. 440×280 is the deterministic
  // renderer proxy for the native 880×560 window at 200%; exact installed-app
  // zoom/scaling remains part of the signed-package matrix.
  await page.setViewportSize({ width: 440, height: 280 });
  await bootApp(page);
  await page.goto("/");
  await page.waitForSelector(".content", { timeout: 8000 });

  const metrics = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const main = document.querySelector<HTMLElement>(".main");
    if (!content || !shell || !main) throw new Error("desktop shell did not mount");
    return {
      shellOverflowX: shell.scrollWidth - shell.clientWidth,
      shellOverflowY: shell.scrollHeight - shell.clientHeight,
      bodyOverflowX: document.body.scrollWidth - document.body.clientWidth,
      bodyOverflowY: document.body.scrollHeight - document.body.clientHeight,
      mainWidth: main.getBoundingClientRect().width,
      contentWidth: content.getBoundingClientRect().width,
    };
  });

  expect(metrics.shellOverflowX).toBeLessThanOrEqual(2);
  expect(metrics.shellOverflowY).toBeLessThanOrEqual(2);
  expect(metrics.bodyOverflowX).toBeLessThanOrEqual(2);
  expect(metrics.bodyOverflowY).toBeLessThanOrEqual(2);
  expect(metrics.mainWidth).toBeGreaterThan(300);
  expect(metrics.contentWidth).toBeGreaterThan(300);
});
