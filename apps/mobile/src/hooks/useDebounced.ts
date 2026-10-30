import { useEffect, useState } from "react";

/**
 * useDebounced — returns a value that lags `delayMs` behind input.
 * Used by the subscriber search input so we don't fire a request
 * per keystroke.
 */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
