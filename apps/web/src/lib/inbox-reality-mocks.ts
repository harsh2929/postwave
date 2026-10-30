// SPDX-License-Identifier: AGPL-3.0-only
//
// In-memory fakes for the Inbox Reality endpoints. Used while
// `services/deliverability` is reachable in dev but lacks real data, and
// any time `NEXT_PUBLIC_USE_MOCKS=1` is set.

import type {
  AuthCheck,
  CampaignReport,
  Diagnosis,
  DmarcStats,
  PersistedReport,
  PredictResponse,
  Reputation,
  ReportDetail,
  ReputationSnapshot,
} from "./inbox-reality-types";

const NOW = new Date().toISOString();
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

export function mockReputation(): Reputation {
  return {
    domain: "send.acmenews.example",
    ip: "203.0.113.40",
    google_score: "high",
    microsoft_score: "medium",
    sender_score: 87,
	data_available: true,
    blacklist_hits: [],
    checked_at: NOW,
  };
}

// A gently-declining SenderScore trend (INBOX-031) so the sparkline has shape
// in mock mode. Oldest-first, matching the service's ORDER BY checked_at ASC.
export function mockReputationHistory(): ReputationSnapshot[] {
  const points = [91, 90, 92, 89, 88, 90, 87];
  const day = 24 * 60 * 60 * 1000;
  return points.map((score, i) => ({
    sender_score: score,
    google_score: score >= 90 ? "high" : "medium",
    microsoft_score: "medium",
    blacklist_hit_count: 0,
    data_available: true,
    checked_at: new Date(
      Date.now() - (points.length - 1 - i) * day,
    ).toISOString(),
  }));
}

export function mockAuthChecks(): AuthCheck[] {
  return [
    {
      domain: "send.acmenews.example",
      spf: {
        status: "ok",
        detail: "SPF passes — 4 of 10 DNS lookups used.",
      },
      dkim: {
        status: "ok",
        detail: "DKIM signed with selector pm at 2048 bits.",
      },
      dmarc: {
        status: "warn",
        detail: "DMARC at p=none — monitoring only, no enforcement.",
      },
      bimi: {
        status: "warn",
        detail: "No BIMI record published; eligibility criteria are met.",
      },
      ptr: {
        status: "ok",
        detail: "PTR mta-1.acmenews.example resolves correctly.",
      },
    },
  ];
}

export function mockCampaignReport(id: string): CampaignReport {
  return {
    campaign_id: id,
    campaign_name: "Spring Edit · Issue #18",
    sent_at: "2026-04-22T15:00:00Z",
    total_inboxes: 64,
    generated_at: NOW,
    overall_pct: { primary: 0.62, promotions: 0.27, spam: 0.11 },
    providers: [
      {
        provider: "gmail",
        total: 16,
        placements: { primary: 9, promotions: 6, spam: 1 },
      },
      {
        provider: "outlook_com",
        total: 8,
        placements: { primary: 6, promotions: 1, spam: 1 },
      },
      {
        provider: "o365",
        total: 8,
        placements: { primary: 5, promotions: 2, spam: 1 },
      },
      {
        provider: "icloud",
        total: 8,
        placements: { primary: 7, promotions: 1 },
      },
      {
        provider: "yahoo",
        total: 8,
        placements: { primary: 4, promotions: 3, spam: 1 },
      },
      {
        provider: "proton",
        total: 6,
        placements: { primary: 3, spam: 3 },
      },
      {
        provider: "gmx",
        total: 5,
        placements: { primary: 4, promotions: 1 },
      },
      {
        provider: "mailru",
        total: 5,
        placements: { primary: 4, promotions: 1 },
      },
    ],
  };
}

export function mockDiagnosis(campaignId: string): Diagnosis {
  return {
    campaign_id: campaignId,
    diagnosis:
      "Most messages reach the primary inbox, but Gmail is routing a noticeable share to Promotions and ProtonMail is rejecting roughly half of seedlist deliveries. The two largest contributors are a missing list-unsubscribe-post header and an image-to-text ratio above the threshold most classifiers use. DMARC is also still at p=none, which limits both BIMI eligibility and reputation upside.",
    fixes: [
      {
        title: "Move DMARC to p=quarantine",
        detail:
          "You already publish a DMARC record at p=none with rua reporting. Promoting to p=quarantine unlocks BIMI and improves reputation across Gmail and Yahoo.",
        action: "dns_record",
        dns_record: {
          type: "TXT",
          name: "_dmarc.send.acmenews.example",
          value:
            "v=DMARC1; p=quarantine; rua=mailto:dmarc@acmenews.example; pct=100",
        },
        estimated_impact: 0.18,
      },
      {
        title: "Reduce image-to-text ratio in the hero block",
        detail:
          "The current hero uses a single full-width image. Replace with a 60/40 split: a smaller image plus 80–120 words of plain HTML text. This keeps Gmail Promotions classifiers happy and improves dark-mode rendering.",
        action: "copy_change",
        estimated_impact: 0.12,
      },
      {
        title: "Add List-Unsubscribe-Post header",
        detail:
          "RFC 8058 one-click unsubscribe is now effectively required by Gmail and ProtonMail for bulk senders. Adding the header alongside the existing List-Unsubscribe URL should unlock most ProtonMail placements.",
        action: "dns_record",
        estimated_impact: 0.15,
      },
      {
        title: "Re-send to subscribers who never received the original",
        detail:
          "Roughly 11% of seedlist mailboxes received nothing. After the DMARC and content fixes ship, queue a re-send to the bounce cohort to validate the change in production.",
        action: "resend",
        estimated_impact: 0.05,
      },
    ],
    predicted_impact: {
      primary: 0.85,
      promotions: 0.1,
      spam: 0.05,
    },
    generated_at: NOW,
  };
}

