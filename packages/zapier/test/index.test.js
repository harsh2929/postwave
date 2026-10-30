// Smoke tests for the Moosewave Zapier app, using Node's built-in test runner.
//
// These don't exercise the real Zapier sandbox (we don't have credentials in
// CI). Instead they verify the shape of the app definition + that each
// operation's pure-JS logic (subscribe, unsubscribe, perform for hooks,
// perform for creates) does the right thing when given a mock `z` and
// `bundle`.

const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../index.js');
const authentication = require('../authentication.js');
const campaignSent = require('../triggers/campaign-sent.js');
const subscriberAdded = require('../triggers/subscriber-added.js');
const subscriberUnsubscribed = require('../triggers/subscriber-unsubscribed.js');
const approvalDecided = require('../triggers/approval-decided.js');
const approvalRequested = require('../triggers/approval-requested.js');
const bounceReceived = require('../triggers/bounce-received.js');
const listSubscriberAdded = require('../triggers/list-subscriber-added.js');
const addSubscriber = require('../creates/add-subscriber.js');
const updateSubscriber = require('../creates/update-subscriber.js');
const unsubscribeSubscriber = require('../creates/unsubscribe-subscriber.js');
const sendCampaign = require('../creates/send-campaign.js');
const startSequence = require('../creates/start-sequence.js');
const addToList = require('../creates/add-to-list.js');
const removeFromList = require('../creates/remove-from-list.js');
const findSubscriber = require('../searches/find-subscriber.js');
const { apiUrl } = require('../lib/api-url.js');

// A tiny mock for Zapier's `z` object. Each test wires its own request
// handler — `request(opts)` returns whatever the handler returns. Captured
// calls live in `mock.calls` for assertions.
function makeZ(handler) {
  const calls = [];
  const z = {
    request: async (opts) => {
      calls.push(opts);
      const result = await Promise.resolve(handler(opts));
      // Default to { status: 200, data: {} } so handlers that just want to
      // observe a call don't have to spell out the full envelope.
      const envelope = result || {};
      if (envelope.status == null) envelope.status = 200;
      if (envelope.data == null && envelope.json == null) envelope.data = {};
      return envelope;
    },
    console: { log: () => {} },
  };
  return { z, calls };
}

const bundle = (overrides = {}) => ({
  authData: { api_key: 'pw_test_abc', api_base_url: 'https://api.test.local' },
  inputData: {},
  targetUrl: 'https://hooks.zapier.com/h/inbox/12345',
  cleanedRequest: {},
  subscribeData: {},
  ...overrides,
});

// ── app shape ────────────────────────────────────────────────────────────

test('app definition has version, authentication, triggers and creates', () => {
  assert.equal(typeof app.version, 'string');
  assert.equal(typeof app.platformVersion, 'string');
  assert.equal(app.authentication.type, 'custom');
  assert.ok(app.triggers.campaign_sent, 'campaign_sent trigger registered');
  assert.ok(app.triggers.subscriber_added, 'subscriber_added trigger registered');
  assert.ok(app.triggers.subscriber_unsubscribed, 'subscriber_unsubscribed trigger registered');
  assert.ok(app.triggers.approval_decided, 'approval_decided trigger registered');
  assert.ok(app.triggers.approval_requested, 'approval_requested trigger registered');
  assert.ok(app.triggers.bounce_received, 'bounce_received trigger registered');
  assert.ok(app.triggers.list_subscriber_added, 'list_subscriber_added trigger registered');
  assert.ok(app.triggers.list_lists, 'hidden list_lists trigger registered');
  assert.ok(app.triggers.list_draft_campaigns, 'hidden list_draft_campaigns trigger registered');
  assert.ok(app.triggers.list_sequences, 'hidden list_sequences trigger registered');
  assert.ok(app.creates.add_subscriber, 'add_subscriber create registered');
  assert.ok(app.creates.update_subscriber, 'update_subscriber create registered');
  assert.ok(app.creates.unsubscribe_subscriber, 'unsubscribe_subscriber create registered');
  assert.ok(app.creates.send_campaign, 'send_campaign create registered');
  assert.ok(app.creates.start_sequence, 'start_sequence create registered');
  assert.ok(app.creates.add_to_list, 'add_to_list create registered');
  assert.ok(app.creates.remove_from_list, 'remove_from_list create registered');
  assert.ok(app.searches, 'searches map registered');
  assert.ok(app.searches.find_subscriber, 'find_subscriber search registered');
});

