// © Moosewave. Proprietary and confidential.
//
// k6 load test for the behavioral-trigger event ingester. Posts a stream
// of opened/clicked/complained events at the internal Listmonk webhook
// endpoint, signed with a shared HMAC secret. Validates the trigger
// pipeline can keep up with sustained inbound event volume without
// dropping events or breaching the latency budget.
//
// Mix:
//   70% opened
//   25% clicked
//    5% complained
//
// Stages: 0 -> 10 RPS over 1 minute, 10 RPS sustained for 5 minutes,
// ramp down 1 minute. Thresholds: P99 < 300ms, error rate < 1%.
//
// Run:
//   k6 run scripts/scale-test/k6-automation-events.js
//
// Env vars:
//   POSTWAVE_API_URL              base URL (default http://localhost:8080)
//   POSTWAVE_EVENTS_PATH          override path (default /api/internal/listmonk/events)
//   POSTWAVE_EVENTS_HMAC_SECRET   shared HMAC secret (required)
//   POSTWAVE_TENANT_ID            tenant id to attribute events to (required)

import http from "k6/http";
import { check, sleep } from "k6";
import crypto from "k6/crypto";
import { Trend, Rate, Counter } from "k6/metrics";

const BASE = __ENV.POSTWAVE_API_URL || "http://localhost:8080";
const PATH = __ENV.POSTWAVE_EVENTS_PATH || "/api/internal/listmonk/events";
const SECRET = __ENV.POSTWAVE_EVENTS_HMAC_SECRET || "";
const TENANT = __ENV.POSTWAVE_TENANT_ID || "tnt_loadtest";

if (!SECRET) {
  // Fail fast rather than silently 401-looping the run.
  throw new Error("POSTWAVE_EVENTS_HMAC_SECRET is required");
}

export const options = {
  scenarios: {
    automation_events: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 20,
      maxVUs: 80,
      stages: [
        { duration: "1m", target: 10 }, // ramp up
        { duration: "5m", target: 10 }, // sustain
        { duration: "1m", target: 0 },  // ramp down
      ],
    },
  },
  thresholds: {
    "http_req_duration{endpoint:events}": ["p(99)<300"],
    "http_req_failed{endpoint:events}": ["rate<0.01"],
  },
};

const evtLatency = new Trend("event_ingest_latency", true);
const evtErrors = new Rate("event_ingest_error_rate");
const evtCount = new Counter("event_ingest_count");

const CAMPAIGN_POOL = ["cmp_loadtest_1", "cmp_loadtest_2", "cmp_loadtest_3"];
const URL_POOL = [
  "https://example.com/post-1",
  "https://example.com/pricing",
  "https://example.com/changelog",
];

function pickEvent() {
  const r = Math.random();
  if (r < 0.70) return "opened";
  if (r < 0.95) return "clicked";
  return "complained";
}

function pickFrom(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickSubscriber() {
  // 50K-subscriber synthetic pool, deterministic id format.
  const i = Math.floor(Math.random() * 50000);
  return `sub_${i}`;
}

function buildEvent() {
  const event = pickEvent();
  const body = {
    tenant_id: TENANT,
    event,
    subscriber_id: pickSubscriber(),
    campaign_id: pickFrom(CAMPAIGN_POOL),
    occurred_at: new Date().toISOString(),
  };
  if (event === "clicked") {
    body.url = pickFrom(URL_POOL);
  }
  return JSON.stringify(body);
}

function sign(body) {
  return crypto.hmac("sha256", SECRET, body, "hex");
}

export default function () {
  const url = `${BASE}${PATH}`;
  const body = buildEvent();
  const params = {
    headers: {
      "Content-Type": "application/json",
      "X-Postwave-Signature": sign(body),
    },
    tags: { endpoint: "events" },
  };
  const res = http.post(url, body, params);
  evtLatency.add(res.timings.duration);
  evtCount.add(1);
  const ok = check(res, {
    "status 2xx": (r) => r.status >= 200 && r.status < 300,
  });
  evtErrors.add(!ok);
  if (!ok) {
    sleep(0.2);
  }
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data),
    "scripts/scale-test/runs/automation-events-summary.json": JSON.stringify(data, null, 2),
  };
}

function textSummary(data) {
  const m = data.metrics;
  const fmt = (k) => (m[k] && m[k].values ? JSON.stringify(m[k].values) : "n/a");
  return [
    "Moosewave automation-events scale test",
    `count: ${fmt("event_ingest_count")}`,
    `latency: ${fmt("event_ingest_latency")}`,
    `error_rate: ${fmt("event_ingest_error_rate")}`,
    "",
  ].join("\n");
}