// DMARC aggregate-report monitoring (INBOX-032) fixtures. --------------

export function mockDmarcStats(): DmarcStats {
  return {
    total_reports: 3,
    total_records: 5,
    total_count: 1840,
    dkim_pass: 1712,
    dkim_fail: 128,
    spf_pass: 1655,
    spf_fail: 185,
    pass_count: 1602,
    fail_count: 238,
  };
}

// Newest first, so index 0 is the latest report (matches ListReports
// ordering by date_range_end DESC).
export function mockDmarcReports(): PersistedReport[] {
  return [
    {
      id: "dmr_2026_07_26",
      tenant_id: "tnt_1",
      org_name: "google.com",
      report_id: "16094152947274116815",
      date_range_begin: YESTERDAY,
      date_range_end: NOW,
      domain: "send.acmenews.example",
      policy_p: "quarantine",
      policy_sp: "quarantine",
      policy_pct: 100,
      ingested_at: NOW,
      source_message_id: "<report@google.com>",
    },
    {
      id: "dmr_2026_07_25",
      tenant_id: "tnt_1",
      org_name: "Yahoo",
      report_id: "1500000000998877",
      date_range_begin: YESTERDAY,
      date_range_end: YESTERDAY,
      domain: "send.acmenews.example",
      policy_p: "none",
      policy_sp: "none",
      policy_pct: 100,
      ingested_at: YESTERDAY,
      source_message_id: "<report@yahoo.com>",
    },
  ];
}

export function mockDmarcReport(id: string): ReportDetail {
  return {
    report: {
      id,
      tenant_id: "tnt_1",
      org_name: "google.com",
      report_id: "16094152947274116815",
      date_range_begin: YESTERDAY,
      date_range_end: NOW,
      domain: "send.acmenews.example",
      policy_p: "quarantine",
      policy_sp: "quarantine",
      policy_pct: 100,
      ingested_at: NOW,
      source_message_id: "<report@google.com>",
    },
    records: [
      {
        id: "dmrec_1",
        report_id: id,
        source_ip: "203.0.113.40",
        count: 1512,
        disposition: "none",
        dkim_result: "pass",
        spf_result: "pass",
        header_from: "acmenews.example",
        envelope_from: "send.acmenews.example",
        envelope_to: "gmail.com",
      },
      {
        id: "dmrec_2",
        report_id: id,
        source_ip: "198.51.100.17",
        count: 204,
        disposition: "quarantine",
        dkim_result: "fail",
        spf_result: "pass",
        header_from: "acmenews.example",
        envelope_from: "mail.acmenews.example",
        envelope_to: "gmail.com",
      },
      {
        id: "dmrec_3",
        report_id: id,
        source_ip: "192.0.2.88",
        count: 124,
        disposition: "reject",
        dkim_result: "fail",
        spf_result: "fail",
        header_from: "acmenews.example",
        envelope_from: "unknown.example",
        envelope_to: "gmail.com",
      },
    ],
  };
}

export function mockPredict(): PredictResponse {
  return {
    predicted: { primary: 0.74, promotions: 0.21, spam: 0.05 },
    content: {
      spam_score: 0.18,
      spam_reasons: ["image_heavy"],
      image_text_ratio: 1.4,
      link_reputation: "ok",
      html_issues: [],
    },
    risk: {
      model: {
        name: "postwave-placement-heuristic",
        version: "v1",
        kind: "heuristic",
        source: "embedded",
        trained: false,
        notes: ["Mock disclosure mirrors the production response shape."],
      },
      weights: {
        content: 0.4,
        reputation: 0.3,
        auth: 0.15,
        engagement: 0.15,
      },
      content: 0.18,
      reputation: 0.25,
      auth: 0.1,
      engagement: 0.5,
      combined: 0.237,
      assumptions: ["No historical engagement series was supplied."],
    },
    at: NOW,
  };
}