test('beforeRequest attaches bearer token from authData', () => {
  const fn = app.beforeRequest[0];
  const req = { headers: {} };
  const out = fn(req, {}, { authData: { api_key: 'k123' } });
  assert.equal(out.headers['Authorization'], 'Bearer k123');
});

test('beforeRequest is a no-op when no api_key is set', () => {
  const fn = app.beforeRequest[0];
  const req = { headers: {} };
  const out = fn(req, {}, { authData: {} });
  assert.equal(out.headers['Authorization'], undefined);
});

test('beforeRequest rejects unsafe bearer token header values', () => {
  const fn = app.beforeRequest[0];
  const req = { headers: {} };
  const out = fn(req, {}, { authData: { api_key: 'k123\nX-Bad: yes' } });
  assert.equal(out.headers['Authorization'], undefined);
});

// ── authentication ───────────────────────────────────────────────────────

test('authentication.test calls /api/v1/auth/me and returns data', async () => {
  const { z, calls } = makeZ(() => ({
    status: 200,
    data: { tenant_slug: 'acme', user: { email: 'a@b.co' } },
  }));
  const out = await authentication.test(z, bundle());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.test.local/api/v1/auth/me');
  assert.equal(out.tenant_slug, 'acme');
});

test('authentication.test falls back to the default base URL when missing', async () => {
  const { z, calls } = makeZ(() => ({ data: { tenant_slug: 'acme' } }));
  await authentication.test(z, { authData: { api_key: 'k' } });
  assert.ok(calls[0].url.startsWith('https://api.moosewave.com/'));
});

test('authentication.test sanitizes unsafe or messy API base URLs', async () => {
  const { z, calls } = makeZ(() => ({ data: { tenant_slug: 'acme' } }));

  await authentication.test(
    z,
    bundle({ authData: { api_key: 'k', api_base_url: 'https://api.test.local///' } }),
  );
  await authentication.test(
    z,
    bundle({ authData: { api_key: 'k', api_base_url: 'https://u:p@evil.test' } }),
  );

  assert.equal(calls[0].url, 'https://api.test.local/api/v1/auth/me');
  assert.equal(calls[1].url, 'https://api.moosewave.com/api/v1/auth/me');
});

test('authentication.test rejects http and localhost API base URLs', async () => {
  const { z, calls } = makeZ(() => ({ data: { tenant_slug: 'acme' } }));

  await authentication.test(
    z,
    bundle({ authData: { api_key: 'k', api_base_url: 'http://api.test.local' } }),
  );
  await authentication.test(
    z,
    bundle({ authData: { api_key: 'k', api_base_url: 'https://localhost:8080' } }),
  );
  await authentication.test(
    z,
    bundle({ authData: { api_key: 'k', api_base_url: 'https://api.test.local\nbad' } }),
  );

  assert.equal(calls[0].url, 'https://api.moosewave.com/api/v1/auth/me');
  assert.equal(calls[1].url, 'https://api.moosewave.com/api/v1/auth/me');
  assert.equal(calls[2].url, 'https://api.moosewave.com/api/v1/auth/me');
});

test('authentication.test rejects private, link-local, and metadata API base URLs', async () => {
  const { z, calls } = makeZ(() => ({ data: { tenant_slug: 'acme' } }));

  for (const api_base_url of [
    'https://10.0.0.2',
    'https://172.16.0.10',
    'https://192.168.1.5',
    'https://169.254.169.254',
    'https://100.64.0.1',
    'https://[::1]',
    'https://[fc00::1]',
    'https://metadata.google.internal',
  ]) {
    await authentication.test(z, bundle({ authData: { api_key: 'k', api_base_url } }));
  }

  for (const call of calls) {
    assert.equal(call.url, 'https://api.moosewave.com/api/v1/auth/me');
  }
});

test('all Zapier operation URL builders sanitize unsafe or messy API base URLs', async () => {
  const { z, calls } = makeZ(() => ({
    data: { webhook: { id: 'owh_abc' }, lists: [], campaigns: [], items: [] },
  }));

  await app.triggers.list_lists.operation.perform(
    z,
    bundle({ authData: { api_key: 'k', api_base_url: 'https://api.test.local///' } }),
  );
  await addSubscriber.operation.perform(
    z,
    bundle({
      authData: { api_key: 'k', api_base_url: 'https://u:p@evil.test' },
      inputData: { email: 'a@b.co' },
    }),
  );
  await campaignSent.operation.performSubscribe(
    z,
    bundle({ authData: { api_key: 'k', api_base_url: 'https://evil.test?x=1' } }),
  );

  assert.equal(calls[0].url, 'https://api.test.local/api/v1/lists');
  assert.equal(calls[1].url, 'https://api.moosewave.com/api/v1/subscribers');
  assert.equal(calls[2].url, 'https://api.moosewave.com/api/v1/outbound-webhooks');
});

