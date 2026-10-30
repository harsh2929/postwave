import { useCallback, useEffect, useRef, useState } from "react";

import {
  beginRemoteLoad,
  completeRemoteLoad,
  createRemoteResource,
  createVerifiedRemoteResource,
  failRemoteLoad,
  type RemoteApiError,
  type RemoteResource,
} from "../lib/remote-resource";

export type RemoteLoadResult<T> =
  | { data: T; error?: never }
  | { data?: never; error: RemoteApiError };

export interface UseRemoteResourceOptions<T> {
  /** Changes identify a different dataset and clear the previous one. */
  identity: string;
  /** A verified parent/list snapshot to retain while the detail read runs. */
  initialData?: T;
  auto?: boolean;
}

export interface RemoteResourceController<T> extends RemoteResource<T> {
  reload: () => Promise<void>;
  /**
   * Reload and report the exact verified outcome to an aggregate controller.
   * `null` means the result was superseded or the owner unmounted.
   */
  reloadResult: () => Promise<RemoteLoadResult<T> | null>;
}

interface IdentityBoundResource<T> {
  identity: string;
  value: RemoteResource<T>;
}

function initialRemoteResource<T>(
  initialData: T | undefined,
): RemoteResource<T> {
  return initialData === undefined
    ? createRemoteResource<T>()
    : createVerifiedRemoteResource(initialData);
}

/**
 * Race-safe remote read controller. The loader lives in a ref so callers do
 * not need to memoize it merely to avoid effect loops; `identity` is the only
 * value that changes which dataset is being represented.
 */
export function useRemoteResource<T>(
  loader: () => Promise<RemoteLoadResult<T>>,
  options: UseRemoteResourceOptions<T>,
): RemoteResourceController<T> {
  const loaderRef = useRef(loader);
  const initialDataRef = useRef(options.initialData);
  const identityRef = useRef(options.identity);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  loaderRef.current = loader;
  initialDataRef.current = options.initialData;
  identityRef.current = options.identity;

  const [snapshot, setSnapshot] = useState<IdentityBoundResource<T>>(() => ({
    identity: options.identity,
    value: initialRemoteResource(options.initialData),
  }));

  const run = useCallback(
    async (
      reset: boolean,
      requestedIdentity = identityRef.current,
    ): Promise<RemoteLoadResult<T> | null> => {
      const generation = ++generationRef.current;
      setSnapshot((previous) => {
        const initial = initialDataRef.current;
        const current =
          previous.identity === requestedIdentity
            ? previous.value
            : initialRemoteResource(initial);
        return {
          identity: requestedIdentity,
          value: beginRemoteLoad(
            reset ? initialRemoteResource(initial) : current,
          ),
        };
      });

      let result: RemoteLoadResult<T>;
      try {
        result = await loaderRef.current();
      } catch {
        result = {
          error: {
            message: "Request failed",
            kind: "network",
          },
        };
      }
      if (!mountedRef.current || generation !== generationRef.current) {
        return null;
      }

      if ("error" in result && result.error) {
        setSnapshot((previous) => ({
          identity: requestedIdentity,
          value: failRemoteLoad(
            previous.identity === requestedIdentity
              ? previous.value
              : initialRemoteResource(initialDataRef.current),
            result.error,
          ),
        }));
        return result;
      }
      setSnapshot((previous) => ({
        identity: requestedIdentity,
        value: completeRemoteLoad(
          previous.identity === requestedIdentity
            ? previous.value
            : initialRemoteResource(initialDataRef.current),
          result.data,
        ),
      }));
      return result;
    },
    [],
  );

  const reload = useCallback(async (): Promise<void> => {
    await run(false);
  }, [run]);
  const reloadResult = useCallback(
    (): Promise<RemoteLoadResult<T> | null> => run(false),
    [run],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (options.auto !== false) void run(true, options.identity);
    return () => {
      generationRef.current += 1;
      mountedRef.current = false;
    };
  }, [options.auto, options.identity, run]);

  const visible =
    snapshot.identity === options.identity
      ? snapshot.value
      : initialRemoteResource(options.initialData);
  return { ...visible, reload, reloadResult };
}
