import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MutableRefObject,
} from "react";

import { registerLifecycleGuard } from "../lib/lifecycle-coordinator";
import { markLifecycleOperationRefRetained } from "./useSettingsDraftLifecycle";

interface PersistentLifecycleOperationOptions {
  /** Stable surface/resource identity; a mounted-instance token is appended. */
  ownerId: string;
  label: string;
  detail?: string;
}

export interface PersistentLifecycleOperation {
  active: boolean;
  promiseRef: MutableRefObject<Promise<unknown> | null>;
  run: <T>(operation: () => Promise<T>) => Promise<T> | null;
  wait: () => Promise<void>;
}

/**
 * Own one exact, non-cancellable request from the first synchronous event
 * through settlement. Unlike an effect-backed activity flag, the imperative
 * lifecycle guard deliberately survives a component unmount and is released
 * only by the request's `finally` path. This closes the route-change/window-
 * exit gap without touching React state after unmount.
 */
export function usePersistentLifecycleOperation({
  ownerId,
  label,
  detail = "Wait for this request to finish before leaving Moosewave.",
}: PersistentLifecycleOperationOptions): PersistentLifecycleOperation {
  const instanceId = useId();
  const mountedRef = useRef(true);
  const promiseRef = useRef<Promise<unknown> | null>(null);
  markLifecycleOperationRefRetained(promiseRef);
  const operationSequenceRef = useRef(0);
  const [active, setActive] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // The request owns its process-wide guard until settlement. Do not
      // unregister it merely because this renderer surface disappeared.
    };
  }, []);

  const run = useCallback(
    <T>(operation: () => Promise<T>): Promise<T> | null => {
      if (promiseRef.current) return null;
      const operationId = ++operationSequenceRef.current;
      const unregister = registerLifecycleGuard({
        id: `active-operation-${ownerId}-${instanceId}-${operationId}`,
        label,
        inspect: (intent) =>
          intent.disposition === "hide"
            ? null
            : {
                level: "blocking",
                detail,
                canSave: false,
                canDiscard: false,
                canRecover: false,
              },
      });
      if (mountedRef.current) setActive(true);
      const source = (async (): Promise<T> => operation())();
      let tracked: Promise<T>;
      tracked = source.finally(() => {
        if (promiseRef.current === tracked) promiseRef.current = null;
        // Clear before unregister notifies lifecycle subscribers so the draft
        // owner can immediately re-surface retained retry state on failure.
        unregister();
        if (mountedRef.current) setActive(false);
      });
      promiseRef.current = tracked;
      return tracked;
    },
    [detail, instanceId, label, ownerId],
  );

  const wait = useCallback(async (): Promise<void> => {
    await promiseRef.current;
  }, []);

  return { active, promiseRef, run, wait };
}
