// Shared helper: resolve a subscriber email → Moosewave subscriber id.
//
// Several creates (Update Subscriber, Unsubscribe, Add/Remove from List)
// accept an email but operate against id-keyed endpoints
// (PATCH /api/v1/subscribers/{id}, the list-membership writes which take
// uuid subscriber_ids). We resolve the email via the read-only search
// endpoint using the `email:` operator — an exact-field lookup against the
// email column (see apps/api/internal/subscribers/search_parser.go) — rather
// than the fuzzy free-text `q` filter, which scores email + name + tags +
// custom fields with non-relevance sort and could rank the wanted address off
// the first page (find-or-create reliability). We still confirm a
// case-insensitive EXACT email match client-side, since `email:` is a
// substring/contains predicate at the DB level. Bearer auth is attached
// automatically by the includeBearerToken beforeRequest middleware in
// index.js — same as every other operation in this app.

const { apiUrlForBundle } = require('./api-url');
const { envelopeItems, requiredEmail, responseData } = require('./fields');

// findExactSubscriberByEmail returns the subscriber object whose email matches
// `email` (already lowercased + validated), or null when a clean 200 returns
// no exact match. It THROWS on any non-2xx response (401/403/429/5xx, etc.) so
// a transient auth/rate-limit/server failure is never silently masked as
// "not found" — a find-or-create Zap must not enrol a duplicate just because
// the lookup errored. Only a clean response with no exact-email row is a real
// "no match".
async function findExactSubscriberByEmail(z, bundle, email) {
  const response = await z.request({
    url: apiUrlForBundle(bundle, '/api/v1/subscribers/search'),
    // `email:<addr>` routes through the structured email-column predicate
    // instead of the relevance-free `q` scan. per_page is generous so the
    // exact row is on the page even when several addresses share a prefix.
    params: { q: `email:${email}`, per_page: 100 },
    skipThrowForStatus: true,
  });
  if (response.status < 200 || response.status >= 300) {
    // Propagate the real failure. A 4xx/5xx is NOT "no subscriber" — masking
    // it as an empty result would let find-or-create create a duplicate or an
    // update silently target nobody.
    throw new Error(
      `Moosewave subscriber lookup for ${email} failed (HTTP ${response.status}).`,
    );
  }
  const data = responseData(response);
  const items = envelopeItems(data, ['subscribers', 'items']);
  return items.find((s) => String(s.email || '').toLowerCase() === email) || null;
}

// resolveSubscriberIdByEmail returns the id of the subscriber whose email
// matches `rawEmail` (case-insensitive exact match). Throws a friendly error
// when the address is malformed or no matching subscriber exists, so a Zap
// step fails loudly rather than silently no-op'ing against the wrong person.
// Transport/auth/server errors propagate (see findExactSubscriberByEmail).
async function resolveSubscriberIdByEmail(z, bundle, rawEmail, label = 'email') {
  const email = requiredEmail(rawEmail, label);
  const match = await findExactSubscriberByEmail(z, bundle, email);
  if (!match || !match.id) {
    throw new Error(`No Moosewave subscriber found for ${email}.`);
  }
  return String(match.id);
}

module.exports = { resolveSubscriberIdByEmail, findExactSubscriberByEmail };
