import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MutableRefObject,
} from "react";

import {
  registerLifecycleGuard,
  signalLifecycleOwnerChanged,
} from "../lib/lifecycle-coordinator";

export interface SingleFlightOperation {
  active: boolean;
  promiseRef: MutableRefObject<Promise<unknown> | null>;
  run: <T>(operation: () => Promise<T>) => Promise<T> | null;
  wait: () => Promise<void>;
}

interface SingleFlightOperationOptions {
  ownerId: string;
  label: string;
  detail?: string;
}

const retainedOperationRefs = new WeakSet<object>();

/**
 * Mark an operation ref whose own process-level guard outlives its React
 * surface. Draft owners then avoid reporting a duplicate in-flight concern
 * while retaining their dirty-state concern before and after the request.
 */
export function markLifecycleOperationRefRetained(
  operationRef: MutableRefObject<Promise<unknown> | null>,
): void {
  retainedOperationRefs.add(operationRef);
}

export function lifecycleOperationError(
  error: unknown,
  fallback: string,
): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

/**
 * Own one exact mutation promise from the first synchronous click through its
 * final settlement. The promise survives component unmount; only the React
 * activity mirror is suppressed after unmount.
 */
export function useSingleFlightOperation(
  options?: SingleFlightOperationOptions,
): SingleFlightOperation {
  const instanceId = useId();
  const mountedRef = useRef(true);
  const promiseRef = useRef<Promise<unknown> | null>(null);
  const [active, setActive] = useState(false);
  if (options) markLifecycleOperationRefRetained(promiseRef);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    <T>(operation: () => Promise<T>): Promise<T> | null => {
      if (promiseRef.current) return null;
      if (mountedRef.current) setActive(true);
      const source = (async (): Promise<T> => operation())();
      let unregister = (): void => undefined;
      let tracked: Promise<T>;
      tracked = source.finally(() => {
        if (promiseRef.current === tracked) promiseRef.current = null;
        if (mountedRef.current) setActive(false);
        unregister();
        if (!options) signalLifecycleOwnerChanged();
      });
      promiseRef.current = tracked;
      if (options) {
        unregister = registerLifecycleGuard({
          id: `active-setting-operation-${options.ownerId}-${instanceId}`,
          label: options.label,
          inspect: (intent) =>
            intent.disposition === "hide"
              ? null
              : {
                  level: "blocking",
                  detail:
                    options.detail ??
                    "Wait for this settings request to finish before leaving Moosewave.",
                  canSave: false,
                  canDiscard: false,
                  canRecover: false,
                },
        });
      } else {
        signalLifecycleOwnerChanged();
      }
      return tracked;
    },
    [instanceId, options],
  );

  const wait = useCallback(async (): Promise<void> => {
    await promiseRef.current;
  }, []);

  return { active, promiseRef, run, wait };
}

interface ExistingSettingLifecycleOptions {
  ownerId: string;
  label: string;
  dirty: boolean;
  operationRef: MutableRefObject<Promise<unknown> | null>;
  save: () => Promise<boolean>;
  discard: () => void;
  detail?: string;
  operationDetail?: string;
  enabled?: boolean;
}

/**
 * Protect an editor for an already-loaded server setting.
 *
 * Global Save invokes the same validated UI save path and awaits its exact
 * request. A failed save keeps the acknowledged baseline and dirty draft, so
 * the coordinator's post-prepare inspection returns the operator to review.
 */
