/** Shared pre-confirmation lock for every suppression-roster mutation. */
export function tryAcquireSmsSuppressionWrite(lock: {
  current: boolean;
}): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseSmsSuppressionWrite(lock: { current: boolean }): void {
  lock.current = false;
}
