import {
  Suspense,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";

const DEFAULT_RECOVERY_DELAY_MS = 2_500;
const MAX_RECOVERY_DELAY_MS = 10_000;

interface RecoverableSuspenseProps {
  children: ReactNode;
  fallback: ReactNode;
  /**
   * Base delay before retrying a fallback that has not received React's
   * normal Suspense wake-up. Exposed for deterministic tests; product callers
   * should normally keep the measured 2.5 second default.
   */
  recoveryDelayMs?: number;
}

function RecoveryTimer({
  attempt,
  baseDelayMs,
  onRecover,
}: {
  attempt: number;
  baseDelayMs: number;
  onRecover: () => void;
}): ReactElement {
  useEffect(() => {
    const multiplier = 2 ** Math.min(attempt, 2);
    const delay = Math.min(baseDelayMs * multiplier, MAX_RECOVERY_DELAY_MS);
    const timer = globalThis.setTimeout(onRecover, delay);
    return () => globalThis.clearTimeout(timer);
  }, [attempt, baseDelayMs, onRecover]);

  return <></>;
}

/**
 * A Suspense boundary with a narrowly-scoped recovery path for a resolved
 * lazy module whose wake-up was missed by the renderer.
 *
 * Normal lazy loads behave exactly like React.Suspense. Only a fallback that
 * remains mounted past the recovery delay is remounted. React.lazy retains
 * its module promise/result, so this does not refetch a chunk; it gives React
 * a fresh render opportunity. The backoff caps at ten seconds to avoid a
 * tight loop on genuinely slow or offline connections.
 */
export function RecoverableSuspense({
  children,
  fallback,
  recoveryDelayMs = DEFAULT_RECOVERY_DELAY_MS,
}: RecoverableSuspenseProps): ReactElement {
  const [attempt, setAttempt] = useState(0);
  const recover = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);
  const safeDelay = Math.max(250, recoveryDelayMs);

  return (
    <Suspense
      key={attempt}
      fallback={
        <>
          {fallback}
          <RecoveryTimer
            attempt={attempt}
            baseDelayMs={safeDelay}
            onRecover={recover}
          />
        </>
      }
    >
      {children}
    </Suspense>
  );
}
