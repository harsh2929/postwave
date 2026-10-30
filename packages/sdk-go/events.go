package postwave

import "context"

// EventsResource is the behavioural-event ingest API — the entry point for
// event-triggered flows.
type EventsResource struct{ client *Client }

// Track records one behavioural event for a subscriber (identified by email,
// subscriber_id, or external_id in the payload).
func (r *EventsResource) Track(ctx context.Context, in map[string]any) (map[string]any, error) {
	out := map[string]any{}
	return out, r.client.request(ctx, "POST", "/api/v1/events", in, &out)
}

// Identify creates or resolves a subscriber from a stable external identifier
// (Klaviyo/Segment-style identify).
func (r *EventsResource) Identify(ctx context.Context, in map[string]any) (map[string]any, error) {
	out := map[string]any{}
	return out, r.client.request(ctx, "POST", "/api/v1/subscribers/identify", in, &out)
}