test('Zapier API URL builder rejects absolute and traversal request paths', () => {
  assert.equal(
    apiUrl('https://api.example.test/gateway', 'https://evil.example/api/v1/me'),
    'https://api.example.test/gateway/',
  );
  assert.equal(
    apiUrl('https://api.example.test/gateway', '/api/v1/%2e%2e/admin'),
    'https://api.example.test/gateway/',
  );
  assert.equal(
    apiUrl('https://api.example.test/gateway', '/api/v1/subscribers\nX-Test: x'),
    'https://api.example.test/gateway/',
  );
  assert.equal(
    apiUrl('https://api.example.test/gateway', '/api/v1/%252e%252e/admin'),
    'https://api.example.test/gateway/',
  );
  assert.equal(
    apiUrl('https://api.example.test/gateway', '/api/v1/subscribers\\admin'),
    'https://api.example.test/gateway/',
  );
});

// ── triggers: subscribe / unsubscribe / perform / performList ───────────

const triggerCases = [
  { name: 'campaign_sent', mod: campaignSent, event: 'campaign.sent' },
  { name: 'subscriber_added', mod: subscriberAdded, event: 'subscriber.added' },
  { name: 'subscriber_unsubscribed', mod: subscriberUnsubscribed, event: 'subscriber.unsubscribed' },
  { name: 'approval_decided', mod: approvalDecided, event: 'approval.decided' },
  { name: 'approval_requested', mod: approvalRequested, event: 'approval.requested' },
  { name: 'bounce_received', mod: bounceReceived, event: 'bounce.received' },
  { name: 'list_subscriber_added', mod: listSubscriberAdded, event: 'list.subscriber.added' },
];

for (const tc of triggerCases) {
  test(`${tc.name}: performSubscribe POSTs to /outbound-webhooks with the right event`, async () => {
    const { z, calls } = makeZ(() => ({
      status: 201,
      data: { webhook: { id: 'owh_abc', events: [tc.event] }, signing_secret: 'owhsec_x' },
    }));
    const out = await tc.mod.operation.performSubscribe(z, bundle());
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, 'https://api.test.local/api/v1/outbound-webhooks');
    assert.deepEqual(calls[0].body.events, [tc.event]);
    assert.equal(calls[0].body.url, 'https://hooks.zapier.com/h/inbox/12345');
    assert.equal(out.id, 'owh_abc');
  });

  test(`${tc.name}: performUnsubscribe DELETEs by id`, async () => {
    const { z, calls } = makeZ(() => ({ status: 200, data: { ok: true } }));
    await tc.mod.operation.performUnsubscribe(
      z,
      bundle({ subscribeData: { id: 'owh_abc' } }),
    );
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(
      calls[0].url,
      'https://api.test.local/api/v1/outbound-webhooks/owh_abc',
    );
  });

  test(`${tc.name}: perform preserves the canonical envelope and exposes stable event.id for Zapier dedupe`, () => {
    const payload = {
      event: {
        id: `evt-${tc.name}`,
        type: tc.event,
        occurred_at: '2026-07-23T00:00:00Z',
        data: { foo: 'bar' },
      },
      webhook: { id: 'owh_abc' },
      delivery: { id: `delivery-${tc.name}`, attempt: 1 },
    };
    const out = tc.mod.operation.perform(null, bundle({ cleanedRequest: payload }));
    assert.equal(out.length, 1);
    assert.equal(out[0].id, payload.event.id);
    assert.deepEqual(out[0].event, payload.event);
    assert.deepEqual(out[0].webhook, payload.webhook);
    assert.deepEqual(out[0].delivery, payload.delivery);
  });

  test(`${tc.name}: publishes a canonical sample object`, () => {
    assert.equal(typeof tc.mod.operation.sample, 'object');
    assert.equal(tc.mod.operation.sample.event.type, tc.event);
    assert.equal(tc.mod.operation.sample.id, tc.mod.operation.sample.event.id);
    assert.ok(tc.mod.operation.sample.webhook.id);
    assert.ok(tc.mod.operation.sample.delivery.id);
  });

  test(`${tc.name}: publishes nested canonical outputFields`, () => {
    assert.ok(Array.isArray(tc.mod.operation.outputFields));
    const keys = tc.mod.operation.outputFields.map((field) => field.key);
    assert.ok(keys.includes('event__id'));
    assert.ok(keys.includes('event__type'));
    assert.ok(keys.includes('delivery__id'));
  });
}

