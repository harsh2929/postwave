// REST-Hook subscription for `approval.decided` events.

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
      description: 'Zapier — approval decided',
      events: ['approval.decided'],
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
    params: { limit: 5, status: 'decided' },
  });
  const data = responseData(response);
  const items = envelopeItems(data, ['approvals', 'items']);
  return items.map((a) =>
    outboundEnvelope(
      'approval.decided',
      { approval: a },
      { sourceId: a.id, occurredAt: a.decided_at || a.updated_at },
    ),
  );
};

module.exports = {
  key: 'approval_decided',
  noun: 'Approval',
  display: {
    label: 'Approval Decided',
    description: 'Fires when a Moosewave approval is approved or rejected.',
    directions:
      'Subscribe to know the moment a gated campaign or sequence is approved/rejected. ' +
      'Useful for Slack notifications, audit logs, or kicking off downstream automation.',
  },
  operation: {
    type: 'hook',
    performSubscribe: subscribeHook,
    performUnsubscribe: unsubscribeHook,
    perform: performHook,
    performList,
    sample: outboundEnvelope('approval.decided', {
      approval: {
        id: 'apr_01HFAKE',
        resource_type: 'campaign',
        resource_id: 'cmp_01HFAKE',
        decision: 'approved',
        decided_by: 'usr_01HFAKE',
        decided_at: '2026-05-09T12:00:00Z',
      },
    }),
    outputFields: outboundEnvelopeFields([
      { key: 'approval__id', label: 'Approval ID', type: 'string' },
      { key: 'approval__resource_type', label: 'Resource Type', type: 'string' },
      { key: 'approval__resource_id', label: 'Resource ID', type: 'string' },
      { key: 'approval__decision', label: 'Decision', type: 'string' },
      { key: 'approval__decided_by', label: 'Decided By', type: 'string' },
      { key: 'approval__decided_at', label: 'Decided At', type: 'datetime' },
    ]),
  },
};
