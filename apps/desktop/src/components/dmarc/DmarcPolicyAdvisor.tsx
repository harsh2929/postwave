import type { ReactElement } from "react";

import type { DmarcInsights } from "../../lib/api-client";

interface Props {
  insights: DmarcInsights;
}

function policyLabel(policy: string | undefined, domain: string): string {
  if (policy === "none") return "p=none · monitoring";
  if (policy === "quarantine") return "p=quarantine";
  if (policy === "reject") return "p=reject";
  if (policy === "unknown") return "Policy value not recognized";
  return domain ? "No policy observed in window" : "Multiple-domain scope";
}

function policyContext(policy: string | undefined, domain: string): string {
  if (policy === "none") {
    return "Aggregate-report payloads declared a monitoring policy. Review legitimate unaligned sources before considering enforcement.";
  }
  if (policy === "quarantine") {
    return "Aggregate-report payloads declared quarantine enforcement. Investigate unaligned legitimate senders before any further policy change.";
  }
  if (policy === "reject") {
    return "Aggregate-report payloads declared reject enforcement. Continue monitoring unexpected unaligned volume and reporting gaps.";
  }
  if (policy === "unknown" && domain) {
    return `The latest ingested report for ${domain} did not contain a recognized p=none, p=quarantine, or p=reject value. Inspect the report receipt and live DNS independently.`;
  }
  if (domain) {
    return `No report in this window supplied policy evidence for ${domain}. This is an evidence gap, not a DNS-policy conclusion.`;
  }
  return "Tenant-wide views can combine several domains and policies. Select one domain to inspect its latest reported policy evidence.";
}

export function DmarcPolicyAdvisor({ insights }: Props): ReactElement {
  return (
    <section
      className="dmarc-policy-advisor"
      aria-labelledby="dmarc-policy-title"
    >
      <div className="dmarc-policy-advisor__icon" aria-hidden="true">
        <span />
      </div>
      <div>
        <p className="dmarc-kicker">Policy evidence</p>
        <h2 id="dmarc-policy-title">
          {policyLabel(insights.latestPolicy, insights.domain)}
        </h2>
        <p>{policyContext(insights.latestPolicy, insights.domain)}</p>
        <div className="dmarc-policy-advisor__boundary" role="note">
          <strong>Observation only</strong>
          <span>
            This value came from the latest aggregate report in scope. It is not
            a live DNS lookup and must never be used to replace a complete DMARC
            TXT record. Verify every existing tag, reporting address, and
            external authorization before changing DNS.
          </span>
        </div>
      </div>
    </section>
  );
}