test('hook perform rejects legacy flat or incomplete payloads', () => {
  assert.throws(
    () =>
      campaignSent.operation.perform(
        null,
        bundle({ cleanedRequest: { event: 'campaign.sent', campaign: { id: 'cmp_1' } } }),
      ),
    /envelope is missing event/,
  );
});

test('approval_decided performList swallows 404 gracefully', async () => {
  const { z } = makeZ(() => ({ status: 404, data: { error: 'not found' } }));
  const out = await approvalDecided.operation.performList(z, bundle());
  assert.deepEqual(out, []);
});

test('bounce_received performList swallows 404 gracefully', async () => {
  const { z } = makeZ(() => ({ status: 404, data: {} }));
  const out = await bounceReceived.operation.performList(z, bundle());
  assert.deepEqual(out, []);
});

test('subscriber_unsubscribed performList swallows 404 gracefully', async () => {
  const { z } = makeZ(() => ({ status: 404, data: {} }));
  const out = await subscriberUnsubscribed.operation.performList(z, bundle());
  assert.deepEqual(out, []);
});

test('subscriber_unsubscribed performList wraps subscribers with the event name', async () => {
  const { z, calls } = makeZ(() => ({
    data: { subscribers: [{ id: 'sub_1', email: 'a@b.co', status: 'blocklisted' }] },
  }));
  const out = await subscriberUnsubscribed.operation.performList(z, bundle());
  // BUG-CATCHER (finding #4): the poller must filter on the `status` column
  // value the Unsubscribe action writes (blocklisted), NOT the separate
  // mailchimp_status 'unsubscribed' lifecycle value it diverged to before.
  assert.equal(calls[0].params.status, 'blocklisted');
  assert.equal(out[0].event.type, 'subscriber.unsubscribed');
  assert.equal(out[0].event.data.subscriber.id, 'sub_1');
  assert.equal(out[0].id, 'sample:subscriber.unsubscribed:sub_1');
});

test('approval_requested performList passes status=pending and swallows 404', async () => {
  const ok = makeZ(() => ({ data: { approvals: [{ id: 'apr_1' }] } }));
  const out = await approvalRequested.operation.performList(ok.z, bundle());
  assert.equal(ok.calls[0].params.status, 'pending');
  assert.equal(out[0].event.type, 'approval.requested');

  const missing = makeZ(() => ({ status: 404, data: {} }));
  assert.deepEqual(await approvalRequested.operation.performList(missing.z, bundle()), []);
});

test('list membership added trigger performList returns the static sample (no global feed)', () => {
  const out = listSubscriberAdded.operation.performList(null, bundle());
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 1);
  assert.equal(out[0], listSubscriberAdded.operation.sample);
});

// ── creates ──────────────────────────────────────────────────────────────

test('add_subscriber posts email + parsed tags', async () => {
  const { z, calls } = makeZ(() => ({
    status: 201,
    data: { id: 'sub_1', email: 'a@b.co', status: 'subscribed' },
  }));
  const out = await addSubscriber.operation.perform(
    z,
    bundle({
      inputData: {
        email: 'a@b.co',
        list_id: 'lst_1',
        tags: 'founder, vip',
        first_name: 'Ada',
        last_name: 'Lovelace',
      },
    }),
  );
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.test.local/api/v1/subscribers');
  assert.equal(calls[0].body.email, 'a@b.co');
  assert.deepEqual(calls[0].body.tags, ['founder', 'vip']);
  assert.deepEqual(calls[0].body.lists, ['lst_1']);
  assert.equal(out.id, 'sub_1');
});

