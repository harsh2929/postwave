// send-loop.k6.js — campaign queue + dispatch throughput.
//
// Models the "create draft → queue → poll until sent" trip a real
// operator takes when sending a campaign. We don't actually deliver
// email (the test tenant should be configured with a /dev/null sender),
// but we exercise the queue + state-machine + listmonk-write path.
//
// Throughput target: 50 sends/s sustained, P95 first-dispatch < 5s.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { authHeaders, BASE } from './auth.js';

const sendTrend = new Trend('campaign_send_to_dispatch_ms', true);
const sendTimeout = new Rate('campaign_send_timeout');

export const options = {
  scenarios: {
    send_loop: {
      executor: 'ramping-vus',
      stages: [
        { duration: '20s', target: 5 },
        { duration: '60s', target: 20 },
        { duration: '20s', target: 0 },
      ],
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.02'],
    'campaign_send_to_dispatch_ms': ['p(95)<5000'],
    'campaign_send_timeout': ['rate<0.05'],
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
  const draftBody = JSON.stringify({
    name: `load-${__VU}-${__ITER}-${Date.now()}`,
    subject: 'load test',
    html: '<p>load-test body</p>',
    audience: { kind: 'list', list_id: 'load-test' },
  });

  const createRes = http.post(`${BASE}/api/v1/campaigns`, draftBody, {
    headers: HEADERS,
    tags: { name: 'POST campaigns' },
  });
  if (!check(createRes, { 'campaign created': (r) => r.status === 201 || r.status === 200 })) {
    return;
  }

  let campaignID;
  try {
    campaignID = createRes.json('id');
  } catch (_) {
    return;
  }
  if (!campaignID) return;

  const queueRes = http.post(
    `${BASE}/api/v1/campaigns/${campaignID}/queue`,
    null,
    { headers: HEADERS, tags: { name: 'POST campaigns/{id}/queue' } },
  );
  check(queueRes, { 'campaign queued': (r) => r.status < 400 });

  // Poll until status leaves "queued" or we time out.
  const startedAt = Date.now();
  let dispatched = false;
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    const statusRes = http.get(`${BASE}/api/v1/campaigns/${campaignID}`, {
      headers: HEADERS,
      tags: { name: 'GET campaigns/{id}' },
    });
    if (statusRes.status === 200) {
      const status = (statusRes.json('status') || '').toString();
      if (status === 'sending' || status === 'sent' || status === 'finished') {
        dispatched = true;
        sendTrend.add(Date.now() - startedAt);
        break;
      }
    }
    sleep(POLL_INTERVAL_MS / 1000);
  }
  sendTimeout.add(!dispatched);
}
