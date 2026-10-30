import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";

import {
  useDiscardOnlyDraftLifecycle,
  useExistingSettingLifecycle,
  useSingleFlightOperation,
} from "./useSettingsDraftLifecycle";

export type DraftLifecycleMode = "create" | "edit" | "action";

interface DraftLifecycleControllerOptions {
  ownerId: string;
  label: string;
  mode: DraftLifecycleMode;
  enabled: boolean;
  dirty: boolean;
  save?: () => Promise<boolean>;
  discard: () => void;
  close?: () => void;
  detail: string;
  operationDetail?: string;
  onError?: (error: unknown) => void;
}

export interface DraftLifecycleController {
  active: boolean;
  promiseRef: MutableRefObject<Promise<unknown> | null>;
  runOperation: <T>(operation: () => Promise<T>) => Promise<T> | null;
  submit: () => Promise<boolean>;
  requestClose: () => void;
  discardAndClose: () => void;
  discardConfirmOpen: boolean;
  keepEditing: () => void;
}

/**
 * Compose the established draft and single-flight hooks for one editor.
 *
 * Create/action modes remain discard-only. Edit mode may prepare the exact
 * validated save callback against an acknowledged baseline. Local dismissal
 * is explicit whenever the draft is dirty, while the retained operation guard
 * continues to own an accepted request after the React surface unmounts.
 */
export function useDraftLifecycleController({
  ownerId,
  label,
  mode,
  enabled,
  dirty,
  save,
  discard,
  close,
  detail,
  operationDetail = "Wait for this request to finish before leaving Moosewave.",
  onError,
}: DraftLifecycleControllerOptions): DraftLifecycleController {
  const operationOptions = useMemo(
    () => ({ ownerId, label: `${label} operation`, detail: operationDetail }),
    [label, operationDetail, ownerId],
  );
  const operation = useSingleFlightOperation(operationOptions);
  const saveRef = useRef(save);
  const discardRef = useRef(discard);
  const closeRef = useRef(close);
  const errorRef = useRef(onError);
  saveRef.current = save;
  discardRef.current = discard;
  closeRef.current = close;
  errorRef.current = onError;
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);

  const submit = useCallback(async (): Promise<boolean> => {
    const pending = operation.promiseRef.current;
    if (pending) return (await pending) === true;
    if (!saveRef.current) return false;
    const request = operation.run(async (): Promise<boolean> => {
      try {
        return await saveRef.current!();
      } catch (error) {
        errorRef.current?.(error);
        return false;
      }
    });
    return request ? await request : false;
  }, [operation.promiseRef, operation.run]);

  const discardAndClose = useCallback((): void => {
    if (operation.promiseRef.current) return;
    discardRef.current();
    setDiscardConfirmOpen(false);
    closeRef.current?.();
  }, [operation.promiseRef]);

  const requestClose = useCallback((): void => {
    if (operation.promiseRef.current) return;
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    closeRef.current?.();
  }, [dirty, operation.promiseRef]);

  const keepEditing = useCallback((): void => {
    if (!operation.promiseRef.current) setDiscardConfirmOpen(false);
  }, [operation.promiseRef]);

  useEffect(() => {
    if (!enabled) setDiscardConfirmOpen(false);
  }, [enabled]);

  useDiscardOnlyDraftLifecycle({
    ownerId,
    label,
    dirty,
    operationRef: operation.promiseRef,
    discard: discardAndClose,
    detail,
    operationDetail,
    enabled: enabled && mode !== "edit",
  });
  useExistingSettingLifecycle({
    ownerId,
    label,
    dirty,
    operationRef: operation.promiseRef,
    save: submit,
    discard: discardAndClose,
    detail,
    operationDetail,
    enabled: enabled && mode === "edit",
  });

  return {
    active: operation.active,
    promiseRef: operation.promiseRef,
    runOperation: operation.run,
    submit,
    requestClose,
    discardAndClose,
    discardConfirmOpen,
    keepEditing,
  };
}
