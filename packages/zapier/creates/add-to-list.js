// Zapier "create" action: add a subscriber to a list (standalone step).
//
// POST /api/v1/lists/{id}/subscribers with body { subscriber_ids: [...] }
// (apps/api/internal/lists/membership_write.go). The membership write surface
// is keyed by subscriber uuid, so we resolve the supplied email to an id
// first. The endpoint is idempotent — re-adding an active member is a counted
// no-op — and returns { added, skipped }.

const { apiUrlForBundle } = require('../lib/api-url');
const { requiredString, responseData } = require('../lib/fields');
const { resolveSubscriberIdByEmail } = require('../lib/subscribers');

const perform = async (z, bundle) => {
  const input = bundle.inputData || {};
  const listId = requiredString(input.list_id, 'list_id');
  const subscriberId = await resolveSubscriberIdByEmail(z, bundle, input.subscriber_email);

  const response = await z.request({
    method: 'POST',
    url: apiUrlForBundle(bundle, `/api/v1/lists/${encodeURIComponent(listId)}/subscribers`),
    body: { subscriber_ids: [subscriberId] },
  });
  const data = responseData(response);
  // Normalize so the sample/outputFields contract holds regardless of the
  // upstream envelope shape.
  return {
    list_id: listId,
    subscriber_id: subscriberId,
    added: data.added != null ? data.added : null,
    skipped: data.skipped != null ? data.skipped : null,
  };
};

module.exports = {
  key: 'add_to_list',
  noun: 'List Membership',
  display: {
    label: 'Add To List',
    description:
      'Add an existing subscriber (by email) to a list. Idempotent — adding ' +
      'someone already on the list is a no-op.',
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'list_id',
        label: 'List',
        required: true,
        type: 'string',
        // Backed by the hidden `list_lists` trigger in index.js.
        dynamic: 'list_lists.id.name',
      },
      {
        key: 'subscriber_email',
        label: 'Subscriber Email',
        required: true,
        type: 'string',
        helpText: 'The email of the subscriber to add to the list.',
      },
    ],
    sample: {
      list_id: 'lst_01HFAKE',
      subscriber_id: 'sub_01HFAKE',
      added: 1,
      skipped: 0,
    },
    outputFields: [
      { key: 'list_id', label: 'List ID', type: 'string' },
      { key: 'subscriber_id', label: 'Subscriber ID', type: 'string' },
      { key: 'added', label: 'Added', type: 'integer' },
      { key: 'skipped', label: 'Skipped', type: 'integer' },
    ],
  },
};
