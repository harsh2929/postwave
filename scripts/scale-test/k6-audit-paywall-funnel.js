// © Moosewave. Proprietary and confidential.
//
// k6 load test for the new admin/analytics surfaces shipped in this
// punch-list batch:
//
//   GET /api/v1/audit                         (audit log read)
//   GET /api/v1/voice/sequences/{id}/funnel   (drip funnel analytics)
//   GET /api/v1/paid-members                  (paywall member list)
//   GET /api/v1/security/settings             (security settings)
//   GET /api/v1/dlq                           (DLQ inspection)
//
// These are read-mostly admin endpoints — the SLA is "stays
// responsive when an operator opens 5 tabs" rather than the high-
// throughput webhook pipelines tested elsewhere.
//
// Mix is roughly:
//   40% audit   (most-frequent admin look)
//   25% funnel
//   15% paid_members
//   10% security
//   10% dlq
//
// Run:
//   k6 run scripts/scale-test/k6-audit-paywall-funnel.js
//
// Env vars:
//   POSTWAVE_API_URL    base URL (default http://localhost:8080)
//   POSTWAVE_API_KEY    admin-scoped API key (required)
//   POSTWAVE_SEQUENCE_ID  uuid of a sequence to funnel-query (required for the funnel ramp)

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE = __ENV.POSTWAVE_API_URL || "http://localhost:8080";
const KEY = __ENV.POSTWAVE_API_KEY || "";
const SEQ = __ENV.POSTWAVE_SEQUENCE_ID || "";

if (!KEY) {
  throw new Error("POSTWAVE_API_KEY is required");
}

const errors = new Rate("errors");
const auditLatency = new Trend("audit_latency_ms", true);
const funnelLatency = new Trend("funnel_latency_ms", true);

export const options = {
  scenarios: {
    admin_reads: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 10,
      maxVUs: 40,
      stages: [
        { duration: "30s", target: 5 },
        { duration: "2m", target: 5 },
        { duration: "30s", target: 0 },
      ],
    },
  },
  thresholds: {
    // Admin endpoints should be fast — operator UX falls off a cliff
    // past ~500ms. We cap p95 at 400ms to leave headroom.
    "http_req_duration{endpoint:audit}": ["p(95)<400"],
    "http_req_duration{endpoint:funnel}": ["p(95)<400"],
    "http_req_duration{endpoint:paid_members}": ["p(95)<400"],
    errors: ["rate<0.01"],
  },
};

const HEADERS = {
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};

function pickEndpoint() {
  const r = Math.random();
  if (r < 0.4) return "audit";
  if (r < 0.65) return "funnel";
  if (r < 0.8) return "paid_members";
  if (r < 0.9) return "security";
  return "dlq";
}

export default function () {
  const ep = pickEndpoint();
  let url;
  switch (ep) {
    case "audit":
      url = `${BASE}/api/v1/audit?limit=50`;
      break;
    case "funnel":
      if (!SEQ) {
        // Skip the funnel ramp if no sequence is configured rather
        // than poisoning the error rate with environment noise.
        return;
      }
      url = `${BASE}/api/v1/voice/sequences/${SEQ}/funnel`;
      break;
    case "paid_members":
      url = `${BASE}/api/v1/paid-members`;
      break;
    case "security":
      url = `${BASE}/api/v1/security/settings`;
      break;
    case "dlq":
      url = `${BASE}/api/v1/dlq`;
      break;
  }

  const res = http.get(url, { headers: HEADERS, tags: { endpoint: ep } });
  const ok = check(res, {
    "status 200": (r) => r.status === 200,
  });
  errors.add(!ok);
  if (ep === "audit") auditLatency.add(res.timings.duration);
  if (ep === "funnel") funnelLatency.add(res.timings.duration);
  sleep(0.2 + Math.random() * 0.3);
}
