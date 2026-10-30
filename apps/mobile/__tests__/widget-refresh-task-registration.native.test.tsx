/**
 * The home-screen widget's background task must exist before the app does.
 *
 * `defineWidgetRefreshTask()` and the `setWidgetRefreshWork()` that gives it
 * something to do both used to live in `useEffect`s inside
 * `useWidgetBackgroundRefresh`, which `ShellLifecycle` mounts from the root
 * layout — BELOW `if (!proceed) return null`. So the OS-facing task came into
 * existence only after auth hydration, the splash and the launch gate had all
 * settled. A `BGAppRefreshTask` wake runs the bundle and then asks TaskManager
 * for the handler; it found either no task or one whose `work` was still null,
 * which `lib/widgetBackgroundRefresh.ts` reports as `Failed` — and iOS answers
 * repeated failures by shrinking the app's future scheduling budget.
 *
 * This suite therefore asserts the thing that is easy to regress by moving one
 * line: both halves happen at MODULE LOAD of `app/_layout.tsx`, with NOTHING
 * rendered. `render()` is deliberately never called below.
 */
import { describe, expect, it, jest } from "@jest/globals";

jest.mock("@/lib/widgetBackgroundRefresh", () => ({
  WIDGET_REFRESH_TASK: "postwave-widget-refresh",
  WIDGET_REFRESH_TASK_INTERVAL_MINUTES: 120,
  setWidgetRefreshWork: jest.fn(),
  defineWidgetRefreshTask: jest.fn(),
  registerWidgetRefreshTask: jest.fn(async () => true),
  unregisterWidgetRefreshTask: jest.fn(async () => undefined),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const bridge = require("@/lib/widgetBackgroundRefresh") as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("NATIVE#19 — the widget task is defined at module scope", () => {
  it("installs the work and defines the task on importing the root layout, with nothing rendered", () => {
    // Precondition, and the whole point: the task does not exist yet. If this
    // fails, something else already imported the layout and the assertions
    // below would pass without proving when the definition happened.
    expect(bridge.setWidgetRefreshWork).not.toHaveBeenCalled();
    expect(bridge.defineWidgetRefreshTask).not.toHaveBeenCalled();

    require("../app/_layout");

    expect(bridge.setWidgetRefreshWork).toHaveBeenCalledTimes(1);
    expect(bridge.defineWidgetRefreshTask).toHaveBeenCalledTimes(1);

    // WORK BEFORE DEFINITION. A task defined while `work` is still null is the
    // exact shape that returns `Failed` from a headless wake, so the order is
    // part of the contract rather than an accident of how the lines are typed.
    const installedAt = bridge.setWidgetRefreshWork.mock.invocationCallOrder[0];
    const definedAt = bridge.defineWidgetRefreshTask.mock.invocationCallOrder[0];
    expect(installedAt).toBeLessThan(definedAt);

    // And it is real work, not a placeholder the hook overwrites later.
    expect(typeof bridge.setWidgetRefreshWork.mock.calls[0][0]).toBe("function");

    // SCHEDULING is not part of this: it needs an authenticated identity and
    // stays in the hook. Defining reaches no network and discloses nothing.
    expect(bridge.registerWidgetRefreshTask).not.toHaveBeenCalled();
  });
});
