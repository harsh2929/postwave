/**
 * InboundRoutesScreen — "did mail actually route, and did the actions it
 * triggered run".
 *
 * WHY THIS IS THE ONLY INBOUND-ROUTING SURFACE ON A PHONE. The desktop's
 * `apps/desktop/src/pages/InboundRoutes.tsx` is a rule editor: the receiver
 * endpoint with its one-shot HMAC secret, a test-match panel, and a
 * priority-ordered table with inline drag reorder and type-to-confirm delete.
 * Glob grammar, priority ordering and a drag gesture are pointer-and-keyboard
 * work and stay on a desk. The operations half is what ports: an inbound
 * webhook that starts refusing at 02:00 silently drops every reply until
 * somebody notices, and noticing is what a phone is for.
 *
 * THE ONE THING THIS SCREEN CANNOT DO, STATED RATHER THAN PAPERED OVER. There
 * is no global match feed on this API — matches are only reachable one rule at
 * a time. So the screen can never answer "did all mail route today"; it answers
 * "did THIS rule fire, and did its actions run". Every headline is scoped
 * accordingly, and the posture card at the top says only what a list of
 * configuration rows can support.
 *
 * ROLE. Owner/admin, and NOT because of the write routes. All eight
 * /api/v1/inbound-routes routes — including both reads this screen makes — are
 * `apikeys.RequireScope(ScopeAdmin)` (routes.go:80-89). The routeauth manifest
 * disagrees with itself inside the same family: the list row is `admin`
 * (reviewed) while both drill-down rows are `viewer` (fail_closed_default,
 * unreviewed). The handler is the authority and it is stricter.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  INBOUND_MATCHES_PAGE_SIZE,
  isInboundRoleDenied,
} from "@/api/inboundRoutes";
import { MobileScopeNotice } from "@/components/MobileScopeNotice";
import { Pill, type PillTone } from "@/components/Pill";
import { QueryStates } from "@/components/QueryStates";
import { RoleGateNotice } from "@/components/RoleGateNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import { ActionRunSection } from "@/components/inbound-routes/ActionRunSection";
import { InboundMatchRow } from "@/components/inbound-routes/InboundMatchRow";
import { InboundRouteEnabledControl } from "@/components/inbound-routes/InboundRouteEnabledControl";
import { InboundRouteRow } from "@/components/inbound-routes/InboundRouteRow";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import {
  useInboundActionRuns,
  useInboundRouteMatches,
  useInboundRoutes,
} from "@/hooks/useInboundRoutes";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import { FONT } from "@/lib/fonts";
import { plural } from "@/lib/format";
import {
  disabledNotice,
  matchWindowNotice,
  routingVerdict,
  type RoutingTone,
} from "@/lib/inboundRouteVerdict";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

const TONE_PILL: Readonly<Record<RoutingTone, PillTone>> = {
  ok: "success",
  warn: "warning",
  idle: "neutral",
};

const TONE_WORD: Readonly<Record<RoutingTone, string>> = {
  ok: "all rules firing",
  warn: "needs a look",
  idle: "nothing configured",
};

export function InboundRoutesScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  // Read off the store rather than off the gate: the store is where the role
  // and the auth MODE both live, and an api_key session must be denied here
  // (these routes want the `admin` SCOPE, which mobile never receives).
  const role = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const mode = useAuthStore((s) => s.mode);
  useScreenViewed("inbound-routes");

  const allowed = canAccessMinimumRole("admin", role, mode);
  const routes = useInboundRoutes(allowed);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [selectedMatchId, setSelectedMatchId] = useState<number | null>(null);

  const rows = useMemo(
    () => (Array.isArray(routes.data) ? routes.data : []),
    [routes.data],
  );
  // A selection the reader made survives a refetch as long as the rule is still
  // there; otherwise the first rule is shown, so the detail below is never
  // blank while a list is on screen.
  const activeRouteId =
    selectedRouteId && rows.some((route) => route.id === selectedRouteId)
      ? selectedRouteId
      : (rows[0]?.id ?? null);
  const activeRoute = rows.find((route) => route.id === activeRouteId) ?? null;

  const matches = useInboundRouteMatches(activeRouteId, allowed);
  const matchRows = useMemo(
    () => (Array.isArray(matches.data) ? matches.data : []),
    [matches.data],
  );
  const activeMatchId =
    selectedMatchId !== null &&
    matchRows.some((match) => match.id === selectedMatchId)
      ? selectedMatchId
      : (matchRows[0]?.id ?? null);
  const runs = useInboundActionRuns(activeMatchId, allowed);

  const refresh = useManualRefresh(
    [routes.refetch, matches.refetch, runs.refetch],
    { enabled: gate.enabled && allowed },
  );

  const onSelectRoute = useCallback((id: string) => {
    setSelectedRouteId(id);
    // The match selection belongs to the PREVIOUS rule; carrying it over would
    // request an action log for a match this rule never made.
    setSelectedMatchId(null);
  }, []);
  const onSelectMatch = useCallback((id: number) => setSelectedMatchId(id), []);

  const verdict = useMemo(
    () => routingVerdict(routes.data ?? null),
    [routes.data],
  );
  const roleDenied =
    isInboundRoleDenied(routes.error) || isInboundRoleDenied(matches.error);
  const disabled = activeRoute ? disabledNotice(activeRoute) : null;

  const subtitle =
    routes.data !== undefined && rows.length > 0
      ? plural(rows.length, "rule")
      : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Inbound routing"
        {...(subtitle ? { subtitle } : {})}
        onBack={goBackOrMore}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refresh.refreshing}
            onRefresh={refresh.onRefresh}
            enabled={gate.enabled && allowed}
            tintColor={t.fgMuted}
            colors={[t.accent]}
          />
        }
      >
        {!allowed || roleDenied ? (
          <RoleGateNotice
            title="Needs an owner or admin session"
            body="Every inbound-routing route is mounted behind the admin scope on this server — the read-only match history included. Ask an owner, or open Inbound Routes on the web admin."
            live={roleDenied}
          />
        ) : (
          <>
            <MobileScopeNotice
              title="Monitor, plus the off switch"
              body="This screen answers whether mail reached a rule and what its actions did — and a misfiring rule can be switched off (and back on) right here. Creating, editing, reordering and the dry-run matcher stay on the web admin."
            />

            {routes.data !== undefined ? (
              <View
                accessible
                accessibilityLabel={`${verdict.headline}. ${verdict.detail}`}
                style={{
                  backgroundColor: t.surface,
                  borderColor: t.borderSubtle,
                  borderWidth: 1,
                  borderRadius: 14,
                  padding: 14,
                  marginBottom: 12,
                }}
              >
                <Pill label={TONE_WORD[verdict.tone]} tone={TONE_PILL[verdict.tone]} />
                <Text
                  {...typeCap("heading")}
                  style={{
                    color: t.fg,
                    ...typeStyle("heading"),
                    marginTop: 8,
                    fontWeight: "600",
                    fontFamily: FONT.semibold,
                  }}
                >
                  {verdict.headline}
                </Text>
                <Text
                  {...typeCap("label")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("label"),
                    marginTop: 6,
                    fontFamily: FONT.regular,
                  }}
                >
                  {verdict.detail}
                </Text>
              </View>
            ) : null}

            <SectionLabel subtitle="In the priority order the matcher walks them. The first rule that matches and stops ends the walk.">
              Rules
            </SectionLabel>
            <QueryStates
              query={routes}
              gate={gate}
              isEmpty={rows.length === 0}
              offlineMessage="Routing rules need a connection. Reconnect and pull to refresh — this is not the same as having no rules."
              skeleton={<SkeletonList rows={4} lines={2} label="Loading routing rules" />}
              empty={{
                title: "No routing rules",
                description:
                  "Nothing is configured to act on inbound mail. Rules are authored on the web admin.",
              }}
            >
              {rows.map((route) => (
                <InboundRouteRow
                  key={route.id}
                  route={route}
                  selected={route.id === activeRouteId}
                  onSelect={onSelectRoute}
                />
              ))}
            </QueryStates>

            {activeRoute ? (
              <View style={{ marginTop: 16 }}>
                <SectionLabel
                  topMargin={0}
                  subtitle={matchWindowNotice(
                    activeRoute,
                    matchRows,
                    INBOUND_MATCHES_PAGE_SIZE,
                  )}
                >
                  {activeRoute.name || "Unnamed rule"}
                </SectionLabel>
                {disabled ? <Note text={disabled} /> : null}
                <InboundRouteEnabledControl route={activeRoute} />
                <QueryStates
                  query={matches}
                  gate={gate}
                  isEmpty={matchRows.length === 0}
                  offlineMessage="Match history needs a connection. Reconnect and pull to refresh."
                  skeleton={<SkeletonList rows={3} lines={3} label="Loading matches" />}
                  empty={{
                    title:
                      activeRoute.matchCount > 0
                        ? "No match rows remain"
                        : "This rule has never matched",
                    description: matchWindowNotice(
                      activeRoute,
                      matchRows,
                      INBOUND_MATCHES_PAGE_SIZE,
                    ),
                  }}
                >
                  {matchRows.map((match) => (
                    <InboundMatchRow
                      key={match.id}
                      match={match}
                      selected={match.id === activeMatchId}
                      onSelect={onSelectMatch}
                    />
                  ))}
                </QueryStates>

                {activeMatchId !== null ? (
                  <ActionRunSection query={runs} gate={gate} route={activeRoute} />
                ) : null}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Note({ text }: { text: string }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("bodySmall")}
      style={{
        color: t.warning,
        ...typeStyle("bodySmall"),
        marginBottom: 8,
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}
