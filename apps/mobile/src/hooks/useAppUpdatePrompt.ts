/**
 * useAppUpdatePrompt — the app-wide half of the update surface.
 *
 * A downloaded update that nobody is told about is the same as no update: it
 * applies on the next cold start, which on a phone can be days away. Desktop
 * has `DesktopUpdateBadge` in its TopBar for exactly this; mobile had nothing
 * (SHELL#29).
 *
 * A TOAST rather than a banner or a modal, deliberately:
 *   - a modal would interrupt whatever the user is doing for something that
 *     is not urgent;
 *   - a persistent banner would sit on top of every screen indefinitely,
 *     which is the chrome cost the offline banner already pays and this does
 *     not deserve;
 *   - a toast with an action states the fact once, offers the one-tap path,
 *     and leaves the same control permanently available in Diagnostics for
 *     anyone who dismisses it.
 *
 * Restarting DISCARDS unsent work: `reloadAsync()` tears down the JS context,
 * and the offline mutation queue is only durable for mutations the persister
 * has already written. So the restart goes through the same pre-restart
 * safety scan the diagnostics card uses (hooks/useRestartSafety — desktop's
 * DesktopUpdateService restartDecision): it names unsaved edits, syncing and
 * queued changes and open shares, blocks on the ones a restart would lose
 * outright, and "Remind me in 4 hours" re-raises this toast when the
 * deferral elapses.
 */
import { useCallback, useEffect, useRef } from "react";

import { useToast } from "@/components/Toast";
import { useAppUpdateWatcher } from "@/hooks/useAppUpdate";
import { useGuardedRestart } from "@/hooks/useRestartSafety";
import {
  clearRestartReminder,
  RESTART_REMINDER_MS,
  restartReminderDue,
} from "@/lib/restartSafetyScan";

export function useAppUpdatePrompt(): void {
  const { toast } = useToast();
  const guardedRestart = useGuardedRestart();
  const reminder = useRef<ReturnType<typeof setTimeout> | null>(null);
  const announceRef = useRef<() => void>(() => undefined);

  useEffect(
    () => () => {
      if (reminder.current) clearTimeout(reminder.current);
    },
    [],
  );

  const restart = useCallback(async () => {
    const outcome = await guardedRestart();
    if (outcome !== "deferred") return;
    if (reminder.current) clearTimeout(reminder.current);
    reminder.current = setTimeout(() => {
      reminder.current = null;
      if (!restartReminderDue()) return;
      clearRestartReminder();
      announceRef.current();
    }, RESTART_REMINDER_MS);
  }, [guardedRestart]);

  const announce = useCallback(() => {
    toast({
      kind: "info",
      message: "A Moosewave update is ready.",
      action: {
        label: "Restart",
        onPress: () => {
          void restart();
        },
      },
      // Longer than the default: the user has to read it, decide, and
      // understand that restarting is a deliberate act.
      durationMs: 9000,
    });
  }, [restart, toast]);
  announceRef.current = announce;

  useAppUpdateWatcher(announce);
}