test('add_subscriber validates email and deduplicates tags', async () => {
  const { z, calls } = makeZ(() => ({ data: { id: 'sub_3' } }));
  await assert.rejects(
    () => addSubscriber.operation.perform(z, bundle({ inputData: { email: 'not-email' } })),
    /valid email/,
  );
  await addSubscriber.operation.perform(
    z,
    bundle({ inputData: { email: 'ADA@B.CO', tags: 'vip, vip, founder' } }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.email, 'ada@b.co');
  assert.deepEqual(calls[0].body.tags, ['vip', 'founder']);
});

test('hidden dropdown helpers tolerate malformed envelopes', async () => {
  const { z } = makeZ(() => ({ data: { lists: { id: 'not-array' } } }));
  const out = await app.triggers.list_lists.operation.perform(z, bundle());
  assert.deepEqual(out, []);
});

test('add_subscriber accepts a tags array (Zapier line-item shape)', async () => {
  const { z, calls } = makeZ(() => ({ data: { id: 'sub_2' } }));
  await addSubscriber.operation.perform(
    z,
    bundle({ inputData: { email: 'a@b.co', tags: ['x', 'y'] } }),
  );
  assert.deepEqual(calls[0].body.tags, ['x', 'y']);
});

test('send_campaign POSTs to /campaigns/{id}/send', async () => {
  const { z, calls } = makeZ(() => ({
    data: { id: 'cmp_1', status: 'sending', queued_at: '2026-05-09T00:00:00Z' },
  }));
  const out = await sendCampaign.operation.perform(
    z,
    bundle({ inputData: { campaign_id: 'cmp_1' } }),
  );
  assert.equal(calls[0].method, 'POST');
  assert.equal(
    calls[0].url,
    'https://api.test.local/api/v1/campaigns/cmp_1/send',
  );
  assert.equal(out.status, 'sending');
});

test('send_campaign throws without a campaign_id', async () => {
  const { z } = makeZ(() => ({}));
  await assert.rejects(
    () => sendCampaign.operation.perform(z, bundle({ inputData: {} })),
    /campaign_id is required/,
  );
});

test('start_sequence POSTs to /sequences/{id}/subscribers with the email', async () => {
  const { z, calls } = makeZ(() => ({
    data: { subscriber_id: 'sub_1', started_at: '2026-05-09T00:00:00Z' },
  }));
  const out = await startSequence.operation.perform(
    z,
    bundle({ inputData: { sequence_id: 'seq_1', subscriber_email: 'a@b.co' } }),
  );
  assert.equal(calls[0].method, 'POST');
  assert.equal(
    calls[0].url,
    'https://api.test.local/api/v1/sequences/seq_1/subscribers',
  );
  assert.deepEqual(calls[0].body, { email: 'a@b.co' });
  assert.equal(out.success, true);
  assert.equal(out.enrolled.subscriber_id, 'sub_1');
  assert.equal(out.enrolled.sequence_id, 'seq_1');
});

test('start_sequence throws when sequence_id is missing', async () => {
  const { z } = makeZ(() => ({}));
  await assert.rejects(
    () =>
      startSequence.operation.perform(
        z,
        bundle({ inputData: { subscriber_email: 'a@b.co' } }),
      ),
    /sequence_id is required/,
  );
});

test('start_sequence throws when subscriber_email is missing', async () => {
  const { z } = makeZ(() => ({}));
  await assert.rejects(
    () =>
      startSequence.operation.perform(
        z,
        bundle({ inputData: { sequence_id: 'seq_1' } }),
      ),
    /subscriber_email is required/,
  );
});

// ── creates: update_subscriber ─────────────────────────────────────────────

test('update_subscriber resolves an email (exact email: lookup) then PATCHes /subscribers/{id}', async () => {
  const { z, calls } = makeZ((opts) => {
    if (opts.method === 'PATCH') {
      return { data: { id: 'sub_1', email: 'a@b.co', status: 'enabled' } };
    }
    if (String(opts.url).endsWith('/sub_1')) {
      // GET current tags for the merge.
      return { data: { id: 'sub_1', tags: ['existing'] } };
    }
    // The email→id lookup (search endpoint).
    return { data: { items: [{ id: 'sub_1', email: 'a@b.co' }] } };
  });
  const out = await updateSubscriber.operation.perform(
    z,
    bundle({
      inputData: { email: 'A@B.CO', status: 'enabled', tags: 'vip, vip, founder' },
    }),
  );
  assert.equal(calls[0].url, 'https://api.test.local/api/v1/subscribers/search');
  assert.equal(calls[0].params.q, 'email:a@b.co');
  // GET to read existing tags before the merge
  assert.equal(calls[1].url, 'https://api.test.local/api/v1/subscribers/sub_1');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.url, 'https://api.test.local/api/v1/subscribers/sub_1');
  assert.equal(patch.body.status, 'enabled');
  // BUG-CATCHER (finding #1): tags MERGE with existing, not replace.
  assert.deepEqual(patch.body.tags, ['existing', 'vip', 'founder']);
  assert.equal(out.id, 'sub_1');
});

