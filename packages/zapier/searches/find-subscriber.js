// Zapier "search" action: find a subscriber in Moosewave.
//
// Backs find-or-create Zaps: callers give us an email (preferred) or a free-
// text query, and we return the matching subscriber(s). Hits the read-only
// search endpoint (GET /api/v1/subscribers/search). When an email is supplied
// we use the structured `email:<addr>` operator (an exact email-column
// predicate — see apps/api/internal/subscribers/search_parser.go) and confirm
// a case-insensitive EXACT match client-side, so a find-or-create Zap never
// enrols the wrong person on a fuzzy hit. A free-text query falls through the
// same endpoint's relevance scan. Bearer auth is attached automatically by the
// `includeBearerToken` beforeRequest middleware in index.js — same as every
// other operation in this app.

const { apiUrlForBundle } = require('../lib/api-url');
const { envelopeItems, optionalString, responseData } = require('../lib/fields');
const { findExactSubscriberByEmail } = require('../lib/subscribers');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const perform = async (z, bundle) => {
  const input = bundle.inputData || {};
  const email = optionalString(input.email);
  const query = optionalString(input.query);
  if (!email && !query) {
    throw new Error('Provide an email or a search query to find a subscriber.');
  }

  // Email path: exact-match lookup. findExactSubscriberByEmail PROPAGATES
  // auth/rate-limit/server errors (401/403/429/5xx) instead of masking them as
  // "no match" — only a clean 200 with no exact row is a real miss. Zapier
  // expects an array, so wrap the single match (or return []).
  if (email && EMAIL_RE.test(email)) {
    const match = await findExactSubscriberByEmail(z, bundle, email.toLowerCase());
    return match ? [match] : [];
  }

  // Free-text fallback (no usable email): relevance scan via the search
  // endpoint. A non-2xx here is a genuine failure — propagate it rather than
  // pretending there was no match.
  const response = await z.request({
    url: apiUrlForBundle(bundle, '/api/v1/subscribers/search'),
    params: { q: email || query, per_page: 25 },
    skipThrowForStatus: true,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Moosewave subscriber search failed (HTTP ${response.status}).`,
    );
  }
  const data = responseData(response);
  return envelopeItems(data, ['subscribers', 'items']);
};

module.exports = {
  key: 'find_subscriber',
  noun: 'Subscriber',
  display: {
    label: 'Find Subscriber',
    description:
      'Find a subscriber by email address (or a free-text query). Pair with ' +
      'Add Subscriber in a find-or-create step to avoid duplicates.',
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'email',
        label: 'Email',
        required: false,
        type: 'string',
        helpText: 'The subscriber email address to look up (exact match preferred).',
      },
      {
        key: 'query',
        label: 'Search Query',
        required: false,
        type: 'string',
        helpText:
          'Free-text fallback when you do not have an exact email — matches ' +
          'email or name. Ignored when an email is provided.',
      },
    ],
    sample: {
      id: 'sub_01HFAKE',
      email: 'ada@example.com',
      status: 'subscribed',
      first_name: 'Ada',
      last_name: 'Lovelace',
      tags: ['founder'],
      lists: ['lst_newsletter'],
      created_at: '2026-05-09T12:00:00Z',
    },
    outputFields: [
      { key: 'id', label: 'Subscriber ID', type: 'string' },
      { key: 'email', label: 'Email', type: 'string' },
      { key: 'status', label: 'Status', type: 'string' },
      { key: 'first_name', label: 'First Name', type: 'string' },
      { key: 'last_name', label: 'Last Name', type: 'string' },
      { key: 'created_at', label: 'Created At', type: 'datetime' },
    ],
  },
};
