// Zapier "create" action: enroll a subscriber in a sequence.

const { apiUrlForBundle } = require('../lib/api-url');
const { requiredEmail, requiredString, responseData } = require('../lib/fields');

const perform = async (z, bundle) => {
  const input = bundle.inputData || {};
  const id = requiredString(input.sequence_id, 'sequence_id');
  const email = requiredEmail(input.subscriber_email, 'subscriber_email');

  const response = await z.request({
    method: 'POST',
    url: apiUrlForBundle(
      bundle,
      `/api/v1/sequences/${encodeURIComponent(id)}/subscribers`,
    ),
    body: { email },
  });
  const data = responseData(response);
  // Normalize the response so the sample/outputFields contract holds even if
  // the upstream API returns a different envelope shape over time.
  return {
    success: true,
    enrolled: data.enrolled || {
      subscriber_id: data.subscriber_id || data.id || null,
      sequence_id: id,
      started_at: data.started_at || data.created_at || null,
    },
  };
};

module.exports = {
  key: 'start_sequence',
  noun: 'Sequence',
  display: {
    label: 'Start Sequence',
    description: 'Enroll a subscriber in an automated email sequence.',
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'sequence_id',
        label: 'Sequence',
        required: true,
        type: 'string',
        // Backed by the hidden `list_sequences` trigger in index.js.
        dynamic: 'list_sequences.id.name',
      },
      {
        key: 'subscriber_email',
        label: 'Subscriber Email',
        required: true,
        type: 'string',
      },
    ],
    sample: {
      success: true,
      enrolled: {
        subscriber_id: 'sub_01HFAKE',
        sequence_id: 'seq_01HFAKE',
        started_at: '2026-05-09T12:00:00Z',
      },
    },
    outputFields: [
      { key: 'success', label: 'Success', type: 'boolean' },
      { key: 'enrolled__subscriber_id', label: 'Subscriber ID', type: 'string' },
      { key: 'enrolled__sequence_id', label: 'Sequence ID', type: 'string' },
      { key: 'enrolled__started_at', label: 'Started At', type: 'datetime' },
    ],
  },
};
