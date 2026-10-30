// Zapier "create" action: remove a subscriber from a list (standalone step).
//
// DELETE /api/v1/lists/{id}/subscribers/{sub_id}
// (apps/api/internal/lists/membership_write.go). Keyed by subscriber uuid, so
// we resolve the supplied email to an id first. The endpoint soft-deletes the
// membership and always returns 204 once the list id resolves — removing a
// non-member is a silent no-op — so there is no response body to surface.

const { apiUrlForBundle } = require('../lib/api-url');
const { requiredString, responseData } = require('../lib/fields');
const { resolveSubscriberIdByEmail } = require('../lib/subscribers');

const perform = async (z, bundle) => {
  const input = bundle.inputData || {};
  const listId = requiredString(input.list_id, 'list_id');
  const subscriberId = await resolveSubscriberIdByEmail(z, bundle, input.subscriber_email);

  const response = await z.request({
    method: 'DELETE',
    url: apiUrlForBundle(
      bundle,
      `/api/v1/lists/${encodeURIComponent(listId)}/subscribers/${encodeURIComponent(subscriberId)}`,
    ),
  });
  const data = responseData(response);
  // 204 No Content carries no body — synthesize a stable success envelope so
  // downstream Zap steps have something to map.
  return {
    success: true,
    list_id: listId,
    subscriber_id: subscriberId,
    ...(data && typeof data === 'object' ? data : {}),
  };
};

module.exports = {
  key: 'remove_from_list',
  noun: 'List Membership',
  display: {
    label: 'Remove From List',
    description:
      'Remove a subscriber (by email) from a list. Removing someone who is ' +
      'not on the list is a no-op.',
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
        helpText: 'The email of the subscriber to remove from the list.',
      },
    ],
    sample: {
      success: true,
      list_id: 'lst_01HFAKE',
      subscriber_id: 'sub_01HFAKE',
    },
    outputFields: [
      { key: 'success', label: 'Success', type: 'boolean' },
      { key: 'list_id', label: 'List ID', type: 'string' },
      { key: 'subscriber_id', label: 'Subscriber ID', type: 'string' },
    ],
  },
};
