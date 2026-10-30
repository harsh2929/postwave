// © Moosewave. Proprietary and confidential.
//
// k6 load test — simulates 50 concurrent tenants each kicking off a
// migration discovery against `services/migration`'s
// `POST /v1/migrations/{source}/discover` endpoint. The goal is to
// confirm we can stay inside source-platform rate-limit headroom and
// never 5xx on our side.
//
// Source defaults to `mailchimp`; pass MIGRATION_SOURCE=convertkit (etc.)
// to override.

import http from "k6/http";
import { check } from "k6";
import { Trend, Rate } from "k6/metrics";

const BASE = __ENV.POSTWAVE_API_URL || "http://localhost:8080";
const BEARER = __ENV.POSTWAVE_BEARER || "";
const SOURCE = __ENV.MIGRATION_SOURCE || "mailchimp";

export const options = {
  scenarios: {
    discover: {
      executor: "per-vu-iterations",
      vus: 50,
      iterations: 1,
      maxDuration: "2m",
    },
  },
  thresholds: {
    "http_req_duration{endpoint:discover}": ["p(99)<8000"],
    "http_req_failed{endpoint:discover}": ["rate<0.01"],
  },
};

const discoverLatency = new Trend("migration_discover_latency", true);
const discoverErrors = new Rate("migration_discover_error_rate");

export default function () {
  // Each VU represents a unique tenant; the credentials lookup happens
  // server-side via the bearer token's tenant claim. In the staging
  // harness we provision 50 stubbed credential records, one per VU.
  const url = `${BASE}/v1/migrations/${SOURCE}/discover`;
  const body = JSON.stringify({
    tenant_index: __VU, // staging-only field; ignored in prod
  });
  const params = {
    headers: {
      "Content-Type": "application/json",
      ...(BEARER ? { Authorization: `Bearer ${BEARER}` } : {}),
    },
    tags: { endpoint: "discover" },
    timeout: "60s",
  };
  const res = http.post(url, body, params);
  discoverLatency.add(res.timings.duration);
  const ok = check(res, {
    "status 2xx": (r) => r.status >= 200 && r.status < 300,
    "has counts": (r) => {
      try {
        const j = r.json();
        return typeof j.subscribers_count === "number";
      } catch {
        return false;
      }
    },
  });
  discoverErrors.add(!ok);
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify({
      latency: data.metrics.migration_discover_latency?.values,
      error_rate: data.metrics.migration_discover_error_rate?.values,
    }, null, 2),
    "scripts/scale-test/runs/migration-discover-summary.json": JSON.stringify(data, null, 2),
  };
}
