// abuse-rate-limit.k6.js — public-form and tenant API abuse smoke.
//
// This is intentionally correctness-biased rather than throughput-biased:
// the acceptable responses include validation errors, 404 for nonexistent
// forms, and 429 once rate limits trigger. The regression we care about is
// "abuse traffic causes 5xx, hangs, or bypasses validation completely."

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { authHeaders, BASE } from './auth.js';

export const options = {
  scenarios: {
    form_spam: {
      executor: 'constant-vus',
      vus: Number(__ENV.POSTWAVE_ABUSE_VUS || 20),
      duration: __ENV.POSTWAVE_ABUSE_DURATION || '30s',
    },
  },
  thresholds: {
    abuse_unexpected: ['rate<0.01'],
    checks: ['rate>0.95'],
    'http_req_duration{name:POST public form abuse}': ['p(95)<500'],
    'http_req_duration{name:GET subscriber abuse probe}': ['p(95)<500'],
  },
};

const abuseUnexpected = new Rate('abuse_unexpected');
const FORM_SLUG = __ENV.POSTWAVE_ABUSE_FORM_SLUG || 'missing-e2e-abuse-form';

const apiHeaders = authHeaders({ Accept: 'application/json' });

const jsonHeaders = {
  ...apiHeaders,
  'Content-Type': 'application/json',
};

function expected(status) {
  return status === 200 || status === 400 || status === 401 || status === 403 ||
    status === 404 || status === 422 || status === 429;
}

export default function () {
  const marker = `${__VU}-${__ITER}-${Date.now()}`;
  const payload = {
    email: `abuse-${marker}@invalid`,
    website: __ITER % 2 === 0 ? 'https://bot.invalid' : '',
    customFields: {
      oversized: 'x'.repeat(1024),
      marker,
    },
  };

  const submit = http.post(
    `${BASE}/api/public/forms/${FORM_SLUG}/submit`,
    JSON.stringify(payload),
    { headers: jsonHeaders, tags: { name: 'POST public form abuse' } },
  );
  const submitOK = expected(submit.status);
  abuseUnexpected.add(!submitOK);
  check(submit, {
    'form abuse returns controlled status': () => submitOK,
    'form abuse does not return 5xx': (r) => r.status < 500,
  });

  const probe = http.get(`${BASE}/api/v1/subscribers?per_page=1`, {
    headers: apiHeaders,
    tags: { name: 'GET subscriber abuse probe' },
  });
  const probeOK = expected(probe.status);
  abuseUnexpected.add(!probeOK);
  check(probe, {
    'subscriber abuse probe returns controlled status': () => probeOK,
    'subscriber abuse probe does not return 5xx': (r) => r.status < 500,
  });

  sleep(0.1);
}
