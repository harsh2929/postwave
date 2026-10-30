const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function responseData(response) {
  return (response && (response.data || response.json)) || {};
}

function envelopeItems(data, keys) {
  for (const key of keys) {
    if (Array.isArray(data && data[key])) return data[key];
  }
  return [];
}

function requiredString(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function optionalString(value) {
  const normalized = String(value || '').trim();
  return normalized || undefined;
}

function requiredEmail(value, label = 'email') {
  const email = requiredString(value, label).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error(`${label} must be a valid email address`);
  return email;
}

function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const tag = String(item || '').trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function outboundEnvelope(eventType, data, options = {}) {
  const eventId = requiredString(
    options.eventId || `sample:${eventType}:${options.sourceId || 'fixture'}`,
    'event id',
  );
  const occurredAt =
    optionalString(options.occurredAt) ||
    optionalString(data && (data.occurred_at || data.created_at || data.updated_at)) ||
    '2026-05-09T12:00:00Z';
  return {
    // Zapier requires a root id for deduplication. Canonical Moosewave payload
    // fields remain nested and unmodified below.
    id: eventId,
    event: {
      id: eventId,
      type: requiredString(eventType, 'event type'),
      occurred_at: occurredAt,
      data: data && typeof data === 'object' && !Array.isArray(data) ? data : {},
    },
    webhook: {
      id: optionalString(options.webhookId) || 'zapier-sample-webhook',
    },
    delivery: {
      id: optionalString(options.deliveryId) || `sample-delivery:${eventId}`,
      attempt: 1,
    },
  };
}

function zapierWebhookItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Moosewave webhook body must be an object');
  }
  const event = value.event;
  const webhook = value.webhook;
  const delivery = value.delivery;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('Moosewave webhook envelope is missing event');
  }
  requiredString(event.id, 'event.id');
  requiredString(event.type, 'event.type');
  requiredString(event.occurred_at, 'event.occurred_at');
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
    throw new Error('Moosewave webhook envelope is missing event.data');
  }
  if (!webhook || typeof webhook !== 'object' || Array.isArray(webhook)) {
    throw new Error('Moosewave webhook envelope is missing webhook');
  }
  requiredString(webhook.id, 'webhook.id');
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
    throw new Error('Moosewave webhook envelope is missing delivery');
  }
  requiredString(delivery.id, 'delivery.id');
  if (!Number.isInteger(delivery.attempt) || delivery.attempt < 1) {
    throw new Error('Moosewave webhook envelope has an invalid delivery.attempt');
  }
  return { ...value, id: event.id };
}

function outboundEnvelopeFields(dataFields) {
  return [
    { key: 'event__id', label: 'Stable Event ID', type: 'string' },
    { key: 'event__type', label: 'Event Type', type: 'string' },
    { key: 'event__occurred_at', label: 'Occurred At', type: 'datetime' },
    ...dataFields.map((field) => ({
      ...field,
      key: `event__data__${field.key}`,
    })),
    { key: 'webhook__id', label: 'Moosewave Webhook ID', type: 'string' },
    { key: 'delivery__id', label: 'Delivery ID', type: 'string' },
    { key: 'delivery__attempt', label: 'Delivery Attempt', type: 'integer' },
  ];
}

module.exports = {
  envelopeItems,
  normalizeTags,
  optionalString,
  outboundEnvelope,
  outboundEnvelopeFields,
  requiredEmail,
  requiredString,
  responseData,
  zapierWebhookItem,
};
