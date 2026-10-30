// Package track owns the product-event ingest endpoint (Loops-style).
//
// Callers POST {subscriber_id|email, event_name, properties?, occurred_at?}
// to /api/v1/track. The endpoint resolves the subscriber, writes a row to
// product_events, and (best-effort) fans out an automation trigger of kind
// "product_event" via AUTOMATION_SERVICE_URL.
//
// Env vars:
//
//	AUTOMATION_SERVICE_URL — automation service base URL. Optional; absent
//	                         disables fan-out.
package track
