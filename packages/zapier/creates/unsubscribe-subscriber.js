// Zapier "create" action: unsubscribe a subscriber by email.
//
// Unsubscribing in Moosewave is a status transition to "blocklisted" — the
// final-stop state that fires the subscriber.unsubscribed webhook and writes
// the consent-sync ledger (see apps/api/internal/subscribers/repo.go
// isUnsubscribeTransition). We resolve the email to a subscriber id (the
// PATCH path is id-keyed and is what fires the lifecycle events) and PATCH
// status=blocklisted.

const { apiUrlForBundle } = require('../lib/api-url');
const { responseData } = require('../lib/fields');
const { resolveSubscriberIdByEmail } = require('../lib/subscribers');

// "blocklisted" is StatusBlocklisted in the API — the state the gateway
// treats as a tenant-visible unsubscribe (apps/api/internal/subscribers/
// types.go + repo.go).
const UNSUBSCRIBE_STATUS = 'blocklisted';

const perform = async (z, bundle) => {
  const input = bundle.inputData || {};
  const id = await resolveSubscriberIdByEmail(z, bundle, input.email);

  const response = await z.request({
    method: 'PATCH',
    url: apiUrlForBundle(bundle, `/api/v1/subscribers/${encodeURIComponent(id)}`),
    body: { status: UNSUBSCRIBE_STATUS },
  });
  return responseData(response) || { id, status: UNSUBSCRIBE_STATUS };
};

module.exports = {
  key: 'unsubscribe_subscriber',
  noun: 'Subscriber',
  display: {
    label: 'Unsubscribe Subscriber',
    description:
      'Unsubscribe a subscriber by email (sets status to blocklisted). ' +
      'Fires the subscriber.unsubscribed event and records the consent change.',
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'email',
        label: 'Email',
        required: true,
        type: 'string',
        helpText: 'The email address of the subscriber to unsubscribe.',
      },
    ],
    sample: {
      id: 'sub_01HFAKE',
      email: 'ada@example.com',
      status: 'blocklisted',
      updated_at: '2026-05-09T12:00:00Z',
    },
    outputFields: [
      { key: 'id', label: 'Subscriber ID', type: 'string' },
      { key: 'email', label: 'Email', type: 'string' },
      { key: 'status', label: 'Status', type: 'string' },
      { key: 'updated_at', label: 'Updated At', type: 'datetime' },
    ],
  },
};
