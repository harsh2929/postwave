/**
 * PrivacyPortal — single-pane-of-glass for tenant compliance posture.
 *
 * Mirrors Braze's "Privacy Portal" surface. Renders:
 *   1. Top KPI tiles (DSAR open/overdue/closed, GPC, do-not-sell,
 *      pending double opt-in) — <PortalDashboard />
 *   2. Privacy regions matrix with add/remove — <RegionsCard />
 *   3. Consent proof panel + recent receipts — <ConsentProofPanel />
 *   4. Double opt-in pending review queue — <DoubleOptinPendingTable />
 *   5. Preference center theme customizer + live preview —
 *      <PreferenceCenterCustomization />
 *
 * GAP-LS-091 / 093 / 094 / 096 / 097 / 098 / 099 / 144 / 149 / 150.
 *
 * The page is a single read off /api/v1/privacy/portal that fans out
 * into the tiles + regions; remove / add region operations re-trigger
 * the read so every tile stays in sync.
 */

import { type ReactElement } from "react";

import { PageHeader } from "../components/PageHeader";
import { RemoteDataNotice } from "../components/RemoteDataNotice";
import { SectionHeader } from "../components/SectionHeader";
import { ConsentProofPanel } from "../components/privacy/ConsentProofPanel";
import { DoubleOptinPendingTable } from "../components/privacy/DoubleOptinPendingTable";
import { PortalDashboard } from "../components/privacy/PortalDashboard";
import { PreferenceCenterCustomization } from "../components/privacy/PreferenceCenterCustomization";
import { RegionsCard } from "../components/privacy/RegionsCard";
import { type PrivacyPortalSummary, api } from "../lib/api-client";
import { useRemoteResource } from "../hooks/useRemoteResource";
import { isInitialRemoteLoad } from "../lib/remote-resource";

/** Complete empty shape — every array field present so a partial API body
 *  can be merged onto it without leaving children to read `undefined`. */
const EMPTY_SUMMARY: PrivacyPortalSummary = {
  regions: [],
  dsar_requests: [],
  gpc_signaled_count: 0,
  do_not_sell_count: 0,
  double_optin_pending: 0,
  suppression_breakdown: [],
  consent_proof_summary: [],
};

export function PrivacyPortal(): ReactElement {
  const portal = useRemoteResource<PrivacyPortalSummary>(
    async () => {
      const res = await api.privacyPortal.get();
      if ("error" in res && res.error) {
        return { error: res.error };
      }
      // A successful partial/empty body is verified empty data. It is never
      // used as a fallback for a failed request.
      return { data: { ...EMPTY_SUMMARY, ...res.data } };
    },
    { identity: "privacy-portal" },
  );
  const summary = portal.data;
  const initialLoading = isInitialRemoteLoad(portal);

  return (
    <>
      <PageHeader
        eyebrow="Compliance"
        title="Privacy portal"
        subtitle="One pane of glass for DSAR fulfilment, framework matrix, consent proof, and preference center theming."
        actions={[
          {
            label: portal.transport === "loading" ? "Refreshing…" : "Refresh",
            onClick: () => void portal.reload(),
            disabled: portal.transport === "loading",
          },
        ]}
      />

      <RemoteDataNotice
        resource={portal}
        label="privacy portal"
        onRetry={() => void portal.reload()}
      />

      {initialLoading ? (
        <div role="status" aria-live="polite" aria-busy="true">
          <div className="skel" style={{ height: 80, marginBottom: 12 }} />
          <div className="skel" style={{ height: 200, marginBottom: 12 }} />
          <div className="skel" style={{ height: 160 }} />
        </div>
      ) : summary ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <PortalDashboard summary={summary} />

          <div>
            <SectionHeader
              title="Regions"
              description="Which framework applies in which market — and what it requires."
            />
            <RegionsCard
              regions={summary.regions}
              onChanged={() => void portal.reload()}
            />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            <ConsentProofPanel summary={summary.consent_proof_summary} />
            <DoubleOptinPendingTable />
          </div>

          <div>
            <SectionHeader
              title="Preference center"
              description="Theme the hosted subscribe/unsubscribe page. Live preview on the right."
            />
            <PreferenceCenterCustomization />
          </div>
        </div>
      ) : null}
    </>
  );
}