test('update_subscriber MERGES tags by default (does not drop existing tags)', async () => {
  // BUG-CATCHER (finding #1): the old code did body.tags = normalizeTags(input)
  // which REPLACED everything. Merge must preserve prior tags.
  const { z, calls } = makeZ((opts) => {
    if (opts.method === 'PATCH') return { data: { id: 'sub_9' } };
    return { data: { id: 'sub_9', tags: ['founder', 'early-access'] } };
  });
  await updateSubscriber.operation.perform(
    z,
    bundle({ inputData: { subscriber_id: 'sub_9', tags: 'vip, founder' } }),
  );
  // GET (read tags) then PATCH (union).
  assert.equal(calls[0].method, undefined); // GET has no method set
  assert.equal(calls[0].url, 'https://api.test.local/api/v1/subscribers/sub_9');
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.deepEqual(patch.body.tags, ['founder', 'early-access', 'vip']);
});

test('update_subscriber replace mode overwrites tags and skips the GET', async () => {
  const { z, calls } = makeZ(() => ({ data: { id: 'sub_9' } }));
  await updateSubscriber.operation.perform(
    z,
    bundle({ inputData: { subscriber_id: 'sub_9', tags: 'only-this', tag_mode: 'replace' } }),
  );
  // No GET — replace does not need to read existing tags.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body.tags, ['only-this']);
});

test('update_subscriber sends empty first_name/last_name to CLEAR them', async () => {
  // BUG-CATCHER (finding #1, part 2): the old code used optionalString which
  // turned "" into undefined, so a clear was impossible. A present-but-empty
  // key must be sent so the backend pointer field clears the column.
  const { z, calls } = makeZ(() => ({ data: { id: 'sub_9' } }));
  await updateSubscriber.operation.perform(
    z,
    bundle({ inputData: { subscriber_id: 'sub_9', first_name: '', last_name: '  ' } }),
  );
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.body.first_name, '');
  assert.equal(patch.body.last_name, '');
});

test('update_subscriber leaves names untouched when the keys are absent', async () => {
  const { z, calls } = makeZ(() => ({ data: { id: 'sub_9' } }));
  await updateSubscriber.operation.perform(
    z,
    bundle({ inputData: { subscriber_id: 'sub_9', status: 'enabled' } }),
  );
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal('first_name' in patch.body, false);
  assert.equal('last_name' in patch.body, false);
  assert.equal('tags' in patch.body, false);
});

test('update_subscriber refuses to merge when it cannot read current tags', async () => {
  // BUG-CATCHER: if the GET to read existing tags fails, we must NOT silently
  // proceed with only the new tags (that would drop the existing ones).
  const { z } = makeZ((opts) => {
    if (opts.method === 'PATCH') return { data: { id: 'sub_9' } };
    return { status: 500, data: {} };
  });
  await assert.rejects(
    () =>
      updateSubscriber.operation.perform(
        z,
        bundle({ inputData: { subscriber_id: 'sub_9', tags: 'vip' } }),
      ),
    /HTTP 500/,
  );
});

test('update_subscriber accepts a direct subscriber_id without a lookup', async () => {
  const { z, calls } = makeZ(() => ({ data: { id: 'sub_9', status: 'disabled' } }));
  await updateSubscriber.operation.perform(
    z,
    bundle({ inputData: { subscriber_id: 'sub_9', status: 'disabled', new_email: 'NEW@B.CO' } }),
  );
  // Only one call: straight to PATCH, no email lookup, no tags GET.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, 'https://api.test.local/api/v1/subscribers/sub_9');
  assert.equal(calls[0].body.email, 'new@b.co');
});

test('update_subscriber throws without an email or id', async () => {
  const { z } = makeZ(() => ({}));
  await assert.rejects(
    () => updateSubscriber.operation.perform(z, bundle({ inputData: {} })),
    /subscriber id or an email/,
  );
});

test('update_subscriber throws when the email resolves to nobody', async () => {
  const { z } = makeZ(() => ({ data: { items: [] } }));
  await assert.rejects(
    () => updateSubscriber.operation.perform(z, bundle({ inputData: { email: 'ghost@b.co' } })),
    /No Moosewave subscriber found/,
  );
});

test('update_subscriber PROPAGATES a resolver 5xx (finding #3) instead of "not found"', async () => {
  const { z } = makeZ(() => ({ status: 503, data: {} }));
  await assert.rejects(
    () => updateSubscriber.operation.perform(z, bundle({ inputData: { email: 'a@b.co' } })),
    /HTTP 503/,
  );
});

// ── creates: unsubscribe_subscriber ────────────────────────────────────────

