// Zapier "create" action: add a subscriber to Moosewave.

const { apiUrlForBundle } = require('../lib/api-url');
const {
  normalizeTags,
  optionalString,
  requiredEmail,
  responseData,
} = require('../lib/fields');

const perform = async (z, bundle) => {
  const input = bundle.inputData || {};
  const body = {
    email: requiredEmail(input.email),
    first_name: optionalString(input.first_name),
    last_name: optionalString(input.last_name),
  };
  if (input.list_id) {
    body.lists = [String(input.list_id).trim()].filter(Boolean);
  }
  if (input.tags) {
    body.tags = normalizeTags(input.tags);
  }
  const response = await z.request({
    method: 'POST',
    url: apiUrlForBundle(bundle, '/api/v1/subscribers'),
    body,
  });
  return responseData(response);
};

module.exports = {
  key: 'add_subscriber',
  noun: 'Subscriber',
  display: {
    label: 'Add Subscriber',
    description: 'Add a new subscriber to your Moosewave workspace.',
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'email',
        label: 'Email',
        required: true,
        type: 'string',
        helpText: 'The subscriber email address.',
      },
      {
        key: 'list_id',
        label: 'List',
        required: false,
        type: 'string',
        // Dynamic dropdown — `list_lists` is a hidden trigger registered in
        // index.js that fetches /api/v1/lists.
        dynamic: 'list_lists.id.name',
      },
      {
        key: 'tags',
        label: 'Tags',
        required: false,
        type: 'string',
        helpText: 'Comma-separated tags (e.g. "founder,early-access").',
      },
      { key: 'first_name', label: 'First Name', required: false, type: 'string' },
      { key: 'last_name', label: 'Last Name', required: false, type: 'string' },
    ],
    sample: {
      id: 'sub_01HFAKE',
      email: 'ada@example.com',
      status: 'subscribed',
      tags: ['founder'],
      lists: ['lst_newsletter'],
      created_at: '2026-05-09T12:00:00Z',
    },
    outputFields: [
      { key: 'id', label: 'Subscriber ID', type: 'string' },
      { key: 'email', label: 'Email', type: 'string' },
      { key: 'status', label: 'Status', type: 'string' },
      { key: 'created_at', label: 'Created At', type: 'datetime' },
    ],
  },
};
