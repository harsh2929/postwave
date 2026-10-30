// REST-Hook subscription for `list.subscriber.added` events.
// Mirrors the structure of subscriber-added.js.
//
// list.subscriber.* events carry { list_id, subscriber_id, email, … } in the
// payload (apps/api/internal/outbound_webhooks/outbound_webhooks.go) and are
// scoped per-list by the dispatcher. Distinct from the workspace-wide
// subscriber.added event.

const { apiUrlForBundle } = require('../lib/api-url');
const {
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
      description: 'Zapier — list subscriber added',
      events: ['list.subscriber.added'],
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

// There is no workspace-wide "recent list memberships" feed (membership lives
// in the gateway-owned list_subscribers join table, read per-list). The hook
// payload is the real source of truth; performList only powers Zapier's
// "test trigger" sample, so we return the static sample rather than
// fabricating a query that needs a list id we don't have here.
const performList = (z, bundle) => [module.exports.operation.sample];

module.exports = {
  key: 'list_subscriber_added',
  noun: 'List Membership',
  display: {
    label: 'Subscriber Added To List',
    description: 'Fires when a subscriber is added to a specific list.',
    directions:
      'Moosewave will POST to Zapier whenever a subscriber joins a list — via the ' +
      'Add To List action, an import, or the dashboard. Use it to mirror list ' +
      'membership into a CRM or kick off a list-specific welcome flow.',
  },
  operation: {
    type: 'hook',
    performSubscribe: subscribeHook,
    performUnsubscribe: unsubscribeHook,
    perform: performHook,
    performList,
    sample: outboundEnvelope('list.subscriber.added', {
      list_id: 'lst_01HFAKE',
      subscriber_id: 'sub_01HFAKE',
      email: 'ada@example.com',
      occurred_at: '2026-05-09T12:00:00Z',
    }),
    outputFields: outboundEnvelopeFields([
      { key: 'list_id', label: 'List ID', type: 'string' },
      { key: 'subscriber_id', label: 'Subscriber ID', type: 'string' },
      { key: 'email', label: 'Email', type: 'string' },
      { key: 'occurred_at', label: 'Occurred At', type: 'datetime' },
    ]),
  },
};
