// Package inbound_webhooks owns the per-tenant inbound webhook ingest path.
//
// Each tenant can register N endpoints; each gets a stable slug + signing
// secret. Upstream systems POST to /api/public/inbound/{slug} with a fresh Unix
// timestamp, a stable event identity, and an X-Postwave-Signature containing
// hex HMAC-SHA256(secret, "<timestamp>.<raw-body>"). Validated requests claim
// their replay identity in inbound_events before automation fanout or trigger
// execution. Exact retries are acknowledged without running side effects again.
//
// Env vars:
//
//	AUTOMATION_SERVICE_URL — base URL for the trigger event POST. Optional;
//	                         absent disables fan-out (events are still landed).
package inbound_webhooks
