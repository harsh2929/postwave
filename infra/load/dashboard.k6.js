// dashboard.k6.js — auth + dashboard read baseline.
//
// Hits the two highest-traffic read endpoints in the product:
//   GET /api/v1/dashboard/stats
//   GET /api/v1/campaigns?per_page=20
//
// Ramping VU profile so the run also captures cold-start behaviour (the
// JIT / connection-pool warm-up is part of P95 in practice).

import http from 'k6/http';
import { check, sleep } from 'k6';
import { authHeaders, BASE } from './auth.js';

export const options = {
  scenarios: {
    dashboard_reads: {
      executor: 'ramping-vus',
      stages: [
        { duration: '15s', target: 20 },
        { duration: '30s', target: 50 },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    'http_req_duration{name:GET dashboard}': ['p(95)<400'],
    'http_req_duration{name:GET campaigns}': ['p(95)<400'],
    'http_req_failed': ['rate<0.01'],
    'checks': ['rate>0.99'],
  },
};

const HEADERS = authHeaders({ Accept: 'application/json' });

export default function () {
  let res = http.get(`${BASE}/api/v1/dashboard/stats`, {
    headers: HEADERS,
    tags: { name: 'GET dashboard' },
  });
  check(res, { 'dashboard 200': (r) => r.status === 200 });

  res = http.get(`${BASE}/api/v1/campaigns?per_page=20`, {
    headers: HEADERS,
    tags: { name: 'GET campaigns' },
  });
  check(res, { 'campaigns 200': (r) => r.status === 200 });

  sleep(1);
}
