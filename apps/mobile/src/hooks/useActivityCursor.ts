/**
 * hooks/useActivityCursor.ts — the wiring for the cross-device resume cursor.
 *
 * Split from `api/activityCursor.ts` on purpose: that module holds the rules
 * (which references are valid, which entities this surface can open) and must
 * stay importable in the node vitest environment. Binding the transport there
 * would drag React Native into every one of its tests. So the pure half is
 * tested without a simulator, and this half — which is mostly React lifecycle —
 * is thin enough to read.
 */
import { useCallback } from "react";
import { useFocusEffect } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import { EVENTS } from "@postwave/telemetry";

import {
  createActivityCursorClient,
  type ActivityCursor,
  type CursorResult,
} from "@/api/activityCursor";
import { rawRequest } from "@/api/request";
import { track } from "@/lib/telemetry";

/**
 * The live client. Unexpected read failures are reported because on screen they
 * are invisible — a broken endpoint and "no cursor yet" both render as no card.
 */
export const activityCursor = createActivityCursorClient({
  request: <T>(method: string, path: string, body?: unknown) =>
    rawRequest<T>(
      method as Parameters<typeof rawRequest>[0],
      path,
      body,
    ) as Promise<CursorResult<T>>,
  onUnexpectedError: ({ status, code }) =>
    track(EVENTS.CONTINUITY_RESUME_READ_FAILED, { status, code }),
});

/**
 * Record an entity as the resume cursor while its screen is focused.
 *
 * `useFocusEffect`, not `useEffect`: expo-router keeps screens mounted in the
 * stack, so a plain mount effect fires once and then never again — after a
 * back-navigation the cursor would still point at the deeper screen the user
 * has already left, and the user's other devices would offer to resume it.
 */
export function useRecordLastViewed(
  entityKey: string,
  entityId: string | undefined | null,
): void {
  useFocusEffect(
    useCallback(() => {
      if (!entityId) return;
      void activityCursor.recordLastViewed(entityKey, entityId);
    }, [entityKey, entityId]),
  );
}

/** Query key root for the cursor read. */
export const RESUME_CURSOR_ROOT = "resume-cursor";

/**
 * Read the resume cursor for the dashboard card.
 *
 * `retry: false` because every failure mode here already resolves to null —
 * retrying an absence just delays rendering the rest of the dashboard. A short
 * staleTime keeps the card current when the user hops devices mid-task, which
 * is precisely the moment it earns its place.
 */
export function useResumeCursor() {
  return useQuery<ActivityCursor | null>({
    queryKey: [RESUME_CURSOR_ROOT],
    queryFn: () => activityCursor.fetchLastViewed(),
    staleTime: 60_000,
    retry: false,
  });
}
