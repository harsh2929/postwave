import { describe, expect, it } from "vitest";

import {
  DESKTOP_TASK_INTENTS,
  desktopTaskIntentFromRoute,
  desktopTaskIntentRoute,
  type DesktopTaskIntent,
} from "../../lib/desktop-task-intents";
import {
  DesktopRouterController,
  type DesktopRouterEnvironment,
  parseDesktopRoute,
  serializeDesktopRoute,
} from "../../lib/desktop-router";

class TaskHistoryEnvironment implements DesktopRouterEnvironment {
  readonly entries: Array<{ state: unknown; url: string }>;
  readonly storage = new Map<string, string>();
  index = 0;
  readonly #listeners = new Set<(state: unknown) => void>();

  constructor(url = "/app/dashboard") {
    this.entries = [{ state: null, url }];
  }

  location = (): string => this.entries[this.index]?.url ?? "/app/dashboard";
  historyState = (): unknown => this.entries[this.index]?.state ?? null;
  pushState = (state: unknown, url: string): void => {
    this.entries.splice(this.index + 1);
    this.entries.push({ state, url });
    this.index = this.entries.length - 1;
  };
  replaceState = (state: unknown, url: string): void => {
    this.entries[this.index] = { state, url };
  };
  go = (delta: number): void => {
    const next = this.index + delta;
    if (next < 0 || next >= this.entries.length || next === this.index) return;
    this.index = next;
    for (const listener of this.#listeners) listener(this.historyState());
  };
  subscribePopState = (listener: (state: unknown) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getStorage = (key: string): string | null => this.storage.get(key) ?? null;
  setStorage = (key: string, value: string): void => {
    this.storage.set(key, value);
  };
  removeStorage = (key: string): void => {
    this.storage.delete(key);
  };
}

const intents = Object.keys(DESKTOP_TASK_INTENTS) as DesktopTaskIntent[];

describe("desktop task intents", () => {
  it.each(intents)(
    "round-trips the exact %s task through the route codec",
    (intent) => {
      const route = desktopTaskIntentRoute(intent);
      const url = serializeDesktopRoute(route);
      const parsed = parseDesktopRoute(url);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(desktopTaskIntentFromRoute(parsed.route)).toBe(intent);
      expect(url).toMatch(/^\/app\/[a-z-]+\?overlay=(?:create|import)$/u);
    },
  );

  it("rejects unknown and payload-bearing task shapes", () => {
    const route = desktopTaskIntentRoute("new-campaign");
    expect(
      desktopTaskIntentFromRoute({ ...route, query: "draft body" }),
    ).toBeNull();
    expect(
      desktopTaskIntentFromRoute({
        ...route,
        overlay: { name: "create", resourceId: "record-1" },
      }),
    ).toBeNull();
    expect(
      desktopTaskIntentFromRoute({
        section: "campaigns",
        overlay: { name: "delete" },
      }),
    ).toBeNull();
    const serialized = intents.map((intent) =>
      serializeDesktopRoute(desktopTaskIntentRoute(intent)),
    );
    expect(serialized.join("\n").toLowerCase()).not.toMatch(
      /api[_-]?key|credential|email|password|secret|token/u,
    );
  });

  it("restores a task through Back, Forward, and reload", () => {
    const route = desktopTaskIntentRoute("new-template");
    const environment = new TaskHistoryEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate(route);
    router.navigate({ section: "dashboard" });

    environment.go(-1);
    expect(desktopTaskIntentFromRoute(router.getSnapshot().route)).toBe(
      "new-template",
    );
    environment.go(1);
    expect(desktopTaskIntentFromRoute(router.getSnapshot().route)).toBeNull();

    const reloaded = new DesktopRouterController(
      new TaskHistoryEnvironment(serializeDesktopRoute(route)),
    );
    expect(desktopTaskIntentFromRoute(reloaded.getSnapshot().route)).toBe(
      "new-template",
    );
  });

  it("models explicit close as replacement so Forward cannot reopen it", () => {
    const environment = new TaskHistoryEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate(desktopTaskIntentRoute("new-list"));
    router.navigate({ section: "lists" }, { replace: true });
    expect(environment.entries).toHaveLength(2);
    environment.go(-1);
    expect(router.getSnapshot().route).toEqual({ section: "dashboard" });
    environment.go(1);
    expect(router.getSnapshot().route).toEqual({ section: "lists" });
  });
});
