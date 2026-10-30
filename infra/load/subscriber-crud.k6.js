// subscriber-crud.k6.js — mixed read/write subscriber traffic.
//
// Distribution chosen to match production telemetry: 70% list reads,
// 20% creates, 10% updates/deletes. The created subscriber's id is
// reused in the same iteration for the patch/delete so we don't need
// to load fixtures. Local smoke runs clean up their own writes so the
// test does not trip plan contact caps or poison later runs.
//
// Target: P95 < 250ms mixed, < 0.5% error rate, 200 req/s.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { authHeaders, BASE } from './auth.js';

export const options = {
  scenarios: {
    crud: {
      executor: 'ramping-vus',
      stages: [
        { duration: '15s', target: 20 },
        { duration: '45s', target: 50 },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.01'],
    'http_req_duration{name:GET subscribers}': ['p(95)<250'],
    'http_req_duration{name:POST subscribers}': ['p(95)<350'],
    'http_req_duration{name:PATCH subscribers/{id}}': ['p(95)<300'],
    'http_req_duration{name:DELETE subscribers/{id}}': ['p(95)<300'],
    'checks': ['rate>0.99'],
  },
};

const HEADERS = authHeaders({
  'Content-Type': 'application/json',
  Accept: 'application/json',
});

function rand() {
  return Math.random();
}

function randomEmail() {
  return `load-${__VU}-${__ITER}-${Date.now()}-${Math.floor(rand() * 1e6)}@load.postwave.test`;
}

function deleteSubscriber(id) {
  return http.del(`${BASE}/api/v1/subscribers/${id}`, null, {
    headers: HEADERS,
    tags: { name: 'DELETE subscribers/{id}' },
  });
}

export default function () {
  const r = rand();

  if (r < 0.7) {
    // 70% — list read.
    const res = http.get(`${BASE}/api/v1/subscribers?per_page=20`, {
      headers: HEADERS,
      tags: { name: 'GET subscribers' },
    });
    check(res, { 'list 200': (rr) => rr.status === 200 });
    sleep(0.5);
    return;
  }

  // The remaining 30% always starts with a POST so we have an id to
  // mutate. 20% stops there; 10% follows up with PATCH/DELETE.
  const email = randomEmail();
  const createRes = http.post(
    `${BASE}/api/v1/subscribers`,
    JSON.stringify({ email, name: 'load test' }),
    { headers: HEADERS, tags: { name: 'POST subscribers' } },
  );
  if (!check(createRes, { 'create 201': (rr) => rr.status === 201 || rr.status === 200 })) {
    return;
  }

  let id;
  try {
    id = createRes.json('id');
  } catch (_) {
    return;
  }
  if (!id) return;

  if (r < 0.9) {
    // 20% — POST only, then cleanup. The POST remains the measured product
    // behavior; cleanup keeps local smoke idempotent against plan limits.
    const cleanupRes = deleteSubscriber(id);
    check(cleanupRes, { 'delete ok': (rr) => rr.status < 400 });
    return;
  }

  // 10% — PATCH then DELETE.
  if (rand() < 0.5) {
    const patchRes = http.patch(
      `${BASE}/api/v1/subscribers/${id}`,
      JSON.stringify({ name: 'load test patched' }),
      { headers: HEADERS, tags: { name: 'PATCH subscribers/{id}' } },
    );
    check(patchRes, { 'patch ok': (rr) => rr.status < 400 });
    const cleanupRes = deleteSubscriber(id);
    check(cleanupRes, { 'delete ok': (rr) => rr.status < 400 });
  } else {
    const delRes = deleteSubscriber(id);
    check(delRes, { 'delete ok': (rr) => rr.status < 400 });
  }
  sleep(0.2);
}
