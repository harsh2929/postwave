/**
 * CustomDomainsStatStrip — 4 KPIs that summarise the tenant's domain
 * inventory. Combines three signals into one strip so the operator
 * sees inventory + readiness + reputation + risk at a glance:
 *
 *   • Domains       — total count (with verified/pending mix bar)
 *   • DNS health    — Verified / Partial / Broken / Pending breakdown
 *   • Best score    — highest reputation grade across all domains
 *   • Issues        — domains with broken DNS or critical reputation
 *
 * Everything derives from the rows the parent already loaded; no
 * extra fetches.
 */

import { type ReactElement, useMemo } from "react";

import type {
  CustomDomain,
  DnsHealthStatus,
  SenderReputationDomain,
} from "../../lib/api-client";
import { CategoricalDistributionChart } from "../charts/CategoricalDistributionChart";
import { dux025Provenance } from "../charts/dux-025-visual-manifest";

interface Props {
  domains: CustomDomain[];
  /** Keyed by domain.name (lowercased). */
  healthByDomain: Record<string, DnsHealthStatus>;
  /** Keyed by domain.name (lowercased). */
  reputationByDomain: Record<string, SenderReputationDomain>;
}

interface Counts {
  total: number;
  verifiedDomains: number;
  pendingDomains: number;
  healthVerified: number;
  healthPartial: number;
  healthBroken: number;
  healthPending: number;
  topGrade: string | null;
  topScore: number;
  topDomain: string | null;
  issues: number;
}

function buildCounts(p: Props): Counts {
  const c: Counts = {
    total: p.domains.length,
    verifiedDomains: 0,
    pendingDomains: 0,
    healthVerified: 0,
    healthPartial: 0,
    healthBroken: 0,
    healthPending: 0,
    topGrade: null,
    topScore: -1,
    topDomain: null,
    issues: 0,
  };
  for (const d of p.domains) {
    if (d.verified) c.verifiedDomains++;
    else c.pendingDomains++;

    const key = (d.domain ?? "").toLowerCase();
    const h = p.healthByDomain[key];
    if (h) {
      if (h.verify_state === "verified") c.healthVerified++;
      else if (h.verify_state === "partial") c.healthPartial++;
      else if (h.verify_state === "broken") c.healthBroken++;
      else c.healthPending++;
    } else {
      c.healthPending++;
    }

    const rep = p.reputationByDomain[key];
    if (rep && rep.score > c.topScore) {
      c.topScore = rep.score;
      c.topGrade = rep.grade;
      c.topDomain = rep.domain;
    }
    // A domain is one issue, however many problems it has — counting
    // DNS + reputation separately double-counted domains with both.
    const repIssue =
      rep !== undefined && (rep.grade === "Critical" || rep.grade === "Poor");
    const dnsIssue = h?.verify_state === "broken";
    if (repIssue || dnsIssue) c.issues++;
  }
  return c;
}

export function CustomDomainsStatStrip(props: Props): ReactElement {
  const c = useMemo(() => buildCounts(props), [props]);
  // KPI = share of domains whose DNS health checks come back clean.
  // The old code showed the *verification* rate here, so the value
  // could read "100%" in red next to a "2 broken" hint.
  const dnsHealthRate = c.total > 0 ? (c.healthVerified / c.total) * 100 : 0;
  return (
    <div className="stat-grid" style={{ marginBottom: 12 }}>
      <StatCard
        label="Domains"
        value={c.total.toLocaleString()}
        hint={`${c.verifiedDomains.toLocaleString()} verified · ${c.pendingDomains.toLocaleString()} pending`}
      >
        <MixBar verified={c.verifiedDomains} pending={c.pendingDomains} />
      </StatCard>
      <StatCard
        label="DNS health"
        value={`${dnsHealthRate.toFixed(0)}%`}
        hint={
          c.healthBroken > 0
            ? `${c.healthBroken} broken · ${c.healthPartial} partial`
            : c.healthPartial > 0
              ? `${c.healthPartial} partial · ${c.healthVerified} clean`
              : `${c.healthVerified} clean`
        }
        positive={
          c.total > 0 && c.healthVerified === c.total && c.healthBroken === 0
        }
        negative={c.healthBroken > 0}
      />
      <StatCard
        label="Best reputation"
        value={c.topScore >= 0 ? String(c.topScore) : "—"}
        hint={
          c.topDomain
            ? `${c.topGrade} · ${c.topDomain}`
            : "No sends in last 7 days"
        }
        positive={c.topScore >= 80}
        negative={c.topScore >= 0 && c.topScore < 60}
      />
      <StatCard
        label="Issues"
        value={c.issues.toLocaleString()}
        hint={
          c.issues === 0
            ? "No broken or critical domains"
            : "Broken DNS or critical reputation"
        }
        negative={c.issues > 0}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  positive,
  negative,
  children,
}: {
  label: string;
  value: string;
  hint: string;
  positive?: boolean;
  negative?: boolean;
  children?: React.ReactNode;
}): ReactElement {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div
        className="stat-value tabular"
        style={{
          color: positive
            ? "var(--pw-accent)"
            : negative
              ? "var(--pw-danger)"
              : "var(--pw-fg)",
        }}
      >
        {value}
      </div>
      <div className="stat-delta subtle">{hint}</div>
      {children}
    </div>
  );
}

function MixBar({
  verified,
  pending,
}: {
  verified: number;
  pending: number;
}): ReactElement {
  return (
    <div style={{ marginTop: 6 }}>
      <CategoricalDistributionChart
        title="Domain verification distribution"
        valueLabel="Domains"
        height={8}
        segments={[
          {
            key: "verified",
            label: "Verified",
            value: verified,
            color: "var(--pw-accent)",
          },
          {
            key: "pending",
            label: "Pending",
            value: pending,
            color: "var(--pw-warning)",
          },
        ]}
        provenance={dux025Provenance("domainVerificationMix")}
        exportFileName="domain-verification-distribution.csv"
        exportPrivacy="confidential"
      />
    </div>
  );
}
