import { expect } from "@playwright/test";

import budgets from "../../performance-budgets.json" with { type: "json" };
import { collectGarbageCollectedDomCounters } from "../../scripts/collect-dom-metric.mjs";
import { test } from "../visual/fixture";

const MIB = 1024 * 1024;
const ROUTES = [
  { label: "Subscribers", heading: "Subscribers" },
  { label: "Campaigns", heading: "Campaigns" },
  { label: "Analytics", heading: "Analytics" },
  { label: "Webhook simulator", heading: "Webhook Simulator" },
  { label: "Settings", heading: "Settings" },
] as const;

interface BrowserMetric {
  name: string;
  value: number;
}

interface PerformanceMetricsResult {
  metrics: BrowserMetric[];
}

function metric(result: PerformanceMetricsResult, name: string): number {
  const value = result.metrics.find((entry) => entry.name === name)?.value;
  if (value == null) throw new Error(`Chromium did not report ${name}`);
  return value;
}

function percentile95(values: readonly number[]): number {
  if (values.length === 0) throw new Error("cannot calculate p95 of no values");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

test.describe("optimized renderer performance budgets", () => {
  test("cold authenticated shell stays within paint, heap and blocking budgets", async ({
    page,
    context,
    bootApp,
  }, testInfo) => {
    await bootApp(page);
    await page.addInitScript(() => {
      const durations: number[] = [];
      const coldMetrics: {
        longTasks: number[];
        longTaskObserverAvailable: boolean;
        shellReadyMs: number | null;
      } = {
        longTasks: durations,
        longTaskObserverAvailable: false,
        shellReadyMs: null,
      };
      Object.defineProperty(window, "__postwaveColdMetrics", {
        value: coldMetrics,
        configurable: true,
      });
      const captureShellReady = (): void => {
        if (coldMetrics.shellReadyMs !== null) return;
        const sidebar = document.querySelector(".sidebar");
        const dashboardHeading = Array.from(
          document.querySelectorAll("h1"),
        ).some((heading) => heading.textContent?.trim() === "Dashboard");
        if (sidebar && dashboardHeading) {
          coldMetrics.shellReadyMs = performance.now();
          shellObserver.disconnect();
        }
      };
      const shellObserver = new MutationObserver(captureShellReady);
      shellObserver.observe(document, { childList: true, subtree: true });
      document.addEventListener("DOMContentLoaded", captureShellReady, {
        once: true,
      });
      try {
        if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) {
          return;
        }
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) durations.push(entry.duration);
        });
        observer.observe({ type: "longtask", buffered: true });
        coldMetrics.longTaskObserverAvailable = true;
      } catch {
        // The explicit availability assertion below makes this fail closed.
      }
    });

    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.enable");
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page
      .locator(".sidebar")
      .waitFor({ state: "visible", timeout: 20_000 });
    await expect(
      page.getByRole("heading", { name: "Dashboard", exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    const navigation = await page.evaluate(() => {
      const paint = performance.getEntriesByName("first-contentful-paint")[0];
      const coldMetrics = (
        window as unknown as {
          __postwaveColdMetrics?: {
            longTasks: number[];
            longTaskObserverAvailable: boolean;
            shellReadyMs: number | null;
          };
        }
      ).__postwaveColdMetrics;
      return {
        shellReadyMs: coldMetrics?.shellReadyMs ?? null,
        firstContentfulPaintMs: paint?.startTime ?? null,
        longTasks: coldMetrics?.longTasks ?? [],
        longTaskObserverAvailable:
          coldMetrics?.longTaskObserverAvailable ?? false,
        connectedElements: document.querySelectorAll("*").length,
        connectedNodes: (() => {
          const walker = document.createTreeWalker(
            document,
            NodeFilter.SHOW_ALL,
          );
          let count = 1;
          while (walker.nextNode()) count += 1;
          return count;
        })(),
      };
    });
    expect(navigation.shellReadyMs).not.toBeNull();
    expect(navigation.firstContentfulPaintMs).not.toBeNull();
    expect(navigation.longTaskObserverAvailable).toBe(true);

    const browser = (await cdp.send(
      "Performance.getMetrics",
    )) as PerformanceMetricsResult;
    const jsHeapMiB = metric(browser, "JSHeapUsedSize") / MIB;
    const uncollectedDomNodes = metric(browser, "Nodes");
    // Chromium's raw Nodes metric includes unreachable parser and React
    // reconciliation intermediates until V8 happens to collect them. That
    // made identical active documents report anywhere from ~2.4k to ~16k
    // nodes. Collect first so the budget still catches connected DOM and
    // genuinely retained detached nodes, without depending on GC timing.
    const collectedDomCounters = await collectGarbageCollectedDomCounters(cdp);
    const maxLongTaskMs = Math.max(0, ...navigation.longTasks);
    const totalBlockingTimeMs = navigation.longTasks.reduce(
      (total, duration) => total + Math.max(0, duration - 50),
      0,
    );
    const result = {
      shellReadyMs: navigation.shellReadyMs!,
      firstContentfulPaintMs: navigation.firstContentfulPaintMs,
      jsHeapMiB,
      domNodes: collectedDomCounters.nodes,
      connectedElements: navigation.connectedElements,
      connectedNodes: navigation.connectedNodes,
      uncollectedDomNodes,
      rendererDocuments: collectedDomCounters.documents,
      rendererEventListeners: collectedDomCounters.jsEventListeners,
      maxLongTaskMs,
      totalBlockingTimeMs,
      longTaskObserverAvailable: navigation.longTaskObserverAvailable,
    };
    console.info(`[desktop-performance:cold] ${JSON.stringify(result)}`);
    await testInfo.attach("cold-renderer-performance.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });

    expect(result.shellReadyMs).toBeLessThanOrEqual(
      budgets.renderer.coldShellReadyMs,
    );
    expect(result.firstContentfulPaintMs!).toBeLessThanOrEqual(
      budgets.renderer.firstContentfulPaintMs,
    );
    expect(result.jsHeapMiB).toBeLessThanOrEqual(
      budgets.renderer.coldJsHeapMiB,
    );
    expect(result.domNodes).toBeLessThanOrEqual(budgets.renderer.coldDomNodes);
    expect(result.maxLongTaskMs).toBeLessThanOrEqual(
      budgets.renderer.coldMaxLongTaskMs,
    );
    expect(result.totalBlockingTimeMs).toBeLessThanOrEqual(
      budgets.renderer.coldTotalBlockingTimeMs,
    );
  });

  test("repeated heavy-route traversal has bounded transition time and retained heap", async ({
    page,
    context,
    bootApp,
  }, testInfo) => {
    await bootApp(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.enable");
    await page.goto("/");
    await page
      .locator(".sidebar")
      .waitFor({ state: "visible", timeout: 20_000 });

    const traverse = async (): Promise<number[]> => {
      const timings: number[] = [];
      for (const route of ROUTES) {
        const item = page
          .locator(".sidebar-item")
          .filter({ hasText: new RegExp(`^\\s*${route.label}`) })
          .first();
        await expect(item).toBeVisible();
        const transitionMs = await page.evaluate(
          async ({ heading, label }) =>
            await new Promise<number>((resolve, reject) => {
              const button = Array.from(
                document.querySelectorAll<HTMLButtonElement>(".sidebar-item"),
              ).find((candidate) =>
                candidate.textContent?.trim().startsWith(label),
              );
              if (!button) {
                reject(new Error(`missing sidebar item ${label}`));
                return;
              }
              let startedAt = 0;
              const timer = window.setTimeout(() => {
                observer.disconnect();
                reject(new Error(`route ${label} did not render within 10s`));
              }, 10_000);
              const check = (): void => {
                const rendered = Array.from(
                  document.querySelectorAll("h1"),
                ).some((candidate) => candidate.textContent?.includes(heading));
                if (!rendered || startedAt === 0) return;
                window.clearTimeout(timer);
                observer.disconnect();
                resolve(performance.now() - startedAt);
              };
              const observer = new MutationObserver(check);
              button.addEventListener(
                "click",
                () => {
                  startedAt = performance.now();
                  observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                  });
                  queueMicrotask(check);
                },
                { capture: true, once: true },
              );
              button.click();
            }),
          route,
        );
        await expect(
          page
            .getByRole("heading", { name: route.heading, exact: false })
            .first(),
        ).toBeVisible({ timeout: 10_000 });
        timings.push(transitionMs);
      }
      return timings;
    };

    const firstTimings = await traverse();
    await cdp.send("HeapProfiler.collectGarbage");
    const firstMetrics = (await cdp.send(
      "Performance.getMetrics",
    )) as PerformanceMetricsResult;
    const firstHeapMiB = metric(firstMetrics, "JSHeapUsedSize") / MIB;

    const secondTimings = await traverse();
    await cdp.send("HeapProfiler.collectGarbage");
    const secondMetrics = (await cdp.send(
      "Performance.getMetrics",
    )) as PerformanceMetricsResult;
    const secondHeapMiB = metric(secondMetrics, "JSHeapUsedSize") / MIB;
    const heapGrowthMiB = Math.max(0, secondHeapMiB - firstHeapMiB);
    const routeTransitionP95Ms = percentile95([
      ...firstTimings,
      ...secondTimings,
    ]);
    const result = {
      routes: ROUTES.map((route) => route.label),
      firstTimings,
      secondTimings,
      routeTransitionP95Ms,
      firstHeapMiB,
      secondHeapMiB,
      heapGrowthMiB,
    };
    console.info(`[desktop-performance:warm] ${JSON.stringify(result)}`);
    await testInfo.attach("warm-route-performance.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });

    expect(routeTransitionP95Ms).toBeLessThanOrEqual(
      budgets.renderer.routeTransitionP95Ms,
    );
    expect(secondHeapMiB).toBeLessThanOrEqual(
      budgets.renderer.warmRouteCycleHeapMiB,
    );
    expect(heapGrowthMiB).toBeLessThanOrEqual(
      budgets.renderer.warmRouteCycleGrowthMiB,
    );
  });
});
