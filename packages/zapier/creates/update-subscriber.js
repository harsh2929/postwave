// Zapier "create" action: update an existing subscriber's attributes/status.
//
// PATCH /api/v1/subscribers/{id} — the id-keyed update path is the one that
// fires the subscriber lifecycle webhooks (status_changed, unsubscribed,
// confirmed) and writes the attribute-history audit trail, so we always
// resolve to an id first. Callers may pass an email (resolved via the exact
// `email:` lookup in lib/subscribers.js) or a subscriber id directly.
//
// TAGS — the backend PATCH REPLACES the tags array wholesale
// (apps/api/internal/subscribers/repo.go: `cur.Tags = in.Tags`); there is no
// server-side merge mode. To offer non-destructive merge (the safer default,
// and what most "add a tag" automations expect) we fetch the subscriber's
// current tags and send the UNION. A "Tag Mode" field lets a user opt into
// the destructive replace explicitly, so the behaviour always matches the UI
// copy.

const { apiUrlForBundle } = require('../lib/api-url');
const { normalizeTags, optionalString, responseData } = require('../lib/fields');
const { resolveSubscriberIdByEmail } = require('../lib/subscribers');

// hasOwn reports whether the user actually supplied a key in the Zap step,
// distinguishing "leave unchanged" (key absent) from "clear this field" (key
// present but empty). Name columns are pointer fields server-side: an explicit
// "" clears them (apps/api/internal/subscribers/types.go UpdateInput).
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// fetchCurrentTags reads the subscriber's existing tags so a merge can union
// against them. Returns [] when the record carries none.
const fetchCurrentTags = async (z, bundle, id) => {
  const response = await z.request({
    url: apiUrlForBundle(bundle, `/api/v1/subscribers/${encodeURIComponent(id)}`),
    skipThrowForStatus: true,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Could not read existing tags for subscriber ${id} (HTTP ${response.status}); ` +
        'refusing to risk dropping tags. Retry or use Tag Mode "replace".',
    );
  }
  const sub = responseData(response);
  return Array.isArray(sub.tags) ? sub.tags : [];
};

const perform = async (z, bundle) => {
  const input = bundle.inputData || {};
  const directId = optionalString(input.subscriber_id);
  const email = optionalString(input.email);
  if (!directId && !email) {
    throw new Error('Provide a subscriber id or an email to update.');
  }
  const id = directId || (await resolveSubscriberIdByEmail(z, bundle, email));

  // Build a sparse PATCH body: only fields the user actually supplied are
  // sent so an omitted field is left unchanged (the API treats absent keys
  // as "no change").
  const body = {};
  const status = optionalString(input.status);
  if (status) body.status = status;
  const newEmail = optionalString(input.new_email);
  if (newEmail) body.email = newEmail.toLowerCase();
  // Name columns: send when the key is PRESENT, even if empty — an explicit ""
  // clears the column server-side. A truly omitted key leaves it untouched.
  if (hasOwn(input, 'first_name')) {
    body.first_name = String(input.first_name == null ? '' : input.first_name).trim();
  }
  if (hasOwn(input, 'last_name')) {
    body.last_name = String(input.last_name == null ? '' : input.last_name).trim();
  }

  // Tags. Only touch the array when the user supplied tags (or explicitly asked
  // to clear via replace + empty). Merge is the default + non-destructive.
  if (hasOwn(input, 'tags') && input.tags != null && String(input.tags).trim() !== '') {
    const incoming = normalizeTags(input.tags);
    const mode = (optionalString(input.tag_mode) || 'merge').toLowerCase();
    if (mode === 'replace') {
      body.tags = incoming;
    } else {
      const current = await fetchCurrentTags(z, bundle, id);
      // Union (dedup, preserve order: existing first, then new). normalizeTags
      // handles dedupe + trimming across the combined list.
      body.tags = normalizeTags([...current, ...incoming]);
    }
  }

  const response = await z.request({
    method: 'PATCH',
    url: apiUrlForBundle(bundle, `/api/v1/subscribers/${encodeURIComponent(id)}`),
    body,
  });
  return responseData(response) || { id };
};

module.exports = {
  key: 'update_subscriber',
  noun: 'Subscriber',
  display: {
    label: 'Update Subscriber',
    description:
      "Update an existing subscriber's status, name, email, or tags. " +
      'Identify the subscriber by email (looked up automatically) or by id.',
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'email',
        label: 'Email',
        required: false,
        type: 'string',
        helpText:
          'The current email of the subscriber to update. Either this or a ' +
          'Subscriber ID is required.',
      },
      {
        key: 'subscriber_id',
        label: 'Subscriber ID',
        required: false,
        type: 'string',
        helpText: 'Use instead of Email when you already have the id.',
      },
      {
        key: 'status',
        label: 'Status',
        required: false,
        type: 'string',
        choices: ['enabled', 'disabled', 'blocklisted', 'unconfirmed'],
        helpText:
          'Engine status. Set to "blocklisted" to unsubscribe (or use the ' +
          'dedicated Unsubscribe Subscriber action).',
      },
      {
        key: 'new_email',
        label: 'New Email',
        required: false,
        type: 'string',
        helpText: 'Change the subscriber email address.',
      },
      {
        key: 'tags',
        label: 'Tags',
        required: false,
        type: 'string',
        helpText:
          'Comma-separated tags (e.g. "founder,early-access"). By default these ' +
          'are ADDED to the subscriber\'s existing tags (see Tag Mode). Leave ' +
          'blank to leave tags untouched.',
      },
      {
        key: 'tag_mode',
        label: 'Tag Mode',
        required: false,
        type: 'string',
        default: 'merge',
        choices: ['merge', 'replace'],
        helpText:
          '"merge" (default) adds the tags above to the existing ones without ' +
          'removing any. "replace" overwrites ALL existing tags with exactly ' +
          'the tags above (destructive).',
      },
      {
        key: 'first_name',
        label: 'First Name',
        required: false,
        type: 'string',
        helpText: 'Leave this field out to keep the current value; send it empty to clear it.',
      },
      {
        key: 'last_name',
        label: 'Last Name',
        required: false,
        type: 'string',
        helpText: 'Leave this field out to keep the current value; send it empty to clear it.',
      },
    ],
    sample: {
      id: 'sub_01HFAKE',
      email: 'ada@example.com',
      status: 'enabled',
      first_name: 'Ada',
      last_name: 'Lovelace',
      tags: ['founder'],
      updated_at: '2026-05-09T12:00:00Z',
    },
    outputFields: [
      { key: 'id', label: 'Subscriber ID', type: 'string' },
      { key: 'email', label: 'Email', type: 'string' },
      { key: 'status', label: 'Status', type: 'string' },
      { key: 'first_name', label: 'First Name', type: 'string' },
      { key: 'last_name', label: 'Last Name', type: 'string' },
      { key: 'updated_at', label: 'Updated At', type: 'datetime' },
    ],
  },
};
