// REST-Hook subscription for `bounce.received` events.

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
      description: 'Zapier — bounce received',
      events: ['bounce.received'],
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
    url: apiUrlForBundle(bundle, '/api/v1/deliverability/suppressions'),
    params: { limit: 5, reason: 'hard_bounce' },
    skipThrowForStatus: true,
  });
  if (response.status === 404) {
    return [];
  }
  if (response.status >= 400) {
    throw new Error(`Moosewave deliverability API error ${response.status}`);
  }
  const data = responseData(response);
  const items = envelopeItems(data, ['suppressions', 'items']);
  return items.map((s) => {
    const receivedAt = s.received_at || s.created_at;
    return outboundEnvelope(
      'bounce.received',
      {
        subscriber_email: s.email || s.subscriber_email,
        campaign_id: s.campaign_id || null,
        bounce_reason: s.reason || s.bounce_reason || 'hard_bounce',
        severity: s.severity || 'hard',
        received_at: receivedAt,
      },
      {
        sourceId: s.id || `${s.email}-${s.created_at || ''}`,
        occurredAt: receivedAt,
      },
    );
  });
};

module.exports = {
  key: 'bounce_received',
  noun: 'Bounce',
  display: {
    label: 'Bounce Received',
    description: 'Fires when a hard bounce is recorded for any send.',
    directions:
      'Trigger a Zap whenever a hard bounce hits suppression — clean up your CRM, ' +
      'alert ops, or pause sequences automatically.',
  },
  operation: {
    type: 'hook',
    performSubscribe: subscribeHook,
    performUnsubscribe: unsubscribeHook,
    perform: performHook,
    performList,
    sample: outboundEnvelope('bounce.received', {
      subscriber_email: 'ada@example.com',
      campaign_id: 'cmp_01HFAKE',
      bounce_reason: 'mailbox_does_not_exist',
      severity: 'hard',
      received_at: '2026-05-09T12:00:00Z',
    }),
    outputFields: outboundEnvelopeFields([
      { key: 'subscriber_email', label: 'Subscriber Email', type: 'string' },
      { key: 'campaign_id', label: 'Campaign ID', type: 'string' },
      { key: 'bounce_reason', label: 'Bounce Reason', type: 'string' },
      { key: 'severity', label: 'Severity', type: 'string' },
      { key: 'received_at', label: 'Received At', type: 'datetime' },
    ]),
  },
};
