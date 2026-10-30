// REST-Hook subscription for `approval.requested` events.
// Mirrors the structure of approval-decided.js.

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
      description: 'Zapier — approval requested',
      events: ['approval.requested'],
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
    url: apiUrlForBundle(bundle, '/api/v1/approvals'),
    params: { limit: 5, status: 'pending' },
    skipThrowForStatus: true,
  });
  if (response.status === 404 || response.status >= 400) return [];
  const data = responseData(response);
  const items = envelopeItems(data, ['approvals', 'items']);
  return items.map((a) =>
    outboundEnvelope(
      'approval.requested',
      { approval: a },
      { sourceId: a.id, occurredAt: a.requested_at || a.created_at },
    ),
  );
};

module.exports = {
  key: 'approval_requested',
  noun: 'Approval',
  display: {
    label: 'Approval Requested',
    description: 'Fires when a campaign or sequence is submitted for approval.',
    directions:
      'Subscribe to know the moment a gated campaign or sequence needs a decision. ' +
      'Route the request to Slack, a ticketing system, or an on-call rotation.',
  },
  operation: {
    type: 'hook',
    performSubscribe: subscribeHook,
    performUnsubscribe: unsubscribeHook,
    perform: performHook,
    performList,
    sample: outboundEnvelope('approval.requested', {
      approval: {
        id: 'apr_01HFAKE',
        resource_type: 'campaign',
        resource_id: 'cmp_01HFAKE',
        status: 'pending',
        requested_by: 'usr_01HFAKE',
        requested_at: '2026-05-09T12:00:00Z',
      },
    }),
    outputFields: outboundEnvelopeFields([
      { key: 'approval__id', label: 'Approval ID', type: 'string' },
      { key: 'approval__resource_type', label: 'Resource Type', type: 'string' },
      { key: 'approval__resource_id', label: 'Resource ID', type: 'string' },
      { key: 'approval__status', label: 'Status', type: 'string' },
      { key: 'approval__requested_by', label: 'Requested By', type: 'string' },
      { key: 'approval__requested_at', label: 'Requested At', type: 'datetime' },
    ]),
  },
};