test('unsubscribe_subscriber resolves email then PATCHes status=blocklisted', async () => {
  const { z, calls } = makeZ((opts) => {
    if (opts.method === 'PATCH') return { data: { id: 'sub_1', status: 'blocklisted' } };
    return { data: { subscribers: [{ id: 'sub_1', email: 'a@b.co' }] } };
  });
  const out = await unsubscribeSubscriber.operation.perform(
    z,
    bundle({ inputData: { email: 'a@b.co' } }),
  );
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url, 'https://api.test.local/api/v1/subscribers/sub_1');
  assert.deepEqual(calls[1].body, { status: 'blocklisted' });
  assert.equal(out.status, 'blocklisted');
});

test('unsubscribe_subscriber rejects a malformed email before any request', async () => {
  const { z, calls } = makeZ(() => ({}));
  await assert.rejects(
    () => unsubscribeSubscriber.operation.perform(z, bundle({ inputData: { email: 'not-email' } })),
    /valid email/,
  );
  assert.equal(calls.length, 0);
});

// ── creates: add_to_list / remove_from_list ────────────────────────────────

test('add_to_list resolves email then POSTs subscriber_ids to the list', async () => {
  const { z, calls } = makeZ((opts) => {
    if (opts.method === 'POST') return { data: { added: 1, skipped: 0 } };
    return { data: { subscribers: [{ id: 'sub_1', email: 'a@b.co' }] } };
  });
  const out = await addToList.operation.perform(
    z,
    bundle({ inputData: { list_id: 'lst_1', subscriber_email: 'a@b.co' } }),
  );
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].url, 'https://api.test.local/api/v1/lists/lst_1/subscribers');
  assert.deepEqual(calls[1].body, { subscriber_ids: ['sub_1'] });
  assert.equal(out.added, 1);
  assert.equal(out.subscriber_id, 'sub_1');
});

test('add_to_list throws without a list_id', async () => {
  const { z } = makeZ(() => ({}));
  await assert.rejects(
    () => addToList.operation.perform(z, bundle({ inputData: { subscriber_email: 'a@b.co' } })),
    /list_id is required/,
  );
});

test('remove_from_list resolves email then DELETEs by list + subscriber id', async () => {
  const { z, calls } = makeZ((opts) => {
    if (opts.method === 'DELETE') return { status: 204, data: {} };
    return { data: { subscribers: [{ id: 'sub_1', email: 'a@b.co' }] } };
  });
  const out = await removeFromList.operation.perform(
    z,
    bundle({ inputData: { list_id: 'lst_1', subscriber_email: 'a@b.co' } }),
  );
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(
    calls[1].url,
    'https://api.test.local/api/v1/lists/lst_1/subscribers/sub_1',
  );
  assert.equal(out.success, true);
  assert.equal(out.subscriber_id, 'sub_1');
});

// ── hidden dropdown triggers ─────────────────────────────────────────────

test('list_lists hidden trigger normalizes API response to [{id,name}]', async () => {
  const { z, calls } = makeZ(() => ({
    data: { lists: [{ id: 'lst_1', name: 'Newsletter' }, { id: 'lst_2', name: 'Beta' }] },
  }));
  const out = await app.triggers.list_lists.operation.perform(z, bundle());
  assert.equal(calls[0].url, 'https://api.test.local/api/v1/lists');
  assert.deepEqual(out, [
    { id: 'lst_1', name: 'Newsletter' },
    { id: 'lst_2', name: 'Beta' },
  ]);
});

test('list_draft_campaigns passes status=draft', async () => {
  const { z, calls } = makeZ(() => ({
    data: { campaigns: [{ id: 'cmp_1', name: 'May newsletter' }] },
  }));
  const out = await app.triggers.list_draft_campaigns.operation.perform(z, bundle());
  assert.equal(calls[0].params.status, 'draft');
  assert.deepEqual(out, [{ id: 'cmp_1', name: 'May newsletter' }]);
});

test('list_sequences returns an empty list when the API 404s', async () => {
  const { z } = makeZ(() => ({ status: 404, data: {} }));
  const out = await app.triggers.list_sequences.operation.perform(z, bundle());
  assert.deepEqual(out, []);
});

// ── searches: find_subscriber ────────────────────────────────────────────

test('find_subscriber has search shape: key, noun, perform, inputFields, sample', () => {
  assert.equal(findSubscriber.key, 'find_subscriber');
  assert.equal(findSubscriber.noun, 'Subscriber');
  assert.equal(typeof findSubscriber.operation.perform, 'function');
  assert.ok(Array.isArray(findSubscriber.operation.inputFields));
  assert.ok(findSubscriber.operation.inputFields.length > 0);
  assert.equal(typeof findSubscriber.operation.sample, 'object');
  assert.ok(findSubscriber.operation.sample);
});

