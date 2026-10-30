package postwave

import (
	"context"
	"net/url"
)

// SubscribersResource is the subscriber CRUD API.
type SubscribersResource struct{ client *Client }

// Subscriber is a subscriber record (a permissive map of the API shape).
type Subscriber = map[string]any

// List returns a page of subscribers. opts are passed as query parameters
// (e.g. {"limit": "50", "cursor": "..."}).
func (r *SubscribersResource) List(ctx context.Context, opts map[string]string) (map[string]any, error) {
	q := url.Values{}
	for k, v := range opts {
		q.Set(k, v)
	}
	path := "/api/v1/subscribers"
	if e := q.Encode(); e != "" {
		path += "?" + e
	}
	out := map[string]any{}
	if err := r.client.request(ctx, "GET", path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Get fetches one subscriber by id.
func (r *SubscribersResource) Get(ctx context.Context, id string) (Subscriber, error) {
	out := Subscriber{}
	if err := r.client.request(ctx, "GET", "/api/v1/subscribers/"+url.PathEscape(id), nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Create upserts a subscriber.
func (r *SubscribersResource) Create(ctx context.Context, in map[string]any) (Subscriber, error) {
	out := Subscriber{}
	if err := r.client.request(ctx, "POST", "/api/v1/subscribers", in, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Update patches a subscriber.
func (r *SubscribersResource) Update(ctx context.Context, id string, in map[string]any) (Subscriber, error) {
	out := Subscriber{}
	if err := r.client.request(ctx, "PATCH", "/api/v1/subscribers/"+url.PathEscape(id), in, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Delete removes a subscriber.
func (r *SubscribersResource) Delete(ctx context.Context, id string) error {
	return r.client.request(ctx, "DELETE", "/api/v1/subscribers/"+url.PathEscape(id), nil, nil)
}
