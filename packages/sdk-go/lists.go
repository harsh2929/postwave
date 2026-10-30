package postwave

import (
	"context"
	"net/url"
)

// ListsResource is the mailing-list API.
type ListsResource struct{ client *Client }

// List is a mailing list record.
type List = map[string]any

// All returns every list (paginated via opts).
func (r *ListsResource) All(ctx context.Context, opts map[string]string) (map[string]any, error) {
	q := url.Values{}
	for k, v := range opts {
		q.Set(k, v)
	}
	path := "/api/v1/lists"
	if e := q.Encode(); e != "" {
		path += "?" + e
	}
	out := map[string]any{}
	return out, r.client.request(ctx, "GET", path, nil, &out)
}

// Get fetches one list by id.
func (r *ListsResource) Get(ctx context.Context, id string) (List, error) {
	out := List{}
	return out, r.client.request(ctx, "GET", "/api/v1/lists/"+url.PathEscape(id), nil, &out)
}

// Create makes a new list.
func (r *ListsResource) Create(ctx context.Context, in map[string]any) (List, error) {
	out := List{}
	return out, r.client.request(ctx, "POST", "/api/v1/lists", in, &out)
}

// Update patches a list.
func (r *ListsResource) Update(ctx context.Context, id string, in map[string]any) (List, error) {
	out := List{}
	return out, r.client.request(ctx, "PATCH", "/api/v1/lists/"+url.PathEscape(id), in, &out)
}

// Delete removes a list.
func (r *ListsResource) Delete(ctx context.Context, id string) error {
	return r.client.request(ctx, "DELETE", "/api/v1/lists/"+url.PathEscape(id), nil, nil)
}
