// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Moosewave.
//
// k6 load test — simulates a 100K-subscriber transactional send through
// the separately running upstream Listmonk `/api/tx` endpoint, fronted by the
// Moosewave API
// gateway. Ramps 0→100 RPS over 1 minute, sustains for 5 minutes, ramps
// down for 1 minute.
//
// Run:
//   k6 run scripts/scale-test/k6-listmonk-send.js
//
// Env vars:
//   POSTWAVE_API_URL  — base URL (default http://localhost:8080)
//   POSTWAVE_BEARER   — bearer token for the service account
//   LISTMONK_TX_PATH  — override path (default /api/tx)
//   TEMPLATE_ID       — Listmonk transactional template ID (default 1)

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

const BASE = __ENV.POSTWAVE_API_URL || "http://localhost:8080";
const BEARER = __ENV.POSTWAVE_BEARER || "";
const TX_PATH = __ENV.LISTMONK_TX_PATH || "/api/tx";
const TEMPLATE_ID = parseInt(__ENV.TEMPLATE_ID || "1", 10);

export const options = {
  scenarios: {
    listmonk_tx: {
      executor: "ramping-arrival-rate",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: 100,
      maxVUs: 400,
      stages: [
        { duration: "1m", target: 100 }, // ramp up
        { duration: "5m", target: 100 }, // sustain
        { duration: "1m", target: 0 },   // ramp down
      ],
    },
  },
  thresholds: {
    // PRD SLO: P99 transactional send < 500ms.
    "http_req_duration{endpoint:tx}": ["p(50)<150", "p(95)<250", "p(99)<500"],
    "http_req_failed{endpoint:tx}": ["rate<0.001"],
  },
};

const txLatency = new Trend("tx_send_latency", true);
const txErrors = new Rate("tx_send_error_rate");
const txCount = new Counter("tx_send_count");

// Round-robin over a synthetic 100K subscriber pool. We don't actually
// touch a DB; the subscriber email is generated.
function pickEmail() {
  const i = Math.floor(Math.random() * 100000);
  return `loadtest+${i}@scale.postwave.test`;
}

export default function () {
  const url = `${BASE}${TX_PATH}`;
  const body = JSON.stringify({
    subscriber_email: pickEmail(),
    template_id: TEMPLATE_ID,
    data: {
      campaign_id: "scale-test-1",
      first_name: "Scale",
    },
    content_type: "html",
  });
  const params = {
    headers: {
      "Content-Type": "application/json",
      ...(BEARER ? { Authorization: `Bearer ${BEARER}` } : {}),
    },
    tags: { endpoint: "tx" },
  };
  const res = http.post(url, body, params);
  txLatency.add(res.timings.duration);
  txCount.add(1);
  const ok = check(res, {
    "status 2xx": (r) => r.status >= 200 && r.status < 300,
  });
  txErrors.add(!ok);
  if (!ok) {
    // Slow the VU briefly on backpressure so we don't add to the storm.
    sleep(0.2);
  }
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data),
    "scripts/scale-test/runs/listmonk-send-summary.json": JSON.stringify(data, null, 2),
  };
}

function textSummary(data) {
  const m = data.metrics;
  const fmt = (k) => (m[k] && m[k].values ? JSON.stringify(m[k].values) : "n/a");
  return [
    "Moosewave Listmonk-tx scale test",
    `count: ${fmt("tx_send_count")}`,
    `latency: ${fmt("tx_send_latency")}`,
    `error_rate: ${fmt("tx_send_error_rate")}`,
    "",
  ].join("\n");
}
