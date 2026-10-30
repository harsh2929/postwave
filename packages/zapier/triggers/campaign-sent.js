// Zapier REST-Hook subscription for `campaign.sent` events.
//
// Subscribe/unsubscribe go through Moosewave's outbound-webhooks API
// (apps/api/internal/outbound_webhooks). `perform` preserves Moosewave's
// canonical event/webhook/delivery envelope and only mirrors event.id to the
// root because Zapier uses a root id for trigger deduplication.

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
      description: 'Zapier — campaign sent',
      events: ['campaign.sent'],
    },
  });
  const data = responseData(response);
  // The Moosewave create response is { webhook: {...}, signing_secret }.
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
    url: apiUrlForBundle(bundle, '/api/v1/campaigns'),
    params: { limit: 5, status: 'sent' },
  });
  const data = responseData(response);
  const items = envelopeItems(data, ['campaigns', 'items']);
  return items.map((c) =>
    outboundEnvelope(
      'campaign.sent',
      { campaign: c },
      { sourceId: c.id, occurredAt: c.sent_at || c.updated_at },
    ),
  );
};

module.exports = {
  key: 'campaign_sent',
  noun: 'Campaign',
  display: {
    label: 'Campaign Sent',
    description: 'Fires when a campaign finishes sending.',
    directions:
      'Moosewave will POST to Zapier each time a campaign moves to status=sent. ' +
      'Connect your Moosewave account, pick this trigger, and Zapier handles the rest.',
  },
  operation: {
    type: 'hook',
    performSubscribe: subscribeHook,
    performUnsubscribe: unsubscribeHook,
    perform: performHook,
    performList,
    sample: outboundEnvelope('campaign.sent', {
      campaign: {
        id: 'cmp_01HFAKE',
        name: 'May newsletter',
        subject: 'What we shipped in May',
        recipient_count: 12453,
        sent_at: '2026-05-09T12:00:00Z',
        open_rate: 0.42,
        click_rate: 0.08,
      },
    }),
    outputFields: outboundEnvelopeFields([
      { key: 'campaign__id', label: 'Campaign ID', type: 'string' },
      { key: 'campaign__name', label: 'Campaign Name', type: 'string' },
      { key: 'campaign__subject', label: 'Campaign Subject', type: 'string' },
      { key: 'campaign__recipient_count', label: 'Recipient Count', type: 'integer' },
      { key: 'campaign__sent_at', label: 'Sent At', type: 'datetime' },
      { key: 'campaign__open_rate', label: 'Open Rate', type: 'number' },
      { key: 'campaign__click_rate', label: 'Click Rate', type: 'number' },
    ]),
  },
};
