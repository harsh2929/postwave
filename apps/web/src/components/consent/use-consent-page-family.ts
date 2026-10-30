// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// One cursor-paged "page family" over a consent evidence plane.
//
// Page one belongs to the page that owns the query; this hook only appends
// OLDER pages to it. The appended rows are bound to the exact page-one object
// they continue: a refresh (a new page-one object) drops them, and a response
// that lands after a refresh is discarded rather than stitched onto the wrong
// boundary. A failed or inconsistent older page never removes rows already
// shown, and the same cursor can be retried (desktop Consent.tsx:707-947).

import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { apiErrorMessage, isApiError } from "@/lib/api";
import { ConsentCursorError } from "@/lib/consent-receipts-api";

interface ConsentPageShape {
  snapshot_at?: string;
  workspace_id?: string;
  has_more: boolean;
  next_cursor?: string;
}

interface FamilyState<Page, Row> {
  base: Page;
  appended: Row[];
  nextCursor: string | null;
  hasMore: boolean;
  failure: string | null;
}

export interface ConsentPageFamily<Row> {
  /** Page one plus every verified older page, in server order. */
  rows: Row[];
  /** Rows appended from older pages only. */
  appended: Row[];
  hasMore: boolean;
  canLoadOlder: boolean;
  /** The server reported more rows but no continuation cursor to reach them. */
  cursorMissing: boolean;
  loading: boolean;
  failure: string | null;
  loadOlder: () => void;
}

function fresh<Page extends ConsentPageShape, Row>(
  base: Page,
): FamilyState<Page, Row> {
  return {
    base,
    appended: [],
    nextCursor: base.next_cursor ?? null,
    hasMore: base.has_more,
    failure: null,
  };
}

export function useConsentPageFamily<
  Page extends ConsentPageShape,
  Row,
>(options: {
  base: Page;
  rowsOf: (page: Page) => Row[];
  fetchPage: (cursor: string) => Promise<Page>;
  pageFailure: (
    base: Page,
    loaded: readonly Row[],
    page: Page,
    requestedCursor: string,
  ) => string | null;
  /** e.g. "receipt/proof" or "event". */
  noun: string;
  /** What the failure copy promises was kept, e.g. "evidence". */
  keptNoun: string;
}): ConsentPageFamily<Row> {
  const { base, rowsOf, fetchPage, pageFailure, noun, keptNoun } = options;
  const [state, setState] = useState<FamilyState<Page, Row>>(() =>
    fresh(base),
  );
  const current: FamilyState<Page, Row> =
    state.base === base ? state : fresh(base);
  if (state.base !== base) setState(current);

  const mutation = useMutation({
    mutationFn: (variables: { base: Page; cursor: string }) =>
      fetchPage(variables.cursor),
    onSuccess: (page, variables) => {
      setState((previous) => {
        if (previous.base !== variables.base) return previous;
        const loaded = [...rowsOf(previous.base), ...previous.appended];
        const failure = pageFailure(
          previous.base,
          loaded,
          page,
          variables.cursor,
        );
        if (failure) return { ...previous, failure };
        return {
          ...previous,
          appended: [...previous.appended, ...rowsOf(page)],
          nextCursor: page.next_cursor ?? null,
          hasMore: page.has_more,
          failure: null,
        };
      });
    },
    onError: (error, variables) => {
      const failure =
        error instanceof ConsentCursorError
          ? error.message
          : isApiError(error)
            ? `${apiErrorMessage(error, `The older ${noun} page could not be verified.`)} Loaded ${keptNoun} was kept.`
            : `The older ${noun} page could not be reached. Loaded ${keptNoun} was kept.`;
      setState((previous) =>
        previous.base === variables.base ? { ...previous, failure } : previous,
      );
    },
  });

  const loading = mutation.isPending && mutation.variables?.base === base;
  const cursor = current.nextCursor;
  const { mutate, isPending } = mutation;
  const loadOlder = useCallback(() => {
    if (isPending || !cursor) return;
    mutate({ base, cursor });
  }, [base, cursor, isPending, mutate]);

  return {
    rows: [...rowsOf(base), ...current.appended],
    appended: current.appended,
    hasMore: current.hasMore,
    canLoadOlder: current.hasMore && cursor !== null,
    cursorMissing: current.hasMore && cursor === null,
    loading,
    failure: current.failure,
    loadOlder,
  };
}
