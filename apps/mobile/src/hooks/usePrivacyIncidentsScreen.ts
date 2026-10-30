/**
 * hooks/usePrivacyIncidentsScreen.ts — the breach register's controller.
 *
 * Extracted from components/privacy-incidents/PrivacyIncidentsScreen.tsx when
 * the screen passed the source-complexity budget. Everything here is the part
 * that decides WHAT IS KNOWN; the screen is left to render it. That split is
 * worth naming on this surface in particular, because the whole risk of a
 * governance screen is a decided-looking answer derived from an undecided
 * state:
 *
 *  - THREE EMPTY-LOOKING STATES THAT MEAN COMPLETELY DIFFERENT THINGS. A
 *    successful zero-row result is a fact about the loaded register; "your
 *    role cannot read the register" is a fact about the session; "the register
 *    could not be loaded" is a fact about the network. `forbidden`,
 *    `listFailed` and `dataState` keep the three apart, and none of them is
 *    derived from a state where the answer is merely unknown.
 *  - A REFUSAL IS NOT A COUNT. `countsUnknown` withholds the headline and the
 *    subtitle whenever the register has not been enumerated.
 *
 * THE CLOCK TICKS. `useTickingNow` re-renders while the screen has data,
 * because a countdown frozen at whatever it said on mount is worse than no
 * countdown: it looks live and is not.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { useIsOnline } from "@/hooks/useIsOnline";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  usePrivacyIncident,
  usePrivacyIncidentEvents,
  usePrivacyIncidents,
} from "@/hooks/usePrivacyIncidents";
import { useRefreshControl } from "@/hooks/useRefreshControl";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { MINUTE_MS, useTickingNow } from "@/hooks/useTickingNow";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  incidentCounts,
  incidentHeadline,
  incidentReadAccess,
  incidentRegisterDataState,
  incidentTransitionAccess,
  orderIncidents,
} from "@/lib/privacyIncidentPolicy";
import type { PrivacyIncident } from "@/lib/privacyIncidents";
import { useAuthStore } from "@/store/auth";

function queryStatus(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

export function usePrivacyIncidentsScreen() {
  const gate = useOnlineQueryGate();
  const online = useIsOnline();
  useScreenViewed("privacy-incidents");

  const role = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const mode = useAuthStore((s) => s.mode);
  const queriesEnabled = gate.enabled && Boolean(gate.tenantId);

  const accessInput = {
    isAdmin: canAccessMinimumRole("admin", role, mode),
    role,
    mode,
    online: online && queriesEnabled,
  };
  const read = incidentReadAccess(accessInput);
  const write = incidentTransitionAccess(accessInput);

  const [openId, setOpenId] = useState<string | null>(null);
  const [accessRefused, setAccessRefused] = useState(false);
  const [declaring, setDeclaring] = useState(false);

  const canAttemptProtectedReads =
    queriesEnabled && online && read.allowed && !accessRefused;
  const incidents = usePrivacyIncidents(canAttemptProtectedReads);
  const detailId = canAttemptProtectedReads ? openId : null;
  const detail = usePrivacyIncident(detailId);
  const events = usePrivacyIncidentEvents(detailId);
  const refresh = useRefreshControl(incidents);

  const immediatelyForbidden =
    queryStatus(incidents.error) === 403 ||
    (openId !== null &&
      (queryStatus(detail.error) === 403 || queryStatus(events.error) === 403));
  const forbidden = accessRefused || immediatelyForbidden;

  useEffect(() => {
    setAccessRefused(false);
    setOpenId(null);
  }, [gate.tenantId]);

  useEffect(() => {
    if (!immediatelyForbidden) return;
    setAccessRefused(true);
    setOpenId(null);
  }, [immediatelyForbidden]);

  const rawPage = incidents.data;
  const rawHasRows =
    Array.isArray(rawPage?.incidents) && rawPage.incidents.length > 0;
  const dataState = incidentRegisterDataState({
    canReadNow: queriesEnabled && online && read.allowed,
    forbidden,
    hasRows: rawHasRows,
    fetching: incidents.isFetching,
    failed: incidents.isError,
  });
  const page = dataState === "hidden" ? undefined : rawPage;
  /**
   * MINUTE RESOLUTION. Everything this screen renders the clock into is
   * humanGap, whose finest output is literally "under a minute", so 59 of
   * every 60 ticks used to re-render the whole screen — and every row that
   * takes `now` as a prop — to repaint an identical string. Measured: 60
   * renders/min → 1.
   *
   * The cost is that a boundary lands on the wall-clock minute rather than
   * exactly 60s after the event; see useTickingNow for where that is NOT
   * acceptable.
   */
  const now = useTickingNow(dataState !== "hidden", MINUTE_MS);

  useEffect(() => {
    if (dataState === "hidden") setOpenId(null);
  }, [dataState]);

  // Array.isArray, not `?? []`: `orderIncidents` opens with `[...rows]`, and a
  // truthy `{}` sails past a nullish guard into exactly the "Invalid attempt to
  // spread non-iterable instance" that api-keys shipped. The queryFn normalises
  // a LIVE payload; a restored one written by an older build never passes
  // through it (see the schema buster in lib/secureQueryPersister).
  const rows = useMemo(
    () =>
      orderIncidents(Array.isArray(page?.incidents) ? page.incidents : [], now),
    [page, now],
  );
  const restoredPageMalformed =
    page !== undefined && !Array.isArray(page?.incidents);
  const counts = useMemo(() => incidentCounts(rows, now), [rows, now]);
  const openIncident = useMemo(
    () => rows.find((row) => row.id === openId) ?? null,
    [rows, openId],
  );

  // A 403 is its own state: the role gate above withholds the request from a
  // session already known not to be owner/admin, but a role can change
  // mid-session and a custom role can be granted the admin scope server-side
  // (apikeys/middleware.go:216), so the screen must not read a refusal as an
  // empty register.
  const listFailed = (incidents.isError && !forbidden) || restoredPageMalformed;
  // `incidents.isError`, NOT `listFailed`. The two differ on exactly one case —
  // a 403 — and that case used to leave the counts "known", so the header
  // announced "0 open of 0 incidents" while the body said the server had
  // refused the read. The subtitle is an `accessibilityLiveRegion`, so that
  // all-clear was spoken aloud about a breach register nobody had been allowed
  // to enumerate. A refusal is not a count.
  const countsUnknown =
    incidents.isLoading ||
    incidents.isFetching ||
    incidents.isError ||
    restoredPageMalformed ||
    dataState === "hidden";
  const headline = countsUnknown ? null : incidentHeadline(counts);

  const openRow = useCallback(
    (incident: PrivacyIncident) => setOpenId(incident.id),
    [],
  );
  const closeSheet = useCallback(() => setOpenId(null), []);
  const keyExtractor = useCallback((row: PrivacyIncident) => row.id, []);

  return {
    read,
    write,
    declaring,
    setDeclaring,
    incidents,
    detail,
    events,
    refresh,
    dataState,
    page,
    now,
    rows,
    restoredPageMalformed,
    counts,
    openIncident,
    canAttemptProtectedReads,
    forbidden,
    listFailed,
    countsUnknown,
    headline,
    openRow,
    closeSheet,
    keyExtractor,
  };
}

export type PrivacyIncidentsScreenController = ReturnType<
  typeof usePrivacyIncidentsScreen
>;
