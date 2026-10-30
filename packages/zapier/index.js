// Moosewave's Zapier platform-cli app.
//
// Wires up:
//   - API-key bearer auth via beforeRequest
//   - 7 user-visible REST-Hook triggers (campaign.sent, subscriber.added,
//     subscriber.unsubscribed, approval.decided, approval.requested,
//     bounce.received, list.subscriber.added)
//   - 7 user-visible creates (add/update/unsubscribe subscriber, send
//     campaign, start sequence, add to list, remove from list)
//   - 1 user-visible search (find subscriber) that backs find-or-create Zaps
//   - 3 hidden "list_*" triggers that back the dynamic dropdowns on creates.
//
// Hidden triggers are defined inline rather than in their own files because
// they're tiny glue — they each just GET a collection endpoint and normalize
// the shape Zapier expects (`[{id, name}, ...]`).

const authentication = require('./authentication');

const campaignSentTrigger = require('./triggers/campaign-sent');
const subscriberAddedTrigger = require('./triggers/subscriber-added');
const subscriberUnsubscribedTrigger = require('./triggers/subscriber-unsubscribed');
const approvalDecidedTrigger = require('./triggers/approval-decided');
const approvalRequestedTrigger = require('./triggers/approval-requested');
const bounceReceivedTrigger = require('./triggers/bounce-received');
const listSubscriberAddedTrigger = require('./triggers/list-subscriber-added');

const addSubscriberCreate = require('./creates/add-subscriber');
const updateSubscriberCreate = require('./creates/update-subscriber');
const unsubscribeSubscriberCreate = require('./creates/unsubscribe-subscriber');
const sendCampaignCreate = require('./creates/send-campaign');
const startSequenceCreate = require('./creates/start-sequence');
const addToListCreate = require('./creates/add-to-list');
const removeFromListCreate = require('./creates/remove-from-list');

const findSubscriberSearch = require('./searches/find-subscriber');

const { apiUrlForBundle, safeHeaderValue } = require('./lib/api-url');
const { envelopeItems, responseData } = require('./lib/fields');

// Hidden helper trigger: returns the tenant's lists for the list_id dropdown
// on Add Subscriber.
const listListsTrigger = {
  key: 'list_lists',
  noun: 'List',
  display: {
    hidden: true,
    label: 'List of Lists',
    description: 'Internal helper for dynamic dropdowns.',
  },
  operation: {
    perform: async (z, bundle) => {
      const response = await z.request({
        url: apiUrlForBundle(bundle, '/api/v1/lists'),
        skipThrowForStatus: true,
      });
      if (response.status === 404 || response.status >= 400) return [];
      const data = responseData(response);
      const items = envelopeItems(data, ['lists', 'items']);
      return items.map((l) => ({
        id: l.id,
        name: l.name || l.title || l.id,
      }));
    },
  },
};

// Hidden helper trigger: returns draft campaigns for the campaign_id dropdown
// on Send Campaign.
const listDraftCampaignsTrigger = {
  key: 'list_draft_campaigns',
  noun: 'Campaign',
  display: {
    hidden: true,
    label: 'List of Draft Campaigns',
    description: 'Internal helper for dynamic dropdowns.',
  },
  operation: {
    perform: async (z, bundle) => {
      const response = await z.request({
        url: apiUrlForBundle(bundle, '/api/v1/campaigns'),
        params: { status: 'draft', limit: 100 },
        skipThrowForStatus: true,
      });
      if (response.status === 404 || response.status >= 400) return [];
      const data = responseData(response);
      const items = envelopeItems(data, ['campaigns', 'items']);
      return items.map((c) => ({
        id: c.id,
        name: c.name || c.subject || c.id,
      }));
    },
  },
};

// Hidden helper trigger: returns sequences for the sequence_id dropdown on
// Start Sequence.
const listSequencesTrigger = {
  key: 'list_sequences',
  noun: 'Sequence',
  display: {
    hidden: true,
    label: 'List of Sequences',
    description: 'Internal helper for dynamic dropdowns.',
  },
  operation: {
    perform: async (z, bundle) => {
      const response = await z.request({
        url: apiUrlForBundle(bundle, '/api/v1/sequences'),
        params: { limit: 100 },
        skipThrowForStatus: true,
      });
      if (response.status === 404 || response.status >= 400) return [];
      const data = responseData(response);
      const items = envelopeItems(data, ['sequences', 'items']);
      return items.map((s) => ({
        id: s.id,
        name: s.name || s.title || s.id,
      }));
    },
  },
};

// Attach the bearer token before every outbound request. Zapier runs this
// middleware on EVERY z.request() call, including the auth.test ping and the
// hidden dropdown triggers — which is exactly what we want.
const includeBearerToken = (request, z, bundle) => {
  if (bundle && bundle.authData && safeHeaderValue(bundle.authData.api_key)) {
    request.headers = request.headers || {};
    request.headers['Authorization'] = `Bearer ${bundle.authData.api_key}`;
  }
  return request;
};

module.exports = {
  version: require('./package.json').version,
  // Defer to zapier-platform-core's bundled version when available so we don't
  // accidentally lie about which platform we targeted. The fallback string
  // mirrors the version pinned in package.json — keeps `require('./index.js')`
  // working from `node --test` even if zapier-platform-core isn't installed
  // (e.g. in a fresh clone before `npm install`).
  platformVersion: (() => {
    try {
      return require('zapier-platform-core').version;
    } catch (_) {
      return '16.3.0';
    }
  })(),
  authentication,
  beforeRequest: [includeBearerToken],
  triggers: {
    [campaignSentTrigger.key]: campaignSentTrigger,
    [subscriberAddedTrigger.key]: subscriberAddedTrigger,
    [subscriberUnsubscribedTrigger.key]: subscriberUnsubscribedTrigger,
    [approvalDecidedTrigger.key]: approvalDecidedTrigger,
    [approvalRequestedTrigger.key]: approvalRequestedTrigger,
    [bounceReceivedTrigger.key]: bounceReceivedTrigger,
    [listSubscriberAddedTrigger.key]: listSubscriberAddedTrigger,
    // Hidden helpers for dynamic dropdowns:
    [listListsTrigger.key]: listListsTrigger,
    [listDraftCampaignsTrigger.key]: listDraftCampaignsTrigger,
    [listSequencesTrigger.key]: listSequencesTrigger,
  },
  creates: {
    [addSubscriberCreate.key]: addSubscriberCreate,
    [updateSubscriberCreate.key]: updateSubscriberCreate,
    [unsubscribeSubscriberCreate.key]: unsubscribeSubscriberCreate,
    [sendCampaignCreate.key]: sendCampaignCreate,
    [startSequenceCreate.key]: startSequenceCreate,
    [addToListCreate.key]: addToListCreate,
    [removeFromListCreate.key]: removeFromListCreate,
  },
  searches: {
    [findSubscriberSearch.key]: findSubscriberSearch,
  },
};
