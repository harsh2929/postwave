/**
 * CompliancePostureScreen — "is any attestation about to lapse, and what does
 * the record actually say".
 *
 * A MONITOR, NOT A CONSOLE, AND THE MISSING BUTTONS ARE THE DESIGN. The API
 * exposes five routes; this screen uses two of them, and the three it leaves
 * alone are left alone on purpose:
 *
 *  - `POST /{framework}/attest` (compliance.go:261) requires `signedByEmail`
 *    and accepts `documentPath` + `documentSha256` — the fields that make an
 *    attestation auditable. A phone cannot produce a SHA-256 of an auditor's
 *    report, and the upsert only preserves a prior hash on a RENEWAL
 *    (compliance.go:250-251): a FIRST attestation sent without one stores empty
 *    strings, i.e. a legal claim with no evidence attached to it. Offering a
 *    one-tap "Attest" that quietly produces that record would be the single
 *    most damaging button in the app.
 *
 *  - `POST /{framework}/revoke` (compliance.go:358) is the same legal weight in
 *    the opposite direction — it writes a permanent ledger row asserting that
 *    the workspace has withdrawn a compliance claim — with none of the urgency
 *    that would justify carrying it. Renewal windows here are measured in
 *    weeks, and revoking a tracker row stops nothing: the claim that matters
 *    lives in a sales deck and a signed contract, not in this table. The
 *    warehouse monitor carries a `pause` because pausing a broken pipeline
 *    changes what happens TONIGHT. Nothing here does.
 *
 *  - `GET /{framework}` returns the identical `Program` struct from the
 *    identical SELECT as the list (compliance.go:201-209 vs :138-142), so
 *    calling it for the selected row would be a round trip for bytes already
 *    in hand.
 *
 * Authoring stays on `apps/desktop/src/pages/Compliance.tsx`, which has the
 * attest modal, the document fields and the desk session they deserve.
 *
 * ROLE. Owner/admin only, and both authorization layers agree for once — see
 * the header of `api/compliance.ts` for the read of
 * `apikeys.RequireScope(ScopeAdmin)` at the mount site and of the `routeauth`
 * manifest rows. The screen checks the role BEFORE issuing anything, because a
 * request that can only answer 403 is not worth a cellular round trip, and it
 * still treats a live 403 as its own state, because a role can change while the
 * app is open.
 *
 * NativeWind v4: static Pressable style objects only.
 */
import { useCallback, useMemo, useState } from "react";
import { AssuranceLegalHoldPanel } from "@/components/compliance/AssuranceLegalHoldPanel";
import { SarQueueBanner } from "@/components/compliance/SarQueueBanner";
import { GpcSignalsCard } from "@/components/consent/GpcSignalsCard";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { isComplianceRoleDenied } from "@/api/compliance";
import { Article50ReadinessCard } from "@/components/compliance/Article50ReadinessCard";
import { AttestationLedger } from "@/components/compliance/AttestationLedger";
import { PrivacyPortalSection } from "@/components/compliance/PrivacyPortalSection";
import { RetentionActivityPanel } from "@/components/compliance/RetentionActivityPanel";
import { FrameworkDetailCard } from "@/components/compliance/FrameworkDetailCard";
import { FrameworkReferenceCard } from "@/components/compliance/FrameworkReferenceCard";
import { FrameworkRow } from "@/components/compliance/FrameworkRow";
import { PostureSummaryCard } from "@/components/compliance/PostureSummaryCard";
import { QueryStates } from "@/components/QueryStates";
import { RoleGateNotice } from "@/components/RoleGateNotice";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionLabel } from "@/components/SectionLabel";
import { SkeletonList } from "@/components/Skeleton";
import {
  useComplianceEvents,
  useCompliancePrograms,
} from "@/hooks/useCompliance";
import { useManualRefresh } from "@/hooks/useManualRefresh";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { useScreenViewed } from "@/hooks/useScreenViewed";
import {
  compliancePosture,
  RENEWAL_DUE_SOON_DAYS,
} from "@/lib/compliancePosture";
import { HIPAA_SLUG } from "@/lib/complianceFrameworks";
import { plural } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { goBackOrMore } from "@/lib/nav";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import { useAuthStore } from "@/store/auth";

const ROLE_BODY =
  "Every compliance route is mounted behind the admin scope, which for a signed-in session means an owner or admin role. Ask an owner to check the renewal dates, or open Compliance on the web admin.";