export function useExistingSettingLifecycle({
  ownerId,
  label,
  dirty,
  operationRef,
  save,
  discard,
  detail = "These setting changes have not been saved.",
  operationDetail = "Wait for this settings request to finish before leaving Moosewave.",
  enabled = true,
}: ExistingSettingLifecycleOptions): void {
  const instanceId = useId();
  const dirtyRef = useRef(dirty);
  const saveRef = useRef(save);
  const discardRef = useRef(discard);
  const detailRef = useRef(detail);
  const operationDetailRef = useRef(operationDetail);
  const enabledRef = useRef(enabled);
  dirtyRef.current = dirty;
  saveRef.current = save;
  discardRef.current = discard;
  detailRef.current = detail;
  operationDetailRef.current = operationDetail;
  enabledRef.current = enabled;

  useEffect(() => {
    signalLifecycleOwnerChanged();
  }, [dirty, enabled]);

  useEffect(
    () =>
      registerLifecycleGuard({
        id: `setting-draft-${ownerId}-${instanceId}`,
        label,
        inspect: (intent) => {
          if (!enabledRef.current) return null;
          if (intent.disposition === "hide") return null;
          if (operationRef.current) {
            if (retainedOperationRefs.has(operationRef)) return null;
            return {
              level: "blocking",
              detail: operationDetailRef.current,
              canSave: false,
              canDiscard: false,
              canRecover: false,
            };
          }
          if (!dirtyRef.current) return null;
          return {
            level: "warning",
            detail: detailRef.current,
            canSave: true,
            canDiscard: true,
            canRecover: false,
          };
        },
        prepare: async () => {
          if (!enabledRef.current) return;
          const pending = operationRef.current;
          if (pending) await pending;
          if (dirtyRef.current && (await saveRef.current())) {
            dirtyRef.current = false;
            signalLifecycleOwnerChanged();
          }
        },
        discard: () => {
          if (enabledRef.current && !operationRef.current && dirtyRef.current) {
            discardRef.current();
            dirtyRef.current = false;
            signalLifecycleOwnerChanged();
          }
        },
      }),
    [instanceId, label, operationRef, ownerId],
  );
}

interface DiscardOnlyDraftLifecycleOptions {
  ownerId: string;
  label: string;
  dirty: boolean;
  operationRef: MutableRefObject<Promise<unknown> | null>;
  discard: () => void;
  detail?: string;
  operationDetail?: string;
  blocking?: boolean;
  enabled?: boolean;
}

/**
 * Protect a create/action draft without providing a global prepare callback.
 * This makes it impossible for Quit/Sign out/Restart to create a resource,
 * queue an export, or perform another consequential action automatically.
 */
export function useDiscardOnlyDraftLifecycle({
  ownerId,
  label,
  dirty,
  operationRef,
  discard,
  detail = "This local action draft has not been submitted.",
  operationDetail = "Wait for this request to finish before leaving Moosewave.",
  blocking = false,
  enabled = true,
}: DiscardOnlyDraftLifecycleOptions): void {
  const instanceId = useId();
  const dirtyRef = useRef(dirty);
  const discardRef = useRef(discard);
  const detailRef = useRef(detail);
  const operationDetailRef = useRef(operationDetail);
  const enabledRef = useRef(enabled);
  dirtyRef.current = dirty;
  discardRef.current = discard;
  detailRef.current = detail;
  operationDetailRef.current = operationDetail;
  enabledRef.current = enabled;

  useEffect(() => {
    signalLifecycleOwnerChanged();
  }, [dirty, enabled]);

  useEffect(
    () =>
      registerLifecycleGuard({
        id: `action-draft-${ownerId}-${instanceId}`,
        label,
        inspect: (intent) => {
          if (!enabledRef.current) return null;
          if (intent.disposition === "hide") return null;
          if (operationRef.current) {
            if (retainedOperationRefs.has(operationRef)) return null;
            return {
              level: "blocking",
              detail: operationDetailRef.current,
              canSave: false,
              canDiscard: false,
              canRecover: false,
            };
          }
          if (!dirtyRef.current) return null;
          return {
            level: blocking ? "blocking" : "warning",
            detail: detailRef.current,
            canSave: false,
            canDiscard: true,
            canRecover: false,
          };
        },
        discard: () => {
          if (enabledRef.current && !operationRef.current && dirtyRef.current) {
            discardRef.current();
            dirtyRef.current = false;
            signalLifecycleOwnerChanged();
          }
        },
      }),
    [blocking, instanceId, label, operationRef, ownerId],
  );
}
