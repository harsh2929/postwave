// REST-Hook subscription for `subscriber.unsubscribed` events.
// Mirrors the structure of subscriber-added.js — see campaign-sent.js for the
// outbound-webhooks subscribe/unsubscribe rationale.
//
// This is the tenant-wide unsubscribe fanout (one-click RFC 8058, admin
// unsubscribe, status→blocklisted) — distinct from list-membership changes.

const { apiUrlForBundle } = require('../lib/api-url');
const {
  envelopeItems,
  outboundEnvelope,
  outboundEnvelopeFields,
  responseData,
  zapierWebhookItem,
} = require('../lib/fields');

const subscribeHook = async (z, bundle) => {
  const response = await z.request({
    method: 'POST',
    url: apiUrlForBundle(bundle, '/api/v1/outbound-webhooks'),
    body: {
      url: bundle.targetUrl,
      description: 'Zapier — subscriber unsubscribed',
      events: ['subscriber.unsubscribed'],
    },
  });
  const data = responseData(response);
  const id = (data.webhook && data.webhook.id) || data.id;
  return { id };
};

const unsubscribeHook = async (z, bundle) => {
  const id = bundle.subscribeData && bundle.subscribeData.id;
  if (!id) return {};
  const response = await z.request({
    method: 'DELETE',
    url: apiUrlForBundle(bundle, `/api/v1/outbound-webhooks/${encodeURIComponent(id)}`),
  });
  return responseData(response);
};

const performHook = (z, bundle) => [zapierWebhookItem(bundle.cleanedRequest)];

const performList = async (z, bundle) => {
  const response = await z.request({
    url: apiUrlForBundle(bundle, '/api/v1/subscribers'),
    // Filter on the `status` column value the Unsubscribe action writes
    // (status=blocklisted — see creates/unsubscribe-subscriber.js
    // UNSUBSCRIBE_STATUS and apps/api/internal/subscribers/repo_helpers.go
    // statusFilterClause). The prior 'unsubscribed' value mapped to the
    // SEPARATE mailchimp_status column (the marketing lifecycle state), so a
    // contact unsubscribed via the action never surfaced in the polling
    // fallback — the trigger and the action had diverged.
    params: { per_page: 5, status: 'blocklisted', sort: 'updated_at', order: 'desc' },
    skipThrowForStatus: true,
  });
  if (response.status === 404 || response.status >= 400) return [];
  const data = responseData(response);
  const items = envelopeItems(data, ['subscribers', 'items']);
  return items.map((s) =>
    outboundEnvelope(
      'subscriber.unsubscribed',
      { subscriber: s },
      { sourceId: s.id, occurredAt: s.updated_at },
    ),
  );
};

module.exports = {
  key: 'subscriber_unsubscribed',
  noun: 'Subscriber',
  display: {
    label: 'Subscriber Unsubscribed',
    description: 'Fires when a subscriber opts out of all marketing (global unsubscribe).',
    directions:
      'Moosewave will POST to Zapier whenever someone unsubscribes workspace-wide ' +
      '— one-click unsubscribe, admin action, or status change. Clean up your CRM, ' +
      'pause sequences, or alert ops.',
  },
  operation: {
    type: 'hook',
    performSubscribe: subscribeHook,
    performUnsubscribe: unsubscribeHook,
    perform: performHook,
    performList,
    sample: outboundEnvelope('subscriber.unsubscribed', {
      subscriber: {
        id: 'sub_01HFAKE',
        email: 'ada@example.com',
        status: 'blocklisted',
        updated_at: '2026-05-09T12:00:00Z',
      },
    }),
    outputFields: outboundEnvelopeFields([
      { key: 'subscriber__id', label: 'Subscriber ID', type: 'string' },
      { key: 'subscriber__email', label: 'Email', type: 'string' },
      { key: 'subscriber__status', label: 'Status', type: 'string' },
      { key: 'subscriber__updated_at', label: 'Updated At', type: 'datetime' },
    ]),
  },
};
