// SPDX-License-Identifier: AGPL-3.0-only
//
// Guard for "only the newest request may write state".
//
// An effect keyed on a filter/page/query re-runs whenever the user changes it,
// but the request already in flight is neither aborted nor ignored. Responses
// are not guaranteed to arrive in the order they were sent, so a slower EARLIER
// request can resolve last and overwrite the newer result — the list then shows
// rows for a filter the user has already moved off, with no error and nothing
// to retry. Typing into a debounced search box is the easiest way to see it.
//
// The codebase solved this twice by hand (a request-id ref in
// cross-client-preview, a `cancelled` flag in live-count). This is the same
// idea with one owner and a test.
//
// Deliberately NOT an AbortController: aborting is an optimisation that also
// needs per-endpoint signal plumbing. Correctness only requires that a stale
// response be *ignored*, which works even when the request cannot be cancelled.

export interface LatestRequestGate {
  /**
   * Mark the start of a request. Returns a predicate that reports whether this
   * request is still the newest — call it after every await, before writing
   * state.
   */
  begin: () => () => boolean;
}

export function createLatestRequestGate(): LatestRequestGate {
  let current = 0;
  return {
    begin() {
      const id = ++current;
      return () => id === current;
    },
  };
}
