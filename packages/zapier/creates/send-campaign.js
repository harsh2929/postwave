// Zapier "create" action: send a Moosewave campaign.
//
// POST /api/v1/campaigns/{id}/send. If the tenant has approval gates enabled
// this will return 202 + status=pending_approval rather than actually sending,
// which is the correct behavior — Zaps shouldn't bypass governance.

const { apiUrlForBundle } = require('../lib/api-url');
const { requiredString, responseData } = require('../lib/fields');

const perform = async (z, bundle) => {
  const id = requiredString(bundle.inputData && bundle.inputData.campaign_id, 'campaign_id');
  const response = await z.request({
    method: 'POST',
    url: apiUrlForBundle(bundle, `/api/v1/campaigns/${encodeURIComponent(id)}/send`),
    body: {},
  });
  return responseData(response) || { id };
};

module.exports = {
  key: 'send_campaign',
  noun: 'Campaign',
  display: {
    label: 'Send Campaign',
    description:
      'Send a Moosewave campaign to its configured audience. ' +
      'WARNING: Sends to the configured audience. Approval required if your tenant ' +
      'has gates enabled.',
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'campaign_id',
        label: 'Campaign',
        required: true,
        type: 'string',
        // Backed by the hidden `list_draft_campaigns` trigger in index.js.
        dynamic: 'list_draft_campaigns.id.name',
        helpText: 'Pick a draft campaign to send.',
      },
    ],
    sample: {
      id: 'cmp_01HFAKE',
      status: 'sending',
      queued_at: '2026-05-09T12:00:00Z',
    },
    outputFields: [
      { key: 'id', label: 'Campaign ID', type: 'string' },
      { key: 'status', label: 'Status', type: 'string' },
      { key: 'queued_at', label: 'Queued At', type: 'datetime' },
    ],
  },
};
