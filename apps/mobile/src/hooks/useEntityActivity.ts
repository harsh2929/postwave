/**
 * useEntityActivity — donate the entity on screen to iOS (SHELL#31).
 *
 * Call it from a detail screen with whatever is currently known about the
 * entity; it re-donates as the title resolves and suspends the activity when
 * the screen goes away.
 *
 * FAIL-CLOSED ON THE LOCK. The app-lock preference is read asynchronously, so
 * the first render cannot know it. Until it resolves, the hook reports the
 * lock as ARMED and donates nothing — a screen that flashed a campaign title
 * into Spotlight before finding out the workspace is Face-ID protected would
 * have already disclosed it.
 */
import { useEffect, useState } from "react";

import {
  getBiometricLockEnabled,
  subscribeBiometricLockPreference,
} from "@/lib/biometric";
import {
  entityActivityDescriptor,
  type EntityActivityInput,
} from "@/lib/entityActivity";
import {
  donateEntityActivity,
  suspendEntityActivity,
} from "@/lib/entityActivityBridge";

type UseEntityActivityInput = Omit<EntityActivityInput, "appLockEnabled">;

/** The app-lock preference, treating "not yet known" as armed. */
function useAppLockEnabled(): boolean {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void getBiometricLockEnabled()
      .then((value) => {
        if (!cancelled) setEnabled(value);
      })
      .catch(() => {
        // Unreadable preference is not permission.
        if (!cancelled) setEnabled(true);
      });
    const unsubscribe = subscribeBiometricLockPreference((value) => {
      setEnabled(value);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return enabled;
}

export function useEntityActivity(input: UseEntityActivityInput): void {
  const appLockEnabled = useAppLockEnabled();
  const { entity, id, title, subtitle } = input;

  useEffect(() => {
    const descriptor = entityActivityDescriptor({
      entity,
      id,
      title,
      subtitle,
      appLockEnabled,
    });
    if (!descriptor) return;
    if (!donateEntityActivity(descriptor)) return;
    return () => {
      suspendEntityActivity(descriptor.id);
    };
  }, [appLockEnabled, entity, id, title, subtitle]);
}
