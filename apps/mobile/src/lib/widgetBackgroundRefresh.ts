/**
 * lib/widgetBackgroundRefresh.ts — keeping the home-screen widget alive
 * between visits to the Dashboard tab (DASHBOARD#50 / NATIVE#19).
 *
 * The snapshot's only writer is `useWidgetMirror`, mounted by
 * `app/(tabs)/dashboard.tsx`. Splitting freshness from expiry (see
 * lib/widgetData.ts) already means the widget keeps showing yesterday's
 * numbers WITH their age instead of blanking after fifteen minutes; this is
 * the other half — actually going and getting new ones.
 *
 * HONEST EXPECTATIONS, because the alternative is a feature that looks
 * scheduled and is not: iOS decides when a `BGAppRefreshTask` runs. The
 * `minimumInterval` below is a floor, not a promise, and Apple documents that
 * short intervals are often ignored in favour of system-chosen windows. This
 * makes the widget MORE current for an app the user opens regularly; it is not
 * a polling loop and must not be described as one.
 *
 * Deliberately narrow, because this runs with no user watching:
 *   - it bails before touching the network unless widget metrics are opted in;
 *   - it never registers the task for an identity that cannot use it;
 *   - every failure is swallowed into a `Failed` result rather than thrown, so
 *     a background launch can never surface a crash the user cannot see the
 *     cause of;
 *   - it writes through the SAME `writeWidgetSnapshot` contract as the
 *     foreground path, so the App Group can only ever hold values that passed
 *     the same clamping and transaction markers.
 */
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";

export const WIDGET_REFRESH_TASK = "postwave-widget-refresh";

/**
 * A floor, and a deliberately unambitious one. Asking for fifteen minutes
 * would not make iOS run it every fifteen minutes; it would only make the
 * budget the system allocates us harder to earn. Two hours is well inside the
 * twelve-hour disclosure window the snapshot lives in.
 */
export const WIDGET_REFRESH_TASK_INTERVAL_MINUTES = 120;

/**
 * What the task actually does, injected so the registration and the work can
 * be reasoned about separately — and so the work can be exercised from the
 * foreground during development without waiting on a system window.
 */
export type WidgetRefreshWork = () => Promise<boolean>;

let work: WidgetRefreshWork | null = null;
let defined = false;

/** Install the refresh implementation. Called once, from the shell hook. */
export function setWidgetRefreshWork(next: WidgetRefreshWork): void {
  work = next;
}

/**
 * Define the OS-facing task. Must happen before `registerTaskAsync`, and must
 * be idempotent: a background launch re-executes module scope, and defining
 * the same task twice throws.
 */
export function defineWidgetRefreshTask(): void {
  if (defined) return;
  defined = true;
  try {
    if (TaskManager.isTaskDefined(WIDGET_REFRESH_TASK)) return;
    TaskManager.defineTask(WIDGET_REFRESH_TASK, async () => {
      try {
        const ok = await work?.();
        return ok
          ? BackgroundTask.BackgroundTaskResult.Success
          : BackgroundTask.BackgroundTaskResult.Failed;
      } catch {
        return BackgroundTask.BackgroundTaskResult.Failed;
      }
    });
  } catch {
    // A platform without the native task module (web, an old dev client).
    // Registration below will fail the same way and is equally guarded.
  }
}

/** Ask the OS to schedule the task. Safe to call repeatedly. */
export async function registerWidgetRefreshTask(): Promise<boolean> {
  try {
    defineWidgetRefreshTask();
    if (!TaskManager.isTaskDefined(WIDGET_REFRESH_TASK)) return false;
    const status = await BackgroundTask.getStatusAsync();
    // `Restricted` means Background App Refresh is off for this app or this
    // device. Registering anyway would leave a task that can never run and
    // would report as scheduled.
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return false;
    await BackgroundTask.registerTaskAsync(WIDGET_REFRESH_TASK, {
      minimumInterval: WIDGET_REFRESH_TASK_INTERVAL_MINUTES,
    });
    return true;
  } catch {
    return false;
  }
}

/** Stop the OS scheduling it — on sign-out, or when the user opts out. */
export async function unregisterWidgetRefreshTask(): Promise<void> {
  try {
    if (!TaskManager.isTaskDefined(WIDGET_REFRESH_TASK)) return;
    const registered = await TaskManager.isTaskRegisteredAsync(
      WIDGET_REFRESH_TASK,
    );
    if (!registered) return;
    await BackgroundTask.unregisterTaskAsync(WIDGET_REFRESH_TASK);
  } catch {
    // Nothing to tell the user: the snapshot is purged by the same code paths
    // that trigger this (sign-out, opt-out), so a lingering registration can
    // only ever find no consent and bail.
  }
}
