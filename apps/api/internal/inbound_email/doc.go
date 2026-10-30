// Package inbound_email accepts signed inbound-email payloads from ESP signing
// proxies at /api/public/inbound-email/{slug}. Requests must carry a fresh Unix
// timestamp, a stable delivery identity, and an HMAC-SHA256 over
// "<timestamp>.<raw-body>". The package atomically deduplicates the identity
// before route actions or fanout, parses the minimal reply headers, looks up the
// originating subscriber, and writes the email to inbound_emails.
//
// Per-tenant slug + envelope-encrypted secret are managed via the
// inbound_email_endpoints admin surface — exactly one endpoint per tenant.
// Endpoint GETs are metadata-only; create/rotation reveals plaintext once.
// Providers unable to add the required headers must be fronted by a signing
// proxy.
//
// Env vars:
//
//	AUTOMATION_SERVICE_URL — automation service base URL. Optional.
package inbound_email