export function CompliancePostureScreen() {
  const { t } = useTheme();
  const gate = useOnlineQueryGate();
  // Read off the store rather than off the gate: the store is where the role
  // and the auth MODE both live, and an api_key session must be denied here
  // (RequireScope wants the literal `admin` scope, which mobile never holds).
  const role = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const mode = useAuthStore((s) => s.mode);
  useScreenViewed("compliance");

  const allowed = canAccessMinimumRole("admin", role, mode);
  const programs = useCompliancePrograms(allowed);
  const [selected, setSelected] = useState<string | null>(null);

  const rows = useMemo(
    () => (Array.isArray(programs.data) ? programs.data : []),
    [programs.data],
  );
  // `now` is captured with the data rather than on every render, so a scroll
  // does not silently reorder the list under the reader's thumb.
  const posture = useMemo(() => compliancePosture(rows, Date.now()), [rows]);

  // The most urgent row is the default, so the screen lands on the thing that
  // needs attention rather than on whatever the catalogue happens to list
  // first. A selection the reader made survives a refetch.
  const activeSlug =
    selected && posture.rows.some((row) => row.program.framework === selected)
      ? selected
      : (posture.rows[0]?.program.framework ?? null);
  const active =
    posture.rows.find((row) => row.program.framework === activeSlug) ?? null;

  const events = useComplianceEvents(activeSlug, allowed);

  const refresh = useManualRefresh([programs.refetch, events.refetch], {
    enabled: gate.enabled && allowed,
  });

  const onSelect = useCallback((framework: string) => {
    setSelected(framework);
  }, []);

  const roleDenied = isComplianceRoleDenied(programs.error);
  const subtitle =
    programs.data !== undefined && posture.tracked > 0
      ? `${posture.attested} of ${plural(posture.tracked, "framework")} attested`
      : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top"]}>
      <ScreenHeader
        title="Compliance"
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
            body={ROLE_BODY}
            live={roleDenied}
          />
        ) : (
          <>
            {/* Only once the list has actually arrived. With no data the
                summary would announce "no supported framework came back",
                which is a statement about the workspace derived from a
                request that has not answered yet. */}
            {programs.data !== undefined && rows.length > 0 ? (
              <PostureSummaryCard posture={posture} />
            ) : null}

            <SectionLabel
              subtitle={`Most urgent first. “Renews soon” means within ${RENEWAL_DUE_SOON_DAYS} days.`}
            >
              Frameworks
            </SectionLabel>
            <QueryStates
              query={programs}
              gate={gate}
              isEmpty={posture.rows.length === 0}
              offlineMessage="Compliance posture needs a connection. Reconnect and pull to refresh — this is not the same as nothing being attested."
              skeleton={
                <SkeletonList
                  rows={5}
                  lines={2}
                  label="Loading compliance frameworks"
                />
              }
              empty={{
                // The server returns one row per catalogue entry unconditionally
                // (compliance.go:159-170), so an empty list is an anomaly rather
                // than a clean bill — and it must not read like one.
                title: "No frameworks came back",
                description:
                  "The server normally returns one row for every framework it tracks, even ones nobody has attested to. An empty list means something is wrong with the response, not that this workspace tracks nothing.",
              }}
            >
              {posture.rows.map((row) => (
                <FrameworkRow
                  key={row.program.framework}
                  row={row}
                  selected={row.program.framework === activeSlug}
                  onSelect={onSelect}
                />
              ))}
            </QueryStates>

            {active ? (
              <View style={{ marginTop: 16 }}>
                <SectionLabel topMargin={0}>{active.meta.short}</SectionLabel>
                <FrameworkDetailCard row={active} />
                <FrameworkReferenceCard meta={active.meta} />
                {/* Siblings, never nested: the ledger is an independent read
                    and nesting it would let one failing query hide the other. */}
                {active.program.framework === HIPAA_SLUG ? (
                  <UnsupportedLedgerNotice />
                ) : (
                  <AttestationLedger
                    query={events}
                    gate={gate}
                    frameworkShort={active.meta.short}
                  />
                )}
              </View>
            ) : null}

            {/* A write, on a monitor screen, because it passes this screen's own
                test: placing a hold stops retention sweeps TONIGHT. */}
            <SarQueueBanner />
            {/* GPC signal monitoring (desktop Consent.tsx gpcSubjectSummary):
                renders only when opt-out signals arrived — or failed to load. */}
            <GpcSignalsCard />
            <AssuranceLegalHoldPanel />
            {/* The privacy-portal operator surface (desktop PrivacyPortal.tsx):
                regions matrix, consent proof, pending double opt-ins. Same
                admin floor as every /privacy/portal/* manifest row. */}
            <PrivacyPortalSection allowed={allowed} />
            {/* Evidence panels (desktop Compliance.tsx): retention sweeps and
                Article 50 readiness. */}
            <RetentionActivityPanel allowed={allowed} />
            <Article50ReadinessCard allowed={allowed} />

            <DeskWorkNotice />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * HIPAA has no ledger to read.
 *
 * `ListEvents` short-circuits it to a fixed empty response
 * (compliance.go:447-455), so the request could only ever confirm what the
 * catalogue already says — and an empty "Attestation history" under the one
 * framework nobody may attest to reads as "nothing has happened yet" rather
 * than "this can never happen". Saying so beats fetching an empty array.
 */
function UnsupportedLedgerNotice() {
  const { t } = useTheme();
  return (
    <View style={{ marginTop: 12 }}>
      <SectionLabel topMargin={0}>Attestation history</SectionLabel>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        There is no ledger for HIPAA. Moosewave offers no Business Associate
        Agreement, so there is nothing here to attest to and nothing to record.
      </Text>
    </View>
  );
}

/** Says what this screen will not do, so its absence reads as a decision. */
function DeskWorkNotice() {
  const { t } = useTheme();
  return (
    <View style={{ marginTop: 20 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
        }}
      >
        Attesting and withdrawing are done on the web admin. Both write a
        permanent entry to the ledger above and want the signed document and its
        hash in front of you — this screen is for noticing, not for signing.
      </Text>
    </View>
  );
}
