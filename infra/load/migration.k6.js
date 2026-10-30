// migration.k6.js — Mailchimp migration discovery + planning baseline.
//
// We always run with dry_run=true so no rows are actually imported —
// this measures the slow part (auth + discovery + planning) without
// polluting the test tenant's data. The migration service exposes:
//
//   POST   /api/v1/migrations            — start (returns job)
//   GET    /api/v1/migrations/{id}       — poll
//
// Target: dry-run discovery < 8 s P95 with one migration in flight.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { authHeaders, BASE } from './auth.js';

const planTrend = new Trend('migration_plan_ms', true);
const planTimeout = new Rate('migration_plan_timeout');

export const options = {
  scenarios: {
    migration_plan: {
      executor: 'constant-vus',
      vus: 3,
      duration: '60s',
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.02'],
    'migration_plan_ms': ['p(95)<8000'],
    'migration_plan_timeout': ['rate<0.05'],
    'checks': ['rate>0.95'],
  },
};

const HEADERS = authHeaders({
  'Content-Type': 'application/json',
  Accept: 'application/json',
});

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;

export default function () {
  const body = JSON.stringify({
    source: 'mailchimp',
    api_key: __ENV.POSTWAVE_LOAD_MAILCHIMP_KEY || 'load-test-fake-key',
    dry_run: true,
    resources: ['subscribers', 'segments'],
  });

  const createRes = http.post(
    `${BASE}/api/v1/migrations?dry_run=true`,
    body,
    { headers: HEADERS, tags: { name: 'POST migrations' } },
  );
  if (!check(createRes, { 'migration started': (r) => r.status < 400 })) {
    return;
  }

  let jobID;
  try {
    jobID = createRes.json('id') || createRes.json('job_id');
  } catch (_) {
    return;
  }
  if (!jobID) return;

  const startedAt = Date.now();
  let done = false;
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const res = http.get(`${BASE}/api/v1/migrations/${jobID}`, {
      headers: HEADERS,
      tags: { name: 'GET migrations/{id}' },
    });
    if (res.status === 200) {
      const status = (res.json('status') || '').toString();
      if (status === 'completed' || status === 'planned' || status === 'failed') {
        done = true;
        planTrend.add(Date.now() - startedAt);
        break;
      }
    }
    sleep(POLL_INTERVAL_MS / 1000);
  }
  planTimeout.add(!done);
}
