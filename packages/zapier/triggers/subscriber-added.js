// REST-Hook subscription for `subscriber.added` events.
// Mirrors the structure of campaign-sent.js — see that file for rationale.

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
      description: 'Zapier — subscriber added',
      events: ['subscriber.added'],
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
    params: { limit: 5, sort: 'created_at:desc' },
  });
  const data = responseData(response);
  const items = envelopeItems(data, ['subscribers', 'items']);
  return items.map((s) =>
    outboundEnvelope(
      'subscriber.added',
      { subscriber: s },
      { sourceId: s.id, occurredAt: s.created_at },
    ),
  );
};

module.exports = {
  key: 'subscriber_added',
  noun: 'Subscriber',
  display: {
    label: 'Subscriber Added',
    description: 'Fires when a new subscriber is added to the workspace.',
    directions:
      'Moosewave will POST to Zapier whenever any subscriber lands — via signup form, ' +
      'API, CSV import, or list-add. Connect Moosewave and pick this trigger.',
  },
  operation: {
    type: 'hook',
    performSubscribe: subscribeHook,
    performUnsubscribe: unsubscribeHook,
    perform: performHook,
    performList,
    sample: outboundEnvelope('subscriber.added', {
      subscriber: {
        id: 'sub_01HFAKE',
        email: 'ada@example.com',
        status: 'subscribed',
        tags: ['founder', 'early-access'],
        lists: ['lst_newsletter'],
        created_at: '2026-05-09T12:00:00Z',
      },
    }),
    outputFields: outboundEnvelopeFields([
      { key: 'subscriber__id', label: 'Subscriber ID', type: 'string' },
      { key: 'subscriber__email', label: 'Email', type: 'string' },
      { key: 'subscriber__status', label: 'Status', type: 'string' },
      { key: 'subscriber__tags', label: 'Tags', type: 'string' },
      { key: 'subscriber__lists', label: 'Lists', type: 'string' },
      { key: 'subscriber__created_at', label: 'Created At', type: 'datetime' },
    ]),
  },
};