test('find_subscriber searches via the exact email: operator and returns the match', async () => {
  const { z, calls } = makeZ(() => ({
    data: {
      // The server returns more than the exact row (email: is a contains
      // predicate); the search must filter down to the EXACT address so a
      // find-or-create Zap never enrols the wrong person.
      items: [
        { id: 'sub_1', email: 'ada@b.co', status: 'subscribed' },
        { id: 'sub_2', email: 'ada+work@b.co', status: 'subscribed' },
      ],
    },
  }));
  const out = await findSubscriber.operation.perform(
    z,
    bundle({ inputData: { email: 'ADA@B.CO' } }),
  );
  // exact lookup hits the structured search endpoint with the email: operator
  assert.equal(calls[0].url, 'https://api.test.local/api/v1/subscribers/search');
  assert.equal(calls[0].params.q, 'email:ada@b.co');
  // only the exact email match is returned (not the contains extras)
  assert.deepEqual(out, [{ id: 'sub_1', email: 'ada@b.co', status: 'subscribed' }]);
});

test('find_subscriber returns [] when a clean 200 has no exact email match', async () => {
  // BUG-CATCHER: a fuzzy substring match (ada+alias) must NOT be treated as a
  // hit for ada@b.co — otherwise find-or-create updates the wrong subscriber.
  const { z, calls } = makeZ(() => ({
    data: { items: [{ id: 'sub_9', email: 'ada+alias@b.co', status: 'subscribed' }] },
  }));
  const out = await findSubscriber.operation.perform(
    z,
    bundle({ inputData: { email: 'ada@b.co' } }),
  );
  assert.equal(calls[0].params.q, 'email:ada@b.co');
  assert.deepEqual(out, []);
});

test('find_subscriber falls back to the query field when no email is given', async () => {
  const { z, calls } = makeZ(() => ({
    data: { items: [{ id: 'sub_3', email: 'grace@b.co' }] },
  }));
  const out = await findSubscriber.operation.perform(
    z,
    bundle({ inputData: { query: 'grace' } }),
  );
  assert.equal(calls[0].url, 'https://api.test.local/api/v1/subscribers/search');
  assert.equal(calls[0].params.q, 'grace');
  // a non-email query does not get exact-match filtered
  assert.deepEqual(out, [{ id: 'sub_3', email: 'grace@b.co' }]);
});

test('find_subscriber throws when neither email nor query is provided', async () => {
  const { z } = makeZ(() => ({}));
  await assert.rejects(
    () => findSubscriber.operation.perform(z, bundle({ inputData: {} })),
    /email or a search query/,
  );
});

test('find_subscriber PROPAGATES a 5xx instead of masking it as no-match', async () => {
  // BUG-CATCHER (finding #3): a server error must throw, not return [] —
  // otherwise find-or-create silently creates a duplicate on a transient blip.
  const { z } = makeZ(() => ({ status: 500, data: { error: 'boom' } }));
  await assert.rejects(
    () => findSubscriber.operation.perform(z, bundle({ inputData: { email: 'ada@b.co' } })),
    /HTTP 500/,
  );
});

test('find_subscriber PROPAGATES a 429 rate-limit instead of masking it', async () => {
  const { z } = makeZ(() => ({ status: 429, data: {} }));
  await assert.rejects(
    () => findSubscriber.operation.perform(z, bundle({ inputData: { email: 'ada@b.co' } })),
    /HTTP 429/,
  );
});

test('find_subscriber PROPAGATES a 401 on the free-text path too', async () => {
  const { z } = makeZ(() => ({ status: 401, data: {} }));
  await assert.rejects(
    () => findSubscriber.operation.perform(z, bundle({ inputData: { query: 'grace' } })),
    /HTTP 401/,
  );
});

test('find_subscriber tolerates a malformed envelope on the free-text path', async () => {
  const { z } = makeZ(() => ({ data: { items: { id: 'not-array' } } }));
  const out = await findSubscriber.operation.perform(
    z,
    bundle({ inputData: { query: 'x' } }),
  );
  assert.deepEqual(out, []);
});

test('find_subscriber sanitizes unsafe API base URLs like other operations', async () => {
  const { z, calls } = makeZ(() => ({ data: { items: [] } }));
  await findSubscriber.operation.perform(
    z,
    bundle({
      authData: { api_key: 'k', api_base_url: 'https://u:p@evil.test' },
      inputData: { email: 'a@b.co' },
    }),
  );
  assert.equal(calls[0].url, 'https://api.moosewave.com/api/v1/subscribers/search');
});
